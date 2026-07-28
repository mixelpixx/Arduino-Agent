# Arduino MCP Extension

MCP (Model Context Protocol) server **embedded directly** in Arduino IDE 2.x, enabling AI assistants like Claude Code to programmatically interact with the IDE.

Designed with **STEM education** in mind - includes built-in example browsing, hardware reference data, and beginner-friendly error explanations.

## Architecture

The extension embeds the MCP server directly in the IDE using HTTP transport
(Streamable HTTP at `/mcp`, plus the legacy SSE transport at `/sse` for older clients):

```
+------------------+     HTTP (Bearer auth)  +------------------+
|   Claude Code    |<----------------------->|   Arduino IDE    |
|   (MCP Client)   |   http://127.0.0.1:3847 |   (MCP Server)   |
+------------------+          /mcp           +------------------+
                                                      ↓
                                             Arduino Services
                                            (Sketches, Boards,
                                             Libraries, Core,
                                             Monitor, Formatter,
                                             Config)
```

**The Arduino IDE IS the MCP server** - no sidecar process, no abstraction layer.

## Security

- The server binds to `127.0.0.1` only and **requires a bearer token** by default.
  The token is generated on first start and stored in `~/.arduinoIDE/mcp-token`;
  the IDE logs a ready-to-paste client configuration on startup.
- Requests carrying a browser `Origin` header are rejected and no CORS headers are
  sent, so web pages cannot reach the server.
- File access through MCP tools is restricted to the sketchbook, the built-in
  examples (read-only), and temporary sketches. Set `ARDUINO_MCP_UNRESTRICTED_FS=1`
  to lift the restriction (not recommended).
- Multiple MCP clients can be connected at the same time; each gets its own session.

### Why Embedded?

Previous versions used a "sidecar" pattern (separate Node.js process) to work around Electron's stdout pollution. This version uses HTTP/SSE transport instead, which:

- Eliminates the sidecar entirely
- Reduces complexity (one process, one protocol)
- Makes the IDE the true MCP server (not a proxy)
- Provides cleaner configuration

## Key Features

### Complete Arduino Workflow Support

The extension provides 11 tools covering the entire Arduino development workflow:

| Tool | Description |
|------|-------------|
| `arduino_sketch` | Create, open, edit sketches; browse and clone examples |
| `arduino_compile` | Compilation with `wait:true` one-call results, or async with progress tracking |
| `arduino_upload` | Compile + flash in one call (destructive); failures explained |
| `arduino_board` | Board detection with USB vid/pid, FQBN suggestion, selection, hardware reference |
| `arduino_serial` | Serial monitor: cursor-based reads, `wait_for`, crash/reset event detection |
| `arduino_library` | Search, install, and manage Arduino libraries |
| `arduino_context` | Query current IDE state |
| `arduino_task_status` | Monitor async operation progress |
| `arduino_build_output` | Retrieve build results with optional error explanations |
| `arduino_format` | Format code using clang-format |
| `arduino_config` | Manage IDE configuration (board URLs, sketchbook location) |

### Real-Time Code Sync

When Claude modifies files through MCP tools, the IDE immediately:
- Opens and focuses the changed file
- Shows a notification ("Created by Claude: sketch.ino")
- Auto-reloads the content in the editor

This provides a seamless pair-programming experience where you see changes as Claude makes them.

### STEM Education Enhancements

#### Built-in Example Browser

Access all Arduino built-in examples directly:

```
arduino_sketch action=list_examples
arduino_sketch action=list_examples category=01.Basics
```

Returns categorized examples with descriptions:
- 01.Basics: Blink, DigitalReadSerial, AnalogReadSerial, Fade
- 02.Digital: Button, Debounce, StateChangeDetection
- 03.Analog: AnalogInOutSerial, Calibration, Smoothing
- And more...

#### One-Click Example Projects

Create a new sketch from any example:

```
arduino_sketch action=from_example example_path=<path>
```

Copies the example to your sketch folder, ready for modification.

#### Hardware Reference Data

Query board specifications and pin capabilities:

```
arduino_board action=get_info fqbn=arduino:avr:uno
```

