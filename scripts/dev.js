const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cacheRoot = path.join(root, '.dev-cache');
const tempDir = path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Temp', 'OpenDuinoDev');
fs.mkdirSync(tempDir, { recursive: true });

const env = {
  ...process.env,
  TMP: tempDir,
  TEMP: tempDir,
  ELECTRON_CACHE: path.join(cacheRoot, 'electron'),
  ELECTRON_BUILDER_CACHE: path.join(cacheRoot, 'electron-builder'),
  PYTHONPATH: [
    path.join(__dirname, 'python-bootstrap'),
    path.join(cacheRoot, 'python-packages'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter),
  PYTHON: process.env.OPENDUINO_PYTHON || path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Python', 'bin', 'python.exe'),
  SETUPTOOLS_USE_DISTUTILS: 'local',
};

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args, cwd = root) {
  const result = spawnSync(npm, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNode(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['run', 'prepare:shims']);
const electronRuntime = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronRuntime)) {
  runNode(path.join(root, 'node_modules', 'electron', 'install.js'));
}
const nativeBuildMarker = path.join(cacheRoot, 'electron-30.1.2-native-build.done');
if (!fs.existsSync(nativeBuildMarker)) {
  run(['run', 'rebuild', '--prefix', 'electron-app']);
  fs.writeFileSync(nativeBuildMarker, 'Electron 30.1.2 native modules rebuilt.\n');
}
const ffmpegBuildMarker = path.join(cacheRoot, 'theia-ffmpeg-native-build.done');
if (!fs.existsSync(ffmpegBuildMarker)) {
  const globalNodeHeaders = path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'node-gyp', 'Cache', process.versions.node);
  const nodeHeaders = path.join(cacheRoot, 'node-headers', process.versions.node);
  if (!fs.existsSync(path.join(nodeHeaders, 'include', 'node', 'common.gypi')) && fs.existsSync(path.join(globalNodeHeaders, 'include', 'node', 'common.gypi'))) {
    fs.cpSync(globalNodeHeaders, nodeHeaders, { recursive: true });
    const architectureLib = path.join(nodeHeaders, process.arch === 'x64' ? 'x64' : process.arch, 'node.lib');
    if (fs.existsSync(architectureLib)) {
      for (const configuration of ['Debug', 'Release']) {
        const configurationDir = path.join(nodeHeaders, configuration);
        fs.mkdirSync(configurationDir, { recursive: true });
        fs.copyFileSync(architectureLib, path.join(configurationDir, 'node.lib'));
      }
    }
  }
  const nodeGypArgs = ['exec', '--', 'node-gyp', 'rebuild', '--debug', '--directory', 'node_modules/@theia/ffmpeg'];
  if (fs.existsSync(path.join(nodeHeaders, 'include', 'node', 'common.gypi'))) {
    nodeGypArgs.push(`--nodedir=${nodeHeaders}`);
  }
  run(nodeGypArgs);
  fs.writeFileSync(ffmpegBuildMarker, 'Theia FFmpeg native module built.\n');
}
run(['run', 'build', '--prefix', 'arduino-ide-extension']);
run(['run', 'build', '--prefix', 'arduino-mcp-extension']);
runNode(path.join(__dirname, 'copy-dev-resources.js'));
run(['run', 'build:dev', '--prefix', 'electron-app']);
const devUserData = path.join(cacheRoot, 'user-data');
fs.mkdirSync(devUserData, { recursive: true });
const electronApp = path.join(root, 'electron-app');
const electronExecutable = require(require.resolve('electron', { paths: [electronApp] }));
const appArgs = ['--user-data-dir=' + devUserData, '--disable-gpu', '--no-sandbox', electronApp, '--plugins=local-dir:../plugins'];
const app = spawnSync(electronExecutable, [
  ...appArgs,
], {
  cwd: electronApp,
  env,
  stdio: 'inherit',
});
if (app.error) throw app.error;
if (app.status !== 0) {
  console.error(`Electron exited with status ${app.status ?? app.signal}.`);
  process.exit(app.status ?? 1);
}
