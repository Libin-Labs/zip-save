import { checkAbort, joinBytes } from './binary.js';

export function supportsRawCompression(decompress = false) {
  const Constructor = decompress ? globalThis.DecompressionStream : globalThis.CompressionStream;
  if (!Constructor) return false;
  try { new Constructor('deflate-raw'); return true; } catch { return false; }
}

export async function transformBytes(bytes, { decompress = false, maxSize = Infinity, signal } = {}) {
  checkAbort(signal);
  const Constructor = decompress ? globalThis.DecompressionStream : globalThis.CompressionStream;
  let transformer;
  try { transformer = new Constructor('deflate-raw'); }
  catch { throw new Error(`Native raw DEFLATE ${decompress ? 'decompression' : 'compression'} is unavailable in this environment.`); }
  const reader = new Blob([bytes]).stream().pipeThrough(transformer).getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      size += value.length;
      if (size > maxSize) {
        const message = decompress ? 'Expanded data exceeds the configured or declared size limit.' : 'Compressed data exceeds maxArchiveSize.';
        throw new RangeError(message);
      }
      chunks.push(value);
    }
    return joinBytes(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}