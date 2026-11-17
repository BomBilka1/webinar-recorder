const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {RecordingLibrary}=require('../desktop/recording-library.cjs');
const {RecordingSession}=require('../desktop/recording-session.cjs');
const {MediaTools}=require('../desktop/media-tools.cjs');
const {planTimes,Schedule}=require('../desktop/schedule.cjs');
const {windowHandle}=require('../desktop/windows-capture.cjs');
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webinar-advanced-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from(await fs.readFile(path.join(__dirname,'fixtures/streaming.webm.base64'),'utf8'),'base64');
  const library=new RecordingLibrary(path.join(dir,'history.json'));await library.load();
  return {dir,bytes,library};
}
const space=async()=>({bavail:1000000000,bsize:4096});
test('scheduled recording starts once and stops at wall-clock deadline including paused time',()=>{
  let time=100,starts=0,stops=0,cleared=0;
  const schedule=new Schedule({startAt:200,endAt:300,onStart:()=>starts++,onStop:()=>stops++,now:()=>time,interval:()=>1,clear:()=>cleared++});
  schedule.tick();time=200;schedule.tick();schedule.tick();assert.equal(starts,1);time=350;schedule.tick();schedule.tick();
  assert.equal(stops,1);assert.equal(cleared,1);
});
test('expired schedule does not start a late unattended recording',()=>{
  let starts=0,stops=0;
  const schedule=new Schedule({startAt:200,endAt:300,onStart:()=>starts++,onStop:()=>stops++,now:()=>400,interval:()=>1,clear:()=>{}});
  schedule.tick();assert.equal(starts,0);assert.equal(stops,1);
});
test('schedule validates dates and explicit end overrides duration',()=>{
  assert.deepEqual(planTimes({startAt:200,endAt:300,durationMinutes:8},100),{startAt:200,endAt:300});
  assert.equal(planTimes({durationMinutes:2},100).endAt,120100);
  for(const options of [{startAt:NaN},{endAt:50},{durationMinutes:-1},{startAt:8*86400000}])assert.throws(()=>planTimes(options,100));
});
test('rotates real WebM into independently indexed files and persists history',async t=>{
  const {dir,bytes,library}=await fixture(t);
  const recording=new RecordingSession({library,media:new MediaTools(),statfs:space});
  await recording.start(path.join(dir,'video.webm'),{format:'webm',splitMinutes:1});
  await recording.write(bytes);await recording.rotate(1);await recording.write(bytes);const result=await recording.finish(1);
  assert.equal(result.segments,2);assert.equal(result.warning,'');
  const entry=library.list()[0];assert.equal(entry.status,'completed');assert.equal(entry.duration,2);
  assert.notEqual(entry.segments[0].path,entry.segments[1].path);
  for(const segment of entry.segments){const output=await fs.readFile(segment.path);assert.ok(output.includes(Buffer.from('1c53bb6b','hex')));await assert.rejects(fs.access(segment.partial));}
  const reloaded=new RecordingLibrary(library.filename);await reloaded.load();assert.deepEqual(reloaded.list(),library.list());
});
test('startup offers interrupted recording without deleting recoverable partial',async t=>{
  const {dir,bytes,library}=await fixture(t);const recording=new RecordingSession({library,media:new MediaTools(),statfs:space});
  const prepared=await recording.start(path.join(dir,'unfinished.webm'),{format:'webm'});await recording.write(bytes);
  // Emulate the OS closing handles after process failure, without clean abort.
  await recording.file.handle.close();
  const afterRestart=new RecordingLibrary(library.filename);await afterRestart.load();
  assert.equal(afterRestart.list()[0].status,'interrupted');assert.deepEqual(await fs.readFile(prepared.partial),bytes);
});
test('low disk notifies stop before index reserve is exhausted',async t=>{
  const {dir,bytes,library}=await fixture(t);let low=false;const events=[];
  const recording=new RecordingSession({library,media:new MediaTools(),notify:name=>events.push(name),statfs:async()=>low?{bavail:1,bsize:4096}:space()});
  await recording.start(path.join(dir,'video.webm'),{format:'webm'});low=true;await recording.write(bytes);
  assert.ok(events.includes('low-disk'));await recording.abort();
});
test('repairs old WebM as a separate copy and protects existing output',async t=>{
  const {dir,bytes}=await fixture(t);const input=path.join(dir,'old.webm'),output=path.join(dir,'repaired.webm');await fs.writeFile(input,bytes);
  const media=new MediaTools();await media.repair(input,output);
  assert.deepEqual(await fs.readFile(input),bytes);assert.ok((await fs.readFile(output)).includes(Buffer.from('448988','hex')));
  const repaired=await fs.readFile(output);await assert.rejects(media.repair(input,output),{code:'EEXIST'});assert.deepEqual(await fs.readFile(output),repaired);
  await assert.rejects(media.repair(input,input));
});
test('invalid native window identifiers cannot become command arguments',()=>{
  assert.equal(windowHandle('window:123456:0'),'123456');
  for(const id of ['screen:1:0','window:0:0','window:1;evil:0','-1'])assert.throws(()=>windowHandle(id));
});