Returns:
```json
{
  "name": "Arduino Uno",
  "fqbn": "arduino:avr:uno",
  "pinInfo": {
    "digitalPins": 14,
    "analogPins": 6,
    "pwmPins": [3, 5, 6, 9, 10, 11],
    "i2cPins": {"sda": 18, "scl": 19},
    "spiPins": {"mosi": 11, "miso": 12, "sck": 13, "ss": 10},
    "ledPin": 13,
    "notes": "PWM pins are marked with ~ on the board. A4/A5 can also be used as analog inputs."
  }
}
```

Supported boards include Arduino Uno, Nano, Mega, Leonardo, and ESP32.

#### Beginner-Friendly Error Messages

Get compilation errors with explanations:

```
arduino_build_output format=explained
```

Transforms cryptic compiler output into understandable messages with suggested fixes.

## Installation

### Prerequisites

- Node.js 18 or later
- Yarn 4.x
- Git

### Build from Source

```bash
# Clone the repository
git clone https://github.com/mixelpixx/arduino-mcp.git
cd arduino-mcp

# Install dependencies (Yarn 4 via corepack)
corepack enable
yarn install

# Create the launcher shims Theia's build expects
yarn prepare:shims

# Build all packages
yarn build:dev

# Start the IDE
cd electron-app
yarn start
```

> On Windows, see [docs/BUILDING-WINDOWS.md](../docs/BUILDING-WINDOWS.md) for
> prerequisites and native-module build notes.

### Configure Claude Code

When the IDE starts, it prints a ready-to-paste configuration (including your auth
token) to the console and shows it when you toggle the MCP preference. It looks like:

```json
{
  "mcpServers": {
    "arduino": {
      "type": "http",
      "url": "http://127.0.0.1:3847/mcp",
      "headers": {
        "Authorization": "Bearer <token from ~/.arduinoIDE/mcp-token>"
      }
    }
  }
}
```

Add it to your project's `.mcp.json` (or use `claude mcp add --transport http arduino http://127.0.0.1:3847/mcp --header "Authorization: Bearer <token>"`).

Clients that only support the older SSE transport can use `http://127.0.0.1:3847/sse`
(append `?token=<token>` if they cannot send headers).

**Note:** The MCP server runs on port 3847 by default. You can change this in Arduino IDE preferences.

## IDE Settings

Access via **File > Preferences > Settings**, search for "MCP":

| Setting | Description | Default |
|---------|-------------|---------|
| `arduino.mcp.enabled` | Enable/disable MCP server | `true` |
| `arduino.mcp.autoConnect` | Auto-start MCP server on IDE launch | `true` |
| `arduino.mcp.port` | HTTP port for MCP server (restarts the server immediately) | `3847` |
| `arduino.mcp.requireAuth` | Require the bearer token for connections (change needs IDE restart) | `true` |
| `arduino.mcp.logLevel` | Logging verbosity (none, error, info, debug) | `info` |
| `arduino.mcp.toolMode` | Tool exposure mode (router or direct) | `router` |

### Tool Modes

The extension supports two tool exposure modes:

#### Router Mode (Default, Recommended)

Exposes only 4 meta-tools to minimize LLM context window usage:

| Tool | Description |
|------|-------------|
| `list_tool_categories` | List available tool categories (sketch, build, board, serial, library, ide) |
| `get_category_tools` | Get detailed info about tools in a category |
| `execute_tool` | Execute a specific tool by name |
| `search_tools` | Search for tools by keyword |

Claude Code discovers tools on-demand instead of loading all 11+ tool definitions upfront. This is especially important for models with limited context windows.

#### Direct Mode

Exposes all 11+ individual tools directly. Simpler prompting but uses more context.

## Usage

### Quick Start

1. Launch Arduino IDE
2. The MCP server starts automatically on `http://127.0.0.1:3847`
3. Configure Claude Code with the URL above
4. Restart Claude Code (required after configuration changes)
5. Begin interacting with Arduino through natural language

### Verify Connection

Check the MCP server health:

```bash
curl http://127.0.0.1:3847/health
```

Expected response:
```json
{
  "status": "ok",
  "server": "arduino-ide-mcp",
  "version": "0.5.0",
  "uptime": 123,
  "auth": true
}
```

The `/health` endpoint is the only unauthenticated endpoint; everything else
requires the bearer token (unless `arduino.mcp.requireAuth` is disabled).

### Example Interactions

