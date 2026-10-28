import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { crc32, encoder } from '../src/binary.js';
import { readArchive, writeArchive } from '../src/archive.js';
import { supportsRawCompression } from '../src/compression.js';

function entry(name, content, options = {}) {
  return { name, date: new Date(2026, 0, 1), comment: '', dir: false, _bytes: async () => encoder.encode(content), ...options };
}

test('writes standard local, central and end records; reads stored archives and metadata', async () => {
  const bytes = await writeArchive([entry('hello.txt', 'Hello ZIP'), entry('empty/', '', { dir: true })], { compression: 'STORE', comment: 'Archive comment' });
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(bytes.length - 22 - 'Archive comment'.length, true), 0x06054b50);
  const archive = await readArchive(bytes, { checkCRC32: true });
  assert.equal(archive.comment, 'Archive comment');
  assert.equal(archive.entries[1].dir, true);
  assert.equal(new TextDecoder().decode(await archive.entries[0].read()), 'Hello ZIP');
  assert.equal(view.getUint32(14, true), crc32(encoder.encode('Hello ZIP')));
});

test('DEFLATE output is interoperable with node:zlib when native compression is available', { skip: !supportsRawCompression() }, async () => {
  const content = 'Compress me! '.repeat(1000);
  const bytes = await writeArchive([entry('compressed.txt', content)]);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(8, true), 8);
  const offset = 30 + view.getUint16(26, true);
  assert.equal(inflateRawSync(bytes.subarray(offset, offset + view.getUint32(18, true))).toString(), content);
  const loaded = await readArchive(bytes);
  assert.equal(new TextDecoder().decode(await loaded.entries[0].read()), content);
});

test('detects truncation, corrupt data, traversal, encryption and extraction limits', async () => {
  const source = await writeArchive([entry('abcde.txt', 'data')], { compression: 'STORE' });
  await assert.rejects(readArchive(source.slice(0, -1)), /directory/);
  const corrupt = source.slice();
  corrupt[30 + 'abcde.txt'.length] ^= 1;
  const loaded = await readArchive(corrupt);
  await assert.rejects(loaded.entries[0].read(), /CRC32/);
  await assert.rejects(readArchive(corrupt, { checkCRC32: true }), /CRC32/);
  await assert.rejects(readArchive(source, { maxEntrySize: 2 }), /maxEntrySize/);
  await assert.rejects(readArchive(source, { maxEntries: 0 }), /maxEntries/);
  const unsafe = source.slice();
  const view = new DataView(unsafe.buffer);
  const central = view.getUint32(unsafe.length - 6, true);
  unsafe.set(encoder.encode('../xx.txt'), 30);
  unsafe.set(encoder.encode('../xx.txt'), central + 46);
  await assert.rejects(readArchive(unsafe), /traversal/);
  const encrypted = source.slice();
  new DataView(encrypted.buffer).setUint16(central + 8, 0x0801, true);
  await assert.rejects(readArchive(encrypted), /Encrypted/);
});

test('reads an independently deflated payload and enforces actual expanded size', { skip: !supportsRawCompression(true) }, async () => {
  const data = encoder.encode('x'.repeat(10000));
  const compressed = deflateRawSync(data);
  const name = encoder.encode('bomb.txt');
  const bytes = new Uint8Array(30 + name.length + compressed.length + 46 + name.length + 22);
  const view = new DataView(bytes.buffer);
  const central = 30 + name.length + compressed.length;
  const end = central + 46 + name.length;
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint32(14, crc32(data), true);
  view.setUint32(18, compressed.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, name.length, true);
  bytes.set(name, 30);
  bytes.set(compressed, 30 + name.length);
  view.setUint32(central, 0x02014b50, true);
  view.setUint16(central + 6, 20, true);
  view.setUint16(central + 10, 8, true);
  view.setUint32(central + 16, crc32(data), true);
  view.setUint32(central + 20, compressed.length, true);
  view.setUint32(central + 24, data.length, true);
  view.setUint16(central + 28, name.length, true);
  bytes.set(name, central + 46);
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, 46 + name.length, true);
  view.setUint32(end + 16, central, true);
  const loaded = await readArchive(bytes);
  assert.deepEqual(await loaded.entries[0].read(), data);
  view.setUint32(22, 1, true);
  view.setUint32(central + 24, 1, true);
  const dishonest = await readArchive(bytes);
  await assert.rejects(dishonest.entries[0].read(), /size limit/);
});

test('rejects duplicate names, overlapping records, ZIP64 markers, links and mismatched local headers', async () => {
  const duplicate = await writeArchive([entry('same.txt', 'one'), entry('same.txt', 'two')], { compression: 'STORE' });
  await assert.rejects(readArchive(duplicate), /Duplicate/);
  const source = await writeArchive([entry('one.txt', 'one'), entry('two.txt', 'two')], { compression: 'STORE' });
  const central = new DataView(source.buffer).getUint32(source.length - 6, true);
  const overlap = source.slice();
  const overlappingView = new DataView(overlap.buffer);
  const expandedFirst = central - 30 - 'one.txt'.length;
  overlappingView.setUint32(18, expandedFirst, true);
  overlappingView.setUint32(22, expandedFirst, true);
  overlappingView.setUint32(central + 20, expandedFirst, true);
  overlappingView.setUint32(central + 24, expandedFirst, true);
  await assert.rejects(readArchive(overlap), /Overlapping/);
  const zip64 = source.slice();
  new DataView(zip64.buffer).setUint32(central + 24, 0xffffffff, true);
  await assert.rejects(readArchive(zip64), /ZIP64/);
  const link = source.slice();
  new DataView(link.buffer).setUint32(central + 38, 0xa1ff0000, true);
  await assert.rejects(readArchive(link), /Symbolic-link/);
  const mismatch = source.slice();
  mismatch[30] ^= 1;
  await assert.rejects(readArchive(mismatch), /filenames disagree/);
});