// @ts-check

// Copies this fork's own example sketches into the bundled Examples tree and
// registers them in examples.json, so they show up in File > Examples and in the
// MCP `list_examples` / `from_example` tools alongside the stock Arduino ones.
//
// Why a separate script rather than a change to download-examples.js: that script
// returns early when the Examples directory already exists (the usual case after
// the first build), so anything added there would silently not run on rebuilds.
// This one is idempotent and safe to run every time.
//
// Source of truth is arduino-mcp-extension/examples/<Category>/<Sketch>/<Sketch>.ino,
// which is tracked in git. The destination lives under src/node/resources, which
// is gitignored build output.

const { existsSync, promises: fs, cpSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const source = path.join(repoRoot, 'arduino-mcp-extension', 'examples');
const destination = path.join(
  repoRoot,
  'arduino-ide-extension',
  'src',
  'node',
  'resources',
  'Examples'
);
const manifest = path.join(destination, 'examples.json');

const isSketch = async (dir) => {
  try {
    const names = await fs.readdir(dir);
    return names.includes(`${path.basename(dir)}.ino`);
  } catch (e) {
    if (e.code === 'ENOTDIR') return false;
    throw e;
  }
};

// Mirrors the shape download-examples.js writes: { label, children[], sketches[] }
const describeCategory = async (categoryPath, label) => {
  const entry = { label, children: [], sketches: [] };
  for (const name of await fs.readdir(categoryPath)) {
    const childPath = path.join(categoryPath, name);
    if (await isSketch(childPath)) {
      entry.sketches.push({
        name,
        relativePath: path.relative(destination, childPath),
      });
    }
  }
  return entry;
};

(async () => {
  if (!existsSync(source)) {
    console.log(`No fork examples at ${source}; nothing to bundle.`);
    return;
  }
  if (!existsSync(destination)) {
    console.log(
      `Examples not downloaded yet (${destination} missing). Run download-examples first.`
    );
    return;
  }

  const categories = (await fs.readdir(source, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (!categories.length) {
    console.log('No fork example categories found.');
    return;
  }

  for (const category of categories) {
    cpSync(path.join(source, category), path.join(destination, category), {
      recursive: true,
    });
    console.log(`  Bundled example category '${category}'.`);
  }

  // Re-register in examples.json. Replace any previous entry for these
  // categories so re-running never duplicates them.
  /** @type {Array<{label: string}>} */
  let examples = [];
  try {
    examples = JSON.parse(await fs.readFile(manifest, { encoding: 'utf8' }));
  } catch {
    console.log(`Could not read ${manifest}; writing a fresh manifest.`);
  }
  examples = examples.filter((e) => !categories.includes(e.label));
  for (const category of categories) {
    examples.push(
      await describeCategory(path.join(destination, category), category)
    );
  }
  examples.sort((a, b) => a.label.localeCompare(b.label));

  await fs.writeFile(manifest, JSON.stringify(examples, null, 2), {
    encoding: 'utf8',
  });
  console.log(`Registered ${categories.length} category(ies) in examples.json.`);
})();
