#!/usr/bin/env node
/*
 * Arduino Agent MCP bridge (stdio -> Streamable HTTP).
 *
 * The MCP server lives inside the Arduino Agent IDE, so it only listens on
 * 127.0.0.1:3847 while the IDE is running. Pointing an MCP client straight at
 * that URL means the whole server shows up as "failed to connect" whenever the
 * IDE happens to be closed - which is most of the time, and looks like the
 * integration is broken rather than merely idle.
 *
 * This bridge is a stdio MCP server that the client spawns as a child process,
 * so connecting always succeeds, and it keeps the integration usable while the
 * IDE is closed:
 *   - tools/list always returns the real tool list: the IDE's own list once it
 *     has been seen, otherwise the definitions from the compiled extension for
 *     the tool mode set in the IDE preferences (router by default).
 *   - The read-only router tools (list_tool_categories, get_category_tools,
 *     search_tools) and the prompts are answered locally from the same compiled
 *     code the IDE uses, so tool discovery works with the IDE closed.
 *   - Any other tool call starts the IDE (when ARDUINO_AGENT_PATH is set), waits
 *     for its MCP server and then runs the call - the first call is just slower.
 *     Without ARDUINO_AGENT_PATH it returns a plain "open the IDE" message.
 *   - A watcher notices when the IDE comes up (or restarts) and sends
 *     notifications/tools/list_changed if its tools differ from what the client
 *     was given, so the client refreshes without a restart.
 *
 * Deliberately dependency-free (node builtins only) so it can be run straight
 * from a checkout or a packaged install with `node arduino-agent-bridge.js`.
 *
 * Usage in an MCP client config:
 *   {
 *     "mcpServers": {
 *       "arduino": {
 *         "command": "node",
 *         "args": ["/path/to/arduino-agent-bridge.js"]
 *       }
 *     }
 *   }
 *
 * Environment:
 *   ARDUINO_MCP_URL             Full URL of the MCP endpoint (default http://127.0.0.1:3847/mcp)
 *   ARDUINO_MCP_TOKEN           Auth token (default: read from ~/.arduinoIDE/mcp-token)
 *   ARDUINO_AGENT_PATH          Path to the IDE executable; enables starting the IDE
 *                               when a tool needs it. Opt-in: unset means the bridge
 *                               never starts anything.
 *   ARDUINO_MCP_LAUNCH_TIMEOUT  Seconds to wait for a started IDE (default 120).
 *   ARDUINO_MCP_WATCH_INTERVAL  Seconds between checks for the IDE coming up (default 5).
 *   ARDUINO_MCP_DEBUG           Set to 1 for verbose logging on stderr.
 *
 * NOTE: stdout carries the JSON-RPC stream and nothing else. All diagnostics go
 * to stderr, or they would corrupt the protocol.
 */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2024-11-05';
const BRIDGE_VERSION = '0.3.1';
const ENDPOINT = process.env.ARDUINO_MCP_URL || 'http://127.0.0.1:3847/mcp';
const ARDUINO_DIR = path.join(os.homedir(), '.arduinoIDE');
const TOKEN_FILE = path.join(ARDUINO_DIR, 'mcp-token');
const SETTINGS_FILE = path.join(ARDUINO_DIR, 'settings.json');
const DEBUG = process.env.ARDUINO_MCP_DEBUG === '1';

function seconds(value, fallback) {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 1000;
}
const LAUNCH_TIMEOUT_MS = seconds(process.env.ARDUINO_MCP_LAUNCH_TIMEOUT, 120);
const WATCH_INTERVAL_MS = seconds(process.env.ARDUINO_MCP_WATCH_INTERVAL, 5);
const LAUNCH_POLL_MS = Math.min(1000, WATCH_INTERVAL_MS);
// Handshake and listing requests only; tool calls (e.g. a compile with
// wait:true) may legitimately take minutes and are never timed out here.
const QUICK_REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1000;

