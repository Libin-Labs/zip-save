import { checkAbort, toBytes } from './binary.js';

export function downloadName(name = 'download') {
  if (typeof name !== 'string') throw new TypeError('Download filename must be a string.');
  const leaf = name.replaceAll('\\', '/').split('/').pop();
  const cleaned = leaf.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_');
  let end = cleaned.length;
  while (end > 0 && (cleaned[end - 1] === '.' || cleaned[end - 1] === ' ')) end -= 1;
  const safe = cleaned.slice(0, end);
  if (!safe || safe === '.' || safe === '..') throw new TypeError('Download filename cannot be empty.');
  return safe;
}

function needsBom(type) {
  const [mediaType, ...parameters] = type.toLowerCase().split(';').map((part) => part.trim());
  const text = mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/xml' || (mediaType.startsWith('application/') && mediaType.endsWith('+xml'));
  return text && parameters.some((parameter) => {
    const [name, value] = parameter.split('=').map((part) => part.trim());
    return name === 'charset' && value?.replaceAll('"', '') === 'utf-8';
  });
}

export async function saveAs(data, filename = 'download', { autoBom = false, mimeType = 'application/octet-stream', signal, revokeAfter = 40000 } = {}) {
  if (typeof document === 'undefined' || typeof globalThis.URL?.createObjectURL !== 'function') throw new Error('saveAs requires a browser document and object URL support.');
  if (!Number.isFinite(revokeAfter) || revokeAfter < 0 || revokeAfter > 2147483647) throw new RangeError('revokeAfter must be between 0 and 2147483647 milliseconds.');
  const name = downloadName(filename);
  checkAbort(signal);
  let blob;
  const resolved = await data;
  if (typeof resolved === 'string' || resolved instanceof URL) {
    const url = new URL(String(resolved), document.baseURI);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new TypeError('Download URLs must use HTTP, HTTPS, or blob protocols.');
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Download request failed: HTTP ${response.status}`);
    blob = await response.blob();
  } else {
    blob = resolved instanceof Blob ? resolved : new Blob([await toBytes(resolved)], { type: mimeType });
  }
  checkAbort(signal);
  if (autoBom && needsBom(blob.type)) blob = new Blob(['\ufeff', blob], { type: blob.type });
  const url = URL.createObjectURL(blob);
  let anchor;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    (document.body ?? document.documentElement).appendChild(anchor);
    checkAbort(signal);
    anchor.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    anchor?.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), revokeAfter);
}