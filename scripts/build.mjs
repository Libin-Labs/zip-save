import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/cjs', { recursive: true });
for (const [format, outfile] of [['esm', 'dist/index.js'], ['cjs', 'dist/cjs/index.js']]) {
  await build({
    entryPoints: ['src/index.js'], outfile,
    bundle: true, minify: true, sourcemap: true, format,
    platform: 'neutral', target: 'es2020',
  });
}
await writeFile('dist/cjs/package.json', '{"type":"commonjs"}\n');
await copyFile('src/index.d.ts', 'dist/index.d.ts');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.browser, manifest.module);
assert.ok(manifest.main.endsWith('.js'));
assert.equal(manifest.exports['.'].import, manifest.module);
assert.equal(manifest.exports['.'].require, manifest.main);
const esm = await import(new URL(`../${manifest.module}`, import.meta.url));
const require = createRequire(import.meta.url);
const cjs = require(manifest.name);
for (const name of ['Zip', 'ZipEntry', 'saveAs', 'zipAndSave', 'supports', 'DEFAULT_LIMITS']) {
  assert.ok(esm[name], `Missing ESM export: ${name}`);
  assert.ok(cjs[name], `Missing CommonJS export: ${name}`);
}
assert.equal(esm.default, esm.Zip);
assert.equal(cjs.default, cjs.Zip);
const archive = await new cjs.Zip().file('entry.txt', 'Package entry verified').generateAsync({ type: 'uint8array' });
const loaded = await esm.Zip.loadAsync(archive, { checkCRC32: true });
assert.equal(await loaded.file('entry.txt').async('text'), 'Package entry verified');
await build({ entryPoints: [manifest.browser], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2020' });
console.log('ESM, CommonJS, and browser entry points verified.');
const bundle = await readFile('dist/index.js');
const compressed = gzipSync(bundle).length;
console.log(`ESM: ${bundle.length} bytes minified; ${compressed} bytes gzip. Runtime dependencies: 0.`);
if (compressed > 10240) throw new Error('Bundle exceeded the 10 KiB gzip size budget.');