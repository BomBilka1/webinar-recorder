const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {FileSession} = require('../desktop/file-session.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'webinar-unit-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  return path.join(dir,'video.webm');
}
test('writes in order, preserves destination until successful finish', async t => {
  const dest = await fixture(t);
  await fs.writeFile(dest,'previous');
  const file = await FileSession.open(dest);
  const writes = [file.write(Buffer.from('one')),file.write(Buffer.from('two'))];
  await Promise.all(writes);
  assert.equal(await fs.readFile(dest,'utf8'),'previous');
  const result = await file.finish();
  assert.equal(result.bytes,6);
  assert.equal(await fs.readFile(dest,'utf8'),'onetwo');
  await assert.rejects(fs.access(file.partial));
});
test('exclusive partial file prevents overwriting unfinished recording', async t => {
  const dest = await fixture(t);
  const file = await FileSession.open(dest);
  await file.write(Buffer.from('recoverable'));
  await file.abort();
  await assert.rejects(FileSession.open(dest),{code:'EEXIST'});
  assert.equal(await fs.readFile(file.partial,'utf8'),'recoverable');
});
test('disk failure preserves partial recording and does not publish success', async t => {
  const dest = await fixture(t);
  const file = await FileSession.open(dest);
  await file.write(Buffer.from('good'));
  file.handle.write = async () => {throw new Error('Disk full');};
  await assert.rejects(file.write(Buffer.from('bad')),/Disk full/);
  await assert.rejects(file.finish(),/Disk full/);
  assert.equal(await fs.readFile(file.partial,'utf8'),'good');
  await assert.rejects(fs.access(dest));
});
test('handles short writes without dropping bytes', async t => {
  const dest = await fixture(t);
  const file = await FileSession.open(dest);
  const write = file.handle.write.bind(file.handle);
  file.handle.write = (buffer, offset) => write(buffer,offset,Math.min(2,buffer.length-offset));
  await file.write(Buffer.from('abcdef'));
  await file.finish();
  assert.equal(await fs.readFile(dest,'utf8'),'abcdef');
});
test('empty aborted recordings are removed', async t => {
  const dest = await fixture(t);
  const file = await FileSession.open(dest);
  await file.abort();
  await assert.rejects(fs.access(file.partial));
});

test('indexing failure preserves original partial and existing destination', async t => {
  const dest = await fixture(t);
  await fs.writeFile(dest,'previous');
  const file=await FileSession.open(dest);
  await file.write(Buffer.from('recording'));
  await assert.rejects(file.finish(async()=>{throw new Error('Index failed');}),/Index failed/);
  assert.equal(await fs.readFile(file.partial,'utf8'),'recording');
  assert.equal(await fs.readFile(dest,'utf8'),'previous');
});

test('disk fills during the first chunk: physically written bytes remain recoverable', async t=>{
  const dest=await fixture(t),file=await FileSession.open(dest);
  const write=file.handle.write.bind(file.handle);let first=true;
  file.handle.write=async (buffer,offset)=>{
    if(!first)throw new Error('Disk full');first=false;
    return write(buffer,offset,3);
  };
  await assert.rejects(file.write(Buffer.from('abcdef')),/Disk full/);
  const recovered=await file.abort();assert.equal(recovered.bytes,3);
  assert.equal(await fs.readFile(file.partial,'utf8'),'abc');
});
