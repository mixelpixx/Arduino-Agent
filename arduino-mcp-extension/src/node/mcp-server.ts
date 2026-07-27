/**
 * Arduino MCP Server - Embedded HTTP Implementation
 *
 * This is the MCP server embedded directly in the Arduino IDE backend.
 * It supports both the modern Streamable HTTP transport (`/mcp`) and the
 * legacy HTTP+SSE transport (`/sse` + `/message`) with multiple concurrent
 * client sessions.
 *
 * Architecture:
 *   MCP Client (Claude Code, ...)
 *          | HTTP (Streamable or SSE), Bearer-token auth
 *   Arduino IDE Backend (this server)
 *          | DI child container (see mcp-arduino-services.ts)
 *   Arduino Services (Sketches, Core, Boards, Library, Monitor, Formatter, Config)
 *
 * Security model:
 * - Binds to 127.0.0.1 only.
 * - Requires a bearer token (generated once, stored in ~/.arduinoIDE/mcp-token)
 *   unless authentication is explicitly disabled.
 * - Rejects requests carrying a browser `Origin` header to prevent drive-by
 *   access from web pages, and sends no CORS headers.
 * - File access is restricted to the sketchbook, the built-in examples, and
 *   the temp directory (temporary sketches) unless explicitly overridden with
 *   the ARDUINO_MCP_UNRESTRICTED_FS=1 environment variable.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ARDUINO_TOOLS,
  SERIAL_BAUD_RATES,
  ToolDefinition,
} from '../common/mcp-tools';
import { MCP_SERVER_INSTRUCTIONS } from '../common/mcp-instructions';
import { MCP_PROMPTS, findPrompt } from '../common/mcp-prompts';
import { Task } from '../common/mcp-types';
import {
  MCPStatus,
  MCPFileChangeEvent,
  MCPIDEState,
} from '../common/mcp-service';
import {
  ROUTER_TOOLS,
  listToolCategories,
  getCategoryTools,
  searchTools,
  toolExists,
} from '../common/mcp-tool-router';
import {
  MCPArduinoServices,
  MCPArduinoServicesProvider,
} from './mcp-arduino-services';
import { MCPSerialManager } from './mcp-serial-manager';
import { mcpLog } from './mcp-logger';
import { CoreError } from 'arduino-ide-extension/lib/common/protocol/core-service';
import type { Sketch } from 'arduino-ide-extension/lib/common/protocol/sketches-service';

// Single source of truth for the extension version (lib/node -> package root).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const EXTENSION_VERSION: string = require('../../package.json').version;

const DEFAULT_PORT = 3847;
const MAX_TASKS = 100;
const SKETCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Bounds for the `wait`/`timeout_seconds` option on compile/upload/task_status.
// The default stays well under typical MCP client per-call timeouts; a timeout
// returns current progress (not an error), so callers can simply re-wait.
const TASK_WAIT_DEFAULT_SECONDS = 60;
const TASK_WAIT_MIN_SECONDS = 5;
const TASK_WAIT_MAX_SECONDS = 600;

function clampTaskTimeout(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value)) {
    return TASK_WAIT_DEFAULT_SECONDS;
  }
  return Math.min(
    TASK_WAIT_MAX_SECONDS,
    Math.max(TASK_WAIT_MIN_SECONDS, value)
  );
}

// Serial wait_for holds an MCP request open, so its ceiling is deliberately
// lower than task waits - long serial vigils should be re-issued.
const SERIAL_WAIT_DEFAULT_SECONDS = 30;
const SERIAL_WAIT_MIN_SECONDS = 1;
const SERIAL_WAIT_MAX_SECONDS = 120;

function clampSerialWaitTimeout(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value)) {
    return SERIAL_WAIT_DEFAULT_SECONDS;
  }
  return Math.min(
    SERIAL_WAIT_MAX_SECONDS,
    Math.max(SERIAL_WAIT_MIN_SECONDS, value)
  );
}

interface StructuredBuildError {
  message: string;
  file?: string;
  line?: number;
  details?: string;
}

interface ErrorExplanation {
  pattern: RegExp;
  explanation: string;
  suggestion: string;
}

/** Common compiler diagnostics with beginner-friendly explanations. */
const COMPILE_ERROR_PATTERNS: ErrorExplanation[] = [
  {
    pattern: /was not declared in this scope/i,
    explanation:
      'The variable or function name is not recognized. It might be misspelled or not defined.',
    suggestion:
      'Check spelling. Make sure the variable is declared before use, or include the necessary library.',
  },
  {
    pattern: /expected ';' before/i,
    explanation: 'A semicolon is missing at the end of a statement.',
    suggestion: 'Add a semicolon (;) at the end of the previous line.',
  },
  {
    pattern: /expected '\)' before/i,
    explanation: 'A closing parenthesis is missing.',
    suggestion:
      'Check that all opening parentheses ( have matching closing parentheses ).',
  },
  {
    pattern: /'(\w+)' does not name a type/i,
    explanation: "The compiler doesn't recognize this as a valid type.",
    suggestion:
      'Check spelling, or include the library that defines this type.',
  },
  {
    pattern: /no matching function for call to/i,
    explanation: 'The function is being called with wrong arguments.',
    suggestion: 'Check the function documentation for correct parameter types.',
  },
  {
    pattern: /undefined reference to/i,
    explanation:
      'A function or variable is declared but its implementation cannot be found.',
    suggestion:
      'Make sure the library that implements it is installed and included.',
  },
];

/**
 * esptool/avrdude/serial failure signatures. These messages are about
 * hardware, ports and bootloaders - more confusing than compiler errors, and
 * previously returned raw. Ordering matters: specific patterns first, the
 * generic esptool "A fatal error occurred" last.
 */
const UPLOAD_ERROR_PATTERNS: ErrorExplanation[] = [
  {
    pattern: /Failed to connect to ESP32[^:]*: No serial data received/i,
    explanation:
      'esptool could not talk to the chip over this port - the chip never entered its download mode.',
    suggestion:
      'On boards with native USB (ESP32-S2/S3/C3), uploads are far more reliable over the UART/bridge port if the board has one. Otherwise hold BOOT, press and release RESET, release BOOT, then retry. Also confirm the port is the right one (arduino_board list_connected).',
  },
  {
    pattern: /Wrong boot mode detected/i,
    explanation:
      'The chip is running its application instead of the serial bootloader.',
    suggestion:
      'Hold BOOT while pressing RESET to force download mode, then retry the upload.',
  },
  {
    pattern: /This chip is (ESP32\S*),? not/i,
    explanation:
      'The selected board (FQBN) does not match the chip actually connected.',
    suggestion:
      'Pick the FQBN for the detected chip - arduino_board suggest_fqbn can identify it from the port.',
  },
  {
    pattern:
      /(could not open (?:port )?COM\d+|could not open port|Access is denied|Resource busy|port is busy|PermissionError)/i,
    explanation:
      'The serial port could not be opened - it is either in use by another program or does not exist.',
    suggestion:
      'Disconnect the serial monitor (arduino_serial disconnect) and close other apps using the port. If that does not help, re-run arduino_board list_connected to confirm the port name - native-USB boards re-enumerate after reset.',
  },
  {
    pattern: /Permission denied.*(tty|dev\/)/i,
    explanation: 'The current user is not allowed to open the serial device.',
    suggestion:
      'On Linux, add your user to the dialout group (sudo usermod -aG dialout $USER) and log in again.',
  },
  {
    pattern:
      /(no such file or directory.*(COM|tty)|port .*not found|could not find)/i,
    explanation: 'The serial port does not exist (anymore).',
    suggestion:
      'Native-USB boards re-enumerate after reset and can change port. Re-run arduino_board list_connected and use the port it reports now.',
  },
  {
    pattern: /avrdude.*(not in sync|stk500\w*_recv|programmer is not responding)/i,
    explanation:
      'The AVR bootloader did not answer - usually wrong port, wrong board selection, or the bootloader is not running.',
    suggestion:
      'Verify the port and FQBN. On boards without auto-reset, press RESET just as the upload starts.',
  },
  {
    pattern: /Brownout/i,
    explanation:
      'The chip browned out - its supply voltage dipped during the operation.',
    suggestion:
      'Use a better USB cable/port or a powered hub; avoid powering heavy loads from the board while flashing.',
  },
  {
    pattern: /Timed out waiting for packet/i,
    explanation: 'The connection to the chip dropped mid-transfer.',
    suggestion:
      'Retry. If it persists, use a shorter/better USB cable and avoid hubs.',
  },
  {
    pattern: /A fatal error occurred/i,
    explanation: 'esptool aborted the flash operation.',
    suggestion:
      'Read the message after "A fatal error occurred:" - it names the specific failure. Check port, cable, and bootloader mode, then retry.',
  },
];

interface UsbVidFamily {
  vendor: string;
  /** native = the MCU itself is on USB; bridge = a USB-UART adapter chip. */
  kind: 'native' | 'bridge';
  hint: string;
  /** For native vendors: plausible FQBNs when nothing else identifies the board. */
  fqbnCandidates?: Array<{ fqbn: string; name: string }>;
}

/**
 * Well-known USB vendor IDs (lowercase hex, no 0x). A bridge VID identifies
 * the adapter chip, NOT the microcontroller - a CH340 tells you nothing about
 * which board is behind it. Many boards (e.g. most ESP32-S3 devkits) expose
 * USB PIDs that appear in no boards.txt, so they can NEVER be auto-identified;
 * this table lets suggest_fqbn escape that dead end.
 */
