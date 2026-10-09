const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const resourcesSource = path.join(root, 'arduino-ide-extension', 'src', 'node', 'resources');
const resourcesTarget = path.join(root, 'arduino-ide-extension', 'lib', 'node', 'resources');
const plotterSource = path.join(root, 'node_modules', 'arduino-serial-plotter-webapp', 'build');
const plotterTarget = path.join(resourcesTarget, 'arduino-serial-plotter-webapp');

fs.cpSync(resourcesSource, resourcesTarget, {
  recursive: true,
  filter: (source) => !source.split(path.sep).includes('i18n'),
});
fs.cpSync(plotterSource, plotterTarget, { recursive: true });
console.log('[copy-dev-resources] Arduino CLI assets and plotter copied.');
