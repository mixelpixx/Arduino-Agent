# Open Duino repository guide

Read `CLAUDE.md` for the detailed workspace map, build commands, vendored-code
rules, MCP architecture, and hardware notes. Those engineering instructions
also apply when working with OpenCode.

## Fork conventions

- The application is branded **Open Duino**. Keep upstream Arduino IDE notices
  and trademark language intact; do not imply Arduino SA endorses this fork.
- `arduino-ide-extension/` is vendored Arduino IDE code. Put fork-specific
  features in `arduino-mcp-extension/` unless an upstream change is necessary.
- MCP file changes already notify the frontend and refresh the open editor.
  Preserve that path when adding OpenCode workflows.
- OpenCode connects through the bundled stdio bridge. Generate its setup in
  `MCPServiceImpl.getConnectionGuide()` so paths and executable details match
  each installed build.
- Keep dark and light themes available. Theme IDs remain compatible with saved
  user settings even when their display names or palettes change.
