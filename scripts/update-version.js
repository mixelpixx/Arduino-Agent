//@ts-check

const fs = require('fs');
const path = require('path');
const semver = require('semver');

const targetVersion = process.argv.slice(2).shift();
const repoRootPath = path.join(__dirname, '..');
const { version: currentVersion } = require(path.join(
  repoRootPath,
  'package.json'
));

if (!targetVersion) {
  console.error(
    'Target version was not specified. Target version must be a valid semver. Use: `yarn update:version x.y.z` to update the versions.'
  );
  process.exit(1);
}

if (!semver.valid(targetVersion)) {
  console.error(
    `Target version '${targetVersion}' is not a valid semver. Use: \`yarn update:version x.y.z\` to update the versions.`
  );
  process.exit(1);
}

if (!semver.gt(targetVersion, currentVersion)) {
  console.error(
    `Target version '${targetVersion}' must be greater than the current version '${currentVersion}'.`
  );
  process.exit(1);
}

console.log(
  `🛠️ Updating current version from '${currentVersion}' to '${targetVersion}':`
);
// The IDE version is carried by these three packages. arduino-mcp-extension is
// versioned separately (it tracks the MCP server, not the IDE) but it DEPENDS on
// arduino-ide-extension, and workspace dependencies here are pinned to an exact
// version - so it has to be visited too or its stale `arduino-ide-extension`
// range stops matching the workspace and Yarn goes looking on the public
// registry (`YN0035: ... Package not found`), breaking every build.
for (const toUpdate of [
  path.join(repoRootPath, 'package.json'),
  path.join(repoRootPath, 'electron-app', 'package.json'),
  path.join(repoRootPath, 'arduino-ide-extension', 'package.json'),
  path.join(repoRootPath, 'arduino-mcp-extension', 'package.json'),
]) {
  process.stdout.write(`  Updating ${toUpdate}'...`);
  const pkg = require(toUpdate);
  // Only the IDE packages carry the IDE version; arduino-mcp-extension keeps
  // its own. Every package still gets its arduino-ide-* dependencies rewritten.
  const ownsIdeVersion = pkg.name !== 'arduino-mcp-extension';
  if (ownsIdeVersion) {
    pkg.version = targetVersion;
  }
  if ('dependencies' in pkg) {
    for (const dep of Object.keys(pkg['dependencies'])) {
      if (dep.startsWith('arduino-ide-')) {
        pkg['dependencies'][dep] = targetVersion;
      }
    }
  }
  fs.writeFileSync(toUpdate, JSON.stringify(pkg, null, 2) + '\n');
  process.stdout.write(
    ownsIdeVersion ? ` ✅ Done.\n` : ` ✅ Done (dependencies only).\n`
  );
}

console.log(
  `Done. The new version is '${targetVersion}' now. Commit your changes and tag the code for the release. 🚢`
);
