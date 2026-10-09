const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packages = ['arduino-ide-extension', 'arduino-mcp-extension', 'electron-app'];
const children = [];
let shuttingDown = false;

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

for (const packageDir of packages) {
  const child = spawn(npm, ['run', 'watch', '--prefix', packageDir], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(`[watch:${packageDir}] ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code !== 0 || signal)) {
      console.error(`[watch:${packageDir}] stopped (${signal || code}).`);
      stop(code || 1);
    }
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
