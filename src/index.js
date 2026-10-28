import { checkAbort, output, safePath, toBytes } from './binary.js';
import { DEFAULT_LIMITS, limitsFor, readArchive, writeArchive } from './archive.js';
import { supportsRawCompression } from './compression.js';
import { saveAs } from './save.js';

export { saveAs } from './save.js';
export { DEFAULT_LIMITS } from './archive.js';
export const supports = Object.freeze({
  get compression() { return supportsRawCompression(); },
  get decompression() { return supportsRawCompression(true); },
  get download() { return typeof document !== 'undefined' && typeof globalThis.URL?.createObjectURL === 'function'; },
});

export class ZipEntry {
  constructor(name, data, options = {}, read = undefined) {
    this.name = name;
    this.dir = Boolean(options.dir || name.endsWith('/'));
    this.date = options.date ? new Date(options.date) : new Date();
    if (!Number.isFinite(this.date.getTime())) throw new TypeError('Entry date must be valid.');
    this.comment = options.comment ?? '';
    this.compression = options.compression;
    this._data = data;
    this._inputOptions = { base64: options.base64, binary: options.binary };
    this._read = read;
    this._maxSize = options.maxSize ?? DEFAULT_LIMITS.maxEntrySize;
  }

  async _bytes({ maxSize = this._maxSize, signal } = {}) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 0) throw new RangeError('maxSize must be a nonnegative safe integer.');
    checkAbort(signal);
    const bytes = this._read ? await this._read({ maxSize, signal }) : await toBytes(this._data, { ...this._inputOptions, maxSize });
    checkAbort(signal);
    if (bytes.length > maxSize) throw new RangeError('Entry exceeds the configured size limit.');
    return bytes;
  }

  async async(type = 'uint8array', options = {}) {
    const bytes = this.dir ? new Uint8Array() : await this._bytes(options);
    return output(bytes, type, options.mimeType);
  }
}

export class Zip {
  constructor() {
    this._state = { entries: new Map(), comment: '' };
    this._prefix = '';
  }

  get comment() { return this._state.comment; }
  set comment(value) {
    if (typeof value !== 'string') throw new TypeError('Archive comment must be a string.');
    this._state.comment = value;
  }

  get files() {
    return Object.fromEntries([...this._state.entries].filter(([name]) => name.startsWith(this._prefix) && name !== this._prefix));
  }

  _parents(name) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/') + '/';
      if (!this._state.entries.has(parent)) this._state.entries.set(parent, new ZipEntry(parent, '', { dir: true }));
    }
  }

  file(name, data, options = {}) {
    if (name instanceof RegExp) {
      if (arguments.length > 1) throw new TypeError('A regular expression can only retrieve files.');
      return this.filter((relativePath, entry) => {
        name.lastIndex = 0;
        return !entry.dir && name.test(relativePath);
      });
    }
    if (arguments.length === 1) {
      const entry = this._state.entries.get(this._prefix + safePath(name));
      return entry && !entry.dir ? entry : null;
    }
    const path = this._prefix + safePath(name, options.dir);
    if (options.compression && !['STORE', 'DEFLATE'].includes(options.compression)) throw new TypeError('Compression must be STORE or DEFLATE.');
    const entry = new ZipEntry(path, path.endsWith('/') ? '' : data, options);
    if (options.createFolders !== false) this._parents(path);
    this._state.entries.set(path, entry);
    return this;
  }

  folder(name) {
    const path = this._prefix + safePath(name, true);
    this._parents(path);
    if (!this._state.entries.has(path)) this._state.entries.set(path, new ZipEntry(path, '', { dir: true }));
    const folder = new Zip();
    folder._state = this._state;
    folder._prefix = path;
    return folder;
  }

  remove(name) {
    const path = this._prefix + safePath(name);
    const folder = path.endsWith('/') ? path : path + '/';
    for (const key of this._state.entries.keys()) if (key === path || key.startsWith(folder)) this._state.entries.delete(key);
    return this;
  }

  forEach(callback) {
    for (const [name, entry] of this._state.entries) if (name.startsWith(this._prefix) && name !== this._prefix) callback(name.slice(this._prefix.length), entry);
  }

  filter(predicate) {
    const entries = [];
    this.forEach((name, entry) => { if (predicate(name, entry)) entries.push(entry); });
    return entries;
  }

  async generateAsync(options = {}, onUpdate = undefined) {
    const type = options.type ?? 'blob';
    if (!['blob', 'uint8array', 'arraybuffer', 'base64', 'binarystring', 'nodebuffer'].includes(type)) throw new TypeError(`Unsupported archive output type: ${type}`);
    const entries = this.filter(() => true).map((entry) => ({
      name: entry.name.slice(this._prefix.length), dir: entry.dir, date: new Date(entry.date),
      comment: entry.comment, compression: entry.compression, _bytes: entry._bytes.bind(entry),
    }));
    const bytes = await writeArchive(entries, { ...options, comment: options.comment ?? this.comment }, onUpdate);
    return output(bytes, type, options.mimeType ?? 'application/zip');
  }

  async loadAsync(data, options = {}) {
    const limits = limitsFor(options);
    checkAbort(options.signal);
    const bytes = await toBytes(data, { base64: options.base64, binary: options.binary, maxSize: limits.maxArchiveSize });
    const archive = await readArchive(bytes, options);
    for (const item of archive.entries) {
      const name = this._prefix + item.name;
      this._state.entries.set(name, new ZipEntry(name, null, item, item.read));
    }
    this.comment = archive.comment;
    return this;
  }

  static async loadAsync(data, options) { return new Zip().loadAsync(data, options); }

  async saveAs(filename = 'archive.zip', options = {}) {
    const { onUpdate, autoBom, revokeAfter, ...generateOptions } = options;
    const blob = await this.generateAsync({ ...generateOptions, type: 'blob' }, onUpdate);
    await saveAs(blob, filename, { autoBom, revokeAfter, signal: options.signal });
  }
}

export async function zipAndSave(files, filename = 'archive.zip', options = {}) {
  const zip = new Zip();
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof File !== 'undefined' && file instanceof File) zip.file(file.webkitRelativePath || file.name, file);
      else if (file && typeof file === 'object' && 'name' in file && 'data' in file) zip.file(file.name, file.data, file.options);
      else throw new TypeError('Each file must be a File or an object containing name and data.');
    }
  } else if (files && typeof files === 'object') {
    for (const [name, data] of Object.entries(files)) zip.file(name, data);
  } else throw new TypeError('Files must be a file array or a filename-to-data object.');
  await zip.saveAs(filename, options);
  return zip;
}

export default Zip;