// Windows-only validation with the exact bundled FFmpeg binary.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {MediaTools}=require('../desktop/media-tools.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-windows-'));
 try{
  const binary=require('ffmpeg-static'),tools=new MediaTools({binary});
  const original=Buffer.from(await fs.readFile(path.join(__dirname,'fixtures/streaming.webm.base64'),'utf8'),'base64');
  const input=path.join(dir,'Запись.webm'),output=path.join(dir,'Видео.mp4');await fs.writeFile(input,original);
  await tools.convert(input,output,{duration:1});
  assert.equal((await fs.readFile(output)).subarray(4,8).toString(),'ftyp');
  await tools.run(['-i',output,'-map','0:v:0','-frames:v','1','-f','null','-']);
  assert.deepEqual(await fs.readFile(input),original);
  const partial=path.join(dir,'Обрезанная.webm.partial');await fs.writeFile(partial,original.subarray(0,original.length-10));
  const repaired=path.join(dir,'Восстановленная.webm');await tools.repair(partial,repaired);
  await tools.run(['-i',repaired,'-map','0:v:0','-frames:v','1','-f','null','-']);
  console.log('PASS: bundled Windows FFmpeg converts to decodable MP4 and repairs truncated WebM; Unicode paths and input preservation.');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
