/**
 * MCP Serial Manager
 *
 * Real serial-monitor support for the MCP server. The IDE's `MonitorService`
 * (node side) exposes each running pluggable monitor through a local WebSocket:
 * board output is flushed to WS clients as JSON arrays of string chunks, and
 * clients send data / settings changes as `{ command, data }` messages.
 *
 * The MCP server connects to that WebSocket exactly like the IDE frontend does.
 * This keeps the monitor alive (it disposes itself when the last client leaves)
 * and lets MCP read and write while the IDE's own serial monitor stays usable.
 */

import WebSocket from 'ws';
import type { MonitorManager } from 'arduino-ide-extension/lib/node/monitor-manager';
import type {
  BoardsService,
  Port,
} from 'arduino-ide-extension/lib/common/protocol/boards-service';
import { Monitor } from 'arduino-ide-extension/lib/common/protocol/monitor-service';

export const SUPPORTED_BAUD_RATES = [
  300, 600, 750, 1200, 2400, 4800, 9600, 19200, 31250, 38400, 57600, 74880,
  115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000,
] as const;

const MAX_BUFFER_CHARS = 512 * 1024; // cap the capture buffer at 512 KB

/**
 * A crash/reset signature detected in the board's output. Surfaced through
 * read/wait_for/status so an agent can tell "the board rebooted five times"
 * apart from "the board is quiet" - previously these looked identical.
 */
export interface SerialEvent {
  type: 'reset' | 'panic' | 'watchdog' | 'brownout' | 'abort';
  /** The line that triggered the detection. */
  line: string;
  /** Global cursor just past that line. */
  cursor: number;
  timestamp: number;
  /** Reset reason, panic cause, or the first backtrace line. */
  detail?: string;
}

const MAX_EVENTS = 50;

/**
 * Line-anchored signatures for the funnel scanner. Order matters: the first
 * match wins. ESP32 (esp-idf) signatures plus the classic AVR wdt marker.
 */
const EVENT_SIGNATURES: Array<{
  type: SerialEvent['type'];
  pattern: RegExp;
  detail?: (match: RegExpMatchArray) => string;
}> = [
  {
    type: 'panic',
    pattern: /Guru Meditation Error:?\s*(.*)/,
    detail: (m) => m[1]?.trim() || 'panic',
  },
  { type: 'brownout', pattern: /Brownout detector was triggered/ },
  { type: 'abort', pattern: /abort\(\) was called/ },
  {
    type: 'watchdog',
    pattern: /Task watchdog got triggered|\bwdt reset/i,
  },
  {
    type: 'reset',
    pattern: /^rst:0x[0-9a-f]+\s*\(([^)]+)\)/i,
    detail: (m) => m[1],
  },
];

/** Result shape for waitFor - see that method for the resolutions. */
export interface SerialWaitResult {
  matched: boolean;
  line?: string;
  cursor: number;
  elapsed_ms?: number;
  timed_out?: boolean;
  disconnected?: boolean;
  hint?: string;
  /** Set when a crash/reset ended the wait early. */
  event?: SerialEvent;
  message?: string;
}

interface SerialWaiter {
  regex: RegExp;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: SerialWaitResult) => void;
}

