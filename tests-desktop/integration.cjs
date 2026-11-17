// Requires a display (xvfb-run on Linux), Electron, Playwright and ffmpeg/ffprobe.
const {_electron:electron} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const fixture = `<!doctype html><title>Test webinar</title><canvas width="640" height="360"></canvas><button>Play sound</button>
<script>
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
let frame=0;setInterval(()=>{ctx.fillStyle='hsl('+(frame++*4%360)+' 90% 50%)';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='40px sans-serif';ctx.fillText(String(frame),80,80)},40);
document.querySelector('button').onclick=()=>{window.audio=new AudioContext();const osc=audio.createOscillator();const gain=audio.createGain();gain.gain.value=.15;osc.connect(gain).connect(audio.destination);osc.start();};
</script>`;
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'webinar-desktop-'));
  const output = path.join(dir,'recording.webm');
  const server = http.createServer((_req,res) => {res.writeHead(200,{'content-type':'text/html'});res.end(fixture);});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let app;
  try {
    app = await electron.launch({args:['--no-sandbox',root],env:{...process.env,
      WEBINAR_TEST:'1',WEBINAR_TEST_PROFILE:path.join(dir,'profile'),WEBINAR_TEST_OUTPUT:output}});
    const ui = await app.firstWindow();
    const errors=[];ui.on('pageerror',error=>errors.push(error.message));
    await ui.locator('#mode').selectOption('webinar');
    ui.on('console', message => { if (message.type() === 'error') console.error('UI:',message.text()); });
    await ui.locator('#url').fill(`http://127.0.0.1:${server.address().port}`);
    const opened=app.waitForEvent('window');
    await ui.locator('#open').click();
    const webinar=await opened;
    await webinar.locator('button').click();
    await ui.locator('#refresh').click();
    // Xvfb may have no window manager to honor minimize. Hide the native windows
    // as well, and verify they are invisible; capture remains completely real.
    const hidden = await app.evaluate(({BrowserWindow}) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {win.minimize();win.hide();});
      return windows.every(win => !win.isVisible());
    });
    assert.ok(hidden);
    // Start after hiding: every encoded frame must originate from a hidden
    // window, independent of media timestamps and slower CI scheduling.
    await ui.evaluate(() => document.querySelector('#start').click());
    await ui.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Идёт запись'),{},{timeout:20000});
    await ui.waitForTimeout(4300);
    await ui.evaluate(() => document.querySelector('#pause').click());
    assert.equal(await ui.evaluate(() => recorder.state),'paused');
    await ui.waitForTimeout(1000);
    await ui.evaluate(() => document.querySelector('#pause').click());
    await ui.waitForTimeout(1200);
    await ui.evaluate(() => document.querySelector('#stop').click());
    await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Запись сохранена',{},{timeout:20000});
    assert.deepEqual(errors,[]);
    assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(win=>!win.isVisible())));
    const probe = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8'}));
    assert.ok(probe.streams.some(s=>s.codec_type==='video'));
    assert.ok(probe.streams.some(s=>s.codec_type==='audio'));
    assert.ok(Number(probe.format.duration)>5,'Saved WebM must declare a finite duration');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:')).show());
    const encoded=(await fs.readFile(output)).toString('base64');
    const playback=await ui.evaluate(async encoded=>{
      const data=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      const video=document.createElement('video');video.muted=true;
      const url=URL.createObjectURL(new Blob([data],{type:'video/webm'}));video.src=url;
      const wait=event=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Playback timeout: '+event)),10000);
        video.addEventListener(event,()=>{clearTimeout(timer);resolve();},{once:true});
        video.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Playback error'));},{once:true});
      });
      await wait('loadedmetadata');
      const duration=video.duration;
      for(const time of [3,1,4]) {const done=wait('seeked');video.currentTime=time;await done;}
      const time=video.currentTime;video.removeAttribute('src');video.load();URL.revokeObjectURL(url);
      return {duration,time};
    },encoded);
    assert.ok(Number.isFinite(playback.duration) && playback.duration>5);
    assert.equal(playback.time,4,'Saved video must seek forward and backward');

    const timestamps=execFileSync('ffprobe',['-v','error','-show_entries','packet=pts_time','-of','csv=p=0',output],{encoding:'utf8'}).trim().split('\n').map(Number);
    const recordedSeconds=Math.max(...timestamps.filter(Number.isFinite));
    assert.ok(recordedSeconds>5,`Recorded duration: ${recordedSeconds}`);
    const frames=execFileSync('ffmpeg',['-v','error','-i',output,'-map','0:v:0','-vf','fps=2','-f','framemd5','-'],{encoding:'utf8'});
    const hashes=frames.split('\n').filter(line=>line && !line.startsWith('#')).map(line=>line.split(',').pop().trim());
    assert.ok(new Set(hashes).size>=3,'Video must continue changing while hidden');
    const pcm=execFileSync('ffmpeg',['-v','error','-i',output,'-vn','-f','s16le','-ac','1','-ar','8000','-']);
    let energy=0;for(let i=0;i<pcm.length;i+=2) energy+=Math.abs(pcm.readInt16LE(i));
    assert.ok(energy>100000,'Audio must contain a real signal');
    console.log('PASS: real webinar video + audio while native windows are hidden; pause/resume; saved WebM.',recordedSeconds);
  } finally {
    await app?.close(); server.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
