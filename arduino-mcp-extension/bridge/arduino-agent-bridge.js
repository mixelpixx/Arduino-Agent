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
 * so connecting always succeeds. It forwards requests to the IDE when it is up,
 * and when it is not it answers tool calls with a plain, actionable error
 * ("Arduino Agent is not running - launch the IDE") instead of dropping the
 * connection. When the IDE starts or restarts later, the bridge reconnects on
 * the next request with no client restart required.
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
 *   ARDUINO_MCP_URL     Full URL of the MCP endpoint (default http://127.0.0.1:3847/mcp)
 *   ARDUINO_MCP_TOKEN   Auth token (default: read from ~/.arduinoIDE/mcp-token)
 *   ARDUINO_AGENT_PATH  Path to the IDE executable; enables auto-launch on first
 *                       tool call when the IDE is not running. Opt-in: unset
 *                       means the bridge never starts anything.
 *   ARDUINO_MCP_DEBUG   Set to 1 for verbose logging on stderr.
 *
 * NOTE: stdout carries the JSON-RPC stream and nothing else. All diagnostics go
 * to stderr, or they would corrupt the protocol.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2024-11-05';
const BRIDGE_VERSION = '0.2.0';
const ENDPOINT = process.env.ARDUINO_MCP_URL || 'http://127.0.0.1:3847/mcp';
const TOKEN_FILE = path.join(os.homedir(), '.arduinoIDE', 'mcp-token');
const DEBUG = process.env.ARDUINO_MCP_DEBUG === '1';
// Don't respawn the IDE on every call while it is still starting up.
const LAUNCH_COOLDOWN_MS = 60_000;

/**
 * Server instructions surfaced in the bridge's locally-answered initialize
 * (the bridge must answer even when the IDE is closed). The compiled
 * extension is the source of truth; the embedded string below is only the
 * fallback for unbuilt checkouts.
 *
 * KEEP IN SYNC with src/common/mcp-instructions.ts - the manual smoke test
 * compares the bridge's initialize.instructions with the HTTP server's.
 */
const FALLBACK_INSTRUCTIONS = `Arduino Agent - an Arduino IDE with this MCP server embedded. You share one editor, one board and one serial monitor with the user; prefer these tools over asking the user to click in the IDE.

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

function loadInstructions() {
  try {
    // Prefer the compiled extension next to this file (source of truth).
    // eslint-disable-next-line global-require
    const mod = require(path.join(
      __dirname,
      '..',
      'lib',
      'common',
      'mcp-instructions'
    ));
    if (mod && typeof mod.MCP_SERVER_INSTRUCTIONS === 'string') {
      return mod.MCP_SERVER_INSTRUCTIONS;
    }
  } catch {
    // Unbuilt checkout - use the embedded copy.
  }
  return FALLBACK_INSTRUCTIONS;
}
const INSTRUCTIONS = loadInstructions();

function log(...args) {
  if (DEBUG) console.error('[arduino-bridge]', ...args);
}

function warn(...args) {
  console.error('[arduino-bridge]', ...args);
}

/** The message shown when the IDE is not reachable. */
function offlineMessage(detail) {
  return (
    'Arduino Agent is not running, so the Arduino tools are unavailable.\n\n' +
    'Launch the Arduino Agent IDE and try again - the connection recovers ' +
    'automatically, there is no need to restart this client.\n\n' +
    (detail ? `(details: ${detail})` : '')
  ).trim();
}

// ---------------------------------------------------------------------------
// Upstream (Streamable HTTP) client
// ---------------------------------------------------------------------------

class Upstream {
  constructor(endpoint) {
    this.url = new URL(endpoint);
    this.transport = this.url.protocol === 'https:' ? https : http;
    this.sessionId = null;
    this.initialized = false;
    this.lastLaunchAttempt = 0;
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

  /** Raw JSON-RPC POST. Resolves with the parsed body (or null for 202s). */
  request(body) {
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
            if (res.statusCode === 404 || res.statusCode === 401) {
              // Session expired or token rotated (IDE restarted): re-handshake.
              this.reset();
              return reject(
                Object.assign(new Error(`upstream status ${res.statusCode}`), {
                  retryable: true,
                })
              );
            }
            if (!raw.trim()) return resolve(null);
            resolve(parseBody(raw));
          });
        }
      );
      req.on('error', (err) =>
        reject(Object.assign(err, { offline: isOffline(err) }))
      );
      req.write(data);
      req.end();
    });
  }

  reset() {
    this.sessionId = null;
    this.initialized = false;
  }

  /** Performs the MCP handshake if it has not been done for this session. */
  async ensureSession() {
    if (this.initialized) return;
    await this.request({
      jsonrpc: '2.0',
      id: `bridge-init-${Date.now()}`,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'arduino-agent-bridge', version: BRIDGE_VERSION },
      },
    });
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
    log('upstream session established', this.sessionId || '(no session id)');
  }

  /** Handshake + send, retrying once if the session went stale. */
  async send(body) {
    try {
      await this.ensureSession();
      return await this.request(body);
    } catch (err) {
      if (err && err.retryable) {
        log('retrying after stale session');
        await this.ensureSession();
        return await this.request(body);
      }
      throw err;
    }
  }

  /**
   * Best-effort launch of the IDE, only when ARDUINO_AGENT_PATH is set.
   * Fire-and-forget: the caller still reports "not running" for this call.
   */
  maybeLaunchIde() {
    const exe = process.env.ARDUINO_AGENT_PATH;
    if (!exe) return false;
    const now = Date.now();
    if (now - this.lastLaunchAttempt < LAUNCH_COOLDOWN_MS) return false;
    this.lastLaunchAttempt = now;
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
      child.unref();
      warn(`launching Arduino Agent: ${exe}`);
      return true;
    } catch (err) {
      warn(`failed to launch ${exe}: ${err.message}`);
      return false;
    }
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
// Bridge
// ---------------------------------------------------------------------------

const upstream = new Upstream(ENDPOINT);
// Remembered from the last successful tools/list so the client still sees a
// sensible tool list while the IDE is closed.
let cachedTools = null;

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
    return;
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return; // nothing to do, and notifications take no response
  }

  if (method === 'ping') {
    if (!isNotification) respond(id, {});
    return;
  }

  try {
    const response = await upstream.send(msg);
    if (isNotification) return;
    if (!response) return respond(id, {});

    if (method === 'tools/list' && response.result && response.result.tools) {
      cachedTools = response.result.tools;
    }
    if (response.error) return respondError(id, response.error.code, response.error.message);
    return respond(id, response.result ?? {});
  } catch (err) {
    const offline = err.offline || isOffline(err);
    log(`upstream failure on ${method}: ${err.message}`);
    if (isNotification) return;

    if (!offline) {
      return respondError(id, -32603, `Arduino Agent bridge error: ${err.message}`);
    }

    // The IDE is down. Degrade gracefully instead of failing the connection.
    if (method === 'tools/list') {
      // Advertise the tools we saw last time so the client keeps working;
      // calling one returns the friendly error below.
      return respond(id, { tools: cachedTools || [] });
    }
    if (method === 'tools/call') {
      const launched = upstream.maybeLaunchIde();
      return toolError(
        id,
        offlineMessage(
          launched ? 'starting Arduino Agent now - retry in a few seconds' : null
        )
      );
    }
    if (method === 'resources/list') return respond(id, { resources: [] });
    if (method === 'prompts/list') return respond(id, { prompts: [] });
    if (method === 'prompts/get') {
      return respondError(id, -32601, offlineMessage());
    }
    return respondError(id, -32603, offlineMessage());
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
          respondError(msg.id, -32603, `Arduino Agent bridge error: ${err.message}`);
        }
      });
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (err) => warn(`uncaught: ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => warn(`unhandled rejection: ${err}`));

log(`bridge ${BRIDGE_VERSION} ready; upstream ${ENDPOINT}`);