interface ActiveConnection {
  board: { name: string; fqbn: string };
  port: Port;
  baudRate: number;
  ws: WebSocket;
  buffer: string;
  connected: boolean;
  /**
   * Global char offset of buffer[0]. Cursors handed to callers are global
   * offsets (bufferStartOffset + index into buffer), so they stay valid and
   * monotonically increasing across buffer truncation and clear() - a stale
   * cursor is reported as `dropped` chars instead of silently returning the
   * wrong window. The total received so far is bufferStartOffset + buffer.length.
   */
  bufferStartOffset: number;
  /** Partial trailing line carried between chunks for the line scanner. */
  lineRemainder: string;
  /** Pending wait_for calls, resolved by the line scanner. */
  waiters: SerialWaiter[];
  /** Detected crash/reset events, oldest first, capped at MAX_EVENTS. */
  events: SerialEvent[];
  /** Last panic/abort event still waiting for its Backtrace line. */
  crashPendingDetail: SerialEvent | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MCPSerialManager {
  private connection: ActiveConnection | null = null;

  constructor(
    private readonly monitorManager: () => MonitorManager,
    private readonly boardsService: () => BoardsService
  ) {}

  async connect(
    portAddress: string,
    baudRate: number,
    fqbnOverride?: string
  ): Promise<{
    port: string;
    baudRate: number;
    board: string;
    fqbn: string;
    requestedBaudRate?: number;
    warning?: string;
  }> {
    if (this.connection?.connected) {
      if (this.connection.port.address === portAddress) {
        if (this.connection.baudRate === baudRate) {
          return this.statusForResult();
        }
        // Reconnecting is the only reliable way to change the rate - see the
        // note on stopping the monitor below - and silently reporting the old
        // rate would hand back a status that does not match the wire.
        await this.disconnect();
      } else {
        throw new Error(
          `Already connected to ${this.connection.port.address}. Use the disconnect action first.`
        );
      }
    }

    const detectedPorts = await this.boardsService().getDetectedPorts();
    // The IDE extension ships no type declarations; treat entries as untyped.
    const detectedEntries = Object.values(detectedPorts) as any[];
    const entry = detectedEntries.find(
      (dp) => dp.port.address === portAddress
    );
    if (!entry) {
      const known = detectedEntries
        .map((dp) => dp.port.address)
        .join(', ');
      throw new Error(
        `Port not found: ${portAddress}. Detected ports: ${known || '(none)'}`
      );
    }

    const detectedBoard = entry.boards?.[0] as
      | { name?: string; fqbn?: string }
      | undefined;
    const fqbn = fqbnOverride ?? detectedBoard?.fqbn;
    if (!fqbn) {
      throw new Error(
        `Cannot identify the board on ${portAddress}. Pass an explicit fqbn (e.g. arduino:avr:uno).`
      );
    }
    const board = { name: detectedBoard?.name ?? 'Unknown board', fqbn };
    const port = entry.port;
    const manager = this.monitorManager();

    // `changeMonitorSettings` only takes effect when the monitor service is
    // CREATED, so an already-running service silently keeps its old baud rate
    // and the caller reads garbage while we report the rate they asked for.
    // A service can already exist without us having opened it - the IDE
    // restarts the monitor by itself after an upload - so stop it first and
    // let startMonitor build a fresh one from the settings below.
    await manager.stopMonitor(board, port).catch(() => undefined);

    manager.changeMonitorSettings(board, port, {
      baudrate: {
        id: 'baudrate',
        label: 'Baudrate',
        type: 'enum',
        values: SUPPORTED_BAUD_RATES.map(String),
        selectedValue: String(baudRate),
      },
    });

    await manager.startMonitor(board, port, async () => {
      const wsPort = manager.getWebsocketAddressPort(board, port);
      if (wsPort <= 0) {
        throw new Error('Monitor WebSocket is not available');
      }
      await this.openWebSocket(wsPort, board, port, baudRate);
    });

    if (!this.connection?.connected) {
      throw new Error(`Failed to connect the monitor on ${portAddress}`);
    }

    // The monitor announces its real settings over the websocket
    // (ON_SETTINGS_DID_CHANGE) and we track that, so `baudRate` below is always
    // the rate actually in use. It can differ from the one asked for: the IDE
    // keeps its own monitor settings for a port and will override us. Say so
    // rather than returning a different number with no explanation - a silently
    // ignored baud rate reads as broken hardware.
    const result = this.statusForResult();
    if (result.baudRate !== baudRate) {
      return {
        ...result,
        requestedBaudRate: baudRate,
        warning:
          `The monitor for ${portAddress} is running at ${result.baudRate} baud; ` +
          `the requested ${baudRate} was not applied because the IDE keeps its own ` +
          `setting for this port. Output will be unreadable unless the sketch also ` +
          `uses ${result.baudRate} - change the rate in the IDE's Serial Monitor, ` +
          `or match it in Serial.begin().`,
      };
    }
    return result;
  }

  private openWebSocket(
    wsPort: number,
    board: { name: string; fqbn: string },
    port: Port,
    baudRate: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      const connection: ActiveConnection = {
        board,
        port,
        baudRate,
        ws,
        buffer: '',
        connected: false,
        bufferStartOffset: 0,
        lineRemainder: '',
        waiters: [],
        events: [],
        crashPendingDetail: null,
      };

      ws.on('open', () => {
        connection.connected = true;
        this.connection = connection;
        resolve();
      });
      ws.on('error', (err) => {
        if (!connection.connected) {
          reject(err);
        }
        connection.connected = false;
        this.flushWaiters(connection);
      });
      ws.on('close', () => {
        connection.connected = false;
        this.flushWaiters(connection);
      });
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (Array.isArray(message)) {
            // Board output: an array of string chunks.
            const chunk = message.join('');
            connection.buffer += chunk;
            if (connection.buffer.length > MAX_BUFFER_CHARS) {
              // Advance the global offset by exactly what we drop, so cursors
              // handed out earlier stay meaningful (they report as `dropped`).
              connection.bufferStartOffset +=
                connection.buffer.length - MAX_BUFFER_CHARS;
              connection.buffer = connection.buffer.slice(-MAX_BUFFER_CHARS);
            }
            this.processChunk(connection, chunk);
          } else if (
            message?.command === Monitor.MiddlewareCommand.ON_SETTINGS_DID_CHANGE
          ) {
            const selected =
              message.data?.pluggableMonitorSettings?.baudrate?.selectedValue;
            if (selected) {
              connection.baudRate = Number(selected) || connection.baudRate;
            }
          }
        } catch {
          // Non-JSON payloads are unexpected; ignore them.
        }
      });
    });
  }

  /**
   * Line scanner: assembles complete lines across chunk boundaries (chunks
   * arrive mid-line) and feeds them to pending wait_for waiters. Each line
   * carries the global cursor just past its newline.
   */
  private processChunk(connection: ActiveConnection, chunk: string): void {
    let data = connection.lineRemainder + chunk;
    // Global offset of the start of `data`. Total received so far is
    // bufferStartOffset + buffer.length (the chunk is already appended); back
    // up over the chunk and the carried remainder to find where `data` begins.
    let dataStart =
      connection.bufferStartOffset +
      connection.buffer.length -
      chunk.length -
      connection.lineRemainder.length;
    let index: number;
    while ((index = data.indexOf('\n')) !== -1) {
      const line = data.slice(0, index).replace(/\r$/, '');
      const lineEndCursor = dataStart + index + 1;
      this.handleCompleteLine(connection, line, lineEndCursor);
      data = data.slice(index + 1);
      dataStart += index + 1;
    }
    connection.lineRemainder = data;
  }

  private handleCompleteLine(
    connection: ActiveConnection,
    line: string,
    lineEndCursor: number
  ): void {
    this.classifyLine(connection, line, lineEndCursor);

    if (!connection.waiters.length) {
      return;
    }
    const matched = connection.waiters.filter((w) => w.regex.test(line));
    for (const waiter of matched) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        matched: true,
        line,
        cursor: lineEndCursor,
        elapsed_ms: Date.now() - waiter.startedAt,
      });
    }
    if (matched.length) {
      connection.waiters = connection.waiters.filter(
        (w) => !matched.includes(w)
      );
    }
  }

  /** Matches crash/reset signatures and records SerialEvents. */
  private classifyLine(
    connection: ActiveConnection,
    line: string,
    lineEndCursor: number
  ): void {
    // A panic/abort is followed by its backtrace a few lines later - attach it
    // as detail instead of recording a separate event.
    if (connection.crashPendingDetail && /^Backtrace:/.test(line)) {
      connection.crashPendingDetail.detail = line;
      connection.crashPendingDetail = null;
      return;
    }

    for (const signature of EVENT_SIGNATURES) {
      const match = line.match(signature.pattern);
      if (!match) {
        continue;
      }
      const event: SerialEvent = {
        type: signature.type,
        line,
        cursor: lineEndCursor,
        timestamp: Date.now(),
        detail: signature.detail?.(match),
      };
      connection.events.push(event);
      if (connection.events.length > MAX_EVENTS) {
        connection.events.shift();
      }
      if (event.type === 'panic' || event.type === 'abort') {
        connection.crashPendingDetail = event;
      }
      // Terminal events end pending waits early: the awaited output is not
      // coming from a board that just crashed or rebooted. A watchdog warning
      // can be transient (it does not always abort), so it only records.
      if (event.type !== 'watchdog') {
        this.resolveWaitersWithEvent(connection, event);
      }
      return; // first signature wins
    }
  }

  private resolveWaitersWithEvent(
    connection: ActiveConnection,
    event: SerialEvent
  ): void {
    const waiters = connection.waiters;
    connection.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        matched: false,
        event,
        cursor: event.cursor,
        message: `Board ${
          event.type === 'reset' ? 'reset' : 'crashed'
        } while waiting (${event.type}${
          event.detail ? `: ${event.detail}` : ''
        })`,
      });
    }
  }

  /** Resolves every pending waiter as disconnected (close, error, disconnect). */
  private flushWaiters(connection: ActiveConnection): void {
    const waiters = connection.waiters;
    connection.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        matched: false,
        disconnected: true,
        cursor: connection.bufferStartOffset + connection.buffer.length,
      });
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    this.connection = null;
    this.flushWaiters(connection);
    try {
      connection.ws.close();
    } catch {
      // best effort
    }
    // Closing the last WS client disposes the monitor, but stop explicitly for determinism.
    await this.monitorManager()
      .stopMonitor(connection.board, connection.port)
      .catch(() => undefined);
  }

  /**
   * Reads captured output.
   *
   * Without `since`: the last `maxLines` lines (a tail snapshot), plus the
   * current global `cursor` so the next call can page losslessly.
   *
   * With `since` (a cursor from a previous response): the FIRST `maxLines`
   * complete lines at or after that offset, `cursor` set just past the last
   * returned line, `dropped` counting chars lost to buffer truncation before
   * `since`, and `has_more` when further complete lines are already buffered.
   * A trailing partial line is held back until its newline arrives.
   */
  read(
    maxLines: number,
    since?: number
  ): {
    lines: string[];
    count: number;
    cursor: number;
    dropped: number;
    has_more: boolean;
    events: SerialEvent[];
  } {
    const connection = this.requireConnection();
    const end = connection.bufferStartOffset + connection.buffer.length;

    if (since === undefined) {
      const lines = connection.buffer.split(/\r?\n/);
      // Drop a trailing empty segment caused by a terminating newline.
      if (lines.length && lines[lines.length - 1] === '') {
        lines.pop();
      }
      const slice = lines.slice(-maxLines);
      return {
        lines: slice,
        count: slice.length,
        cursor: end,
        dropped: 0,
        has_more: false,
        events: [...connection.events],
      };
    }

    const clamped = Math.max(
      connection.bufferStartOffset,
      Math.min(since, end)
    );
    const dropped = Math.max(0, connection.bufferStartOffset - since);
    const region = connection.buffer.slice(
      clamped - connection.bufferStartOffset
    );

    const lines: string[] = [];
    let pos = 0;
    while (lines.length < maxLines) {
      const nl = region.indexOf('\n', pos);
      if (nl === -1) {
        break;
      }
      lines.push(region.slice(pos, nl).replace(/\r$/, ''));
      pos = nl + 1;
    }
    return {
      lines,
      count: lines.length,
      cursor: clamped + pos,
      dropped,
      has_more: region.indexOf('\n', pos) !== -1,
      // Only events the caller has not seen yet.
      events: connection.events.filter((e) => e.cursor > since),
    };
  }

  /**
   * Blocks until a line matching `pattern` arrives, the timeout elapses, or
   * the connection drops. When `since` is given, already-buffered complete
   * lines from that cursor are scanned first, so output that arrived between
   * calls cannot be missed.
   */
  async waitFor(
    pattern: string,
    isRegex: boolean,
    timeoutSeconds: number,
    since?: number
  ): Promise<SerialWaitResult> {
    const connection = this.requireConnection();
    let regex: RegExp;
    try {
      regex = isRegex ? new RegExp(pattern) : new RegExp(escapeRegExp(pattern));
    } catch (e) {
      throw new Error(
        `Invalid regular expression "${pattern}": ${
          e instanceof Error ? e.message : e
        }`
      );
    }
    const startedAt = Date.now();
    const end = connection.bufferStartOffset + connection.buffer.length;

    // Scan what is already buffered (complete lines only) from `since`.
    if (since !== undefined) {
      const clamped = Math.max(
        connection.bufferStartOffset,
        Math.min(since, end)
      );
      const region = connection.buffer.slice(
        clamped - connection.bufferStartOffset
      );
      let pos = 0;
      let nl: number;
      while ((nl = region.indexOf('\n', pos)) !== -1) {
        const line = region.slice(pos, nl).replace(/\r$/, '');
        if (regex.test(line)) {
          return {
            matched: true,
            line,
            cursor: clamped + nl + 1,
            elapsed_ms: Date.now() - startedAt,
          };
        }
        pos = nl + 1;
      }
    }

    return new Promise<SerialWaitResult>((resolve) => {
      const waiter: SerialWaiter = {
        regex,
        startedAt,
        resolve,
        timer: setTimeout(() => {
          connection.waiters = connection.waiters.filter((w) => w !== waiter);
          resolve({
            matched: false,
            timed_out: true,
            cursor: connection.bufferStartOffset + connection.buffer.length,
            hint: `No line matched within ${timeoutSeconds}s. Use read with since=<your last cursor> to inspect what the board actually printed.`,
          });
        }, timeoutSeconds * 1000),
      };
      connection.waiters.push(waiter);
    });
  }

  write(data: string): { bytesSent: number } {
    const connection = this.requireConnection();
    connection.ws.send(
      JSON.stringify({ command: Monitor.ClientCommand.SEND_MESSAGE, data })
    );
    return { bytesSent: Buffer.byteLength(data, 'utf8') };
  }

  /**
   * Changes the baud rate of the live connection.
   *
   * Sending CHANGE_SETTINGS over the websocket is not enough on its own: a
   * monitor service that is already running keeps its original rate, so the
   * old code reported the new rate while the wire stayed on the old one and
   * the caller kept reading garbage. Reconnect instead - `connect` stops the
   * monitor service and rebuilds it with these settings - so the value we
   * report is the value in use.
   *
   * Note that reopening the port toggles DTR/RTS, which resets most boards.
   */
  async setBaudRate(baudRate: number): Promise<{ baudRate: number }> {
    const connection = this.requireConnection();
    if (connection.baudRate === baudRate) {
      return { baudRate };
    }
    const portAddress = connection.port.address;
    const fqbn = connection.board.fqbn;
    const result = await this.connect(portAddress, baudRate, fqbn);
    return { baudRate: result.baudRate };
  }

  clear(): void {
    const c = this.connection;
    if (c) {
      // Cursors stay monotonic across clear(): advance the start offset so a
      // stale cursor from before the clear reports `dropped` chars instead of
      // silently mapping onto unrelated new output.
      c.bufferStartOffset += c.buffer.length;
      c.buffer = '';
      c.lineRemainder = '';
      c.events = [];
      c.crashPendingDetail = null;
    }
  }

  status(): {
    connected: boolean;
    port: string | null;
    baudRate: number | null;
    board: string | null;
    cursor: number | null;
    buffered_chars: number | null;
    event_count: number;
    last_event: SerialEvent | null;
  } {
    const c = this.connection;
    return {
      connected: c?.connected ?? false,
      port: c?.port.address ?? null,
      baudRate: c?.baudRate ?? null,
      board: c?.board.name ?? null,
      cursor: c ? c.bufferStartOffset + c.buffer.length : null,
      buffered_chars: c ? c.buffer.length : null,
      event_count: c?.events.length ?? 0,
      last_event: c?.events.length ? c.events[c.events.length - 1] : null,
    };
  }

  isConnected(): boolean {
    return this.connection?.connected ?? false;
  }

  private statusForResult(): {
    port: string;
    baudRate: number;
    board: string;
    fqbn: string;
  } {
    const c = this.connection!;
    return {
      port: c.port.address,
      baudRate: c.baudRate,
      board: c.board.name,
      fqbn: c.board.fqbn,
    };
  }

  private requireConnection(): ActiveConnection {
    if (!this.connection || !this.connection.connected) {
      throw new Error(
        'Not connected to a serial port. Use the connect action first.'
      );
    }
    return this.connection;
  }
}
