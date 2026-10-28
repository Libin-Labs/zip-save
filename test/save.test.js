import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Zip, { saveAs, zipAndSave } from '../src/index.js';

let originals;
let downloads;
let blobs;
let revoked;
let timers;
let removed;

function replace(target, key, value) {
  originals.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

beforeEach(() => {
  originals = [];
  downloads = [];
  blobs = [];
  revoked = [];
  timers = [];
  removed = 0;
  replace(globalThis, 'document', {
    baseURI: 'https://example.test/',
    body: { appendChild() {} },
    createElement() { return { style: {}, click() { downloads.push({ href: this.href, filename: this.download }); }, remove() { removed += 1; } }; },
  });
  replace(URL, 'createObjectURL', (blob) => { blobs.push(blob); return `blob:test-${blobs.length}`; });
  replace(URL, 'revokeObjectURL', (url) => revoked.push(url));
  replace(globalThis, 'setTimeout', (callback, delay) => { timers.push({ callback, delay }); return timers.length; });
});

afterEach(() => {
  for (const [target, key, descriptor] of originals.reverse()) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  }
});

test('downloads Blobs, sanitizes leaf filename, removes anchor and revokes URLs after delay', async () => {
  await saveAs(new Blob(['Hello']), '../folder/report?.txt');
  assert.equal(downloads[0].filename, 'report_.txt');
  assert.equal(removed, 1);
  assert.equal(revoked.length, 0);
  assert.equal(timers[0].delay, 40000);
  timers[0].callback();
  assert.deepEqual(revoked, ['blob:test-1']);
});

test('adds BOM only to explicitly UTF-8 text data and fetches URL inputs', async () => {
  await saveAs(new Blob(['text'], { type: 'text/plain;charset=utf-8' }), 'text.txt', { autoBom: true });
  assert.deepEqual([...new Uint8Array(await blobs[0].arrayBuffer()).slice(0, 3)], [239, 187, 191]);
  replace(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://example.test/files/report.txt');
    return { ok: true, blob: async () => new Blob(['from URL']) };
  });
  await saveAs('/files/report.txt', 'report.txt');
  assert.equal(await blobs[1].text(), 'from URL');
});

test('rejects bad URLs, failed HTTP responses, aborted saves and missing browser APIs', async () => {
  await assert.rejects(saveAs('javascript:alert(1)', 'bad.txt'), /protocols/);
  replace(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));
  await assert.rejects(saveAs('https://example.test/missing', 'missing.txt'), /404/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveAs(new Blob(), 'file', { signal: controller.signal }), { name: 'AbortError' });
  replace(globalThis, 'document', undefined);
  await assert.rejects(saveAs(new Blob(), 'file'), /browser/);
});

test('ZIP saveAs and zipAndSave combine archive generation and download', async () => {
  await new Zip().file('hello.txt', 'Hello').saveAs('archive.zip');
  const first = await Zip.loadAsync(blobs[0]);
  assert.equal(await first.file('hello.txt').async('text'), 'Hello');
  const zip = await zipAndSave({ 'one.txt': 'one', 'nested/two.txt': 'two' }, 'bundle.zip');
  assert.ok(zip.file('one.txt'));
  const second = await Zip.loadAsync(blobs[1]);
  assert.equal(await second.file('nested/two.txt').async('text'), 'two');
  await zipAndSave([{ name: 'three.txt', data: 'three' }], 'three.zip');
  assert.equal(downloads[2].filename, 'three.zip');
});

test('download dispatch errors immediately release object URLs', async () => {
  document.createElement = () => ({ style: {}, click() { throw new Error('blocked'); }, remove() {} });
  await assert.rejects(saveAs(new Blob(), 'file.txt'), /blocked/);
  assert.deepEqual(revoked, ['blob:test-1']);
  assert.equal(timers.length, 0);
});