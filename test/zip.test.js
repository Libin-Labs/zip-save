import test from 'node:test';
import assert from 'node:assert/strict';
import Zip, { supports } from '../src/index.js';

test('file/folder API, Unicode names, binary inputs and empty directories round trip', async () => {
  const zip = new Zip();
  zip.comment = 'Test archive';
  zip.file('hello.txt', 'Hello').file('data.bin', new Uint8Array([0, 128, 255]));
  zip.folder('nested').file('snow-\u2603.txt', Promise.resolve(new Blob(['Unicode \u2603'])));
  zip.folder('empty');
  assert.equal(zip.file('missing'), null);
  assert.equal(zip.file(/\.txt$/g).length, 2);
  const loaded = await Zip.loadAsync(await zip.generateAsync({ type: 'uint8array' }), { checkCRC32: true });
  assert.equal(loaded.comment, 'Test archive');
  assert.equal(await loaded.file('hello.txt').async('text'), 'Hello');
  assert.equal(await loaded.file('nested/snow-\u2603.txt').async('string'), 'Unicode \u2603');
  assert.deepEqual(await loaded.file('data.bin').async(), new Uint8Array([0, 128, 255]));
  assert.equal(loaded.files['empty/'].dir, true);
});

test('folder views share data, generate relative paths, and remove recursively', async () => {
  const zip = new Zip();
  const folder = zip.folder('reports');
  folder.file('one.txt', 'one').folder('sub').file('two.txt', 'two');
  assert.equal(await zip.file('reports/one.txt').async('text'), 'one');
  const relative = await Zip.loadAsync(await folder.generateAsync({ type: 'uint8array' }));
  assert.ok(relative.file('one.txt'));
  assert.equal(relative.file('reports/one.txt'), null);
  folder.remove('sub');
  assert.equal(zip.file('reports/sub/two.txt'), null);
  zip.remove('reports');
  assert.deepEqual(Object.keys(zip.files), []);
});

test('generates Blob, ArrayBuffer, base64, binarystring and nodebuffer outputs', async () => {
  const zip = new Zip().file('value.txt', 'value');
  assert.equal((await zip.generateAsync()).type, 'application/zip');
  assert.ok(await zip.generateAsync({ type: 'arraybuffer' }) instanceof ArrayBuffer);
  assert.ok(Buffer.isBuffer(await zip.generateAsync({ type: 'nodebuffer' })));
  const base64 = await zip.generateAsync({ type: 'base64' });
  assert.equal(await (await Zip.loadAsync(base64, { base64: true })).file('value.txt').async('text'), 'value');
  const binary = await zip.generateAsync({ type: 'binarystring' });
  assert.ok((await Zip.loadAsync(binary, { binary: true })).file('value.txt'));
});

test('supports empty archives and entry options without auto folders', async () => {
  assert.deepEqual(Object.keys((await Zip.loadAsync(await new Zip().generateAsync({ type: 'uint8array' }))).files), []);
  const zip = new Zip().file('nested/file', 'SGVsbG8=', { base64: true, createFolders: false, comment: 'Entry comment' });
  assert.equal(Object.keys(zip.files).length, 1);
  const loaded = await Zip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(await loaded.file('nested/file').async('text'), 'Hello');
  assert.equal(loaded.file('nested/file').comment, 'Entry comment');
});

test('cancellation, progress callbacks, limits and unsupported options fail predictably', async () => {
  const zip = new Zip().file('hello.txt', 'Hello');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(zip.generateAsync({ signal: controller.signal }), { name: 'AbortError' });
  const progress = [];
  await zip.generateAsync({ type: 'uint8array' }, (event) => progress.push(event));
  assert.equal(progress[0].percent, 0);
  assert.equal(progress.at(-1).percent, 100);
  await assert.rejects(zip.generateAsync({ maxEntrySize: 1 }), /size limit/);
  await assert.rejects(zip.generateAsync({ maxTotalSize: 1 }), /maxTotalSize/);
  await assert.rejects(zip.generateAsync({ maxArchiveSize: 1 }), /maxArchiveSize/);
  await assert.rejects(zip.generateAsync({ type: 'bad' }), /output type/);
  assert.throws(() => zip.file('../bad', 'data'), /traversal/);
  assert.equal(typeof supports.compression, 'boolean');
});

test('stored generation falls back when native compression is missing and loading is atomic', async () => {
  const original = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const zip = new Zip().file('data', 'data'.repeat(100));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    assert.equal(new DataView(bytes.buffer).getUint16(8, true), 0);
    await assert.rejects(zip.generateAsync({ compressionFallback: 'error' }), /unavailable/);
    await assert.rejects(zip.loadAsync(new Uint8Array([0, 1, 2])));
    assert.ok(zip.file('data'));
  } finally { globalThis.CompressionStream = original; }
});

test('missing decompression fails clearly for DEFLATE without blocking stored archives', { skip: !supports.compression }, async () => {
  const zip = new Zip().file('compressed', 'Repeated content '.repeat(1000));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const loaded = await Zip.loadAsync(bytes);
  const original = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    await assert.rejects(loaded.file('compressed').async(), /decompression.*unavailable/);
    const stored = await Zip.loadAsync(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
    assert.ok((await stored.file('compressed').async('text')).startsWith('Repeated'));
  } finally { globalThis.DecompressionStream = original; }
});

test('progress can abort generation and invalid per-entry limits are rejected', async () => {
  const zip = new Zip().file('one', 'one').file('two', 'two');
  const controller = new AbortController();
  await assert.rejects(zip.generateAsync({ signal: controller.signal }, ({ percent }) => {
    if (percent > 0) controller.abort();
  }), { name: 'AbortError' });
  await assert.rejects(zip.file('one').async('text', { maxSize: NaN }), /maxSize/);
  await assert.rejects(zip.file('one').async('text', { maxSize: -1 }), /maxSize/);
});