/**
 * Server instructions surfaced in the bridge's locally-answered initialize
 * (the bridge must answer even when the IDE is closed). The compiled
 * extension is the source of truth; the embedded string below is only the
 * fallback for unbuilt checkouts.
 *
 * KEEP IN SYNC with src/common/mcp-instructions.ts - the manual smoke test
 * compares the bridge's initialize.instructions with the HTTP server's.
 */
const FALLBACK_INSTRUCTIONS = `Open Duino - an Arduino IDE with this MCP server embedded. You share one editor, one board and one serial monitor with the user; prefer these tools over asking the user to click in the IDE.

Recommended workflow:
1. arduino_context for current state (open sketch, selected board/port, connected boards with USB vid/pid).
2. If the board shows identified:false, run arduino_board suggest_fqbn (uses USB identity + name matching; tells you which core to install if missing). ALWAYS pass an explicit fqbn to compile/upload/serial connect for such boards - they can never be auto-identified.
3. Write code with arduino_sketch (set_content writes to disk AND live-reloads the user's editor).
4. Compile/upload with wait:true - one call returns the final result. A timed_out:true response is NOT an error: call arduino_task_status {task_id, wait:true} to keep waiting (first builds for a new core can take minutes).
5. arduino_upload compiles first automatically - no separate compile needed.
6. After upload, connect serial at the baud rate in the sketch's Serial.begin(). Reads are cursor-based: keep the returned cursor and pass it as since to page output losslessly. Use wait_for {pattern} to block until expected output arrives.
7. Crash/reset detection is automatic: read/wait_for responses carry events (reset/panic/watchdog/brownout/abort, with reset reasons and backtraces). A crash ends a pending wait_for early. "No output" plus reset events means the board is crash-looping, not quiet.

Failure handling:
- Failed compile/upload tasks carry result.explained - read it before retrying; it names the cause and the fix (port busy, bootloader mode, wrong FQBN, power).
- Native-USB boards (ESP32-S2/S3/C3) re-enumerate after reset: the port can change or vanish; re-run arduino_board list_connected. Uploads are far more reliable via a board's UART/bridge port; native-USB uploads can require holding BOOT while pressing RESET.
- Serial port busy on upload usually means this server's own monitor is connected: arduino_serial disconnect first.

Firmware rules of thumb:
- Never busy-loop without delay()/vTaskDelay() on ESP32 - a starved idle task trips the task watchdog and reboots the chip.
- Serial.begin(115200) is the conventional rate; after flashing over native USB, wait ~1s for CDC re-enumeration before expecting output.`;

/** A module from the compiled extension next to this file, or null (unbuilt checkout). */
function loadCompiled(name) {
  try {
    // eslint-disable-next-line global-require
    return require(path.join(__dirname, '..', 'lib', 'common', name));
  } catch {
    return null;
  }
}

const compiledInstructions = loadCompiled('mcp-instructions');
const INSTRUCTIONS =
  typeof compiledInstructions?.MCP_SERVER_INSTRUCTIONS === 'string'
    ? compiledInstructions.MCP_SERVER_INSTRUCTIONS
    : FALLBACK_INSTRUCTIONS;
// Tool and prompt definitions: the same data the IDE serves.
const toolDefs = loadCompiled('mcp-tools');
const router = loadCompiled('mcp-tool-router');
const promptDefs = loadCompiled('mcp-prompts');

function log(...args) {
  if (DEBUG) console.error('[arduino-bridge]', ...args);
}

