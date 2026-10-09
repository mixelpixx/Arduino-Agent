const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '../src/node/cli-protocol');
const destination = path.resolve(__dirname, '../lib/node/cli-protocol');

if (!fs.existsSync(source)) {
  throw new Error(`Arduino CLI protocol source is missing: ${source}`);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });

const requiredModule = path.join(destination, 'cc/arduino/cli/commands/v1/upload_pb.js');
if (!fs.existsSync(requiredModule)) {
  throw new Error(`Arduino CLI protocol copy did not produce ${requiredModule}`);
}