const USB_VID_FAMILIES: Record<string, UsbVidFamily> = {
  '303a': {
    vendor: 'Espressif',
    kind: 'native',
    hint: 'Native USB on an ESP32-S2/S3/C3/C6-class chip. The USB PID alone cannot distinguish the variant - check the product name or silkscreen.',
    fqbnCandidates: [
      { fqbn: 'esp32:esp32:esp32s3', name: 'ESP32S3 Dev Module' },
      { fqbn: 'esp32:esp32:esp32s2', name: 'ESP32S2 Dev Module' },
      { fqbn: 'esp32:esp32:esp32c3', name: 'ESP32C3 Dev Module' },
      { fqbn: 'esp32:esp32:esp32c6', name: 'ESP32C6 Dev Module' },
    ],
  },
  '2341': {
    vendor: 'Arduino SA',
    kind: 'native',
    hint: 'Official Arduino board; the USB PID identifies the model, so arduino-cli usually auto-identifies it once the core is installed.',
  },
  '2e8a': {
    vendor: 'Raspberry Pi',
    kind: 'native',
    hint: 'RP2040/RP2350-class board (e.g. Pico) on native USB.',
    fqbnCandidates: [
      { fqbn: 'rp2040:rp2040:rpipico', name: 'Raspberry Pi Pico' },
      { fqbn: 'arduino:mbed_rp2040:pico', name: 'Raspberry Pi Pico (Arduino Mbed OS)' },
    ],
  },
  '1a86': {
    vendor: 'WCH',
    kind: 'bridge',
    hint: 'CH34x USB-UART bridge - identifies the adapter, not the MCU. Common on ESP32/ESP8266/AVR clone boards; identify the board by name instead.',
  },
  '10c4': {
    vendor: 'Silicon Labs',
    kind: 'bridge',
    hint: 'CP210x USB-UART bridge - identifies the adapter, not the MCU. Very common on ESP32 devkits.',
  },
  '0403': {
    vendor: 'FTDI',
    kind: 'bridge',
    hint: 'FTDI USB-UART bridge - identifies the adapter, not the MCU.',
  },
};

/** Lowercased alphanumeric tokens for fuzzy board-name matching. */
function nameTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Filler words in board names that should not count against a match:
 * "ESP32S3 Dev Module" is the generic board for a bare "esp32 s3" query and
 * must not lose to "ESP32-S3-Box" just because "Box" is one token shorter.
 */
const GENERIC_NAME_TOKENS = new Set([
  'dev',
  'module',
  'board',
  'devkit',
  'devkitc',
  'kit',
  'generic',
]);

/**
 * 0..1 similarity between a query and a candidate board name. Token overlap
 * with fused-token handling ("esp32 s3" matches the single token "esp32s3"),
 * then a small penalty per distinctive extra token so specialized boards rank
 * below the generic one for a generic query.
 */
function scoreNameMatch(query: string, candidate: string): number {
  const queryTokens = nameTokens(query);
  if (!queryTokens.length) {
    return 0;
  }
  const candidateTokens = nameTokens(candidate);
  const candidateSet = new Set(candidateTokens);
  const queryJoined = queryTokens.join('');

  let hits = 0;
  for (const token of queryTokens) {
    if (candidateSet.has(token)) {
      hits++;
    }
  }
  let base = hits / queryTokens.length;
  if (base < 1 && candidateSet.has(queryJoined)) {
    base = 1; // whole query fused into one candidate token
  }
  if (base < 1 && candidateTokens.join('').includes(queryJoined)) {
    base = Math.max(base, 0.95);
  }

  const extras = candidateTokens.filter(
    (t) =>
      !GENERIC_NAME_TOKENS.has(t) &&
      !queryTokens.includes(t) &&
      !queryJoined.includes(t)
  ).length;
  return Math.max(0, base - 0.03 * extras);
}

interface BuildRecord {
  tool: 'compile' | 'upload';
  stdout: string;
  stderr: string;
  errors: StructuredBuildError[];
  timestamp: number;
}

// ============================================================
// MCP SERVER
// ============================================================

@injectable()
export class ArduinoMCPServer {
  @inject(MCPArduinoServicesProvider)
  private readonly servicesProvider!: MCPArduinoServicesProvider;

  private httpServer: http.Server | null = null;
  private isRunning = false;
  private port = DEFAULT_PORT;
  private startTime = 0;

  // Auth
  private requireAuth = true;
  private authToken: string | null = null;

  // Active client sessions (multiple concurrent clients supported)
  private readonly sseTransports = new Map<string, SSEServerTransport>();
  private readonly streamableTransports = new Map<
    string,
    StreamableHTTPServerTransport
  >();

  // Task management for async operations
  private readonly tasks = new Map<string, Task>();
  // Completion promises so `wait` callers can block on a running task.
  private readonly taskPromises = new Map<string, Promise<void>>();
  private taskCounter = 0;

  // State tracking
  private lastBuild: BuildRecord | null = null;
  private currentSketch: Sketch | null = null; // sketch opened via MCP (overrides IDE state)
  private ideState: MCPIDEState = {}; // pushed from the frontend
  private sessionBoard: { fqbn?: string; port?: string } = {}; // set via board select

  private serialManager: MCPSerialManager | null = null;

  // Callback for file change notifications (real-time sync)
  private fileChangeCallback: ((event: MCPFileChangeEvent) => void) | null =
    null;

  /**
   * Whether to use router pattern (4 meta-tools) or direct mode (all tools).
   * Router pattern is recommended to reduce context window usage.
   */
  private useRouterMode = true;

  private servicesCache: MCPArduinoServices | null = null;

  private get services(): MCPArduinoServices {
    if (!this.servicesCache) {
      this.servicesCache = this.servicesProvider();
      this.serialManager = new MCPSerialManager(
        () => this.servicesCache!.monitorManager,
        () => this.servicesCache!.boardsService
      );
    }
    return this.servicesCache;
  }

  private get serial(): MCPSerialManager {
    // Accessing `services` lazily initializes the serial manager.
    void this.services;
    return this.serialManager!;
  }

  // ============================================================
  // STATUS / LIFECYCLE
  // ============================================================

  getStatus(): MCPStatus {
    return {
      enabled: this.isRunning,
      running: this.isRunning,
      port: this.port,
      connectedClients:
        this.sseTransports.size + this.streamableTransports.size,
      uptime: this.isRunning
        ? Math.floor((Date.now() - this.startTime) / 1000)
        : 0,
      authRequired: this.requireAuth,
    };
  }