function warn(...args) {
  console.error('[arduino-bridge]', ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ARDUINO_AGENT_PATH is retained for compatibility with existing MCP configs.
 * If it names an old Arduino IDE or Arduino Agent executable, try the matching
 * Open Duino path before giving up.
 */
function resolveAgentExecutable(exe) {
  if (!exe || fs.existsSync(exe)) return exe;
  const candidates = [];
  for (const oldName of ['Arduino IDE', 'Arduino Agent']) {
    for (const newName of ['Open Duino', 'Arduino Agent']) {
      const candidate = exe.split(oldName).join(newName);
      if (candidate !== exe) candidates.push(candidate);
    }
  }
  const renamed = candidates.find((p) => fs.existsSync(p));
  if (!renamed) return exe;
  warn(`ARDUINO_AGENT_PATH points at ${exe}, which no longer exists; using ${renamed} instead. Update the setting when convenient.`);
  return renamed;
}

/** The message shown when a tool needs the IDE and it is not reachable. */
function offlineMessage(detail) {
  const lines = [
    'Open Duino is not running, so this Arduino tool cannot run right now.',
    '',
    'Open the Open Duino IDE and call the tool again - the connection ' +
      'recovers on its own; there is no need to restart this client.',
  ];
  if (detail) {
    lines.push('', `(${detail})`);
  } else if (!process.env.ARDUINO_AGENT_PATH) {
    lines.push(
      '',
      'Tip: set ARDUINO_AGENT_PATH to the IDE executable in this MCP server\'s ' +
        'config and the bridge will start the IDE for you when a tool needs it.'
    );
  }
  return lines.join('\n');
}

/** A readable message for upstream failures other than "not running". */
function upstreamErrorMessage(err) {
  if (err && err.status === 401) {
    return (
      'Open Duino rejected the bridge\'s auth token. The IDE writes a fresh ' +
      `token to ${TOKEN_FILE} when it starts; restart the IDE, or set ` +
      'ARDUINO_MCP_TOKEN in this MCP server\'s config if you use a custom token.'
    );
  }
  return `Open Duino bridge error: ${err ? err.message : 'unknown error'}`;
}

// ---------------------------------------------------------------------------
// Upstream (Streamable HTTP) client
// ---------------------------------------------------------------------------

class Upstream {
  constructor(endpoint) {
    this.url = new URL(endpoint);
    this.transport = this.url.protocol === 'https:' ? https : http;
    this.port = Number(this.url.port) || (this.url.protocol === 'https:' ? 443 : 80);
    this.sessionId = null;
    this.initialized = false;
    this.handshake = null; // in-flight handshake, shared by concurrent callers
    this.online = false; // last request reached the IDE
    this.pendingLaunch = null; // in-flight launch-and-wait, shared by concurrent calls
    this.launchGaveUp = false; // a launch timed out; don't open more windows until the IDE is seen
  }

  token() {
    if (process.env.ARDUINO_MCP_TOKEN) return process.env.ARDUINO_MCP_TOKEN;
    try {
      // Re-read per request: the IDE regenerates the token across restarts.
      return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /**
   * Raw JSON-RPC POST. Resolves with the parsed body (or null for 202s).
   * `timeoutMs` bounds how long the upstream may stay silent (quick requests only).
   */
  request(body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const headers = {
        'Content-Type': 'application/json',
        // The server may answer either way; accept both.
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
      };
      const token = this.token();
      if (token) headers.Authorization = `Bearer ${token}`;
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

      const req = this.transport.request(
        {
          hostname: this.url.hostname,
          port: this.url.port,
          path: this.url.pathname + this.url.search,
          method: 'POST',
          headers,
        },
        (res) => {
          const sid = res.headers['mcp-session-id'];
          if (sid) this.sessionId = sid;
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            this.markOnline();
            if (res.statusCode === 404 || res.statusCode === 401) {
              // Session expired or token rotated (IDE restarted): re-handshake.
              this.reset();
              return reject(
                Object.assign(new Error(`upstream status ${res.statusCode}`), {
                  retryable: true,
                  status: res.statusCode,
                })
              );
            }
            if (!raw.trim()) return resolve(null);
            resolve(parseBody(raw));
          });
        }
      );
      if (timeoutMs) {
        req.setTimeout(timeoutMs, () =>
          req.destroy(
            Object.assign(new Error(`no answer within ${timeoutMs / 1000}s`), {
              code: 'ETIMEDOUT',
            })
          )
        );
      }
      req.on('error', (err) => {
        const offline = isOffline(err);
        if (offline) this.markOffline();
        reject(Object.assign(err, { offline }));
      });
      req.write(data);
      req.end();
    });
  }

  markOnline() {
    this.online = true;
    this.launchGaveUp = false;
  }

  markOffline() {
    this.online = false;
    this.reset();
  }

  reset() {
    this.sessionId = null;
    this.initialized = false;
  }

  /** Performs the MCP handshake if it has not been done for this session. */
  ensureSession() {
    if (this.initialized) return Promise.resolve();
    if (!this.handshake) {
      this.handshake = this.handshakeOnce().finally(() => {
        this.handshake = null;
      });
    }
    return this.handshake;
  }

  async handshakeOnce() {
    await this.request(
      {
        jsonrpc: '2.0',
        id: `bridge-init-${Date.now()}`,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'arduino-agent-bridge', version: BRIDGE_VERSION },
        },
      },
      QUICK_REQUEST_TIMEOUT_MS
    );
    await this.request(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      QUICK_REQUEST_TIMEOUT_MS
    );
    this.initialized = true;
    log('upstream session established', this.sessionId || '(no session id)');
  }

  /** Handshake + send, retrying once if the session went stale. */
  async send(body, timeoutMs) {
    try {
      await this.ensureSession();
      return await this.request(body, timeoutMs);
    } catch (err) {
      if (err && err.retryable) {
        log('retrying after stale session');
        await this.ensureSession();
        return await this.request(body, timeoutMs);
      }
      throw err;
    }
  }

  /** Whether anything is listening on the MCP port (cheap TCP connect, no auth). */
  probe() {
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.url.hostname, port: this.port });
      const done = (up) => {
        socket.destroy();
        resolve(up);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }

  /**
   * Starts the IDE (ARDUINO_AGENT_PATH) and waits until its MCP server answers.
   * Concurrent callers share one launch. Resolves {ok} or {ok:false, reason}.
   */
  launchAndWait(onWaiting) {
    if (!this.pendingLaunch) {
      this.pendingLaunch = this.launchAndWaitOnce(onWaiting).finally(() => {
        this.pendingLaunch = null;
      });
    }
    return this.pendingLaunch;
  }

  async launchAndWaitOnce(onWaiting) {
    const exe = resolveAgentExecutable(process.env.ARDUINO_AGENT_PATH);
    if (this.launchGaveUp) {
      return {
        ok: false,
        reason:
          'it was already started once and its MCP server never answered - check that ' +
          'the MCP server is enabled in the IDE preferences (arduino.mcp.enabled / autoConnect)',
      };
    }
    let spawnError = null;
    try {
      const child = spawn(exe, [], {
        cwd: path.dirname(exe),
        detached: true,
        stdio: 'ignore',
      });
      // A missing or non-executable path is reported asynchronously.
      child.once('error', (err) => {
        spawnError = err;
      });
      child.unref();
      warn(`starting Open Duino: ${exe}`);
    } catch (err) {
      spawnError = err;
    }

    const started = Date.now();
    while (Date.now() - started < LAUNCH_TIMEOUT_MS) {
      if (spawnError) {
        return { ok: false, reason: `could not start ${exe}: ${spawnError.message}` };
      }
      if (await this.probe()) return { ok: true };
      if (onWaiting) onWaiting(Date.now() - started);
      await sleep(LAUNCH_POLL_MS);
    }
    this.launchGaveUp = true;
    return {
      ok: false,
      reason:
        `started ${exe}, but its MCP server did not answer within ` +
        `${LAUNCH_TIMEOUT_MS / 1000}s - check that the MCP server is enabled in the IDE preferences`,
    };
  }
}

