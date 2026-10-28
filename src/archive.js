import { MAX_UINT32, checkAbort, crc32, decoder, dosDate, encoder, joinBytes, readDate, safePath } from './binary.js';
import { supportsRawCompression, transformBytes } from './compression.js';

export const DEFAULT_LIMITS = Object.freeze({ maxArchiveSize: 256 * 1024 * 1024, maxEntrySize: 128 * 1024 * 1024, maxTotalSize: 256 * 1024 * 1024, maxEntries: 10000 });

export function limitsFor(options) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${key} must be a nonnegative safe integer.`);
    limits[key] = value;
  }
  return limits;
}

function record(length, signature) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return { bytes, view };
}

function textBytes(text, label) {
  const bytes = encoder.encode(text ?? '');
  if (bytes.length > 65535) throw new RangeError(`${label} exceeds the ZIP UTF-8 length limit.`);
  return bytes;
}

function writeSettings(entries, options, limits) {
  if (entries.length >= 65535 || entries.length > limits.maxEntries) throw new RangeError('Too many ZIP entries; ZIP64 is not supported.');
  const compression = options.compression ?? 'DEFLATE';
  const fallback = options.compressionFallback ?? 'STORE';
  if (!['STORE', 'DEFLATE'].includes(compression)) throw new TypeError('Compression must be STORE or DEFLATE.');
  if (!['STORE', 'error'].includes(fallback)) throw new TypeError('compressionFallback must be STORE or error.');
  return { compression, fallback, nativeCompression: supportsRawCompression() };
}

async function compressedPayload(entry, data, settings, limits, signal) {
  const requested = entry.compression ?? settings.compression;
  if (!['STORE', 'DEFLATE'].includes(requested)) throw new TypeError('Compression must be STORE or DEFLATE.');
  if (entry.dir || requested !== 'DEFLATE' || !data.length) return { payload: data, method: 0 };
  if (!settings.nativeCompression) {
    if (settings.fallback === 'error') throw new Error('Native raw DEFLATE compression is unavailable.');
    return { payload: data, method: 0 };
  }
  const compressed = await transformBytes(data, { signal, maxSize: limits.maxArchiveSize });
  return compressed.length < data.length ? { payload: compressed, method: 8 } : { payload: data, method: 0 };
}

async function prepareEntry(entry, settings, limits, signal) {
  checkAbort(signal);
  const filename = textBytes(entry.name, 'Filename');
  const comment = textBytes(entry.comment, 'Entry comment');
  const date = dosDate(entry.date);
  const data = entry.dir ? new Uint8Array() : await entry._bytes({ maxSize: limits.maxEntrySize, signal });
  checkAbort(signal);
  const compressed = await compressedPayload(entry, data, settings, limits, signal);
  return { entry, filename, comment, date, data, ...compressed };
}

async function* pendingEntries(entries, settings, limits, signal) {
  for (const entry of entries) yield prepareEntry(entry, settings, limits, signal);
}

export async function writeArchive(entries, options = {}, onUpdate = undefined) {
  const limits = limitsFor(options);
  const settings = writeSettings(entries, options, limits);
  const chunks = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  let expanded = 0;
  let completed = 0;
  onUpdate?.({ percent: 0, currentFile: null });
  for await (const { entry, filename, comment, date, data, payload, method } of pendingEntries(entries, settings, limits, options.signal)) {
    expanded += data.length;
    if (expanded > limits.maxTotalSize) throw new RangeError('Uncompressed entries exceed maxTotalSize.');
    const checksum = crc32(data);
    if (data.length >= MAX_UINT32 || payload.length >= MAX_UINT32) throw new RangeError('ZIP64 entries are not supported.');
    const local = record(30, 0x04034b50);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(8, method, true);
    local.view.setUint16(10, date.time, true);
    local.view.setUint16(12, date.date, true);
    local.view.setUint32(14, checksum, true);
    local.view.setUint32(18, payload.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, filename.length, true);
    const directory = record(46, 0x02014b50);
    directory.view.setUint16(4, 20, true);
    directory.view.setUint16(6, 20, true);
    directory.view.setUint16(8, 0x0800, true);
    directory.view.setUint16(10, method, true);
    directory.view.setUint16(12, date.time, true);
    directory.view.setUint16(14, date.date, true);
    directory.view.setUint32(16, checksum, true);
    directory.view.setUint32(20, payload.length, true);
    directory.view.setUint32(24, data.length, true);
    directory.view.setUint16(28, filename.length, true);
    directory.view.setUint16(32, comment.length, true);
    directory.view.setUint32(38, entry.dir ? 0x10 : 0, true);
    directory.view.setUint32(42, offset, true);
    chunks.push(local.bytes, filename, payload);
    central.push(directory.bytes, filename, comment);
    offset += local.bytes.length + filename.length + payload.length;
    centralSize += directory.bytes.length + filename.length + comment.length;
    if (offset + centralSize + 22 > limits.maxArchiveSize) throw new RangeError('Archive exceeds maxArchiveSize.');
    onUpdate?.({ percent: ++completed / entries.length * 100, currentFile: entry.name });
  }
  checkAbort(options.signal);
  const archiveComment = textBytes(options.comment, 'Archive comment');
  const centralBytes = joinBytes(central);
  const end = record(22, 0x06054b50);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralBytes.length, true);
  end.view.setUint32(16, offset, true);
  end.view.setUint16(20, archiveComment.length, true);
  if (offset + centralBytes.length + 22 + archiveComment.length > limits.maxArchiveSize) throw new RangeError('Archive exceeds maxArchiveSize.');
  const result = joinBytes([...chunks, centralBytes, end.bytes, archiveComment]);
  if (!entries.length) onUpdate?.({ percent: 100, currentFile: null });
  return result;
}

function findDirectory(bytes, view, limits, requireRange) {
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('ZIP end-of-central-directory record was not found.');
  const count = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (view.getUint16(endOffset + 4, true) || view.getUint16(endOffset + 6, true) || view.getUint16(endOffset + 8, true) !== count) throw new Error('Multi-disk ZIP archives are not supported.');
  if (count === 65535 || centralSize === MAX_UINT32 || centralOffset === MAX_UINT32) throw new Error('ZIP64 archives are not supported.');
  if (count > limits.maxEntries) throw new RangeError('Archive exceeds maxEntries.');
  requireRange(centralOffset, centralSize, endOffset);
  if (centralOffset + centralSize !== endOffset) throw new Error('Unsupported or invalid ZIP central directory.');
  return { endOffset, centralOffset, count };
}

function validateEntry({ flags, method, size, compressedSize, localOffset, external, disk }, limits) {
  if (disk) throw new Error('Multi-disk ZIP archives are not supported.');
  if (size === MAX_UINT32 || compressedSize === MAX_UINT32 || localOffset === MAX_UINT32) throw new Error('ZIP64 entries are not supported.');
  if (flags & ~0x080e) throw new Error('Encrypted ZIP entries or unsupported ZIP flags are not supported.');
  if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}`);
  if (((external >>> 16) & 0xf000) === 0xa000) throw new Error('Symbolic-link ZIP entries are not supported.');
  if (size > limits.maxEntrySize) throw new RangeError('Entry exceeds maxEntrySize.');
  if (method === 0 && size !== compressedSize) throw new Error('Stored ZIP entry has inconsistent sizes.');
}

