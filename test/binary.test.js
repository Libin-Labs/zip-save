import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, dosDate, encoder, output, safePath, toBytes } from '../src/binary.js';

test('CRC32 matches the standard check vector', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('normalizes safe paths and rejects traversal and absolute paths', () => {
  assert.equal(safePath('reports\\2026.txt'), 'reports/2026.txt');
  assert.equal(safePath('reports', true), 'reports/');
  for (const name of ['../secret', 'a/../secret', '/absolute', 'C:\\secret', '\\\\server\\share', 'a\0b', '.', '']) assert.throws(() => safePath(name));
});

test('converts Unicode, base64, binary strings and typed-array slices', async () => {
  const text = 'Hello \u2603';
  const bytes = await toBytes(text);
  assert.equal(output(bytes, 'text'), text);
  assert.deepEqual(await toBytes(output(bytes, 'base64'), { base64: true }), bytes);
  assert.deepEqual(await toBytes(new Uint8Array([0, 1, 2, 3]).subarray(1, 3)), new Uint8Array([1, 2]));
  assert.deepEqual(await toBytes('\u00ff\x00', { binary: true }), new Uint8Array([255, 0]));
  await assert.rejects(toBytes('not-base64', { base64: true }));
  await assert.rejects(toBytes('\u2603', { binary: true }));
  await assert.rejects(toBytes(new Blob(['123']), { maxSize: 2 }), RangeError);
  assert.throws(() => dosDate(new Date(NaN)), TypeError);
});