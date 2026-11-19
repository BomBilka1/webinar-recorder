// Verify the bundled converter retains 60 fps, variable timestamps and a long
// final gap. B-frame reorder can otherwise make MP4's duration end too early.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {MediaTools}=require('../desktop/media-tools.cjs');
function atoms(buffer,start,end){
  const result=[];
  while(start+8<=end){const size=buffer.readUInt32BE(start),type=buffer.toString('ascii',start+4,start+8);if(size<8 || start+size>end)break;result.push({type,start,size});start+=size;}
  return result;
}
function movieDuration(buffer){
  const moov=atoms(buffer,0,buffer.length).find(a=>a.type==='moov');assert.ok(moov,'MP4 moov');
  const mvhd=atoms(buffer,moov.start+8,moov.start+moov.size).find(a=>a.type==='mvhd');assert.ok(mvhd,'MP4 mvhd');
  const body=mvhd.start+8,version=buffer[body];
  return version===1 ? Number(buffer.readBigUInt64BE(body+24))/buffer.readUInt32BE(body+20)
    : buffer.readUInt32BE(body+16)/buffer.readUInt32BE(body+12);
}
function frameCount(binary,file){
  const output=execFileSync(binary,['-v','error','-threads','2','-i',file,'-map','0:v:0','-fps_mode','passthrough','-enc_time_base','1:1000','-f','framemd5','-'],{encoding:'utf8'});
  return output.split('\n').filter(line=>line && !line.startsWith('#')).length;
}
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webinar-fps-'));
 try {
  const binary=process.platform==='win32'?require('ffmpeg-static'):'/usr/bin/ffmpeg';
  const input=path.join(dir,'60fps-gap.webm'),output=path.join(dir,'60fps-gap.mp4');
  execFileSync(binary,['-v','error','-filter_threads','1','-f','lavfi','-i','testsrc2=size=64x64:rate=60:duration=1',
    '-vf','setpts=PTS+if(gte(N\\,59)\\,5/TB\\,0)','-fps_mode','passthrough',
    '-c:v','libvpx','-threads','2','-deadline','realtime','-cpu-used','8','-f','webm','-n',input]);
  assert.equal(frameCount(binary,input),60);
  await new MediaTools({binary}).convert(input,output,{duration:6});
  assert.equal(frameCount(binary,output),60,'MP4 must retain every input frame');
  const seconds=movieDuration(await fs.readFile(output));
  assert.ok(seconds>5.8 && seconds<6.2,`MP4 must retain the final timestamp, got ${seconds}s`);
  console.log(`PASS: 60 input frames preserved in MP4 including a long final gap; duration ${seconds.toFixed(3)}s`);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