**Learning and exploration:**
- "List the basic Arduino examples"
- "Show me information about the Arduino Uno board"
- "What pins support PWM on the Mega?"

**Project development:**
- "Create a new sketch from the Blink example"
- "Read the current sketch content"
- "Compile the sketch and explain any errors"
- "Upload to the board on /dev/ttyUSB0"

**Library management:**
- "Search for WiFi libraries"
- "Install the ArduinoJson library"
- "Show examples from the Servo library"

**Serial communication:**
- "Connect to serial port /dev/ttyUSB0 at 115200 baud"
- "Read the last 50 lines from serial"
- "Send 'hello' to the serial port"

**Code formatting:**
- "Format this code: void setup(){...}"

**Configuration:**
- "Add this board manager URL: https://..."
- "Show current IDE configuration"

## Tool Reference

### arduino_sketch

| Action | Parameters | Description |
|--------|------------|-------------|
| `create` | `name` (optional) | Create new sketch (named in the sketchbook, or temporary) |
| `open` | `path` | Open existing sketch |
| `list` | - | List user sketches |
| `get_current` | - | Get currently open sketch info |
| `get_content` | `path` | Read file content |
| `set_content` | `path`, `content` | Write file content |
| `get_files` | - | List files in current sketch |
| `list_examples` | `category` (optional) | List built-in examples |
| `from_example` | `example_path` | Create sketch from example |

### arduino_board

| Action | Parameters | Description |
|--------|------------|-------------|
| `list_connected` | - | List USB-connected boards |
| `list_available` | - | List installed board definitions |
| `get_selected` | - | Get the IDE board selection and the MCP session override |
| `get_info` | `fqbn` | Get board specs and pin reference |
| `select` | `fqbn`, `port` | Set the default board/port for this MCP session (does not change the IDE UI) |
| `search` | `query` | Search board registry |
| `suggest_fqbn` | `name`, `port` | Propose FQBNs for an unidentified board from its USB vid/pid and/or name; names the core to install when missing |
| `install_core` | `core` | Install board support package |

`list_connected` includes each port's USB `vid`/`pid`/`serial_number`. A
bridge-chip vid (CH34x/CP210x/FTDI) identifies the adapter, not the MCU -
`suggest_fqbn` knows the difference and says so.

### arduino_compile

| Parameter | Description |
|-----------|-------------|
| `sketch_path` | Path to sketch (defaults to current) |
| `fqbn` | Fully Qualified Board Name |
| `verbose` | Enable verbose output |
| `wait` | Block until the build finishes (recommended) |
| `timeout_seconds` | Max seconds to block when `wait=true` (default 60, clamp 5-600) |

With `wait:true` the call returns the final result in one shot; if the timeout
elapses first you get the current progress plus `timed_out: true` (not an
error) and can keep waiting with `arduino_task_status {wait:true}`. Without
`wait` it returns a task ID immediately.

### arduino_upload

| Parameter | Description |
|-----------|-------------|
| `sketch_path` | Path to sketch (defaults to current) |
| `fqbn` | Fully Qualified Board Name |
| `port` | Serial port (e.g., /dev/ttyUSB0, COM3) |
| `verify` | Verify after upload |
| `wait` | Block until compile+flash finishes (recommended) |
| `timeout_seconds` | Max seconds to block when `wait=true` |

**Note:** This operation overwrites firmware on the target device.

### arduino_build_output

| Parameter | Description |
|-----------|-------------|
| `type` | What to retrieve: `output`, `errors`, `warnings`, `all` |
| `format` | `raw` or `explained` for beginner-friendly output |

### arduino_serial

| Action | Parameters | Description |
|--------|------------|-------------|
| `list_ports` | - | List available serial ports |
| `connect` | `port`, `baud_rate`, `fqbn` (optional) | Open connection |
| `disconnect` | - | Close connection |
| `read` | `max_lines`, `since` | Read buffered board output (cursor-based) |
| `wait_for` | `pattern`, `is_regex`, `timeout_seconds`, `since` | Block until a matching line arrives |
| `write` | `data`, `line_ending` | Send data |
| `clear` | - | Clear read buffer (cursors stay monotonic) |
| `get_config` | - | Get current connection config |
| `set_config` | `baud_rate` | Update connection settings |

