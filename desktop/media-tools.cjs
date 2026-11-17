const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {indexWebM}=require('./webm-index.cjs');

class MediaTools {
  constructor({binary,notify=()=>{}}={}) {this.binary=binary;this.notify=notify;}
  async run(args,{duration=0,label='Обработка видео'}={}) {
    if(!this.binary)throw new Error('Конвертер отсутствует в этой сборке программы');
    return new Promise((resolve,reject)=>{
      const child=spawn(this.binary,['-hide_banner','-nostdin','-loglevel','warning','-threads','2','-filter_threads','1',...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let error='',progress='',seconds=0,lastProgress=Date.now();
      const watchdog=setInterval(()=>{if(Date.now()-lastProgress>120000)child.kill('SIGKILL');},10000);
      child.stderr.on('data',data=>{error=(error+data.toString()).slice(-3000);});
      child.stdout.on('data',data=>{
        lastProgress=Date.now();progress+=data.toString();const lines=progress.split('\n');progress=lines.pop();
        for(const line of lines)if(line.startsWith('out_time_us=')){seconds=Math.max(seconds,Number(line.slice(12))/1000000||0);this.notify({label,percent:duration?Math.min(99,Math.round(seconds*100/duration)):null});}
      });
      child.on('error',error=>{clearInterval(watchdog);reject(error);});
      child.on('close',code=>{clearInterval(watchdog);if(code===0)resolve({duration:seconds});else reject(new Error(`Не удалось обработать видео (${code}): ${error.slice(-1000)}`));});
    });
  }
  async convert(input,destination,{duration=0}={}) {
    const temp=path.join(path.dirname(destination),`.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await this.run(['-i',input,'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-threads','2','-crf','23','-pix_fmt','yuv420p',
        '-vf','fps=25,pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:a','aac','-b:a','160k','-movflags','+faststart','-progress','pipe:1','-f','mp4','-n',temp],{duration,label:'Сохранение MP4'});
      const handle=await fs.open(temp,'r+');try{await handle.sync();}finally{await handle.close();}
      await fs.rename(temp,destination);
      return {path:destination,bytes:(await fs.stat(destination)).size};
    } finally {await fs.unlink(temp).catch(()=>{});}
  }
  async repair(input,destination) {
    if(path.resolve(input)===path.resolve(destination))throw new Error('Выберите другое имя: исходная запись должна сохраниться');
    // Exclusive destination reservation protects an existing file even if another
    // operation is launched while the dialog is open. The input is never changed.
    const reservation=await fs.open(destination,'wx');await reservation.close();
    const temp=`${destination}.${randomUUID()}.repairing`;
    let duration=0;
    try {
      await fs.copyFile(input,temp,require('node:fs').constants.COPYFILE_EXCL);
      try {duration=(await indexWebM(temp)).duration;}
      catch(error) {
        await fs.unlink(temp);
        if(!this.binary)throw error;
        const recovered=await this.run(['-i',input,'-map','0:v:0','-map','0:a?','-c','copy','-cues_to_front','1','-progress','pipe:1','-f','webm','-n',temp],{label:'Восстановление видео'});duration=recovered.duration;
      }
      const bytes=(await fs.stat(temp)).size;
      if(!bytes)throw new Error('Восстановить видео не удалось: нет видеоданных');
      await fs.rename(temp,destination);return {path:destination,bytes,duration};
    } catch(error) {await fs.unlink(destination).catch(()=>{});throw error;}
    finally {await fs.unlink(temp).catch(()=>{});}
  }
}
module.exports={MediaTools};
