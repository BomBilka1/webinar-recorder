const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {FileSession}=require('./file-session.cjs');
const {indexWebM}=require('./webm-index.cjs');
const MIB=1048576;
class RecordingSession {
  constructor({library,media,notify=()=>{},statfs=fs.statfs}){Object.assign(this,{library,media,notify,statfs});this.work=Promise.resolve();this.errors=[];this.totalBytes=0;this.lastDisk=0;}
  get partial(){return this.file?.partial;}
  async start(destination,options={}){
    if(!['webm','mp4'].includes(options.format))throw new Error('Выберите WebM или MP4');
    if(options.format==='mp4' && !this.media.binary)throw new Error('MP4 недоступен в этой сборке');
    this.destination=destination;this.options=options;
    const stats=await this.statfs(path.dirname(destination));
    if(Number(stats.bavail)*Number(stats.bsize)<64*MIB)throw new Error('Для записи нужно не менее 64 МБ свободного места');
    this.entry=await this.library.add({status:options.waiting?'waiting':'recording',format:options.format,segments:[]});
    try {await this.next();}catch(e){await this.library.patch(this.entry.id,{status:'error',error:e.message});throw e;}
    return {name:path.basename(destination),partial:this.file.partial,id:this.entry.id};
  }
  async next(){
    const index=this.entry.segments.length+1;
    const ext=path.extname(this.destination),base=this.destination.slice(0,-ext.length)||this.destination;
    const target=this.options.splitMinutes?`${base}.part${String(index).padStart(3,'0')}${ext}`:this.destination;
    if(this.options.splitMinutes){try{await fs.access(target);throw new Error(`Файл уже существует: ${target}`);}catch(e){if(e.code!=='ENOENT')throw e;}}
    const raw=this.options.format==='mp4'?`${target}.${randomUUID()}.source.webm`:target;
    const file=await FileSession.open(raw);
    this.file=file;this.segment={number:index,path:target,raw,partial:file.partial,status:'recording',duration:0,bytes:0};
    this.entry.segments.push(this.segment);
    try{await this.library.save();}
    catch(error){await file.abort().catch(()=>{});this.file=null;this.segment.status='interrupted';throw error;}
  }
  async write(data){
    const bytes=await this.file.write(data);
    if(Date.now()-this.lastDisk>5000){
      this.lastDisk=Date.now();this.segment.bytes=bytes;await this.library.save();
      try{
        const stat=await this.statfs(path.dirname(this.file.partial));const free=Number(stat.bavail)*Number(stat.bsize);
        if(free<bytes+64*MIB)this.notify('low-disk',{free,needed:bytes+64*MIB});
        else this.notify('disk',{free});
      }catch{this.notify('disk-warning',{});}
    }
    return this.totalBytes+bytes;
  }
  async closeSegment(duration){
    const file=this.file,segment=this.segment;this.file=null;
    try {
      const result=await file.finish();
      segment.duration=Number.isFinite(duration)?Math.max(0,duration):0;segment.bytes=result.bytes;segment.status='processing';
      this.totalBytes+=result.bytes;await this.library.save();
      this.work=this.work.then(async()=>{
        try {
          this.notify('processing',{label:'Подготовка перемотки',number:segment.number});
          const disk=await this.statfs(path.dirname(segment.raw));
          if(Number(disk.bavail)*Number(disk.bsize)<segment.bytes+16*MIB)throw new Error('Недостаточно места для индексации; исходное видео сохранено');
          await indexWebM(segment.raw);
          if(this.options.format==='mp4'){
            const result=await this.media.convert(segment.raw,segment.path,{duration:segment.duration});segment.bytes=result.bytes;
          }else segment.bytes=(await fs.stat(segment.path)).size;
          segment.status='completed';
        }catch(e){segment.status='error';segment.error=e.message;this.errors.push(e.message);}
        await this.library.save();this.notify('history',{});
      }).catch(error=>{this.errors.push(error.message);this.notify('processing-error',{message:error.message});});
    }catch(e){segment.status='interrupted';segment.bytes=file.bytes;segment.error=e.message;await this.library.save();throw e;}
  }
  async rotate(duration){await this.closeSegment(duration);await this.next();return {partial:this.file.partial,number:this.segment.number};}
  async finish(duration){
    try{
      if(this.file)await this.closeSegment(duration);
      await this.work;
      this.entry.duration=this.entry.segments.reduce((n,s)=>n+s.duration,0);
      this.entry.status=this.errors.length?'error':'completed';await this.library.save();
      const last=this.entry.segments.at(-1);
      return {path:last.status==='completed'?last.path:last.raw,bytes:this.totalBytes,warning:this.errors.join('\n'),segments:this.entry.segments.length};
    }catch(e){this.entry.status='interrupted';await this.library.save();throw e;}
  }
  async abort(){
    let result;
    if(this.file){result=await this.file.abort();this.file=null;this.segment.status='interrupted';this.segment.bytes=result.bytes;}
    await this.work;
    if(!result){
      for(const segment of [...this.entry.segments].reverse()){
        for(const candidate of [segment.partial,segment.raw]){
          try{const stat=await fs.stat(candidate);if(stat.size){result={path:candidate,bytes:stat.size};break;}}catch{}
        }
        if(result)break;
      }
    }
    this.entry.status=this.totalBytes || result?.bytes?'interrupted':'cancelled';await this.library.save();return result;
  }
}
module.exports={RecordingSession};