function isOffline(err) {
  return (
    err &&
    ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(
      err.code
    )
  );
}

/** Handles both plain JSON and SSE-framed (`data:`) response bodies. */
function parseBody(raw) {
  const text = raw.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  const dataLines = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i]);
    } catch {
      // keep looking for the last well-formed data frame
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offline answers (from the compiled extension)
// ---------------------------------------------------------------------------

/** The IDE's tool mode as persisted in its preferences (what it will serve on start). */
function toolMode() {
  try {
    const text = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const match = /"arduino\.mcp\.toolMode"\s*:\s*"(router|direct)"/.exec(text);
    if (match) return match[1];
  } catch {
    // no settings yet: the IDE default applies
  }
  return 'router';
}

/** Same shape as the server's tools/list entries. */
function toTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

/** Tools to advertise while the IDE is unreachable. */
function offlineTools() {
  if (upstreamTools) return upstreamTools;
  const defs = toolMode() === 'direct' ? toolDefs?.ARDUINO_TOOLS : router?.ROUTER_TOOLS;
  return Array.isArray(defs) ? defs.map(toTool) : [];
}

function canAnswerLocally(name) {
  return (
    Array.isArray(router?.ROUTER_DISCOVERY_TOOLS) &&
    router.ROUTER_DISCOVERY_TOOLS.includes(name) &&
    typeof router.runRouterDiscoveryTool === 'function'
  );
}

/** Answers a read-only router tool exactly as the server would. */
function answerLocally(id, name, args) {
  try {
    const result = router.runRouterDiscoveryTool(name, args);
    respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (err) {
    respond(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
      isError: true,
    });
  }
}

function offlinePrompts() {
  const prompts = Array.isArray(promptDefs?.MCP_PROMPTS) ? promptDefs.MCP_PROMPTS : [];
  return prompts.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
}

function offlinePrompt(id, params) {
  const prompt =
    typeof promptDefs?.findPrompt === 'function' ? promptDefs.findPrompt(params?.name) : null;
  if (!prompt) {
    return respondError(
      id,
      -32602,
      promptDefs ? `Unknown prompt: ${params?.name}` : offlineMessage()
    );
  }
  respond(id, {
    description: prompt.description,
    messages: [
      { role: 'user', content: { type: 'text', text: prompt.build(params?.arguments ?? {}) } },
    ],
  });
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

const upstream = new Upstream(ENDPOINT);
// The IDE's own tool list, once it has been seen by this bridge.
let upstreamTools = null;
// JSON of the tool list last sent to the client (null: the client never asked).
let advertised = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** A tool result carrying an error, rather than a protocol-level failure. */
function toolError(id, text) {
  respond(id, { content: [{ type: 'text', text }], isError: true });
}

function relay(id, response) {
  if (!response) return respond(id, {});
  if (response.error) return respondError(id, response.error.code, response.error.message);
  return respond(id, response.result ?? {});
}

async function listTools(id, msg) {
  let tools = null;
  try {
    const response = await upstream.send(msg, QUICK_REQUEST_TIMEOUT_MS);
    if (Array.isArray(response?.result?.tools)) {
      tools = response.result.tools;
      upstreamTools = tools;
    }
  } catch (err) {
    log(`tools/list upstream failure: ${err.message}`);
  }
  if (!tools) tools = offlineTools();
  advertised = JSON.stringify(tools);
  respond(id, { tools });
}

async function callTool(id, msg) {
  const name = msg.params?.name;
  try {
    return relay(id, await upstream.send(msg));
  } catch (err) {
    if (!(err.offline || isOffline(err))) return toolError(id, upstreamErrorMessage(err));
    log(`tools/call ${name}: IDE not reachable (${err.message})`);
  }

  // The IDE is not running.
  if (canAnswerLocally(name)) return answerLocally(id, name, msg.params?.arguments);
  if (!process.env.ARDUINO_AGENT_PATH) return toolError(id, offlineMessage());

  const progressToken = msg.params?._meta?.progressToken;
  const onWaiting =
    progressToken === undefined
      ? null
      : (elapsedMs) =>
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: Math.round(elapsedMs / 1000),
              total: LAUNCH_TIMEOUT_MS / 1000,
              message: 'Starting Open Duino...',
            },
          });
  const launch = await upstream.launchAndWait(onWaiting);
  if (!launch.ok) return toolError(id, offlineMessage(`Tried to start it: ${launch.reason}`));

  try {
    return relay(id, await upstream.send(msg));
  } catch (err) {
    return toolError(
      id,
      err.offline || isOffline(err) ? offlineMessage(err.message) : upstreamErrorMessage(err)
    );
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  // Answer the handshake locally so the client always connects, even with no
  // IDE running. Tool discovery happens separately via tools/list.
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, prompts: {} },
      serverInfo: { name: 'arduino-agent-bridge', version: BRIDGE_VERSION },
      instructions: INSTRUCTIONS,
    });
    // Warm the upstream session in the background; ignore failures.
    upstream.ensureSession().catch(() => undefined);
    startWatcher();
    return;
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return; // nothing to do, and notifications take no response
  }

  if (method === 'ping') {
    if (!isNotification) respond(id, {});
    return;
  }

  if (method === 'tools/list' && !isNotification) return listTools(id, msg);
  if (method === 'tools/call' && !isNotification) return callTool(id, msg);

  try {
    const response = await upstream.send(msg, QUICK_REQUEST_TIMEOUT_MS);
    if (isNotification) return;
    return relay(id, response);
  } catch (err) {
    const offline = err.offline || isOffline(err);
    log(`upstream failure on ${method}: ${err.message}`);
    if (isNotification) return;

    if (!offline) return respondError(id, -32603, upstreamErrorMessage(err));

    // The IDE is down. Degrade gracefully instead of failing the connection.
    if (method === 'prompts/list') return respond(id, { prompts: offlinePrompts() });
    if (method === 'prompts/get') return offlinePrompt(id, params);
    if (method === 'resources/list') return respond(id, { resources: [] });
    if (method === 'resources/templates/list') return respond(id, { resourceTemplates: [] });
    if (method === 'logging/setLevel') return respond(id, {});
    return respondError(id, -32603, offlineMessage());
  }
}

