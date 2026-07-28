# Arduino Agent MCP bridge

A tiny stdio ⇄ HTTP bridge for the MCP server embedded in Arduino Agent.

## Why

The MCP server runs *inside* the IDE, so it only listens on `127.0.0.1:3847`
while the IDE is open. If your MCP client connects to that URL directly, the
whole server shows up as **failed to connect** whenever the IDE happens to be
closed — which looks like a broken integration rather than an idle one.

This bridge is a stdio MCP server that your client spawns as a child process, so
**connecting always succeeds**. It forwards requests to the IDE when it's up,
and when it isn't, tool calls come back with a plain, actionable message:

> Arduino Agent is not running, so the Arduino tools are unavailable.
> Launch the Arduino Agent IDE and try again — the connection recovers
> automatically, there is no need to restart this client.

When you launch the IDE later, the next request reconnects on its own. **No
client restart required.**

## Usage

```json
{
  "mcpServers": {
    "arduino": {
      "command": "node",
      "args": ["/path/to/arduino-mcp-extension/bridge/arduino-agent-bridge.js"]
    }
  }
}
```

No dependencies (node builtins only) and no token setup — it reads
`~/.arduinoIDE/mcp-token` itself, re-reading per request so it survives the IDE
regenerating the token on restart.

## Options

All optional, set as environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARDUINO_MCP_URL` | `http://127.0.0.1:3847/mcp` | MCP endpoint to forward to |
| `ARDUINO_MCP_TOKEN` | *(reads the token file)* | Override the auth token |
| `ARDUINO_AGENT_PATH` | *(unset — never launches)* | Path to the IDE executable; when set, a tool call made while the IDE is closed starts it in the background (rate-limited to one attempt per minute). That call still reports "not running" — retry once the IDE is up. |
| `ARDUINO_MCP_DEBUG` | *(off)* | Set to `1` for verbose logging on stderr |

Example with auto-launch on Windows:

```json
{
  "mcpServers": {
    "arduino": {
      "command": "node",
      "args": ["C:/path/to/bridge/arduino-agent-bridge.js"],
      "env": { "ARDUINO_AGENT_PATH": "C:/Arduino/Arduino IDE.exe" }
    }
  }
}
```

## Behaviour when the IDE is closed

| Request | Response |
|---------|----------|
| `initialize` | Succeeds (answered locally) with the server's workflow `instructions` and the `prompts` capability, so the client connects fully featured |
| `tools/list` | The tools seen last time this bridge talked to the IDE, or `[]` on a cold start |
| `tools/call` | A tool result with `isError: true` and the message above |
| `resources/list`, `prompts/list` | Empty lists |
| `prompts/get` | The launch-the-IDE error |

The instructions are loaded from the compiled extension when present (source
of truth) with an embedded fallback; the smoke test asserts bridge/server
parity so the copies cannot drift silently.

Session handling is automatic: if the IDE restarts and invalidates the session
(HTTP 404) or rotates the token (HTTP 401), the bridge re-runs the handshake and
retries the request once.

> stdout carries only the JSON-RPC stream; all diagnostics go to stderr.
