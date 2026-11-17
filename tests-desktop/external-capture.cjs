// Real desktopCapturer recording. On Linux run under Xvfb with a window manager.
const {_electron:electron} = require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const http=require('node:http');const {execFileSync}=require('node:child_process');
const fixture=`<!doctype html><title>Capture target fixture</title><canvas width="640" height="360"></canvas><script>
const ctx=document.querySelector('canvas').getContext('2d');let f=0;setInterval(()=>{ctx.fillStyle='hsl('+(f++*7%360)+' 90% 50%)';ctx.fillRect(0,0,640,360)},40);
</script>`;
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webinar-external-'));
 const output=path.join(dir,'capture.webm');
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(fixture);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let app;
 try {
  app=await electron.launch({args:['--no-sandbox',path.resolve(__dirname,'..')],env:{...process.env,
   WEBINAR_TEST:'1',WEBINAR_TEST_PROFILE:path.join(dir,'profile'),WEBINAR_TEST_OUTPUT:output}});
  const ui=await app.firstWindow();const errors=[];ui.on('pageerror',error=>errors.push(error.message));
  await ui.locator('#mode').selectOption('webinar');
  await ui.locator('#url').fill(`http://127.0.0.1:${server.address().port}`);
  const opened=app.waitForEvent('window');await ui.locator('#open').click();const target=await opened;
  await target.waitForSelector('canvas');
  for (const mode of ['window','screen']) {
   await ui.locator('#mode').selectOption(mode);
   await ui.waitForFunction(()=>!loadingSources);
   const available=await ui.locator('#source option').evaluateAll(options=>options.filter(o=>o.value).map(o=>({id:o.value,name:o.textContent})));
   assert.ok(available.length,`No ${mode} sources. Linux window capture requires a window manager.`);
   assert.ok(available.every(s=>s.id.startsWith(mode+':')));
   const chosen=mode==='window' ? available.find(s=>s.name.includes('Capture target fixture')) : available[0];
   assert.ok(chosen,`Target not found in ${mode} picker`);
   await ui.locator('.source-card').filter({hasText:chosen.name}).first().click();
   assert.equal(await ui.locator('#source').inputValue(),chosen.id);
   await ui.evaluate(()=>{document.querySelector('#audio').checked=false;});
   await ui.locator('#start').click();
   await ui.waitForFunction(()=>recorder?.state==='recording',{},{timeout:20000});
   assert.ok(await ui.locator('.source-card').first().isDisabled());
   await ui.waitForTimeout(2500);
   await ui.locator('#stop').click();
   await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Запись сохранена',{},{timeout:20000});
   const md5=execFileSync('ffmpeg',['-v','error','-i',output,'-map','0:v:0','-vf','fps=2','-f','framemd5','-'],{encoding:'utf8'});
   const hashes=md5.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').pop().trim());
   assert.ok(new Set(hashes).size>=2,`${mode} video must change`);
   console.log(`PASS: picker thumbnail selection and real ${mode} recording`);
  }
  // A closed selected window must produce an error, never silently fall back.
  await ui.locator('#mode').selectOption('window');await ui.waitForFunction(()=>!loadingSources);
  const id=await ui.locator('#source option').evaluateAll(options=>options.find(o=>o.textContent.includes('Capture target fixture')).value);
  await ui.locator('#source').selectOption(id);await target.close();
  await ui.locator('#start').click();
  await ui.waitForFunction(()=>document.querySelector('#status').textContent==='Запись не началась');
  assert.match(await ui.locator('#notice').textContent(),/недоступны/);
  assert.deepEqual(errors,[]);console.log('PASS: closed window rejected without fallback');
 } finally {await app?.close();server.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
