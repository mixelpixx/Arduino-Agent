# Building on Windows

This guide covers building the Arduino IDE + MCP extension from source on
Windows, including the workarounds needed for a clean build. Linux/macOS builds
follow the standard steps in the main [README](../README.md) and generally do
not need anything here.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 18.17+ (< 21) | The build also runs on Node 22, but 18–20 is what upstream targets. |
| Yarn | 4.x via Corepack | Run `corepack enable`. The repo pins `packageManager: yarn@4.5.3`; do **not** use the classic global Yarn 1. |
| Python | 3.9–3.12 | Required by `node-gyp` for native modules. On **Python 3.12** you must `pip install setuptools` (see below). |
| Visual Studio 2022 Build Tools | — | Install the **Desktop development with C++** workload, which includes MSVC, the Windows 10/11 SDK, and the Spectre-mitigated libraries. |
| Git | — | |

### Python 3.12: install `setuptools`

Python 3.12 removed the bundled `distutils` module that the version of
`node-gyp` used here still imports. Without it, native module builds fail with
`ModuleNotFoundError: No module named 'distutils'`. Install the shim:

```bash
python -m pip install --user setuptools
```

If `node-gyp` still picks the wrong interpreter, point it explicitly:

```bash
# PowerShell
$env:npm_config_python = "C:\path\to\Python312\python.exe"
```

### Visual Studio: Spectre-mitigated libraries

The optional `@vscode/windows-ca-certs` native module requires the
Spectre-mitigated C++ libraries. If they are not installed the module fails to
compile. The production webpack config **ignores this optional module when its
prebuilt binary is absent**, so the build still succeeds — but for a complete
build install the "MSVC … Spectre-mitigated libs" component from the Visual
Studio Installer (Individual Components tab).

## Build steps

```bash
git clone https://github.com/lanuzadev/Open-Duino.git
cd Arduino-Agent

corepack enable
yarn install            # applies the bundled node-pty patch automatically

# Create the launcher shims Theia's build expects (see below)
yarn prepare:shims

# Development build + run
yarn build:dev
cd electron-app
yarn start
```

To produce an installable app (unpacked, unsigned):

```bash
cd electron-app
# Rebuild native modules against Electron's ABI. This must come BEFORE the
# production build, which bundles whatever pty.node is present (see CLAUDE.md).
yarn exec theia rebuild:electron
# Production bundle (bundled backend + minified frontend)
yarn exec theia build --config webpack.config.js --mode production
# Package to electron-app/dist/win-unpacked. Use bash (PowerShell mis-tokenizes
# -c.extraMetadata.main). The metadata matches the "Package (unpacked)" step in
# .github/workflows/release.yml; without `name` and `main` the app gets the
# wrong user-data folder and skips its bundled plugins.
node ../node_modules/electron-builder/cli.js --dir --publish never \
  -c.electronVersion=30.1.2 \
  -c.extraMetadata.name=open-duino \
  -c.extraMetadata.main=./arduino-ide-electron-main.js \
  -c.extraMetadata.theia.frontend.config.buildDate="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Open Duino's MCP server starts automatically at `http://127.0.0.1:3847` when the IDE
launches; the console prints a ready-to-paste client configuration including the
auth token (stored in `~/.arduinoIDE/mcp-token`).

## Workarounds, explained

Most of these are applied automatically. They are documented here so the build
is reproducible and the reasons are clear.

### 1. `node-pty` fails to compile (applied automatically)

Recent Windows SDKs (10.0.26100+) define
`PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, which caused this version of `node-pty`
to skip the `PFNCREATEPSEUDOCONSOLE`/`PFNRESIZEPSEUDOCONSOLE` typedefs and fail
with *"PFNCREATEPSEUDOCONSOLE undeclared identifier"*. A second error,
*"initialization … skipped by goto"*, comes from MSVC's strict conformance mode.

Both are fixed by a Yarn patch committed at
[`.yarn/patches/node-pty-npm-0.11.0-beta24-*.patch`](../.yarn/patches/) and
referenced from the root `package.json` `resolutions`. `yarn install` applies it
automatically — no manual editing.

### 2. Launcher shims for the Theia build (`yarn prepare:shims`)

Theia's `application-manager` spawns `webpack` and `electron` from specific
per-package `node_modules/.bin` directories, not from `PATH`. Under Yarn 4's
node-modules linker those binaries are hoisted to the repo root, so the nested
launchers are missing and the build fails — with *"The system cannot find the
path specified"* on Windows or *"webpack: not found"* on Linux/macOS. This
affects all platforms, not just Windows.

[`scripts/prepare-build-shims.js`](../scripts/prepare-build-shims.js)
(run via `yarn prepare:shims`) creates the missing launcher shims pointing at
the hoisted binaries — `.cmd` files on Windows, executable shell shims on
Linux/macOS. It is idempotent.

### 3. `@vscode/windows-ca-certs` optional module (applied automatically)

Handled in `electron-app/webpack.config.js`: the module is ignored on Windows
when its prebuilt binary is absent. `@vscode/proxy-agent` already guards its use
at runtime, so this is safe.

## Troubleshooting

- **`packageManager … yarn@4.5.3 … current global version … 1.22.22`** — run
  `corepack enable`. If corepack cannot write to `C:\Program Files\nodejs`
  (permissions), enable it into a user-writable dir on `PATH`:
  `corepack enable --install-directory "%APPDATA%\npm"`.
- **`webpack exited with an unexpected code: 1` with no visible error** — your
  shell may be truncating output. Run the webpack config directly to see the
  real error:
  `node node_modules/webpack/bin/webpack.js --config electron-app/webpack.config.js --mode production`.
- **`'GetCommitHash.bat' is not recognized`** during `node-pty` build — a
  `NoDefaultCurrentDirectoryInExePath` environment variable is set (some
  automation/CI shells set it), which stops `cmd` from running scripts in the
  current directory. Unset it for the build: PowerShell
  `Remove-Item Env:\NoDefaultCurrentDirectoryInExePath`.
- **The IDE opens sketches from a OneDrive-synced folder and the editor does not
  refresh on external changes** — OneDrive's filesystem can suppress native file
  watch events. The MCP extension force-reloads files it writes, so this does not
  affect MCP-driven edits.
