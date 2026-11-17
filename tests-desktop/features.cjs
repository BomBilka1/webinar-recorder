// Full desktop scenarios, with genuine MediaRecorder, Web Audio and FFmpeg.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const fixture=`<!doctype html><title>Feature test</title><canvas width="640" height="360"></canvas><button>Audio</button><script>
const ctx=document.querySelector('canvas').getContext('2d');let frame=0;
setInterval(()=>{if(window.frozen)return;ctx.fillStyle='hsl('+frame++*12+' 90% 50%)';ctx.fillRect(0,0,640,360)},40);
document.querySelector('button').onclick=()=>{window.audio=new AudioContext();const osc=audio.createOscillator();const gain=audio.createGain();gain.gain.value=.1;osc.connect(gain).connect(audio.destination);osc.start();};</script>`;
function probe(file){return JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));}
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webinar-features-'));
 const output=path.join(dir,'recording.webm');
 const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(fixture);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let app;
 try{
  app=await electron.launch({args:['--no-sandbox','--use-fake-device-for-media-stream',root],env:{...process.env,WEBINAR_TEST:'1',WEBINAR_TEST_PROFILE:path.join(dir,'profile'),WEBINAR_TEST_OUTPUT:output}});
  const ui=await app.firstWindow();const errors=[];ui.on('pageerror',e=>errors.push(e.message));
  await ui.evaluate(()=>{const original=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=options=>original({...options,video:{width:{ideal:640,max:640},height:{ideal:360,max:360},frameRate:{ideal:10,max:10}}});});
  await ui.locator('#mode').selectOption('webinar');await ui.locator('#url').fill(`http://127.0.0.1:${server.address().port}`);
  const opened=app.waitForEvent('window');await ui.locator('#open').click();const webinar=await opened;await webinar.locator('button').click();
  await ui.locator('#refresh').click();
  await ui.locator('#recording-options').evaluate(node=>{node.open=true;});
  await ui.evaluate(()=>{const original=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);navigator.mediaDevices.enumerateDevices=async()=>{const devices=await original();window.testDevices=devices.map(d=>({kind:d.kind,id:d.deviceId,label:d.label}));return devices;};});
  await ui.locator('#microphone-choose').click();
  await ui.waitForFunction(()=>document.querySelector('#microphone-device').options.length>1,{},{timeout:10000}).catch(async error=>{console.error('Microphone UI:',await ui.locator('#notice').innerText(),errors,await ui.evaluate(()=>window.testDevices));throw error;});
  assert.ok(await ui.locator('#microphone').isChecked());await ui.locator('#microphone-device').selectOption({index:1});console.log('PASS: microphone choice');
  await ui.locator('#format').selectOption('mp4');await ui.locator('#split').selectOption('1');
  await ui.locator('#start').click();
  await ui.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Идёт запись'),{},{timeout:20000});
  await ui.waitForFunction(()=>document.querySelector('#source-level').value>0 && document.querySelector('#mic-level').value>0,{},{timeout:10000});
  // Validate warning semantics: stationary slides warn without ending recording.
  await webinar.evaluate(()=>{window.frozen=true;});await ui.waitForTimeout(700);
  await ui.evaluate(()=>{lastFrameChange=Date.now()-21000;});
  await ui.waitForFunction(()=>document.querySelector('#capture-warning').textContent.includes('Кадр не меняется'));
  assert.equal(await ui.evaluate(()=>recorder.state),'recording');
  await webinar.evaluate(()=>{window.frozen=false;});
  await ui.waitForFunction(()=>!document.querySelector('#capture-warning').textContent);
  // Inject native state event; Windows helper has a separate native self-test.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:')).webContents.send('window-state',{valid:true,minimized:true}));
  await ui.waitForFunction(()=>document.querySelector('#capture-warning').textContent.includes('окно свёрнуто'));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:')).webContents.send('window-state',{valid:true,minimized:false}));
  // Force the real 1-minute boundary instead of sleeping for a minute in CI.
  await ui.evaluate(()=>{segmentOffset=-61000;});
  await ui.waitForFunction(()=>document.querySelector('#file').textContent.includes('Часть 2'),{},{timeout:20000});
  await ui.waitForTimeout(2200);await ui.locator('#stop').click();
  await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Запись сохранена',{},{timeout:60000});
  const entries=await ui.evaluate(()=>window.recorderApp.history());
  const saved=entries[0];assert.equal(saved.status,'completed');assert.equal(saved.segments.length,2);
  for(const segment of saved.segments){
   const metadata=probe(segment.path);assert.ok(metadata.streams.some(s=>s.codec_name==='h264'));assert.ok(metadata.streams.some(s=>s.codec_name==='aac'));
   assert.ok(Number(metadata.format.duration)>1);await fs.access(segment.raw);
  }
  assert.equal(await ui.locator('.history-entry').count(),1);console.log('PASS: meters, warnings, split, MP4, history');
  // A short future schedule must not record before start, and must stop itself.
  await ui.locator('#microphone').uncheck();await ui.locator('#format').selectOption('webm');await ui.locator('#split').selectOption('0');
  await ui.evaluate(()=>{
   const local=delta=>new Date(Date.now()+delta-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19);
   document.querySelector('#schedule-start').step='1';document.querySelector('#schedule-start').value=local(3000);
   document.querySelector('#schedule-end').step='1';document.querySelector('#schedule-end').value=local(7500);
  });
  await ui.locator('#start').click();
  await ui.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Ожидание начала'),{},{timeout:20000});
  assert.equal(await ui.evaluate(()=>recorder),null); // No recorder until the deadline.
  await ui.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Идёт запись'),{},{timeout:10000});
  await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Запись сохранена',{},{timeout:20000});
  assert.ok(Number(probe(output).format.duration)>1);
  // Cancel a future schedule without leaving an empty recovery file.
  await ui.evaluate(()=>{
   document.querySelector('#schedule-start').value=new Date(Date.now()+60000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19);
   document.querySelector('#schedule-end').value='';
  });
  await ui.locator('#start').click();await ui.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Ожидание начала'));
  await ui.locator('#stop').click();await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Ожидание отменено');
  await assert.rejects(fs.access(output+'.partial'));
  assert.equal((await ui.evaluate(()=>window.recorderApp.history()))[0].status,'cancelled');
  // Repair real saved files and truncated chunks; never replace the input.
  const original=await fs.readFile(output);const truncated=path.join(dir,'truncated.webm.partial');
  await fs.writeFile(truncated,original.subarray(0,original.length-150));
  const repairedOld=path.join(dir,'old-repaired.webm');
  await app.evaluate(({dialog},destination)=>{dialog.showSaveDialog=async()=>({filePath:destination,canceled:false});},repairedOld);
  await ui.getByRole('button',{name:'Восстановить',exact:true}).first().click();
  await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Восстановленная копия сохранена',{},{timeout:20000});
  assert.deepEqual(await fs.readFile(output),original);assert.ok(Number(probe(repairedOld).format.duration)>0);
  const recovered=path.join(dir,'recovered.webm');
  await app.evaluate(({dialog},options)=>{
    dialog.showOpenDialog=async()=>({filePaths:[options.input],canceled:false});
    dialog.showSaveDialog=async()=>({filePath:options.output,canceled:false});
  },{input:truncated,output:recovered});
  await ui.locator('#repair').click();
  await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Восстановленная копия сохранена',{},{timeout:20000});
  assert.ok(probe(recovered).streams.some(s=>s.codec_type==='video'));assert.ok(Number(probe(recovered).format.duration)>0);
  assert.deepEqual(await fs.readFile(truncated),original.subarray(0,original.length-150));
  assert.deepEqual(errors,[]);
  console.log('PASS: source + microphone meters, frozen/minimized warning, live split into H264/AAC MP4, history, timed start/stop, schedule cancellation, truncated-file recovery.');
 }finally{if(app){const timeout=setTimeout(()=>app.process().kill('SIGKILL'),10000);try{await app.close();}finally{clearTimeout(timeout);}}server.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
