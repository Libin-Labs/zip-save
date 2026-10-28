import Zip, { saveAs, supports, zipAndSave, type FileDescriptor } from '../src/index.js';

async function consumer(files: FileList) {
  const zip = new Zip().file('hello.txt', 'Hello').file('bytes.bin', new Uint8Array([0, 1]));
  zip.folder('docs').file('note.txt', Promise.resolve(new Blob(['Note'])));
  const blob: Blob = await zip.generateAsync();
  const bytes: Uint8Array = await zip.generateAsync({ type: 'uint8array' });
  const base64: string = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
  const loaded = await Zip.loadAsync(bytes, { maxEntries: 100 });
  const text: string | undefined = await loaded.file('hello.txt')?.async('text');
  await saveAs(blob, 'hello.zip');
  await zip.saveAs('hello.zip', { onUpdate: ({ percent }) => console.log(percent) });
  const descriptors: FileDescriptor[] = [{ name: 'one.txt', data: 'one' }];
  await zipAndSave(descriptors, 'files.zip');
  await zipAndSave(Array.from(files), 'files.zip');
  await zipAndSave({ 'one.txt': 'one' });
  // @ts-expect-error ZIP archives do not support text output.
  await zip.generateAsync({ type: 'text' });
  // @ts-expect-error Only supported compression methods can be requested.
  zip.file('bad', 'data', { compression: 'GZIP' });
  void [base64, text, supports];
}
void consumer;