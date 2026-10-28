import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check using npm run test:package.');
const temporary = await mkdtemp(join(tmpdir(), 'zip-save-consumer-'));
const runNpm = (args) => execFileSync(process.execPath, [npm, ...args, '--dry-run=false'], { encoding: 'utf8' });
try {
  const [packed] = JSON.parse(runNpm(['pack', root, '--ignore-scripts', '--json', '--pack-destination', temporary]));
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const paths = new Set(packed.files.map((file) => file.path));
  for (const path of ['dist/index.js', 'dist/cjs/index.js', 'dist/cjs/package.json', 'dist/index.d.ts']) assert.ok(paths.has(path), `Missing packed file: ${path}`);
  runNpm(['install', '--prefix', temporary, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(temporary, packed.filename)]);
  const require = createRequire(join(temporary, 'consumer.cjs'));
  const cjs = require(manifest.name);
  assert.equal(typeof cjs.zipAndSave, 'function');
  assert.equal(cjs, require(join(temporary, 'node_modules', manifest.name)));
  const consumer = `
    import assert from 'node:assert/strict';
    import Zip from ${JSON.stringify(manifest.name)};
    const bytes = await new Zip().file('hello.txt', 'Installed package works').generateAsync({ type: 'uint8array' });
    const loaded = await Zip.loadAsync(bytes, { checkCRC32: true });
    assert.equal(await loaded.file('hello.txt').async('text'), 'Installed package works');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', consumer], { cwd: temporary, stdio: 'pipe' });
  console.log(`Packed ${manifest.name}@${manifest.version}: isolated ESM, CommonJS, and legacy main consumers passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}