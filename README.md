<img src="static/screenshot.png" align="right" width="380" />

# Arduino Agent

**The AI-native Arduino IDE.** Arduino Agent is a full Arduino IDE 2.x with a
Model Context Protocol (MCP) server built into its core — so an AI agent like
Claude can write sketches, compile them, upload to real boards, read the serial
monitor, and manage libraries *alongside you*, editing the same files you see in
the editor in real time.

There's no plugin to install into the AI, no sidecar process, no copy-pasting
code back and forth. **The IDE itself is the agent's workbench.** You launch it,
point your assistant at `http://127.0.0.1:3847`, and the two of you share one
editor, one board, one serial monitor.

<sub>Built on [Arduino IDE 2.x](https://github.com/arduino/arduino-ide) · An
independent community project, not affiliated with or endorsed by Arduino SA ·
AGPL-3.0</sub>

---

## Why it exists

The Arduino IDE is where embedded projects get built. Modern AI agents are great
at embedded code — but they work blind, guessing at your board, your errors, and
your wiring, and handing you snippets to paste. Arduino Agent closes that gap by
making the IDE a first-class participant in the conversation:

- **The agent sees what you see** — the open sketch, the selected board and port,
  connected devices, and real compiler output (not a guess).
- **You see what the agent does** — when it writes a file, the editor opens it,
  reloads it, and shows a *"Created by Claude"* notification. True pair
  programming on hardware.
- **It drives the real toolchain** — the same `arduino-cli`, clang-format, and
  serial monitor the IDE uses. Compile results, memory usage, and upload status
  are the genuine article.

## Download

Unsigned development builds of the **[latest release](https://github.com/mixelpixx/Arduino-Agent/releases/latest)** — these links always point at the newest version:

- [**Windows x64**](https://github.com/mixelpixx/Arduino-Agent/releases/latest/download/arduino-ide-mcp-windows.zip)
- [**macOS**](https://github.com/mixelpixx/Arduino-Agent/releases/latest/download/arduino-ide-mcp-macos.zip)
- [**Linux x64**](https://github.com/mixelpixx/Arduino-Agent/releases/latest/download/arduino-ide-mcp-linux.zip)

Unzip and run `Arduino IDE` (`Arduino IDE.exe` on Windows). Release notes and
older builds are on the
[Releases](https://github.com/mixelpixx/Arduino-Agent/releases) page.

> These are unsigned dev builds. On macOS you may need to allow the app under
> **System Settings → Privacy & Security**; on Windows, dismiss SmartScreen with
> **More info → Run anyway**. Prefer to build it yourself? See
> [Building from source](#building-from-source).

## Quick start — connect your agent

1. **Launch the IDE.** The MCP server starts automatically on
   `http://127.0.0.1:3847` and prints a ready-to-paste client configuration —
   including your auth token — to the console.

2. **Add it to your MCP client.** For Claude Code / Claude Desktop, drop this
   into your `.mcp.json` (the token lives in `~/.arduinoIDE/mcp-token`):

   ```json
   {
     "mcpServers": {
       "arduino": {
         "type": "http",
         "url": "http://127.0.0.1:3847/mcp",
         "headers": { "Authorization": "Bearer <your-token>" }
       }
     }
   }
   ```

   > **Tip — avoid "server failed to connect" when the IDE is closed.** The MCP
   > server lives *inside* the IDE, so a direct HTTP connection fails whenever
   > the IDE isn't running. Use the bundled stdio bridge instead and the server
   > always connects, reporting "Arduino Agent is not running" only when you
   > actually call a tool — and recovering by itself once you launch the IDE:
   >
   > ```json
   > {
   >   "mcpServers": {
   >     "arduino": {
   >       "command": "node",
   >       "args": ["/path/to/arduino-mcp-extension/bridge/arduino-agent-bridge.js"]
   >     }
   >   }
   > }
   > ```
   >
   > It needs no token configuration (it reads `~/.arduinoIDE/mcp-token` itself)
   > and no dependencies. See [the bridge README](arduino-mcp-extension/bridge/README.md)
   > for auto-launch and other options.

   > **Claude Code users:** the server sends workflow guidance automatically,
   > and ships three slash commands (`/bringup`, `/debug-serial`,
   > `/profile-board`). For deeper hardware know-how, install the bundled
   > skill: copy [`skills/arduino-agent/`](skills/arduino-agent/) into
   > `~/.claude/skills/`.

3. **Talk to your board.**
   - *"Create a Blink sketch and open it."*
   - *"What boards are connected?"*
   - *"Compile for the Uno and explain any errors."*
   - *"Upload it, then show me the serial output at 115200."*

## What the agent can do

| Category | Operations |
|----------|------------|
| **Sketches** | Create, open, and edit sketches; read/write code; browse and clone built-in examples |
| **Build** | Compile with `wait:true` for one-call results; live progress; real compiler output with structured, explained errors |
| **Upload** | Compile + flash in one call; failures come back explained (bootloader mode, busy port, wrong FQBN, power) |
| **Boards** | Detect connected boards with USB vid/pid; identify unknown boards (`suggest_fqbn`); pin capabilities; install cores |
| **Serial** | Cursor-based lossless reads; `wait_for` a pattern; automatic crash/reset/watchdog/brownout detection |
| **Libraries** | Search the registry; install/remove; browse library examples |
| **Formatting** | Format Arduino/C++ with clang-format |
| **Config** | Sketchbook location, board-manager URLs, IDE settings |

By default the tools are exposed through a **router pattern** — 4 meta-tools
(`list_tool_categories`, `get_category_tools`, `execute_tool`, `search_tools`)
so the agent discovers tools on demand instead of loading every definition into
its context. A **direct mode** exposes all tools individually if you prefer.

## How it works

```
+------------------+     HTTP (Bearer auth)     +---------------------------+
|    AI agent      | <------------------------> |      Arduino Agent        |
|  (MCP client)    |   http://127.0.0.1:3847    |  (Theia/Electron + MCP)    |
+------------------+           /mcp             +------------------------------+
                                                      |
                                             Arduino toolchain
                                        (arduino-cli daemon, clang-format,
                                         pluggable serial monitor)
```

The MCP server is embedded in the IDE's backend and speaks the modern
**Streamable HTTP** transport (plus legacy SSE for older clients), supporting
multiple simultaneous sessions.

**Security is on by default:**
- Binds to `127.0.0.1` only.
- Requires a bearer token (generated on first launch, stored in
  `~/.arduinoIDE/mcp-token`).
- Rejects browser-originated requests and sends no CORS headers, so a web page
  can't reach it.
- Confines file access to your sketchbook and the built-in examples.

The only unauthenticated endpoint is a health check:

```bash
curl http://127.0.0.1:3847/health
```

## Settings

**File → Preferences → MCP:**

| Setting | Description | Default |
|---------|-------------|---------|
| Enable MCP server | Turn the integration on/off | `true` |
| Start automatically | Launch the server with the IDE | `true` |
| Server port | HTTP port (1024–65535) | `3847` |
| Require auth | Require the bearer token | `true` |
| Log level | none / error / info / debug | `info` |
| Tool mode | Router (4 meta-tools) or Direct (all tools) | `router` |

## Made for learning, too

Arduino Agent ships extras aimed at STEM and classroom use:

- **Example browser** — every built-in Arduino example, with descriptions.
- **Hardware reference** — ask for a board's pin map, PWM/I2C/SPI pins, memory.
- **Beginner-friendly errors** — compiler errors returned with plain-language
  explanations and suggested fixes.

It also carries a modernized UI (refined buttons, dialogs, board selector,
progress bars, and serial monitor) that respects both light and dark themes.

## Building from source

**Prerequisites:** Node.js 18+, Yarn 4 (via Corepack), Python 3.11, Go 1.21, and
a C/C++ toolchain (VS 2022 Build Tools on Windows).

```bash
git clone https://github.com/mixelpixx/arduino-mcp.git
cd arduino-mcp

corepack enable
yarn install
yarn prepare:shims      # create the launcher shims Theia's build expects

yarn build:dev          # build all packages, including the MCP extension
cd electron-app && yarn start
```

Windows has a few extra native-module notes (mostly automated now) — see
[**docs/BUILDING-WINDOWS.md**](docs/BUILDING-WINDOWS.md). Full extension
documentation lives in
[**arduino-mcp-extension/README.md**](arduino-mcp-extension/README.md).

## Project status

Actively developed, and **verified against real hardware** — an ESP32-S3
(N16R8) driven end to end through the MCP tools alone:

> install the board core → create a sketch → write the code → compile →
> upload → read the board's own serial output

Every step ran as an MCP call, with no manual work in the IDE. In one pass the
agent wrote a WiFi scanner, flashed it, and read 21 access points back off the
board.

Those sessions shaped the tooling itself. v0.6.0 turned every pain point they
surfaced into a feature: `wait:true` replaces polling loops, serial reads are
lossless and cursor-based, crashes/resets/watchdogs are detected and reported
as events, upload failures come back explained, and `suggest_fqbn` identifies
boards arduino-cli can't. The server also now teaches connected agents its own
workflow (instructions at connect, `/bringup`-style prompts, a Claude Code
skill).

Release builds for **Windows, macOS and Linux** are produced by CI and attached
to every tagged release.

**Known limits:** artifacts are unsigned. Boards whose USB VID/PID appear in no
`boards.txt` (many ESP32-S3 devkits) can't be auto-identified — use
`arduino_board suggest_fqbn`, then pass the FQBN explicitly. Uploading over a
board's *native* USB port can require manual bootloader entry; a UART bridge
port works without it.

Contributions and bug reports are welcome via
[Issues](https://github.com/mixelpixx/arduino-mcp/issues) and pull requests.

## Relationship to the Arduino IDE

Arduino Agent is a fork of the open-source
**[Arduino IDE 2.x](https://github.com/arduino/arduino-ide)** (a
[Theia](https://theia-ide.org/)/[Electron](https://www.electronjs.org/)
application that drives the [arduino-cli](https://github.com/arduino/arduino-cli)).
All of the core IDE work is theirs; this project adds the embedded MCP server,
the AI-collaboration features, and the UI refinements on top.

**Arduino® is a trademark of Arduino SA.** Arduino Agent is an independent,
community project and is **not affiliated with, sponsored by, or endorsed by
Arduino SA.** The name describes this project's purpose — an agent-driven Arduino
development environment — and implies no official connection.

## License

Licensed under the **GNU AGPL-3.0-or-later**, the same license as the upstream
Arduino IDE. Distributions include third-party components under compatible
licenses (GPLv2, MIT, BSD-3). See [LICENSE.txt](LICENSE.txt).