  async start(port?: number): Promise<void> {
    if (this.isRunning) {
      mcpLog.info('MCP Server already running');
      return;
    }

    this.port =
      port ??
      parseInt(process.env.ARDUINO_MCP_PORT || String(DEFAULT_PORT), 10);
    this.initAuth();

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error) => {
        mcpLog.error('Unhandled HTTP error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          mcpLog.error(
            `Port ${this.port} is in use. Change the arduino.mcp.port preference or set the ARDUINO_MCP_PORT env var.`
          );
        }
        reject(err);
      });

      this.httpServer!.listen(this.port, '127.0.0.1', () => {
        this.isRunning = true;
        this.startTime = Date.now();
        mcpLog.info(
          `MCP Server listening on http://127.0.0.1:${this.port} (auth: ${
            this.requireAuth ? 'required' : 'DISABLED'
          })`
        );
        mcpLog.info('Claude Code config:\n' + this.buildClientConfig());
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const transport of this.sseTransports.values()) {
      await transport.close().catch(() => undefined);
    }
    this.sseTransports.clear();
    for (const transport of this.streamableTransports.values()) {
      await transport.close().catch(() => undefined);
    }
    this.streamableTransports.clear();
    await this.serialManager?.disconnect().catch(() => undefined);

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.isRunning = false;
          mcpLog.info('MCP Server stopped');
          resolve();
        });
      } else {
        this.isRunning = false;
        resolve();
      }
    });
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  getPort(): number {
    return this.port;
  }

  setToolMode(mode: 'router' | 'direct'): void {
    this.useRouterMode = mode === 'router';
    mcpLog.info(`Tool mode set to: ${mode}`);
  }

  setRequireAuth(required: boolean): void {
    this.requireAuth = required;
    if (this.isRunning) {
      mcpLog.info(`Authentication ${required ? 'enabled' : 'DISABLED'}`);
    }
  }

  setIDEState(state: MCPIDEState): void {
    this.ideState = state ?? {};
    mcpLog.debug('IDE state updated:', this.ideState);
  }

  setCurrentSketch(sketch: Sketch | null): void {
    this.currentSketch = sketch;
  }

  setFileChangeCallback(
    callback: ((event: MCPFileChangeEvent) => void) | null
  ): void {
    this.fileChangeCallback = callback;
  }

  /**
   * A ready-to-paste MCP client configuration snippet.
   */
  buildClientConfig(): string {
    const server: Record<string, unknown> = {
      type: 'http',
      url: `http://127.0.0.1:${this.port}/mcp`,
    };
    if (this.requireAuth && this.authToken) {
      server.headers = { Authorization: `Bearer ${this.authToken}` };
    }
    return JSON.stringify({ mcpServers: { arduino: server } }, null, 2);
  }

  getAuthToken(): string | null {
    return this.requireAuth ? this.authToken : null;
  }

  // ============================================================
  // AUTH
  // ============================================================

  private initAuth(): void {
    if (process.env.ARDUINO_MCP_NO_AUTH === '1') {
      this.requireAuth = false;
      return;
    }
    if (this.authToken) {
      return;
    }
    const envToken = process.env.ARDUINO_MCP_TOKEN;
    if (envToken) {
      this.authToken = envToken.trim();
      return;
    }
    const tokenFile = path.join(os.homedir(), '.arduinoIDE', 'mcp-token');
    try {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (/^[A-Za-z0-9_-]{16,}$/.test(existing)) {
        this.authToken = existing;
        return;
      }
    } catch {
      // fall through and generate a new token
    }
    this.authToken = crypto.randomBytes(24).toString('base64url');
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, this.authToken, { mode: 0o600 });
    } catch (error) {
      mcpLog.error(
        'Could not persist the MCP auth token; a new one will be generated on each start:',
        error
      );
    }
  }

  private tokenMatches(candidate: string | null | undefined): boolean {
    if (!candidate || !this.authToken) {
      return false;
    }
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.authToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    if (!this.requireAuth) {
      return true;
    }
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ') && this.tokenMatches(header.slice(7))) {
      return true;
    }
    // Fallback for clients that cannot set headers (e.g. EventSource).
    if (this.tokenMatches(url.searchParams.get('token'))) {
      return true;
    }
    return false;
  }

  // ============================================================
  // HTTP HANDLING
  // ============================================================

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);

    // Reject anything that comes from a browser page. The MCP server is a
    // local-client API; web pages have no business calling it, and answering
    // them (or preflight) would enable drive-by access. No CORS headers are sent.
    if (req.headers.origin !== undefined || req.method === 'OPTIONS') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Browser-originated requests are not allowed' })
      );
      return;
    }

    // Health check endpoint (unauthenticated, intentionally minimal)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          server: 'arduino-ide-mcp',
          version: EXTENSION_VERSION,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          auth: this.requireAuth,
        })
      );
      return;
    }

    if (!this.isAuthorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Unauthorized. Pass the MCP token as an "Authorization: Bearer <token>" header. The token is shown in the Arduino IDE (Preferences > MCP) and stored in ~/.arduinoIDE/mcp-token.',
        })
      );
      return;
    }

    // Streamable HTTP transport (recommended)
    if (url.pathname === '/mcp') {
      await this.handleStreamableRequest(req, res);
      return;
    }

    // Legacy HTTP+SSE transport
    if (url.pathname === '/sse' && req.method === 'GET') {
      await this.handleSSEConnection(req, res);
      return;
    }
    if (url.pathname === '/message' && req.method === 'POST') {
      await this.handleSSEMessage(req, res, url);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleStreamableRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId
      ? this.streamableTransports.get(sessionId)
      : undefined;

    if (!transport) {
      if (sessionId || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown or expired MCP session' }));
        return;
      }
      // New session: must be an initialize request.
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid: string) => {
          this.streamableTransports.set(sid, newTransport);
          mcpLog.info(`Streamable HTTP session initialized: ${sid}`);
        },
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId) {
          this.streamableTransports.delete(newTransport.sessionId);
        }
      };
      const server = this.createMCPServerInstance();
      await server.connect(newTransport);
      transport = newTransport;
    }

    await transport.handleRequest(req, res);
  }

  private async handleSSEConnection(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const transport = new SSEServerTransport('/message', res);
    const server = this.createMCPServerInstance();
    await server.connect(transport);
    this.sseTransports.set(transport.sessionId, transport);
    mcpLog.info(`SSE session established: ${transport.sessionId}`);

    req.on('close', () => {
      mcpLog.info(`SSE session closed: ${transport.sessionId}`);
      this.sseTransports.delete(transport.sessionId);
    });
  }

  private async handleSSEMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const sessionId = url.searchParams.get('sessionId');
    let transport = sessionId ? this.sseTransports.get(sessionId) : undefined;
    if (!transport && !sessionId && this.sseTransports.size === 1) {
      // Backwards compatibility with clients that don't echo the sessionId.
      transport = this.sseTransports.values().next().value;
    }
    if (!transport) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active SSE session for this id' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = body ? JSON.parse(body) : undefined;
        await transport!.handlePostMessage(req, res, parsed);
      } catch (error) {
        mcpLog.error('Error handling message:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });
  }

  // ============================================================
  // MCP PROTOCOL
  // ============================================================

  /**
   * Creates a configured MCP `Server` for one client session.
   * (The SDK pairs one Server instance with one transport.)
   */
  private createMCPServerInstance(): Server {
    const server = new Server(
      { name: 'arduino-ide-mcp', version: EXTENSION_VERSION },
      {
        capabilities: { tools: {}, prompts: {} },
        // Workflow guidance delivered to every client at initialize.
        instructions: MCP_SERVER_INSTRUCTIONS,
      }
    );

    const toTool = (tool: ToolDefinition): Tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema'],
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      mcpLog.debug('tools/list requested');
      const tools = this.useRouterMode ? ROUTER_TOOLS : ARDUINO_TOOLS;
      return { tools: tools.map(toTool) };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: MCP_PROMPTS.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = findPrompt(request.params.name);
      if (!prompt) {
        throw new Error(`Unknown prompt: ${request.params.name}`);
      }
      const args = (request.params.arguments ?? {}) as Record<string, string>;
      return {
        description: prompt.description,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: prompt.build(args) },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      mcpLog.info(`tools/call: ${name}`);

      try {
        let result: unknown;

        if (this.useRouterMode) {
          switch (name) {
            case 'list_tool_categories':
              result = {
                categories: listToolCategories(),
                hint: 'Use get_category_tools with a category name to see detailed tool info',
              };
              break;

            case 'get_category_tools': {
              const category = args?.category as string;
              if (!category) {
                throw new Error('category is required');
              }
              const tools = getCategoryTools(category);
              if (!tools) {
                throw new Error(
                  `Unknown category: ${category}. Use list_tool_categories to see available categories.`
                );
              }
              result = {
                category,
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema.properties,
                  required: t.inputSchema.required || [],
                  annotations: t.annotations,
                })),
                hint: 'Use execute_tool with tool_name and params to execute a tool',
              };
              break;
            }

            case 'execute_tool': {
              const toolName = args?.tool_name as string;
              const params = (args?.params || {}) as Record<string, unknown>;
              if (!toolName) {
                throw new Error('tool_name is required');
              }
              if (!toolExists(toolName)) {
                throw new Error(
                  `Unknown tool: ${toolName}. Use search_tools or get_category_tools to find available tools.`
                );
              }
              result = await this.executeArduinoTool(toolName, params);
              break;
            }

            case 'search_tools': {
              const query = args?.query as string;
              if (!query) {
                throw new Error('query is required');
              }
              const searchResults = searchTools(query);
              result = {
                query,
                results: searchResults,
                count: searchResults.length,
                hint:
                  searchResults.length > 0
                    ? 'Use get_category_tools to see full tool details, or execute_tool to run a tool'
                    : 'No tools found. Try a different search term.',
              };
              break;
            }

            default:
              // Fall through to direct tool execution for backwards compatibility
              result = await this.executeArduinoTool(name, args || {});
          }
        } else {
          result = await this.executeArduinoTool(name, args || {});
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        mcpLog.error(`Tool error (${name}): ${errorMessage}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    });

    return server;
  }

  // ============================================================
  // FILESYSTEM SANDBOX
  // ============================================================

  private toFsPath(input: string): string {
    try {
      return input.startsWith('file:') ? FileUri.fsPath(input) : input;
    } catch {
      throw new Error(`Invalid path or URI: ${input}`);
    }
  }

  private toUriString(input: string): string {
    return input.startsWith('file:')
      ? input
      : FileUri.create(path.resolve(input)).toString();
  }

  private async sandboxRoots(): Promise<{ read: string[]; write: string[] }> {
    const write: string[] = [os.tmpdir()];
    try {
      const state = await this.services.configService.getConfiguration();
      if (state.config?.sketchDirUri) {
        write.push(FileUri.fsPath(state.config.sketchDirUri));
      }
    } catch {
      // configuration not available yet; the sketchbook root is simply absent
    }
    const read = [...write];
    const examples = this.examplesRootPath();
    if (examples) {
      read.push(examples);
    }
    return { read, write };
  }

  private async assertPathAllowed(
    fsPath: string,
    mode: 'read' | 'write'
  ): Promise<string> {
    const resolved = path.resolve(fsPath);
    if (process.env.ARDUINO_MCP_UNRESTRICTED_FS === '1') {
      return resolved;
    }
    const roots = await this.sandboxRoots();
    const allowed = mode === 'write' ? roots.write : roots.read;
    const normalize = (p: string) =>
      process.platform === 'win32' ? p.toLowerCase() : p;
    const target = normalize(resolved);
    for (const root of allowed) {
      const normalizedRoot = normalize(path.resolve(root));
      if (
        target === normalizedRoot ||
        target.startsWith(normalizedRoot + path.sep)
      ) {
        return resolved;
      }
    }
    throw new Error(
      `Access denied: ${fsPath} is outside the sketchbook. MCP file access is restricted to the sketchbook, built-in examples${
        mode === 'read' ? '' : ' (read-only)'
      }, and temporary sketches.`
    );
  }

  private examplesRootPath(): string | null {
    const candidates: string[] = [];
    try {
      const ideExtensionRoot = path.dirname(
        require.resolve('arduino-ide-extension/package.json')
      );
      candidates.push(
        path.join(ideExtensionRoot, 'lib', 'node', 'resources', 'Examples'),
        path.join(ideExtensionRoot, 'Examples')
      );
    } catch {
      // resolution can fail in unusual packagings; fall back to relative lookup
    }
    // Dev layout: this file at arduino-mcp-extension/lib/node, examples in the sibling package.
    candidates.push(
      path.join(
        __dirname,
        '..',
        '..',
        '..',
        'arduino-ide-extension',
        'lib',
        'node',
        'resources',
        'Examples'
      )
    );
    // Bundled (production) layout: everything is webpacked into lib/backend, and the
    // IDE resources are copied to lib/backend/resources. There __dirname is lib/backend.
    candidates.push(
      path.join(__dirname, 'resources', 'Examples'),
      path.join(__dirname, '..', 'backend', 'resources', 'Examples')
    );
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  // ============================================================
  // STATE RESOLUTION (IDE state + MCP overrides)
  // ============================================================

  private async resolveSketch(sketchPathArg?: unknown): Promise<Sketch> {
    if (typeof sketchPathArg === 'string' && sketchPathArg) {
      const fsPath = await this.assertPathAllowed(
        this.toFsPath(sketchPathArg),
        'read'
      );
      return this.services.sketchesService.loadSketch(
        FileUri.create(fsPath).toString()
      );
    }
    if (this.currentSketch) {
      return this.currentSketch;
    }
    if (this.ideState.sketchUri) {
      return this.services.sketchesService.loadSketch(this.ideState.sketchUri);
    }
    throw new Error(
      'No sketch is open. Open a sketch in the IDE, use arduino_sketch open, or pass sketch_path.'
    );
  }

  private resolveFqbn(fqbnArg?: unknown): string {
    const fqbn =
      (typeof fqbnArg === 'string' && fqbnArg) ||
      this.sessionBoard.fqbn ||
      this.ideState.boardFqbn;
    if (!fqbn) {
      throw new Error(
        'No board selected. Select a board in the IDE, use arduino_board select, or pass fqbn (e.g. arduino:avr:uno).'
      );
    }
    return fqbn;
  }

  private resolvePortAddress(portArg?: unknown): string {
    const port =
      (typeof portArg === 'string' && portArg) ||
      this.sessionBoard.port ||
      this.ideState.portAddress;
    if (!port) {
      throw new Error(
        'No port selected. Select a port in the IDE, use arduino_board select, or pass port (e.g. COM3, /dev/ttyUSB0).'
      );
    }
    return port;
  }

  // ============================================================
  // TOOL EXECUTION
  // ============================================================

  private async executeArduinoTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName) {
      // ----------------------------------------------------------
      // SKETCH TOOLS
      // ----------------------------------------------------------
      case 'arduino_sketch': {
        const action = args.action as string;
        switch (action) {
          case 'get_current': {
            if (this.currentSketch) {
              return {
                source: 'mcp',
                name: this.currentSketch.name,
                uri: this.currentSketch.uri,
                mainFileUri: this.currentSketch.mainFileUri,
                otherSketchFileUris: this.currentSketch.otherSketchFileUris,
                additionalFileUris: this.currentSketch.additionalFileUris,
              };
            }
            if (this.ideState.sketchUri) {
              return {
                source: 'ide',
                name: this.ideState.sketchName,
                uri: this.ideState.sketchUri,
              };
            }
            return null;
          }

          case 'get_content': {
            const filePath = args.path as string;
            if (!filePath) throw new Error('path is required');
            const fsPath = await this.assertPathAllowed(
              this.toFsPath(filePath),
              'read'
            );
            const content = await fs.promises.readFile(fsPath, 'utf-8');
            return { content, path: filePath };
          }

          case 'set_content': {
            const filePath = args.path as string;
            const content = args.content as string;
            if (!filePath) throw new Error('path is required');
            if (content === undefined) throw new Error('content is required');
            const fsPath = await this.assertPathAllowed(
              this.toFsPath(filePath),
              'write'
            );

            let fileExists = false;
            try {
              await fs.promises.access(fsPath);
              fileExists = true;
            } catch {
              fileExists = false;
            }

            await fs.promises.writeFile(fsPath, content, 'utf-8');

            this.emitFileChange({
              uri: FileUri.create(fsPath).toString(),
              type: fileExists ? 'modified' : 'created',
              source: 'mcp',
              tool: 'arduino_sketch',
              timestamp: Date.now(),
            });

            return {
              path: filePath,
              bytesWritten: Buffer.byteLength(content, 'utf8'),
            };
          }

          case 'list': {
            const container = await this.services.sketchesService.getSketches(
              {}
            );
            const sketches: Array<{ name: string; uri: string }> = [];
            const collectSketches = (c: {
              sketches: Array<{ name: string; uri: string }>;
              children: unknown[];
            }) => {
              sketches.push(
                ...c.sketches.map((s) => ({ name: s.name, uri: s.uri }))
              );
              (c.children as typeof c[]).forEach(collectSketches);
            };
            collectSketches(container);
            return { sketches };
          }

          case 'create': {
            const name = args.name as string | undefined;
            const sketchesService = this.services.sketchesService;
            let sketch = await sketchesService.createNewSketch();
            if (name) {
              if (!SKETCH_NAME_PATTERN.test(name)) {
                throw new Error(
                  `Invalid sketch name: ${name}. Use letters, digits, "_", "-" and "."`
                );
              }
              const state = await this.services.configService.getConfiguration();
              if (!state.config?.sketchDirUri) {
                throw new Error(
                  'Sketchbook location is not available; cannot create a named sketch'
                );
              }
              const destinationUri = `${state.config.sketchDirUri}/${name}`;
              const destinationPath = FileUri.fsPath(destinationUri);
              try {
                await fs.promises.access(destinationPath);
                throw new Error(
                  `A sketch named "${name}" already exists in the sketchbook`
                );
              } catch (e) {
                if (e instanceof Error && e.message.includes('already exists')) {
                  throw e;
                }
                // ENOENT: destination is free
              }
              sketch = await sketchesService.copy(sketch, {
                destinationUri,
                onlySketchFiles: true,
              });
            }
            this.setCurrentSketch(sketch);
            this.emitFileChange({
              uri: sketch.mainFileUri,
              type: 'created',
              source: 'mcp',
              tool: 'arduino_sketch',
              timestamp: Date.now(),
            });
            return {
              name: sketch.name,
              uri: sketch.uri,
              mainFileUri: sketch.mainFileUri,
            };
          }

          case 'open': {
            const sketchPath = args.path as string;
            if (!sketchPath) throw new Error('path is required');
            const fsPath = await this.assertPathAllowed(
              this.toFsPath(sketchPath),
              'read'
            );
            const sketch = await this.services.sketchesService.loadSketch(
              FileUri.create(fsPath).toString()
            );
            this.setCurrentSketch(sketch);
            return {
              name: sketch.name,
              uri: sketch.uri,
              mainFileUri: sketch.mainFileUri,
              otherSketchFileUris: sketch.otherSketchFileUris,
              additionalFileUris: sketch.additionalFileUris,
            };
          }

          case 'get_files': {
            const sketch = await this.resolveSketch();
            return {
              mainFile: sketch.mainFileUri,
              otherSketchFiles: sketch.otherSketchFileUris,
              additionalFiles: sketch.additionalFileUris,
              rootFolderFiles: sketch.rootFolderFileUris,
            };
          }

          case 'list_examples':
            return {
              examples: await this.getBuiltInExamples(
                args.category as string | undefined
              ),
            };

          case 'from_example': {
            const examplePath = args.example_path as string;
            if (!examplePath) throw new Error('example_path is required');
            const exampleFsPath = await this.assertPathAllowed(
              this.toFsPath(examplePath),
              'read'
            );
            const sketchesService = this.services.sketchesService;
            const exampleSketch = await sketchesService.loadSketch(
              FileUri.create(exampleFsPath).toString()
            );

            const state = await this.services.configService.getConfiguration();
            if (!state.config?.sketchDirUri) {
              throw new Error('Sketchbook location is not available');
            }
            let destinationName = exampleSketch.name;
            let destinationUri = `${state.config.sketchDirUri}/${destinationName}`;
            // Do not overwrite an existing sketch; pick a free name instead.
            for (let i = 2; i < 100; i++) {
              try {
                await fs.promises.access(FileUri.fsPath(destinationUri));
                destinationName = `${exampleSketch.name}_${i}`;
                destinationUri = `${state.config.sketchDirUri}/${destinationName}`;
              } catch {
                break;
              }
            }

            const newSketch = await sketchesService.copy(exampleSketch, {
              destinationUri,
              onlySketchFiles: true,
            });
            this.setCurrentSketch(newSketch);
            this.emitFileChange({
              uri: newSketch.mainFileUri,
              type: 'created',
              source: 'mcp',
              tool: 'arduino_sketch',
              timestamp: Date.now(),
            });
            return {
              name: newSketch.name,
              uri: newSketch.uri,
              mainFileUri: newSketch.mainFileUri,
              message: `Created sketch "${newSketch.name}" from example: ${exampleSketch.name}`,
            };
          }

          case 'save':
            throw new Error(
              'The save action does not exist: set_content writes files to disk immediately.'
            );

          default:
            throw new Error(`Unknown sketch action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // COMPILE TOOL (Task-enabled)
      // ----------------------------------------------------------
      case 'arduino_compile': {
        const task = this.createTask('arduino_compile', {
          sketch_path: args.sketch_path,
          fqbn: args.fqbn,
          verbose: args.verbose,
        });
        this.launchTask(task, () => this.runCompileTask(task));
        if (args.wait) {
          return this.waitForTask(task, clampTaskTimeout(args.timeout_seconds));
        }
        return {
          taskId: task.id,
          status: task.status,
          message:
            'Compilation started. Use arduino_task_status to check progress and arduino_build_output for compiler output. Tip: pass wait:true to block until it finishes.',
        };
      }

      // ----------------------------------------------------------
      // UPLOAD TOOL (Task-enabled, DESTRUCTIVE)
      // ----------------------------------------------------------
      case 'arduino_upload': {
        const task = this.createTask('arduino_upload', {
          sketch_path: args.sketch_path,
          fqbn: args.fqbn,
          port: args.port,
          verify: args.verify,
        });
        this.launchTask(task, () => this.runUploadTask(task));
        if (args.wait) {
          return this.waitForTask(task, clampTaskTimeout(args.timeout_seconds));
        }
        return {
          taskId: task.id,
          status: task.status,
          message:
            'Upload started. This will OVERWRITE firmware on the device. Use arduino_task_status to check progress. Tip: pass wait:true to block until it finishes.',
        };
      }

      // ----------------------------------------------------------
      // BUILD OUTPUT
      // ----------------------------------------------------------
      case 'arduino_build_output': {
        const type = (args.type as string) || 'all';
        const format = (args.format as string) || 'raw';

        if (!this.lastBuild) {
          return {
            message:
              'No build has run yet. Use arduino_compile or arduino_upload first.',
          };
        }

        if (type === 'errors') {
          const errors = this.lastBuild.errors.length
            ? this.lastBuild.errors.map((e) => this.formatStructuredError(e))
            : this.extractErrors(this.lastBuild.stderr);
          const tool = this.lastBuild.tool;
          return format === 'explained'
            ? { errors: errors.map((e) => this.explainError(e, tool)) }
            : { errors };
        }
        if (type === 'warnings') {
          return { warnings: this.extractWarnings(this.lastBuild.stderr) };
        }
        return {
          tool: this.lastBuild.tool,
          stdout: this.lastBuild.stdout,
          stderr: this.lastBuild.stderr,
          errors: this.lastBuild.errors,
        };
      }

      // ----------------------------------------------------------
      // BOARD TOOLS
      // ----------------------------------------------------------
      case 'arduino_board': {
        const action = args.action as string;
        const boardsService = this.services.boardsService;
        switch (action) {
          case 'list_connected': {
            const detectedPorts = await boardsService.getDetectedPorts();
            // Report every detected port, not just the ones arduino-cli could
            // match to a board. A port with no identified board is extremely
            // common - the board's core isn't installed yet, it's a generic
            // clone, or it's sitting in bootloader mode - and dropping those
            // left the agent unable to see that anything was plugged in at all.
            // Unidentified ports are returned with identified: false so the
            // agent can still select the port and supply an explicit FQBN.
            const boards = (Object.values(detectedPorts) as any[]).map((dp) => {
              const board = dp.boards && dp.boards.length > 0 ? dp.boards[0] : undefined;
              const props = dp.port.properties ?? {};
              return {
                name: board?.name ?? 'Unknown',
                fqbn: board?.fqbn ?? null,
                identified: !!board,
                port: {
                  address: dp.port.address,
                  protocol: dp.port.protocol,
                  // USB identity: lets an agent reason about unidentified
                  // boards (suggest_fqbn consumes the same data).
                  vid: props['vid'] ?? null,
                  pid: props['pid'] ?? null,
                  serial_number: props['serialNumber'] ?? null,
                },
              };
            });
            return { boards };
          }

          case 'list_available': {
            const boards = await boardsService.getInstalledBoards();
            return {
              boards: boards.map((b: any) => ({
                name: b.name,
                fqbn: b.fqbn,
                packageName: b.packageName,
              })),
            };
          }

          case 'get_selected':
            return {
              ide: this.ideState.boardFqbn
                ? {
                    fqbn: this.ideState.boardFqbn,
                    name: this.ideState.boardName,
                    port: this.ideState.portAddress,
                  }
                : null,
              mcp_session:
                this.sessionBoard.fqbn || this.sessionBoard.port
                  ? { ...this.sessionBoard }
                  : null,
              effective: {
                fqbn: this.sessionBoard.fqbn ?? this.ideState.boardFqbn ?? null,
                port:
                  this.sessionBoard.port ?? this.ideState.portAddress ?? null,
              },
            };

          case 'select': {
            const fqbn = args.fqbn as string | undefined;
            const port = args.port as string | undefined;
            if (!fqbn && !port) {
              throw new Error('select requires fqbn and/or port');
            }
            if (fqbn) {
              this.sessionBoard.fqbn = fqbn;
            }
            if (port) {
              this.sessionBoard.port = port;
            }
            return {
              success: true,
              note: 'Default board/port set for this MCP session (does not change the IDE UI selection).',
              ...this.sessionBoard,
            };
          }

          case 'get_info': {
            const fqbn = args.fqbn as string;
            if (!fqbn) throw new Error('fqbn is required for get_info');
            try {
              const details = await boardsService.getBoardDetails({ fqbn });
              return {
                name: (details as any)?.name,
                fqbn,
                pinInfo: this.getBoardPinInfo(fqbn),
              };
            } catch {
              return { fqbn, pinInfo: this.getBoardPinInfo(fqbn) };
            }
          }

          case 'search': {
            const query = args.query as string;
            const results = await boardsService.searchBoards({ query });
            return {
              boards: results.map((b: any) => ({
                name: b.name,
                fqbn: b.fqbn,
                packageName: b.packageName,
              })),
            };
          }

          case 'suggest_fqbn':
            return this.suggestFqbn(
              args.name as string | undefined,
              args.port as string | undefined
            );

          case 'install_core': {
            const core = args.core as string;
            if (!core) throw new Error('core is required (e.g. arduino:avr)');
            const searchResults = await boardsService.search({ query: core });
            const match =
              searchResults.find((p: any) => p.id === core) ??
              searchResults[0];
            if (!match) {
              throw new Error(`Core not found: ${core}`);
            }
            await boardsService.install({ item: match });
            return { success: true, core: (match as any).id ?? core };
          }

          default:
            throw new Error(`Unknown board action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // SERIAL TOOLS
      // ----------------------------------------------------------
      case 'arduino_serial': {
        const action = args.action as string;
        switch (action) {
          case 'list_ports': {
            const detectedPorts =
              await this.services.boardsService.getDetectedPorts();
            const ports = (Object.values(detectedPorts) as any[]).map(
              (dp) => ({
                address: dp.port.address,
                protocol: dp.port.protocol,
                vid: dp.port.properties?.['vid'] ?? null,
                pid: dp.port.properties?.['pid'] ?? null,
                boards:
                  dp.boards?.map((b: any) => ({
                    name: b.name,
                    fqbn: b.fqbn,
                  })) || [],
              })
            );
            return { ports };
          }

          case 'connect': {
            const port = this.resolvePortAddress(args.port);
            const baudRate = (args.baud_rate as number) || 9600;
            if (!SERIAL_BAUD_RATES.includes(baudRate)) {
              throw new Error(
                `Unsupported baud rate: ${baudRate}. Supported: ${SERIAL_BAUD_RATES.join(
                  ', '
                )}`
              );
            }
            const result = await this.serial.connect(
              port,
              baudRate,
              (args.fqbn as string) || undefined
            );
            return { success: true, ...result };
          }

          case 'disconnect':
            await this.serial.disconnect();
            return { success: true };

          case 'read': {
            const maxLines = (args.max_lines as number) || 100;
            const since =
              typeof args.since === 'number' ? args.since : undefined;
            return this.serial.read(maxLines, since);
          }

          case 'wait_for': {
            const pattern = args.pattern as string;
            if (!pattern) {
              throw new Error('pattern is required for wait_for');
            }
            const timeout = clampSerialWaitTimeout(args.timeout_seconds);
            const since =
              typeof args.since === 'number' ? args.since : undefined;
            return this.serial.waitFor(
              pattern,
              (args.is_regex as boolean) || false,
              timeout,
              since
            );
          }

          case 'write': {
            const data = args.data as string;
            const lineEnding = (args.line_ending as string) || 'newline';
            if (data === undefined || data === null) {
              throw new Error('data is required');
            }
            let dataToSend = data;
            switch (lineEnding) {
              case 'newline':
                dataToSend += '\n';
                break;
              case 'carriage':
                dataToSend += '\r';
                break;
              case 'both':
                dataToSend += '\r\n';
                break;
            }
            const result = this.serial.write(dataToSend);
            return { success: true, ...result };
          }

          case 'clear':
            this.serial.clear();
            return { success: true };

          case 'get_config':
            return this.serial.status();

          case 'set_config': {
            const newBaudRate = args.baud_rate as number;
            if (!newBaudRate) {
              throw new Error('baud_rate is required for set_config');
            }
            if (!SERIAL_BAUD_RATES.includes(newBaudRate)) {
              throw new Error(
                `Unsupported baud rate: ${newBaudRate}. Supported: ${SERIAL_BAUD_RATES.join(
                  ', '
                )}`
              );
            }
            return {
              success: true,
              ...(await this.serial.setBaudRate(newBaudRate)),
            };
          }

          default:
            throw new Error(`Unknown serial action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // LIBRARY TOOLS
      // ----------------------------------------------------------
      case 'arduino_library': {
        const libraryService = this.services.libraryService;
        const action = args.action as string;
        switch (action) {
          case 'list': {
            const installed = await libraryService.list({});
            return {
              libraries: installed.map((lib: any) => ({
                name: lib.name,
                version: lib.installedVersion,
                author: lib.author,
                summary: lib.summary,
              })),
            };
          }

          case 'search': {
            const query = args.query as string;
            const results = await libraryService.search({
              query: query || '',
            });
            return {
              libraries: results.map((lib: any) => ({
                name: lib.name,
                version: lib.availableVersions?.[0],
                author: lib.author,
                summary: lib.summary,
              })),
            };
          }

          case 'install': {
            const name = args.name as string;
            if (!name) throw new Error('name is required');
            const version = args.version as string | undefined;
            const results = await libraryService.search({ query: name });
            const library = results.find((lib: any) => lib.name === name);
            if (!library) throw new Error(`Library not found: ${name}`);
            await libraryService.install({
              item: library,
              version: version || (library as any).availableVersions?.[0],
            });
            return { success: true, name, version };
          }

          case 'remove': {
            const name = args.name as string;
            if (!name) throw new Error('name is required');
            const installed = await libraryService.list({});
            const library = installed.find((lib: any) => lib.name === name);
            if (!library) throw new Error(`Library not installed: ${name}`);
            await libraryService.uninstall({ item: library });
            return { success: true, name };
          }

          case 'get_info': {
            const name = args.name as string;
            if (!name) throw new Error('name is required');
            const results = await libraryService.search({ query: name });
            const library = results.find((lib: any) => lib.name === name);
            if (!library) throw new Error(`Library not found: ${name}`);
            return library;
          }

          case 'get_examples': {
            const name = args.name as string;
            if (!name) throw new Error('name is required');
            const installed = await libraryService.list({});
            const library = installed.find((lib: any) => lib.name === name);
            if (!library) {
              throw new Error(
                `Library not installed: ${name}. Install it first to browse its examples.`
              );
            }
            return {
              name,
              examples: ((library as any).exampleUris ?? []).map(
                (uri: string) => ({
                  name: uri.split('/').filter(Boolean).pop(),
                  uri,
                })
              ),
            };
          }

          default:
            throw new Error(`Unknown library action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // FORMAT TOOL
      // ----------------------------------------------------------
      case 'arduino_format': {
        const content = args.content as string;
        const tabSize = (args.tab_size as number) || 2;
        const insertSpaces = args.insert_spaces !== false;

        if (!content) throw new Error('content is required');

        const formatted = await this.services.formatter.format({
          content,
          formatterConfigFolderUris: [],
          options: { tabSize, insertSpaces },
        });

        return {
          formatted,
          originalLength: content.length,
          formattedLength: formatted.length,
        };
      }

      // ----------------------------------------------------------
      // CONFIG TOOL
      // ----------------------------------------------------------
      case 'arduino_config': {
        const action = args.action as string;
        const configService = this.services.configService;
        switch (action) {
          case 'get': {
            const state = await configService.getConfiguration();
            if (!state.config) {
              return {
                error: 'Configuration not available',
                messages: state.messages,
              };
            }
            return {
              sketchDirUri: state.config.sketchDirUri,
              dataDirUri: state.config.dataDirUri,
              additionalUrls: state.config.additionalUrls,
              locale: state.config.locale,
            };
          }

          case 'set': {
            const currentState = await configService.getConfiguration();
            if (!currentState.config) {
              throw new Error('Cannot modify configuration - not available');
            }

            const newConfig = { ...currentState.config };
            if (args.additional_urls !== undefined) {
              newConfig.additionalUrls = args.additional_urls as string[];
            }
            if (args.sketch_dir !== undefined) {
              newConfig.sketchDirUri = this.toUriString(
                args.sketch_dir as string
              );
            }

            await configService.setConfiguration(newConfig);
            return { success: true };
          }

          case 'add_board_url': {
            const url = args.url as string;
            if (!url) throw new Error('url is required');

            const currentState = await configService.getConfiguration();
            if (!currentState.config) {
              throw new Error('Cannot modify configuration - not available');
            }

            const urls = [...currentState.config.additionalUrls];
            if (!urls.includes(url)) {
              urls.push(url);
              await configService.setConfiguration({
                ...currentState.config,
                additionalUrls: urls,
              });
            }
            return { success: true, additionalUrls: urls };
          }

          default:
            throw new Error(`Unknown config action: ${action}`);
        }
      }

      // ----------------------------------------------------------
      // CONTEXT TOOL
      // ----------------------------------------------------------
      case 'arduino_context': {
        let connectedBoards: Array<{
          name: string;
          fqbn?: string;
          identified: boolean;
          port: string;
        }> = [];
        try {
          const detectedPorts =
            await this.services.boardsService.getDetectedPorts();
          // Include ports with no identified board (core not installed, generic
          // clone, bootloader mode) - see the note in arduino_board
          // list_connected. Hiding them made a plugged-in device invisible.
          connectedBoards = (Object.values(detectedPorts) as any[]).map((dp) => {
            const board = dp.boards && dp.boards.length > 0 ? dp.boards[0] : undefined;
            const props = dp.port.properties ?? {};
            return {
              name: board?.name ?? 'Unknown',
              fqbn: board?.fqbn,
              identified: !!board,
              port: dp.port.address,
              vid: props['vid'] ?? null,
              pid: props['pid'] ?? null,
            };
          });
        } catch (e) {
          mcpLog.error('Error getting detected ports:', e);
        }

        const serialStatus = this.serial.status();
        return {
          connected: true,
          open_sketch: this.currentSketch
            ? {
                source: 'mcp',
                name: this.currentSketch.name,
                uri: this.currentSketch.uri,
                mainFileUri: this.currentSketch.mainFileUri,
              }
            : this.ideState.sketchUri
            ? {
                source: 'ide',
                name: this.ideState.sketchName,
                uri: this.ideState.sketchUri,
              }
            : null,
          selected_board: this.ideState.boardFqbn
            ? {
                fqbn: this.ideState.boardFqbn,
                name: this.ideState.boardName,
                port: this.ideState.portAddress,
              }
            : null,
          mcp_session_board:
            this.sessionBoard.fqbn || this.sessionBoard.port
              ? { ...this.sessionBoard }
              : null,
          connected_boards: connectedBoards,
          serial_connected: serialStatus.connected,
          serial_port: serialStatus.port,
          mcp_version: EXTENSION_VERSION,
          transport: 'http',
        };
      }

      // ----------------------------------------------------------
      // TASK STATUS
      // ----------------------------------------------------------
      case 'arduino_task_status': {
        const taskId = args.task_id as string;
        if (!taskId) throw new Error('task_id is required');
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (
          args.wait &&
          (task.status === 'pending' || task.status === 'running')
        ) {
          return this.waitForTask(task, clampTaskTimeout(args.timeout_seconds));
        }
        return {
          taskId: task.id,
          status: task.status,
          result: task.result,
          error: task.error,
          progress: task.progress,
          progressMessage: task.progressMessage,
        };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ============================================================
  // ASYNC TASK RUNNERS
  // ============================================================

  private createTask(tool: string, args: Record<string, unknown>): Task {
    const taskId = `task_${++this.taskCounter}_${Date.now()}`;
    const task: Task = {
      id: taskId,
      status: 'pending',
      tool,
      arguments: args,
      createdAt: Date.now(),
    };
    this.tasks.set(taskId, task);
    this.pruneTasks();
    return task;
  }

  /**
   * Starts a task runner and keeps its completion promise so `wait` callers
   * can block on it. The runners never reject (all paths are caught), but the
   * catch guard keeps a future bug from becoming an unhandled rejection.
   */
  private launchTask(task: Task, runner: () => Promise<void>): void {
    this.taskPromises.set(
      task.id,
      runner().catch(() => undefined)
    );
  }

  /**
   * Blocks until the task reaches a terminal status or the timeout elapses.
   * A timeout is NOT an error: the caller gets the current status/progress and
   * the taskId, and can keep waiting via arduino_task_status {wait:true}.
   */
  private async waitForTask(
    task: Task,
    timeoutSeconds: number
  ): Promise<unknown> {
    const completion = this.taskPromises.get(task.id) ?? Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutSeconds * 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!finished) {
      return {
        taskId: task.id,
        status: task.status,
        progress: task.progress,
        progressMessage: task.progressMessage,
        timed_out: true,
        hint: `Still running after ${timeoutSeconds}s. Call arduino_task_status with task_id "${task.id}" and wait:true to keep waiting.`,
      };
    }
    return {
      taskId: task.id,
      status: task.status,
      result: task.result,
      error: task.error,
      progress: task.progress,
      progressMessage: task.progressMessage,
    };
  }

  private pruneTasks(): void {
    if (this.tasks.size <= MAX_TASKS) {
      return;
    }
    for (const [id, task] of this.tasks) {
      if (
        task.status === 'completed' ||
        task.status === 'failed' ||
        task.status === 'cancelled'
      ) {
        this.tasks.delete(id);
        this.taskPromises.delete(id);
      }
      if (this.tasks.size <= MAX_TASKS) {
        return;
      }
    }
  }

  private async runCompileTask(task: Task): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();
    task.progress = 0;
    task.progressMessage = 'Preparing compilation...';

    const services = this.services;
    services.responseService.reset();
    const progressSub = services.responseService.onProgress((message) => {
      if (message.progressId !== task.id) {
        return;
      }
      task.progressMessage = message.message;
      if (message.work && message.work.total > 0) {
        task.progress = Math.min(
          99,
          Math.round((100 * message.work.done) / message.work.total)
        );
      }
    });

    try {
      const sketch = await this.resolveSketch(task.arguments.sketch_path);
      const fqbn = this.resolveFqbn(task.arguments.fqbn);

      task.progressMessage = 'Compiling...';
      const summary = await services.coreService.compile({
        sketch,
        fqbn,
        verbose: (task.arguments.verbose as boolean) || false,
        optimizeForDebug: false,
        sourceOverride: {},
        progressId: task.id,
      });

      task.result = {
        success: true,
        buildPath: summary?.buildPath,
        executableSectionsSize: summary?.executableSectionsSize,
      };
      task.status = 'completed';
      task.finishedAt = Date.now();
      task.progress = 100;
      task.progressMessage = 'Compilation complete';
      this.recordBuild('compile', []);
    } catch (e) {
      task.status = 'failed';
      task.finishedAt = Date.now();
      const errors = this.structuredErrorsOf(e);
      task.error = `Compilation failed: ${
        e instanceof Error ? e.message : e
      }`;
      this.recordBuild('compile', errors);
      task.result = {
        success: false,
        errors,
        explained: this.explainTaskFailure(task, errors, 'compile'),
      };
    } finally {
      progressSub.dispose();
    }
  }

  /**
   * Builds the `explained` entries attached to a failed task - the place
   * agents actually look, rather than requiring a follow-up call to
   * arduino_build_output. Falls back through structured errors, stderr
   * extraction, and finally the task's own error string, so a failed task
   * never carries an empty explanation.
   */
  private explainTaskFailure(
    task: Task,
    errors: StructuredBuildError[],
    tool: 'compile' | 'upload'
  ): Array<{ raw: string; explanation: string; suggestion: string }> {
    let raw = errors.length
      ? errors.map((err) => this.formatStructuredError(err))
      : this.extractErrors(this.lastBuild?.stderr ?? '');
    if (!raw.length && task.error) {
      raw = [task.error];
    }
    return raw.map((r) => this.explainError(r, tool));
  }

  private async runUploadTask(task: Task): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();
    task.progress = 0;
    task.progressMessage = 'Preparing upload...';
    let compileFailed = false;

    const services = this.services;
    services.responseService.reset();
    const progressSub = services.responseService.onProgress((message) => {
      if (message.progressId !== task.id) {
        return;
      }
      task.progressMessage = message.message;
      if (message.work && message.work.total > 0) {
        task.progress = Math.min(
          99,
          Math.round((100 * message.work.done) / message.work.total)
        );
      }
    });

    try {
      const sketch = await this.resolveSketch(task.arguments.sketch_path);
      const fqbn = this.resolveFqbn(task.arguments.fqbn);
      const portAddress = this.resolvePortAddress(task.arguments.port);

      // Look up the detected port to get the right protocol.
      let protocol = 'serial';
      try {
        const detectedPorts =
          await services.boardsService.getDetectedPorts();
        const entry = (Object.values(detectedPorts) as any[]).find(
          (dp) => dp.port.address === portAddress
        );
        if (entry) {
          protocol = entry.port.protocol;
        }
      } catch {
        // fall back to serial
      }

      // Compile first. `coreService.upload` only flashes an existing build, so
      // uploading a sketch that was never compiled failed with the unhelpful
      // "Compiled sketch not found in <hash dir>" - and this tool documents
      // itself as "compile and upload". The IDE's own Upload command works the
      // same way (verify-sketch, then upload). Compilation is incremental, so
      // re-running it for an already-built sketch is cheap.
      task.progressMessage = 'Compiling...';
      try {
        await services.coreService.compile({
          sketch,
          fqbn,
          verbose: false,
          optimizeForDebug: false,
          sourceOverride: {},
          progressId: task.id,
        });
      } catch (e) {
        // Name the phase: "Upload failed: <compiler diagnostic>" would send the
        // caller looking at the board and the cable instead of their code.
        compileFailed = true;
        throw e;
      }

      task.progressMessage = 'Uploading...';
      const result = await services.coreService.upload({
        sketch,
        fqbn,
        port: { address: portAddress, protocol },
        verbose: false,
        verify: (task.arguments.verify as boolean) ?? true,
        userFields: [],
        progressId: task.id,
      });

      task.result = {
        success: true,
        portAfterUpload: result.portAfterUpload,
      };
      task.status = 'completed';
      task.finishedAt = Date.now();
      task.progress = 100;
      task.progressMessage = 'Upload complete';
      this.recordBuild('upload', []);
    } catch (e) {
      task.status = 'failed';
      task.finishedAt = Date.now();
      const errors = this.structuredErrorsOf(e);
      task.error = `${
        compileFailed ? 'Upload failed during compilation' : 'Upload failed'
      }: ${e instanceof Error ? e.message : e}`;
      this.recordBuild('upload', errors);
      task.result = {
        success: false,
        errors,
        explained: this.explainTaskFailure(
          task,
          errors,
          compileFailed ? 'compile' : 'upload'
        ),
      };
    } finally {
      progressSub.dispose();
    }
  }

  private recordBuild(
    tool: 'compile' | 'upload',
    errors: StructuredBuildError[]
  ): void {
    const output = this.services.responseService.snapshot();
    this.lastBuild = {
      tool,
      stdout: output.stdout,
      stderr: output.stderr,
      errors,
      timestamp: Date.now(),
    };
  }

  /** Extracts structured compiler errors from a CoreError, if possible. */
  private structuredErrorsOf(error: unknown): StructuredBuildError[] {
    if (CoreError.is(error)) {
      // No type declarations from the IDE extension; CoreError.is() cannot narrow.
      const data = ((error as { data?: unknown }).data ?? []) as Array<{
        message: string;
        location?: { uri?: string; range?: { start?: { line?: number } } };
        details?: string;
      }>;
      return data.map((location) => ({
        message: location.message,
        file: location.location?.uri,
        line:
          location.location?.range?.start?.line !== undefined
            ? location.location.range.start.line + 1
            : undefined,
        details: location.details,
      }));
    }
    return [];
  }

  private formatStructuredError(error: StructuredBuildError): string {
    const where = error.file
      ? `${error.file}${error.line ? `:${error.line}` : ''}: `
      : '';
    return `${where}${error.message}`;
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  private extractErrors(stderr: string): string[] {
    const errors: string[] = [];
    for (const line of stderr.split('\n')) {
      // 'error:' catches compiler diagnostics; the alternation catches
      // esptool/avrdude failures, which never use that prefix and previously
      // made a failed upload report zero errors.
      if (
        line.includes('error:') ||
        /A fatal error occurred|Failed uploading|Failed to connect|avrdude: /i.test(
          line
        )
      ) {
        errors.push(line.trim());
      }
    }
    return errors;
  }

  private extractWarnings(stderr: string): string[] {
    const warnings: string[] = [];
    for (const line of stderr.split('\n')) {
      if (line.includes('warning:')) {
        warnings.push(line.trim());
      }
    }
    return warnings;
  }

  private explainError(
    error: string,
    tool: 'compile' | 'upload' = 'compile'
  ): {
    raw: string;
    explanation: string;
    suggestion: string;
  } {
    // Upload signatures are tried first for upload failures, but both tables
    // are consulted: an upload that failed during its compile phase carries
    // compiler diagnostics.
    const tables =
      tool === 'upload'
        ? [UPLOAD_ERROR_PATTERNS, COMPILE_ERROR_PATTERNS]
        : [COMPILE_ERROR_PATTERNS];
    for (const table of tables) {
      for (const { pattern, explanation, suggestion } of table) {
        if (pattern.test(error)) {
          return { raw: error, explanation, suggestion };
        }
      }
    }

    return {
      raw: error,
      explanation:
        tool === 'upload'
          ? 'Upload/flashing error occurred.'
          : 'Compilation error occurred.',
      suggestion:
        tool === 'upload'
          ? 'Check the board is connected, the port is correct and not in use, and the FQBN matches the chip.'
          : 'Review the error message and check the indicated line.',
    };
  }

  private async getBuiltInExamples(category?: string): Promise<
    Array<{
      name: string;
      path: string;
      category: string;
      description?: string;
    }>
  > {
    const examplesPath = this.examplesRootPath();
    const examples: Array<{
      name: string;
      path: string;
      category: string;
      description?: string;
    }> = [];
    if (!examplesPath) {
      return examples;
    }

    try {
      const categories = await fs.promises.readdir(examplesPath);
      for (const cat of categories) {
        if (category && !cat.includes(category)) continue;

        const catPath = path.join(examplesPath, cat);
        const stat = await fs.promises.stat(catPath);
        if (!stat.isDirectory()) continue;

        const items = await fs.promises.readdir(catPath);
        for (const item of items) {
          const itemPath = path.join(catPath, item);
          const itemStat = await fs.promises.stat(itemPath);
          if (itemStat.isDirectory()) {
            const files = await fs.promises.readdir(itemPath);
            if (files.some((f) => f.endsWith('.ino'))) {
              examples.push({
                name: item,
                path: FileUri.create(itemPath).toString(),
                category: cat,
                description: this.getExampleDescription(item),
              });
            }
          }
        }
      }
    } catch (e) {
      mcpLog.error('Error reading examples:', e);
    }

    return examples;
  }

  private getExampleDescription(name: string): string | undefined {
    const descriptions: Record<string, string> = {
      Blink:
        'Blink the built-in LED on and off - the "Hello World" of Arduino',
      DigitalReadSerial:
        'Read a digital input and print the state to Serial Monitor',
      AnalogReadSerial:
        'Read an analog sensor and print the value to Serial Monitor',
      Fade: 'Fade an LED in and out using PWM (analogWrite)',
      Button: 'Use a pushbutton to control an LED',
      Debounce: 'Read a pushbutton with debouncing to avoid false triggers',
      Sweep: 'Control a servo motor, sweeping back and forth',
      Knob: 'Control a servo motor with a potentiometer',
      ASCIITable: 'Print the ASCII table to the Serial Monitor',
      ReadASCIIString: 'Parse integers from a comma-separated serial string',
    };
    return descriptions[name];
  }

  /**
   * Suggests FQBNs for a board that arduino-cli cannot identify - the common
   * dead end where a port shows identified:false because the board's USB
   * VID/PID appears in no boards.txt (most ESP32-S3 devkits) or it sits
   * behind a generic USB-UART bridge. Uses the port's USB identity plus fuzzy
   * name matching over installed and searchable boards; when the best match's
   * core is missing, names the core to install.
   */
  private async suggestFqbn(name?: string, port?: string): Promise<unknown> {
    const boardsService = this.services.boardsService;

    // Explicit port > session selection > IDE selection. Name-only is fine.
    const portAddress =
      port ?? this.sessionBoard.port ?? this.ideState.portAddress ?? undefined;

    let portInfo: Record<string, unknown> | null = null;
    let detectedName: string | undefined;
    let family: UsbVidFamily | undefined;
    if (portAddress) {
      const detectedPorts = await boardsService.getDetectedPorts();
      const entry = (Object.values(detectedPorts) as any[]).find(
        (dp) => dp.port.address === portAddress
      );
      if (entry) {
        const props = entry.port.properties ?? {};
        const vid: string | undefined = props['vid'];
        const pid: string | undefined = props['pid'];
        const vidKey = vid?.replace(/^0x/i, '').toLowerCase();
        family = vidKey ? USB_VID_FAMILIES[vidKey] : undefined;
        detectedName = entry.boards?.[0]?.name;
        portInfo = {
          address: portAddress,
          vid: vid ?? null,
          pid: pid ?? null,
          vendor: family?.vendor ?? null,
          kind: family?.kind ?? null,
          hint: family?.hint ?? null,
        };
      } else {
        portInfo = {
          address: portAddress,
          error: 'Port not currently detected',
        };
      }
    }

    if (!name && !detectedName && !family) {
      throw new Error(
        'Nothing to go on: pass a board name (e.g. "esp32 s3") and/or a port with a connected board.'
      );
    }

    const installed = (await boardsService.getInstalledBoards()) as any[];
    const installedFqbns = new Set(
      installed.map((b) => b.fqbn).filter(Boolean)
    );

    interface Candidate {
      name: string;
      /** null when the platform is not installed - arduino-cli only reveals
       *  FQBNs for installed platforms; install `core` to get it. */
      fqbn: string | null;
      installed: boolean;
      score: number;
      reason: string;
      /** Platform id to install (first two FQBN segments), when known. */
      core?: string;
      packageName?: string;
    }
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const push = (c: Candidate) => {
      const key = c.fqbn ?? `${c.name}|${c.core ?? c.packageName ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(c);
      }
    };

    const searchName = name ?? detectedName;
    if (searchName) {
      for (const b of installed) {
        if (!b.fqbn) continue;
        const score = scoreNameMatch(searchName, b.name ?? '');
        if (score >= 0.4) {
          push({
            name: b.name,
            fqbn: b.fqbn,
            installed: true,
            score,
            reason: `name match, core installed`,
            core: b.fqbn.split(':').slice(0, 2).join(':'),
            packageName: b.packageName,
          });
        }
      }
      try {
        const results = (await boardsService.searchBoards({
          query: searchName,
        })) as any[];
        for (const b of results) {
          const score = scoreNameMatch(searchName, b.name ?? '');
          if (score < 0.4) continue;
          // Skip deprecated platforms; their replacement is its own row.
          if (/\[DEPRECATED/i.test(b.packageName ?? '')) continue;
          const fqbn: string | null = b.fqbn || null;
          push({
            name: b.name,
            fqbn,
            installed: fqbn ? installedFqbns.has(fqbn) : false,
            // Nudge below an installed twin so it sorts after it.
            score: score - 0.01,
            reason: fqbn
              ? `name match in board index`
              : `name match - platform not installed, so arduino-cli hides its FQBN`,
            core:
              fqbn?.split(':').slice(0, 2).join(':') ??
              (b.packageId?.vendorId && b.packageId?.arch
                ? `${b.packageId.vendorId}:${b.packageId.arch}`
                : undefined),
            packageName: b.packageName,
          });
        }
      } catch {
        // Offline or index unavailable - installed boards still work.
      }
    }

    if (family?.fqbnCandidates) {
      for (const c of family.fqbnCandidates) {
        push({
          name: c.name,
          fqbn: c.fqbn,
          installed: installedFqbns.has(c.fqbn),
          score: 0.5,
          reason: `USB vendor ${family.vendor} (${family.kind} USB)`,
          core: c.fqbn.split(':').slice(0, 2).join(':'),
        });
      }
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score || Number(b.installed) - Number(a.installed)
    );
    const top = candidates.slice(0, 5);
    const best = top[0];
    const coreToInstall = best && !best.installed ? best.core ?? null : null;

    let hint: string;
    if (!best) {
      hint =
        'No confident match. Try a more specific name, or arduino_board search with the product name.';
    } else if (best.installed && best.fqbn) {
      hint = `Pass fqbn "${best.fqbn}" explicitly to compile/upload/serial connect, or set it for the session with arduino_board select.`;
    } else if (coreToInstall) {
      hint = `Best match "${best.name}" needs its core: arduino_board install_core {"core":"${coreToInstall}"}${
        best.fqbn
          ? `, then use fqbn "${best.fqbn}"`
          : ', then re-run suggest_fqbn to get the exact FQBN'
      }.`;
    } else {
      hint = `Best match "${best.name}" is in platform "${
        best.packageName ?? 'unknown'
      }", which is not installed and whose core id could not be determined. Install it via the IDE Boards Manager, then re-run suggest_fqbn.`;
    }

    return {
      candidates: top,
      port_info: portInfo,
      core_to_install: coreToInstall,
      hint,
    };
  }

  private getBoardPinInfo(fqbn: string): {
    digitalPins: number;
    analogPins: number;
    pwmPins: number[];
    i2cPins?: { sda: number; scl: number };
    spiPins?: { mosi: number; miso: number; sck: number; ss: number };
    ledPin?: number;
    notes?: string;
  } | null {
    const boardPinInfo: Record<string, any> = {
      'arduino:avr:uno': {
        digitalPins: 14,
        analogPins: 6,
        pwmPins: [3, 5, 6, 9, 10, 11],
        i2cPins: { sda: 18, scl: 19 },
        spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
        ledPin: 13,
        notes:
          'PWM pins are marked with ~ on the board. A4/A5 can also be used as analog inputs.',
      },
      'arduino:avr:nano': {
        digitalPins: 14,
        analogPins: 8,
        pwmPins: [3, 5, 6, 9, 10, 11],
        i2cPins: { sda: 18, scl: 19 },
        spiPins: { mosi: 11, miso: 12, sck: 13, ss: 10 },
        ledPin: 13,
        notes:
          'Same pinout as Uno but with extra analog pins A6, A7 (input only).',
      },
      'arduino:avr:mega': {
        digitalPins: 54,
        analogPins: 16,
        pwmPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 44, 45, 46],
        i2cPins: { sda: 20, scl: 21 },
        spiPins: { mosi: 51, miso: 50, sck: 52, ss: 53 },
        ledPin: 13,
        notes:
          'Multiple hardware serial ports: Serial1 (19,18), Serial2 (17,16), Serial3 (15,14).',
      },
      'arduino:avr:leonardo': {
        digitalPins: 20,
        analogPins: 12,
        pwmPins: [3, 5, 6, 9, 10, 11, 13],
        i2cPins: { sda: 2, scl: 3 },
        spiPins: { mosi: 16, miso: 14, sck: 15, ss: 17 },
        ledPin: 13,
        notes:
          'Can act as USB HID device (keyboard/mouse). Pins 2,3 are also I2C.',
      },
      'esp32:esp32:esp32': {
        digitalPins: 34,
        analogPins: 18,
        pwmPins: [
          0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27,
          32, 33,
        ],
        i2cPins: { sda: 21, scl: 22 },
        spiPins: { mosi: 23, miso: 19, sck: 18, ss: 5 },
        notes:
          'WiFi and Bluetooth built-in. All PWM-capable pins support up to 16 channels.',
      },
    };

    return boardPinInfo[fqbn] || null;
  }

  private emitFileChange(event: MCPFileChangeEvent): void {
    if (this.fileChangeCallback) {
      try {
        this.fileChangeCallback(event);
        mcpLog.debug(`File change emitted: ${event.type} ${event.uri}`);
      } catch (error) {
        mcpLog.error('Error emitting file change:', error);
      }
    }
  }
}