function localPayload(metadata, bytes, view, nameBytes, centralOffset, requireRange) {
  const { localOffset, flags, method, checksum, compressedSize, size } = metadata;
  requireRange(localOffset, 30, centralOffset);
  if (view.getUint32(localOffset, true) !== 0x04034b50 || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method) throw new Error('ZIP local and central headers disagree.');
  const localNameSize = view.getUint16(localOffset + 26, true);
  const localExtraSize = view.getUint16(localOffset + 28, true);
  requireRange(localOffset + 30, localNameSize + localExtraSize, centralOffset);
  const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize);
  if (nameBytes.length !== localName.length || !nameBytes.every((byte, position) => byte === localName[position])) throw new Error('ZIP local and central filenames disagree.');
  if (!(flags & 8) && (view.getUint32(localOffset + 14, true) !== checksum || view.getUint32(localOffset + 18, true) !== compressedSize || view.getUint32(localOffset + 22, true) !== size)) throw new Error('ZIP local and central sizes or checksums disagree.');
  const dataOffset = localOffset + 30 + localNameSize + localExtraSize;
  requireRange(dataOffset, compressedSize, centralOffset);
  return { payload: bytes.subarray(dataOffset, dataOffset + compressedSize), range: [localOffset, dataOffset + compressedSize] };
}

