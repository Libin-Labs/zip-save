export type BinaryInput = string | Blob | ArrayBuffer | ArrayBufferView;
export type DataInput = BinaryInput | PromiseLike<BinaryInput>;
export type Compression = 'STORE' | 'DEFLATE';
export interface OutputMap {
  blob: Blob;
  uint8array: Uint8Array;
  arraybuffer: ArrayBuffer;
  base64: string;
  binarystring: string;
  nodebuffer: Uint8Array;
  text: string;
  string: string;
}
export type ArchiveOutput = Exclude<keyof OutputMap, 'text' | 'string'>;
export interface Limits {
  maxArchiveSize?: number;
  maxEntrySize?: number;
  maxTotalSize?: number;
  maxEntries?: number;
}
export interface FileOptions {
  dir?: boolean;
  date?: Date;
  comment?: string;
  compression?: Compression;
  base64?: boolean;
  binary?: boolean;
  createFolders?: boolean;
}
export interface EntryReadOptions {
  signal?: AbortSignal;
  maxSize?: number;
  mimeType?: string;
}
export interface Progress {
  percent: number;
  currentFile: string | null;
}
export interface GenerateOptions<T extends ArchiveOutput = 'blob'> extends Limits {
  type?: T;
  compression?: Compression;
  compressionFallback?: 'STORE' | 'error';
  comment?: string;
  mimeType?: string;
  signal?: AbortSignal;
}
export interface LoadOptions extends Limits {
  base64?: boolean;
  binary?: boolean;
  checkCRC32?: boolean;
  signal?: AbortSignal;
}
export interface SaveOptions {
  autoBom?: boolean;
  mimeType?: string;
  signal?: AbortSignal;
  revokeAfter?: number;
}
export interface ZipSaveOptions extends Omit<GenerateOptions, 'type'>, SaveOptions {
  onUpdate?: (progress: Progress) => void;
}
export class ZipEntry {
  constructor(name: string, data: DataInput, options?: FileOptions);
  readonly name: string;
  readonly dir: boolean;
  date: Date;
  comment: string;
  compression?: Compression;
  async<T extends keyof OutputMap = 'uint8array'>(type?: T, options?: EntryReadOptions): Promise<OutputMap[T]>;
}
export class Zip {
  constructor();
  comment: string;
  readonly files: Readonly<Record<string, ZipEntry>>;
  file(name: string): ZipEntry | null;
  file(pattern: RegExp): ZipEntry[];
  file(name: string, data: DataInput, options?: FileOptions): this;
  folder(name: string): Zip;
  remove(name: string): this;
  forEach(callback: (relativePath: string, entry: ZipEntry) => void): void;
  filter(predicate: (relativePath: string, entry: ZipEntry) => boolean): ZipEntry[];
  generateAsync<T extends ArchiveOutput = 'blob'>(options?: GenerateOptions<T>, onUpdate?: (progress: Progress) => void): Promise<OutputMap[T]>;
  loadAsync(data: DataInput, options?: LoadOptions): Promise<this>;
  static loadAsync(data: DataInput, options?: LoadOptions): Promise<Zip>;
  saveAs(filename?: string, options?: ZipSaveOptions): Promise<void>;
}
export type DownloadData = Blob | ArrayBuffer | ArrayBufferView | string | URL;
export function saveAs(data: DownloadData | PromiseLike<DownloadData>, filename?: string, options?: SaveOptions): Promise<void>;
export interface FileDescriptor {
  name: string;
  data: DataInput;
  options?: FileOptions;
}
export function zipAndSave(files: readonly (File | FileDescriptor)[] | Record<string, DataInput>, filename?: string, options?: ZipSaveOptions): Promise<Zip>;
export const supports: Readonly<{ compression: boolean; decompression: boolean; download: boolean }>;
export const DEFAULT_LIMITS: Readonly<Required<Limits>>;
export default Zip;