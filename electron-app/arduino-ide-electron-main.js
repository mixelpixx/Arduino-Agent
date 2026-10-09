// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./package.json').theia.frontend.config;

/**
 * Open Duino keeps its Electron user data in its own folder
 * (`open-duino`, from the package name) instead of the official Arduino
 * IDE's (`arduino-ide`), so the two no longer share a single-instance lock or
 * window state. On first start, carry over what lived in the shared folder:
 * the shell layout and per-sketch board selections (Local Storage, IndexedDB)
 * and the sketches to reopen (config.json). Settings, the MCP token and the
 * sketchbook are in ~/.arduinoIDE and stay shared on purpose.
 *
 * Must run before the backend module is required: it takes the
 * single-instance lock on the userData folder at load time.
 */
function migrateUserDataFromArduinoIde() {
  const { app } = require('electron');
  const userData = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'arduino-ide');
  const marker = path.join(userData, '.migrated-from-arduino-ide');
  if (
    path.resolve(userData) === path.resolve(legacy) ||
    !fs.existsSync(legacy) ||
    fs.existsSync(marker)
  ) {
    return;
  }
  try {
    // A folder that already has its own data is never overwritten.
    if (!fs.existsSync(path.join(userData, 'Local Storage'))) {
      for (const entry of ['Local Storage', 'IndexedDB', 'config.json']) {
        const from = path.join(legacy, entry);
        if (fs.existsSync(from)) {
          fs.cpSync(from, path.join(userData, entry), {
            recursive: true,
            // LevelDB lock files belong to whichever app has the store open.
            filter: (src) => path.basename(src) !== 'LOCK',
          });
        }
      }
    }
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch (err) {
    console.error(`Could not migrate user data from ${legacy}:`, err);
  }
}

// Only bundled releases (they have `buildDate`) ever used the shared folder.
if (config.buildDate) {
  migrateUserDataFromArduinoIde();
}
// `buildDate` is only available in the bundled application.
if (config.buildDate) {
  // `plugins` folder inside IDE2. IDE2 is shipped with these VS Code extensions. Such as cortex-debug, vscode-cpp, and translations.
  process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${path.resolve(
    __dirname,
    'plugins'
  )}`;
  // `plugins` folder inside the `~/.arduinoIDE` folder. This is for manually installed VS Code extensions. For example, custom themes.
  process.env.THEIA_PLUGINS = [
    process.env.THEIA_PLUGINS,
    `local-dir:${path.resolve(os.homedir(), '.arduinoIDE', 'plugins')}`,
  ]
    .filter(Boolean)
    .join(',');
}

require('./lib/backend/electron-main');