function entryReader({ method, payload, size, checksum, name }, limits) {
  return async ({ maxSize = limits.maxEntrySize, signal } = {}) => {
    checkAbort(signal);
    if (size > maxSize) throw new RangeError('Entry exceeds the configured size limit.');
    const data = method === 0 ? payload : await transformBytes(payload, { decompress: true, maxSize: Math.min(maxSize, size), signal });
    if (data.length !== size) throw new Error(`Expanded ZIP entry size does not match: ${name}`);
    if (crc32(data) !== checksum) throw new Error(`CRC32 mismatch: ${name}`);
    return data;
  };
}

function checkRanges(ranges) {
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index][0] < ranges[index - 1][1]) throw new Error('Overlapping ZIP entries are not supported.');
}

function entryPath(nameBytes, flags, external, size) {
  if (!(flags & 0x0800) && nameBytes.some((byte) => byte > 127)) throw new Error('Legacy non-UTF-8 ZIP filenames are not supported.');
  const rawName = decoder.decode(nameBytes);
  const dir = rawName.endsWith('/') || Boolean(external & 0x10) || ((external >>> 16) & 0xf000) === 0x4000;
  const name = safePath(rawName, dir);
  if (dir && size !== 0) throw new Error('Directory entries cannot contain file data.');
  return { name, dir };
}

export async function readArchive(bytes, options = {}) {
  const limits = limitsFor(options);
  if (bytes.length > limits.maxArchiveSize) throw new RangeError('Archive exceeds maxArchiveSize.');
  checkAbort(options.signal);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const requireRange = (offset, length, boundary = bytes.length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > boundary) throw new Error('Truncated or invalid ZIP structure.');
  };
  const { endOffset, centralOffset, count } = findDirectory(bytes, view, limits, requireRange);
  const entries = [];
  const names = new Set();
  const ranges = [];
  let cursor = centralOffset;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    checkAbort(options.signal);
    requireRange(cursor, 46, endOffset);
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid ZIP central directory signature.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameSize = view.getUint16(cursor + 28, true);
    const extraSize = view.getUint16(cursor + 30, true);
    const commentSize = view.getUint16(cursor + 32, true);
    const external = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const metadata = { flags, method, checksum, compressedSize, size, localOffset, external, disk: view.getUint16(cursor + 34, true) };
    validateEntry(metadata, limits);
    expanded += size;
    if (expanded > limits.maxTotalSize) throw new RangeError('Archive exceeds maxTotalSize.');
    requireRange(cursor + 46, nameSize + extraSize + commentSize, endOffset);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const { name, dir } = entryPath(nameBytes, flags, external, size);
    if (names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    names.add(name);
    const { payload, range } = localPayload(metadata, bytes, view, nameBytes, centralOffset, requireRange);
    ranges.push(range);
    const entry = {
      name, dir, date: readDate(view.getUint16(cursor + 14, true), view.getUint16(cursor + 12, true)),
      comment: decoder.decode(bytes.subarray(cursor + 46 + nameSize + extraSize, cursor + 46 + nameSize + extraSize + commentSize)),
      compression: method === 8 ? 'DEFLATE' : 'STORE',
      maxSize: limits.maxEntrySize,
      read: entryReader({ method, payload, size, checksum, name }, limits),
    };
    entries.push(entry);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== endOffset) throw new Error('ZIP entry count or central directory size does not match.');
  checkRanges(ranges);
  if (options.checkCRC32) await entries.reduce((pending, entry) => pending.then(() => entry.read({ signal: options.signal })), Promise.resolve());
  checkAbort(options.signal);
  return { entries, comment: decoder.decode(bytes.subarray(endOffset + 22)) };
}