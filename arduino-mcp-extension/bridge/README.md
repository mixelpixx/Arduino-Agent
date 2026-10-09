# Open Duino MCP bridge

A tiny stdio ⇄ HTTP bridge for the MCP server embedded in Open Duino.

## Why

The MCP server runs *inside* the IDE, so it only listens on `127.0.0.1:3847`
while the IDE is open. If your MCP client connects to that URL directly, the
whole server shows up as **failed to connect** whenever the IDE happens to be
closed — which looks like a broken integration rather than an idle one.

This bridge is a stdio MCP server that your client spawns as a child process, so
**connecting always succeeds**, and the Arduino tools stay usable while the IDE
is closed:

- The client always sees the real tool list, not an empty one.
- Browsing the tools (`list_tool_categories`, `get_category_tools`,
  `search_tools`) and the prompts work without the IDE.
- A tool that needs the IDE **starts it and waits for it** when
  `ARDUINO_AGENT_PATH` is set — the first call is just slower. Without it, the
  call returns a plain "open the IDE" message.
- When the IDE comes up (or restarts) the bridge notices on its own and tells
  the client if the tool list changed. **No client restart required.**

## Usage

```json
{
  "mcpServers": {
    "arduino": {
      "command": "node",
      "args": ["/path/to/mcp-bridge/bridge/arduino-agent-bridge.js"],
      "env": { "ARDUINO_AGENT_PATH": "/path/to/Open Duino executable" }
    }
  }
}
```

OpenCode uses the same bridge in its local MCP configuration:

```jsonc
{
  "mcp": {
    "servers": {
      "open-duino": {
        "type": "local",
        "command": ["node", "/path/to/arduino-agent-bridge.js"],
        "environment": { "ARDUINO_AGENT_PATH": "/path/to/Open Duino executable" }
      }
    }
  }
}
```

Where to find it:

| Running from | Bridge path |
|--------------|-------------|
| Release, Windows / Linux | `<unzipped folder>/resources/mcp-bridge/bridge/arduino-agent-bridge.js` |
| Release, macOS | `Open Duino.app/Contents/Resources/mcp-bridge/bridge/arduino-agent-bridge.js` |
| Source checkout | `arduino-mcp-extension/bridge/arduino-agent-bridge.js`, after `yarn build` in `arduino-mcp-extension` |

Releases after v0.6.1 include the bridge; earlier zips don't, so use a checkout
with those. Either way the bridge sits next to the compiled extension modules it
loads (`../lib/common/`), which supply the offline tool list and answers.

No dependencies (node builtins only) and no token setup — it reads
`~/.arduinoIDE/mcp-token` itself, re-reading per request so it survives the IDE
regenerating the token on restart.

## Options

All optional, set as environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARDUINO_MCP_URL` | `http://127.0.0.1:3847/mcp` | MCP endpoint to forward to |
| `ARDUINO_MCP_TOKEN` | *(reads the token file)* | Override the auth token |
| `ARDUINO_AGENT_PATH` | *(unset — never launches)* | Path to the IDE executable. When set, a tool call that needs the IDE while it is closed starts it, waits for its MCP server and then runs the call. Concurrent calls share one launch; if the IDE never answers, the bridge doesn't start it again until it has been seen running. Paths from older Arduino IDE and Arduino Agent builds are migrated to Open Duino when possible. |
| `ARDUINO_MCP_LAUNCH_TIMEOUT` | `120` | Seconds to wait for a started IDE's MCP server |
| `ARDUINO_MCP_WATCH_INTERVAL` | `5` | Seconds between checks for the IDE coming up (a local TCP connect) |
| `ARDUINO_MCP_DEBUG` | *(off)* | Set to `1` for verbose logging on stderr |

Example on Windows:

```json
{
  "mcpServers": {
    "arduino": {
      "command": "node",
      "args": ["C:/Open Duino/resources/mcp-bridge/bridge/arduino-agent-bridge.js"],
      "env": { "ARDUINO_AGENT_PATH": "C:/Open Duino/Open Duino.exe" }
    }
  }
}
```

## Behaviour when the IDE is closed

| Request | Response |
|---------|----------|
| `initialize` | Succeeds (answered locally) with the server's workflow `instructions` and the `prompts` capability, so the client connects fully featured |
| `tools/list` | The IDE's own list if this bridge has seen it, otherwise the compiled definitions for the tool mode in `~/.arduinoIDE/settings.json` (`arduino.mcp.toolMode`, router by default) |
| `tools/call` — `list_tool_categories`, `get_category_tools`, `search_tools` | Answered locally, identical to the server (both use `runRouterDiscoveryTool`) |
| `tools/call` — anything else | With `ARDUINO_AGENT_PATH`: starts the IDE, waits (sending progress notifications if the client asked for them), then runs the call. Otherwise, or if the IDE doesn't come up: a tool result with `isError: true` saying what to do |
| `prompts/list`, `prompts/get` | Answered locally from the compiled prompts |
| `resources/list`, `resources/templates/list` | Empty lists |

When the IDE comes up, the bridge fetches its tool list and sends
`notifications/tools/list_changed` if it differs from what the client was given
(for example, the IDE runs in `direct` mode).

The instructions are loaded from the compiled extension when present (source
of truth) with an embedded fallback; the smoke test asserts bridge/server
parity so the copies cannot drift silently.

Session handling is automatic: if the IDE restarts and invalidates the session
(HTTP 404) or rotates the token (HTTP 401), the bridge re-runs the handshake and
retries the request once. A token that is still rejected comes back as a
readable tool error rather than a protocol failure.

Tests: `yarn test:bridge` in `arduino-mcp-extension` (after `yarn build`) runs
the bridge against a fake IDE server.

> stdout carries only the JSON-RPC stream; all diagnostics go to stderr.
