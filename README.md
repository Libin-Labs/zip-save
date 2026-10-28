# @lp-labs/zip-save

Create ZIP archives, read their contents, and download files with one lightweight library. Inspired by the workflows of JSZip and FileSaver.js, without depending on either library or any other runtime package.

Framework-independent: use it with React, Vue, Angular, plain JavaScript, or Node.js. Includes ESM, CommonJS, and TypeScript declarations. Downloads require a browser; ZIP operations do not require a DOM.

The complete minified ESM build is approximately **6.6 KiB gzipped**, with zero runtime dependencies. Source maps and development tools are not part of the application bundle; size may vary between releases.

## Installation

```sh
npm install @lp-labs/zip-save
```

Requires a modern browser or Node.js 18+. Native raw DEFLATE support varies by browser and Node version; inspect `supports.compression` and `supports.decompression` when needed. No polyfills are bundled.

### Browser Sandboxes

Version 0.1.1 uses `.js` entry points for compatibility with browser sandboxes and older package resolvers, while retaining both ESM and CommonJS support. If a sandbox reports a missing `dist/index.cjs` entry for version 0.1.0, update to version 0.1.1 or later and restart the sandbox to refresh its dependency cache.

## ZIP And Download

```js
import { zipAndSave } from '@lp-labs/zip-save';

await zipAndSave({
  'hello.txt': 'Hello world!',
  'reports/summary.json': JSON.stringify({ total: 42 }, null, 2),
}, 'reports.zip');
```

For files selected with an `<input type="file" multiple>`:

```js
await zipAndSave(Array.from(fileInput.files), 'selected-files.zip');
```

`File.webkitRelativePath` is preserved when a directory picker supplies it. File descriptors are also supported:

```js
await zipAndSave([
  { name: 'notes.txt', data: 'Some notes' },
  { name: 'image.png', data: imageBlob, options: { compression: 'STORE' } },
], 'bundle.zip', {
  onUpdate: ({ percent, currentFile }) => console.log(percent, currentFile),
});
```

## Build An Archive

```js
import Zip from '@lp-labs/zip-save';

const zip = new Zip();
zip.comment = 'Monthly export';
zip.file('hello.txt', 'Hello world!');
zip.file('bytes.bin', new Uint8Array([0, 128, 255]));
zip.folder('reports').file('summary.json', JSON.stringify({ total: 42 }));
zip.folder('empty-directory');

await zip.saveAs('export.zip');
```

Alternatively, generate an archive without downloading:

```js
const blob = await zip.generateAsync({ type: 'blob' });
const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
const base64 = await zip.generateAsync({ type: 'base64' });
```

Inputs accept strings, Blobs/Files, ArrayBuffers, typed-array views, and promises of those values. Strings are UTF-8 by default; set `{ base64: true }` for padded base64 or `{ binary: true }` for byte-valued strings.

### Files And Folders

| API | Behavior |
| --- | --- |
| `zip.file(name, data, options?)` | Add or replace an entry; returns the current ZIP/folder view |
| `zip.file(name)` | Get a file entry, or `null` |
| `zip.file(regexp)` | Get matching files using paths relative to the current view |
| `zip.folder(name)` | Create a directory and return a shared folder view |
| `zip.remove(name)` | Remove a file or a directory and its descendants |
| `zip.forEach((path, entry) => ...)` | Visit entries using paths relative to the current view |
| `zip.filter((path, entry) => ...)` | Return matching entries |
| `zip.files` | Snapshot of entries keyed by full archive paths |
| `zip.comment` | Archive comment |

`file` options: `date`, `comment`, `compression`, `base64`, `binary`, `dir`, and `createFolders` (default `true`). Folder views share the same archive; generating a folder view produces an archive with paths relative to that folder. Empty directories are retained. Entry dates use ZIP's local-time DOS format, with two-second precision and years clamped to 1980-2107.

## Read An Archive

```js
import Zip from '@lp-labs/zip-save';

const zip = await Zip.loadAsync(zipFile, { checkCRC32: true });
const entry = zip.file('hello.txt');
if (entry) {
  const text = await entry.async('text');
  console.log(text);
}

zip.forEach((path, entry) => console.log(path, entry.dir));
```

`Zip.loadAsync(data, options?)` creates an archive. `existingZip.loadAsync(...)` merges validated entries into an existing archive, replacing entries with the same names. Loading is atomic: structural validation failures do not partially modify the destination.

`entry.async(type?, options?)` defaults to `uint8array`; options include `signal`, `maxSize` in bytes, and `mimeType` for Blob output. CRC32 and actual expanded size are checked whenever an imported entry is read. Set `checkCRC32: true` when loading to validate every entry immediately; otherwise decompression is lazy. Entry properties include `name`, `dir`, `date`, `comment`, and `compression`.

### Outputs

Archive generation supports `blob` (default), `uint8array`, `arraybuffer`, `base64`, `binarystring`, and `nodebuffer`. Entry reads additionally support UTF-8 `text` and `string`. Node buffer output is a real Buffer at runtime and typed as `Uint8Array` to avoid requiring Node types in browser projects.