Every `read`/`wait_for` response includes a `cursor`. Pass it back as `since`
to page through output **losslessly**: you get the next lines after that
offset, a `dropped` count if the 512 KB buffer overflowed in between, and
`has_more` when more complete lines are already buffered. Without `since`,
`read` returns the familiar tail snapshot. `wait_for` resolves with the
matching line, or `timed_out: true` / `disconnected: true` (never an error).

**Crash detection:** the output stream is scanned for crash/reset signatures
and matches come back as `events` on every `read`/`wait_for` response (and as
`event_count`/`last_event` in `get_config`):

| Event type | Signature |
|------------|-----------|
| `reset` | ESP32 `rst:0x… (REASON)` boot line (reason in `detail`) |
| `panic` | `Guru Meditation Error` (cause in `detail`, backtrace attached) |
| `watchdog` | `Task watchdog got triggered`, AVR `wdt reset` |
| `brownout` | `Brownout detector was triggered` (usually power supply) |
| `abort` | `abort() was called` |

A `reset`/`panic`/`brownout`/`abort` also **ends a pending `wait_for` early**
with the event attached — the output you were waiting for is not coming from a
board that just crashed. Watchdog warnings only record (they can be
transient). Note: on native-USB boards (ESP32-S2/S3/C3 with CDC), the ROM
bootloader's `rst:` line may not appear on the USB port; app-level panics and
watchdog messages still do.

### arduino_library

| Action | Parameters | Description |
|--------|------------|-------------|
| `search` | `query` | Search library registry |
| `install` | `name`, `version` | Install library |
| `remove` | `name` | Uninstall library |
| `list` | - | List installed libraries |
| `get_info` | `name` | Get library details |
| `get_examples` | `name` | List library examples |

### arduino_format

| Parameter | Description |
|-----------|-------------|
| `content` | Code to format |
| `tab_size` | Spaces per tab (default: 2) |
| `insert_spaces` | Use spaces instead of tabs (default: true) |

### arduino_config

| Action | Parameters | Description |
|--------|------------|-------------|
| `get` | - | Get current configuration |
| `set` | `sketch_dir`, `additional_urls` | Update configuration |
| `add_board_url` | `url` | Add a board manager URL |

### arduino_context

Returns current IDE state including:
- Open sketch information (from the IDE, or opened via MCP)
- Selected board and port (IDE selection and MCP session override)
- Connected boards
- Serial monitor status

### arduino_task_status

| Parameter | Description |
|-----------|-------------|
| `task_id` | Task ID from compile or upload operation |
| `wait` | Block until the task reaches a terminal status |
| `timeout_seconds` | Max seconds to block when `wait=true` |

Returns task status: `pending`, `running`, `completed`, `failed`, or `cancelled`.

## Guidance for agents

The server teaches connected agents how to use it:

- **Instructions at initialize** — every MCP client receives ~30 lines of
  workflow guidance (explicit FQBNs for unidentifiable boards, `wait:true`,
  cursor-based serial, crash events, BOOT-button recovery). Source:
  `src/common/mcp-instructions.ts`; the stdio bridge serves an identical copy
  when the IDE is closed (parity asserted by the smoke test).
- **MCP prompts** — `bringup`, `debug-serial`, `profile-board`; Claude Code
  surfaces them as slash commands.
- **Claude Code skill** — richer judgment (port choice, CDCOnBoot, watchdog
  rules, Wokwi simulation): [`skills/arduino-agent/`](../skills/arduino-agent/).

Deliberately **not** shipped: client-side hooks and custom subagents. The
instructions + prompts + skill cover the same ground without imposing
configuration on users; revisit only if a concrete need appears.

## Roadmap

- **v0.7 — pin-safety preflight**: validate pin choices against the target
  board (existence, input-only pins, strapping pins, PWM/I2C conflicts)
  before upload. Needs a real per-board pin database to be more than theater,
  which is why it did not ship in v0.6.

## Environment Variables

Environment variables override the IDE preferences:

| Variable | Description | Default |
|----------|-------------|---------|
| `ARDUINO_MCP_DISABLED` | Set to `1` to disable MCP server | (enabled) |
| `ARDUINO_MCP_PORT` | HTTP port for MCP server | `3847` |
| `ARDUINO_MCP_AUTOSTART` | Set to `0` to disable auto-start | `1` |
| `ARDUINO_MCP_TOKEN` | Use a specific auth token instead of the generated one | (generated) |
| `ARDUINO_MCP_NO_AUTH` | Set to `1` to disable authentication (not recommended) | (auth on) |
| `ARDUINO_MCP_UNRESTRICTED_FS` | Set to `1` to lift the sketchbook file-access sandbox (not recommended) | (sandboxed) |

## Development

### Project Structure

```
arduino-mcp-extension/
├── src/
│   ├── common/
│   │   ├── mcp-tools.ts         # MCP tool schemas and annotations
│   │   ├── mcp-types.ts         # Shared type definitions
│   │   └── mcp-service.ts       # Service protocol definition
│   ├── node/
│   │   ├── arduino-mcp-backend-module.ts  # Inversify DI module
│   │   ├── mcp-server.ts        # Embedded MCP server (Streamable HTTP + SSE)
│   │   ├── mcp-arduino-services.ts # DI child container + build output capture
│   │   ├── mcp-serial-manager.ts   # Serial monitor client (WebSocket)
│   │   ├── mcp-logger.ts        # Leveled logging
│   │   ├── mcp-service-impl.ts  # MCPService implementation
│   │   └── mcp-contribution.ts  # Backend lifecycle hooks + startup prefs
│   └── browser/
│       ├── arduino-mcp-frontend-module.ts
│       ├── mcp-frontend-contribution.ts  # Preference listener + IDE state sync
│       └── mcp-preferences.ts   # Settings UI
├── lib/                         # Compiled output
├── package.json
└── tsconfig.json
```

### Building

```bash
# Build the MCP extension only
cd arduino-mcp-extension
yarn build

# Build entire IDE with extension
cd ..
yarn build:dev
```

### Smoke Test

With the IDE running, verify the MCP server end-to-end (health, auth, session,
tool listing, context):

```bash
node test/manual/smoke-test.js
```

### Extending

To add a new tool:

1. Define the tool schema in `src/common/mcp-tools.ts`
2. Implement the handler in `src/node/mcp-server.ts` (in `executeArduinoTool`)
3. Update the safety table in `mcp-tools.ts`
4. Rebuild and test

## Troubleshooting

### Connection Issues

**"Connection refused" or timeout**

Verify:
- Arduino IDE is running
- MCP server started (check IDE console for `[arduino-mcp] MCP Server listening on http://127.0.0.1:3847`)
- Port is not blocked by firewall
- No other service using port 3847

**Check server health:**
```bash
curl http://127.0.0.1:3847/health
```

**"401 Unauthorized"**

Pass the auth token as an `Authorization: Bearer <token>` header (or `?token=` query
parameter). The token is stored in `~/.arduinoIDE/mcp-token` and the full client
configuration is printed to the IDE console on startup.

### Port Conflicts

If port 3847 is in use:

1. Open IDE preferences (File > Preferences > Settings)
2. Search for "mcp.port"
3. Change to an available port
4. Restart Arduino IDE
5. Update your Claude Code config with the new port

### Debugging

Enable verbose logging:
1. Open IDE preferences
2. Set `arduino.mcp.logLevel` to `debug`
3. Check IDE console (View > Toggle Developer Tools)

## Tool Safety Annotations

Spec-compliant MCP annotations are sent to clients with every tool definition:

| Tool | Read-Only | Destructive | Open World |
|------|-----------|-------------|------------|
| `arduino_sketch` | No | No | No |
| `arduino_compile` | No | No | No |
| `arduino_upload` | No | YES* | Yes |
| `arduino_build_output` | Yes | No | No |
| `arduino_board` | No | No | Yes |
| `arduino_serial` | No | No | Yes |
| `arduino_library` | No | No | Yes |
| `arduino_context` | Yes | No | No |
| `arduino_task_status` | Yes | No | No |
| `arduino_format` | Yes | No | No |
| `arduino_config` | No | No | No |

*arduino_upload overwrites device firmware - use caution

## License

AGPL-3.0-or-later (consistent with Arduino IDE licensing)

## References

- [Arduino IDE](https://github.com/arduino/arduino-ide)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Eclipse Theia](https://theia-ide.org/)
- [Arduino CLI](https://arduino.github.io/arduino-cli/)