// ---------------------------------------------------------------------------
// Watcher: notice the IDE coming up (or restarting) without any client request
// ---------------------------------------------------------------------------

let watcher = null;
let watching = false;

function startWatcher() {
  if (watcher) return;
  watcher = setInterval(() => {
    if (watching) return;
    watching = true;
    watchTick()
      .catch((err) => log(`watch: ${err.message}`))
      .finally(() => {
        watching = false;
      });
  }, WATCH_INTERVAL_MS);
  watcher.unref();
}

async function watchTick() {
  if (!(await upstream.probe())) {
    // Gone: the next start is a new server with a new session and token.
    if (upstream.online) upstream.markOffline();
    return;
  }
  if (upstream.online) return; // already connected and current

  const response = await upstream.send(
    { jsonrpc: '2.0', id: `bridge-watch-${Date.now()}`, method: 'tools/list' },
    QUICK_REQUEST_TIMEOUT_MS
  );
  const tools = response?.result?.tools;
  if (!Array.isArray(tools)) return;
  upstreamTools = tools;
  log('Open Duino is up');
  if (advertised !== null && JSON.stringify(tools) !== advertised) {
    advertised = JSON.stringify(tools);
    log('tool list changed; notifying client');
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
}

// ---------------------------------------------------------------------------
// stdio plumbing: newline-delimited JSON-RPC
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      warn(`ignoring malformed JSON-RPC line: ${err.message}`);
      continue;
    }
    // Each message is handled independently; a failure must never kill the loop.
    Promise.resolve()
      .then(() => handle(msg))
      .catch((err) => {
        warn(`unhandled error: ${err.stack || err.message}`);
        if (msg && msg.id !== undefined && msg.id !== null) {
          respondError(msg.id, -32603, `Open Duino bridge error: ${err.message}`);
        }
      });
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (err) => warn(`uncaught: ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => warn(`unhandled rejection: ${err}`));

log(`bridge ${BRIDGE_VERSION} ready; upstream ${ENDPOINT}`);