## Save Individual Files

```js
import { saveAs } from '@lp-labs/zip-save';

await saveAs(new Blob(['Hello!'], { type: 'text/plain;charset=utf-8' }), 'hello.txt');
await saveAs(new Uint8Array([1, 2, 3]), 'bytes.bin');
await saveAs('/exports/report.pdf', 'report.pdf');
```

String and URL inputs to `saveAs` are **URLs**, not file contents. Wrap text in a Blob to download it. URL downloads use `fetch`, require a successful HTTP response, and require CORS permission for cross-origin resources. HTTP, HTTPS, and blob URLs are accepted; fetch uses the browser's default same-origin credential behavior. Use `saveAs(await response.blob(), filename)` yourself for custom authentication or headers.

`saveAs(data, filename?, options?)` options:

| Option | Default | Behavior |
| --- | --- | --- |
| `autoBom` | `false` | Prepend a UTF-8 BOM to explicitly UTF-8 text/XML/JSON Blobs |
| `mimeType` | `application/octet-stream` | MIME type for raw byte input; existing Blobs retain their type |
| `signal` | none | Abort fetching or preparation before download dispatch |
| `revokeAfter` | `40000` | Milliseconds before releasing the temporary object URL |

The filename is reduced to its leaf name and invalid/control characters are replaced. The helper removes its temporary anchor immediately and revokes its object URL later. Its promise resolves when the browser download is **dispatched**, not when writing to disk finishes. It cannot confirm download completion, choose a filesystem path, or cancel a download already dispatched.

Initiate downloads from user actions such as a button click. Browser policies, sandboxed frames, multiple-download limits, and mobile Safari may restrict asynchronous downloads or open a preview instead. For browsers that require immediate user activation, generate the Blob first and offer a separate download button. This package does not promise to bypass browser restrictions or provide legacy IE support.

## Compression And Progress

`generateAsync(options?, onUpdate?)` and `zip.saveAs(filename?, options?)` support:

| Option | Default | Behavior |
| --- | --- | --- |
| `compression` | `DEFLATE` | Native raw DEFLATE when available; `STORE` writes uncompressed data |
| `compressionFallback` | `STORE` | Use STORE without native compression; set `error` to require compression |
| `comment` | `zip.comment` | Archive comment |
| `mimeType` | `application/zip` | Blob output MIME type |
| `signal` | none | Abort native streams and stop between entries/input conversion stages |

Each file can override `compression`. Even when DEFLATE is requested, empty entries and data that would grow after compression use STORE. The platform selects compression settings; custom compression levels are not supported.

`onUpdate({ percent, currentFile })` reports entry-based progress, not byte-level progress. Pass it as the second argument to `generateAsync`, or in the options for `saveAs`/`zipAndSave`. `zipAndSave` returns the constructed Zip after dispatching the download.

```js
import { supports } from '@lp-labs/zip-save';

console.log(supports.compression, supports.decompression, supports.download);
```

Reading DEFLATE requires native `DecompressionStream('deflate-raw')`. Without it, STORE archives can still be read, but reading a DEFLATE entry throws. Native support for `deflate` or `gzip` alone is not sufficient. No custom DEFLATE implementation is bundled.

## Limits And Compatibility

The package implements standard single-disk ZIP records with UTF-8/ASCII filenames, STORE and DEFLATE, comments, directories, and central-directory sizes, including ordinary data-descriptor archives. It is a focused alternative, **not a drop-in replacement** for every JSZip or FileSaver.js API.

Not supported: ZIP64, encryption/passwords, split archives, symbolic links, legacy non-UTF-8 filename encodings, other compression algorithms, filesystem extraction, streaming archive output, and automatic file-picker dialogs. ZIP extra fields and filesystem permissions are not preserved when regenerating archives. Entry names and comments are UTF-8; comments with invalid UTF-8 are rejected.

Unsafe paths (absolute paths, control characters, or traversal segments), duplicate normalized names, overlapping entries, inconsistent headers, and malformed structures are rejected. CRC32 detects corruption; it does not authenticate archives.

Default byte limits apply to both reading and generation:

| Option | Default |
| --- | --- |
| `maxArchiveSize` | 256 MiB |
| `maxEntrySize` | 128 MiB |
| `maxTotalSize` | 256 MiB uncompressed |
| `maxEntries` | 10,000 |

Override limits in `loadAsync`, `generateAsync`, or ZIP download options. Only nonnegative safe integers are accepted. Expanded data is bounded during decompression and checked against declared size. Entry reads inherit the loaded archive's per-entry bound unless overridden explicitly.

The implementation works in memory and can hold several copies of data during generation. These limits are not guarantees of peak memory usage. Archives must stay below ZIP32's 4 GiB field limits and 65,535 entries; use a different tool for very large archives. Cancellation cannot interrupt a synchronous conversion/CRC calculation or force an unresolved input promise to settle. Process large or untrusted archives in a worker and choose conservative limits appropriate to your application.

## Support

Support maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/).