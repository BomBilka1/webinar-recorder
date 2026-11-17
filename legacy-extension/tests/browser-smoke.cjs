const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
(async () => {
 const context = await chromium.launchPersistentContext('', {channel:'chromium',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required',`--disable-extensions-except=${project}`,`--load-extension=${project}`]});
 try {
 const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const id = new URL(worker.url()).host;
 const page = await context.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`chrome-extension://${id}/recorder.html?target=1`);
 await page.evaluate(() => {
   chrome.tabCapture.getMediaStreamId = async () => 'test';
   window.showSaveFilePicker = async () => {
     const root = await navigator.storage.getDirectory();
     return root.getFileHandle('test.webm', {create:true});
   };
   navigator.mediaDevices.getUserMedia = async () => {
     const canvas = document.createElement('canvas'); canvas.width=320; canvas.height=240;
     const ctx=canvas.getContext('2d');
     window.drawTimer=setInterval(()=>{ctx.fillStyle=`hsl(${Date.now()%360} 80% 50%)`; ctx.fillRect(0,0,320,240);},30);
     const stream=canvas.captureStream(15);
     window.testAudio=new AudioContext();
     const osc=testAudio.createOscillator(); const dest=testAudio.createMediaStreamDestination(); osc.connect(dest); osc.start();
     stream.addTrack(dest.stream.getAudioTracks()[0]);
     return stream;
   };
 });
 await page.click('#start'); await page.waitForTimeout(1000); console.log(await page.locator('#status').textContent());
 await page.waitForFunction(()=>document.querySelector('#stop').disabled===false,{},{timeout:10000});
 await page.waitForTimeout(2200);
 await page.click('#stop');
 await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Запись сохранена'),{},{timeout:10000});
 const size=await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();return (await (await root.getFileHandle('test.webm')).getFile()).size;});
 assert.ok(size>1000); assert.deepEqual(errors,[]);
 console.log('Browser recording lifecycle passed; WebM bytes:',size);
 } finally {await context.close();}
})().catch(e=>{console.error(e);process.exit(1)});
