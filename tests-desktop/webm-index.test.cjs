const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {indexWebM}=require('../desktop/webm-index.cjs');
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webinar-index-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'video.webm.partial');
  const bytes=Buffer.from(await fs.readFile(path.join(__dirname,'fixtures/streaming.webm.base64'),'utf8'),'base64');
  await fs.writeFile(file,bytes);return {file,bytes};
}
test('finalizes real streaming VP8 WebM with duration and discoverable keyframe index',async t=>{
  const {file,bytes}=await fixture(t);await indexWebM(file);
  const result=await fs.readFile(file);
  assert.deepEqual(result.subarray(0,36),bytes.subarray(0,36));
  for(const hex of ['114d9b74','1c53bb6b','448988'])assert.ok(result.includes(Buffer.from(hex,'hex')),hex);
  const durationAt=result.indexOf(Buffer.from('448988','hex'))+3;
  assert.ok(result.readDoubleBE(durationAt)>=800);
  // Repeated finalization must not keep duplicate stale index tables.
  await indexWebM(file);assert.deepEqual(await fs.readFile(file),result);
  await assert.rejects(fs.access(`${file}.indexing`));
});
test('truncated media leaves the original recording intact',async t=>{
  const {file,bytes}=await fixture(t);const truncated=bytes.subarray(0,bytes.length-10);
  await fs.writeFile(file,truncated);await assert.rejects(indexWebM(file));
  assert.deepEqual(await fs.readFile(file),truncated);await assert.rejects(fs.access(`${file}.indexing`));
});
test('exclusive indexing output protects a preexisting recovery file',async t=>{
  const {file,bytes}=await fixture(t);await fs.writeFile(`${file}.indexing`,'recoverable');
  await assert.rejects(indexWebM(file),{code:'EEXIST'});
  assert.deepEqual(await fs.readFile(file),bytes);assert.equal(await fs.readFile(`${file}.indexing`,'utf8'),'recoverable');
});
