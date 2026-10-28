export const encoder = new TextEncoder();
export const decoder = new TextDecoder('utf-8', { fatal: true });
export const MAX_UINT32 = 0xffffffff;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let checksum = value;
  for (let bit = 0; bit < 8; bit += 1) checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
  return checksum >>> 0;
});

export function crc32(bytes) {
  let checksum = MAX_UINT32;
  for (const byte of bytes) checksum = crcTable[(checksum ^ byte) & 255] ^ (checksum >>> 8);
  return (checksum ^ MAX_UINT32) >>> 0;
}

export function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function safePath(name, directory = false) {
  if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f]/.test(name)) throw new TypeError('An entry needs a nonempty name without control characters.');
  const path = name.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) throw new TypeError('Absolute ZIP paths are not allowed.');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) throw new TypeError('ZIP paths cannot contain traversal segments.');
  return parts.join('/') + (directory || path.endsWith('/') ? '/' : '');
}

function checkSize(size, limit) {
  if (size > limit) throw new RangeError('Input exceeds the configured size limit.');
}

function decodeBase64(value, maxSize) {
  const clean = value.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) throw new TypeError('Invalid padded base64 input.');
  const padding = clean.endsWith('==') ? 2 : Number(clean.endsWith('='));
  checkSize(clean.length / 4 * 3 - padding, maxSize);
  return Uint8Array.from(atob(clean), (character) => character.codePointAt(0));
}

function encodeString(value, { base64, binary, maxSize }) {
  if (base64) return decodeBase64(value, maxSize);
  checkSize(value.length, maxSize);
  if (!binary) return encoder.encode(value);
  return Uint8Array.from(value, (character) => {
    const code = character.codePointAt(0);
    if (code > 255) throw new TypeError('A binary string may contain only byte-valued characters.');
    return code;
  });
}

export async function toBytes(input, { base64 = false, binary = false, maxSize = Infinity } = {}) {
  const value = await input;
  let bytes;
  if (typeof value === 'string') bytes = encodeString(value, { base64, binary, maxSize });
  else if (value instanceof ArrayBuffer) {
    checkSize(value.byteLength, maxSize);
    bytes = new Uint8Array(value).slice();
  } else if (ArrayBuffer.isView(value)) {
    checkSize(value.byteLength, maxSize);
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  } else if (typeof Blob !== 'undefined' && value instanceof Blob) {
    checkSize(value.size, maxSize);
    bytes = new Uint8Array(await value.arrayBuffer());
  } else throw new TypeError('Expected a string, Blob, ArrayBuffer, typed array, or a promise of one.');
  checkSize(bytes.length, maxSize);
  return bytes;
}

export function binaryString(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCodePoint(...bytes.subarray(offset, offset + 32768)));
  return chunks.join('');
}

export function output(bytes, type = 'uint8array', mimeType = 'application/octet-stream') {
  switch (type) {
    case 'uint8array': return bytes.slice();
    case 'arraybuffer': return bytes.slice().buffer;
    case 'blob': return new Blob([bytes], { type: mimeType });
    case 'text': case 'string': return decoder.decode(bytes);
    case 'binarystring': return binaryString(bytes);
    case 'base64': return btoa(binaryString(bytes));
    case 'nodebuffer': {
      if (globalThis.Buffer === undefined) throw new Error('nodebuffer output is available only in Node.js.');
      return globalThis.Buffer.from(bytes);
    }
    default: throw new TypeError(`Unsupported output type: ${type}`);
  }
}

export function joinBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (length >= MAX_UINT32) throw new RangeError('ZIP64 is required for archives of 4 GiB or larger and is not supported.');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function dosDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Entry date must be a valid Date.');
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function readDate(date, time) {
  return new Date(1980 + (date >>> 9), ((date >>> 5) & 15) - 1, date & 31, time >>> 11, (time >>> 5) & 63, (time & 31) * 2);
}