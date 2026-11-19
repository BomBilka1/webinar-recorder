// Exercise HTML fullscreen and real 60 fps capture while the webinar is hidden.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const {MediaTools}=require('../desktop/media-tools.cjs');
const root=path.resolve(__dirname,'..');
const fixture=`<!doctype html><title>Moving video fixture</title>
<button id="fullscreen" onclick="document.querySelector('canvas').requestFullscreen().then(()=>window.entered=true).catch(e=>window.fullscreenError=e.name)">Fullscreen</button>
<canvas width="640" height="360"></canvas>
<iframe allow="fullscreen" srcdoc="<button onclick=&quot;document.documentElement.requestFullscreen().then(()=>window.entered=true).catch(e=>window.error=e.name)&quot;>Iframe fullscreen</button>"></iframe>
<script>
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let frame=0;
function draw(){frame++;ctx.fillStyle='hsl('+(frame*4%360)+' 90% 50%)';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='40px sans-serif';ctx.fillText(String(frame),80,80);requestAnimationFrame(draw)}requestAnimationFrame(draw);
</script>`;
function metadata(file){return JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-count_packets','-show_entries','stream=nb_read_packets:format=duration','-of','json',file],{encoding:'utf8'}));}
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webinar-smooth-'));
 const output=path.join(dir,'60fps.webm'),mp4=path.join(dir,'60fps.mp4');
 const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(fixture);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let app;
 try {
  app=await electron.launch({args:['--no-sandbox',root],env:{...process.env,WEBINAR_TEST:'1',WEBINAR_TEST_PROFILE:path.join(dir,'profile'),WEBINAR_TEST_OUTPUT:output}});
  const ui=await app.firstWindow();const errors=[],mainErrors=[];ui.on('pageerror',error=>errors.push(error.message));
  app.process().stderr.on('data',data=>{mainErrors.push(data.toString());if(mainErrors.length>40)mainErrors.shift();});
  await ui.locator('#mode').selectOption('webinar',{timeout:45000}).catch(async error=>{console.error('Startup:',ui.url(),await ui.title(),errors,mainErrors.join('').slice(-3000));throw error;});await ui.locator('#url').fill(`http://127.0.0.1:${server.address().port}`);
  const opened=app.waitForEvent('window');await ui.locator('#open').click();const webinar=await opened;
  await webinar.locator('#fullscreen').click();
  await webinar.waitForFunction(()=>window.entered || window.fullscreenError,{},{timeout:10000});
  assert.equal(await webinar.evaluate(()=>window.fullscreenError),undefined,'Page must be allowed to request fullscreen');
  assert.ok(await webinar.evaluate(()=>!!document.fullscreenElement),'Page must enter HTML fullscreen');
  // Exercise the program's real input handler instead of CDP keyboard events,
  // which bypass Electron's native before-input-event.
  await app.evaluate(({BrowserWindow})=>{
    const target=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http'));
    target.focus();target.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    target.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  });
  await webinar.waitForFunction(()=>!document.fullscreenElement,{},{timeout:10000});
  const frame=webinar.frameLocator('iframe');await frame.getByText('Iframe fullscreen').click();
  await frame.locator('button').evaluate(el=>new Promise((resolve,reject)=>{let n=0;const check=()=>{if(el.ownerDocument.defaultView.entered)resolve();else if(el.ownerDocument.defaultView.error || n++>200)reject(new Error(el.ownerDocument.defaultView.error||'timeout'));else setTimeout(check,50)};check()}));
  assert.ok(await frame.locator('button').evaluate(el=>!!el.ownerDocument.fullscreenElement),'Permitted video iframe enters fullscreen');
  await frame.locator('button').evaluate(el=>el.ownerDocument.exitFullscreen());
  await ui.locator('#recording-options').evaluate(node=>{node.open=true});
  await ui.locator('#fps').selectOption('60');await ui.locator('#audio').uncheck();
  // Keep the same requested FPS, but lower resolution so CI tests frame timing
  // without relying on hardware graphics acceleration at 1080p.
  await ui.evaluate(()=>{const original=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=opts=>{window.testRequestedFPS=opts.video.frameRate;return original({...opts,video:{...opts.video,width:{ideal:640,max:640},height:{ideal:360,max:360}}});};});
  // Keep the player fullscreen while its native window is hidden.
  await webinar.locator('#fullscreen').click();await webinar.waitForFunction(()=>!!document.fullscreenElement);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(win=>{win.minimize();win.hide()}));
  const initialFrame=await webinar.evaluate(()=>frame);
  await ui.evaluate(()=>document.querySelector('#start').click());
  await ui.waitForFunction(()=>recorder?.state==='recording',{},{timeout:40000}).catch(async error=>{console.error('UI state:',await ui.locator('#status').textContent(),await ui.locator('#notice').textContent(),errors);throw error;});
  assert.deepEqual(await ui.evaluate(()=>window.testRequestedFPS),{ideal:60,max:60});
  const negotiated=await ui.evaluate(()=>stream.getVideoTracks()[0].getSettings().frameRate);
  if(negotiated!==undefined)assert.ok(negotiated>0 && negotiated<=60);
  await ui.waitForTimeout(5000);
  const sourceFrames=await webinar.evaluate(()=>frame)-initialFrame;
  const elapsedSeconds=await ui.evaluate(()=>elapsed()/1000);
  await ui.evaluate(()=>document.querySelector('#stop').click());
  await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Запись сохранена',{},{timeout:30000});
  assert.deepEqual(errors,[]);
  const source=metadata(output),sourceCount=Number(source.streams[0].nb_read_packets),sourceDuration=Number(source.format.duration),fps=sourceCount/elapsedSeconds;
  assert.ok(sourceDuration>.1 && sourceCount>=3,`Hidden video must contain changing frames: ${sourceCount} / ${sourceDuration}s`);
  const decoded=execFileSync('ffmpeg',['-v','error','-threads','2','-i',output,'-map','0:v:0','-fps_mode','passthrough','-f','framemd5','-'],{encoding:'utf8'});
  const hashes=decoded.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1).trim());
  assert.ok(new Set(hashes).size>=3,'Hidden video must show at least three distinct images');
  const media=new MediaTools({binary:'/usr/bin/ffmpeg'});await media.convert(output,mp4,{duration:sourceDuration});
  const result=metadata(mp4),outputCount=Number(result.streams[0].nb_read_packets),outputDuration=Number(result.format.duration);
  assert.ok(outputCount>=sourceCount*.98 && outputCount<=sourceCount*1.02,`MP4 must preserve input frames: ${sourceCount} -> ${outputCount}`);
  assert.ok(Math.abs(outputDuration-sourceDuration)<.2,`MP4 time: ${sourceDuration}s -> ${outputDuration}s`);
  console.log(`PASS: main-page and embedded fullscreen; requested 60 fps; hidden source ${sourceFrames} frames, recorded ${fps.toFixed(1)} fps on this test machine; MP4 preserves ${outputCount}/${sourceCount} frames.`);
 }finally{
  if(app){const timeout=setTimeout(()=>app.process().kill('SIGKILL'),10000);try{await app.close();}finally{clearTimeout(timeout);}}
  server.close();await fs.rm(dir,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
