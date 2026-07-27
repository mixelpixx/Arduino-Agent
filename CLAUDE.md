# Arduino Agent — repo guide for AI agents

Fork of Arduino IDE 2.x (Theia/Electron) with an embedded MCP server.
`arduino-ide-extension/` is **vendored upstream code** (synced from
arduino/arduino-ide by targeted file copies — this repo shares no git history
with upstream); `arduino-mcp-extension/` is ours; `electron-app/` packages both.

## Build

- Yarn 4 via corepack (`corepack enable`). Node 18+ works (engines say <21 but
  22 is fine in practice).
- `yarn install` applies `.yarn/patches/*` — after editing ANY patch file you
  MUST regenerate and commit `yarn.lock` in the same commit, or CI's immutable
  install fails with YN0028.
- Workspace deps are pinned to **exact versions**. A version bump must touch
  the workspace's package.json + every dependent's pin (`electron-app` pins
  both extensions) + a regenerated `yarn.lock`, all in ONE commit. Use
  `node scripts/update-version.js x.y.z` for IDE-version bumps (it also visits
  arduino-mcp-extension's deps). Verify with
  `corepack yarn install --immutable --mode=skip-build` — exactly what CI runs
  — BEFORE pushing a release tag. Both failure modes have broken releases.
- Typecheck an extension: `npm run --prefix <workspace> build` (NOT
  `yarn --cwd` — Yarn 4 bin-scoping falls back to a stale global tsc).

## Fast backend-only iteration (Windows dev box)

The MCP extension is bundled into `electron-app/lib/backend/main.js`. To test
a backend change against the installed app at `C:\Arduino` without full
packaging:

1. `npm run --prefix arduino-mcp-extension build`
2. In `electron-app/`: `node ../node_modules/@theia/cli/bin/theia build
   --config webpack.config.js --mode production` (capture FULL output to a
   file — piping through tail/grep has repeatedly swallowed the real error).
   If it dies with ENOTEMPTY on `lib/backend/native-webpack-plugin`, delete
   that directory and rerun (transient Windows file-lock race).
3. Kill "Arduino IDE" processes, copy `electron-app/lib/backend/main.js` over
   `C:\Arduino\resources\app\lib\backend\main.js`, relaunch.
4. Confirm the copy landed by grepping the installed main.js for a distinctive
   new string, and check `/health` uptime is small (a stale uptime means the
   old process survived the kill).

`theia rebuild:electron` lies: it says "already rebuilt" even when
`node_modules/node-pty/build/Release/pty.node` is missing. Force it with
`rm -rf electron-app/.browser_modules node_modules/node-pty/build`. The
production webpack build needs pty.node to exist, and rebuild:electron must
run BEFORE the webpack build.

## CI / release

- `check-mcp-extension.yml` runs tsc only. The real test is
  `arduino-mcp-extension/test/manual/smoke-test.js` against a RUNNING IDE.
- Release: push a `v*` tag (or create the ref via
  `gh api .../git/refs -f ref=refs/tags/vX -f sha=<main tip>`) →
  `release.yml` builds win/linux/mac and attaches a DRAFT release; publish
  with `gh release edit vX --draft=false --latest`.
- The Windows job is pinned to `windows-2022`: the -latest image ships Visual
  Studio 18, which no released node-gyp can detect. Do not "fix" this by
  bumping node-gyp; it does not help.
- Release checklist: immutable-install check, smoke test (includes the
  bridge-instructions parity assertion), hardware pass if tools changed.

## MCP server architecture notes

- Theia binds CoreService/BoardsService/etc. per frontend connection; the MCP
  server reaches them through its own child container
  (`mcp-arduino-services.ts`). A backend singleton cannot @inject them.
- Serial output flows through ONE funnel: `ws.on('message')` in
  `mcp-serial-manager.ts` (cursor accounting, line scanner, crash-signature
  events, wait_for waiters all hang off it).
- Server guidance for agents lives in `src/common/mcp-instructions.ts` (sent
  at initialize) and `src/common/mcp-prompts.ts`. The stdio bridge
  (`bridge/arduino-agent-bridge.js`) answers initialize locally, loading the
  compiled instructions with an embedded fallback — the smoke test asserts
  bridge/server parity.
- Serial monitor settings only apply when the monitor service is CREATED;
  `connect()` stops any existing service first. The reported baud rate always
  reflects the wire (ON_SETTINGS_DID_CHANGE feedback) — never "fix" it to echo
  the requested value.

## Hardware testing

Dev board: ESP32-S3 N16R8 on the CH343 UART port (vid 0x1A86), FQBN
`esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,CDCOnBoot=default`. Its USB PID
(0x4001, native port) appears in no boards.txt, so it can never be
auto-identified — always pass the FQBN explicitly (or use
`arduino_board suggest_fqbn`). Uploads via the UART port need no BOOT-button
dance; the native-USB port does.
