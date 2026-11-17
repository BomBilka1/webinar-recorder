// Finalize Chromium MediaRecorder's streaming WebM without decoding media or
// loading the recording into RAM. Positions follow RFC 9559 (Segment-relative).
const fs = require('node:fs/promises');
const TOP = new Set([0x1549a966,0x1654ae6b,0x1f43b675,0x1c53bb6b,0x114d9b74,0x1254c367]);
function vint(b, offset = 0, id = false) {
  const first=b[offset];let n=1;
  while(n<=8 && !(first & (128 >> (n-1)))) n++;
  if(n>8 || offset+n>b.length || (id && n>4)) throw new Error('Повреждён заголовок WebM');
  let value=BigInt(id ? first : first & (255 >> n));
  for(let i=1;i<n;i++) value=(value<<8n)|BigInt(b[offset+i]);
  const unknown=!id && value===(1n<<BigInt(7*n))-1n;
  if(!unknown && value>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Слишком большой элемент WebM');
  return {n,value:unknown ? null : Number(value)};
}
function size(value) {
  let n=1;while(BigInt(value)>=(1n<<BigInt(7*n))-1n)n++;
  const b=Buffer.alloc(n);let v=BigInt(value)|(1n<<BigInt(7*n));
  for(let i=n-1;i>=0;i--){b[i]=Number(v&255n);v>>=8n;}return b;
}
function element(hex, data) {return Buffer.concat([Buffer.from(hex,'hex'),size(data.length),data]);}
function uint(hex,value) {const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(value));return element(hex,b);}
function children(b) {
  const result=[];let p=0;
  while(p<b.length){const id=vint(b,p,true),s=vint(b,p+id.n),start=p+id.n+s.n;
    if(s.value===null || start+s.value>b.length)throw new Error('Повреждены метаданные WebM');
    result.push({id:id.value,data:b.subarray(start,start+s.value),raw:b.subarray(p,start+s.value)});p=start+s.value;}
  return result;
}
function number(b) {let v=0;for(const byte of b)v=v*256+byte;return v;}
async function indexWebM(filename) {
  const input=await fs.open(filename,'r');const temporary=`${filename}.indexing`;
  let output,owned=false;
  try {
    const length=(await input.stat()).size;
    let cache=Buffer.alloc(0),cacheAt=-1;
    async function read(at,count) {
      if(at<0 || at+count>length)throw new Error('Запись WebM обрывается');
      if(count<=65536 && (at<cacheAt || at+count>cacheAt+cache.length)) {
        cache=Buffer.alloc(Math.min(65536,length-at));cacheAt=at;
        let n=0;while(n<cache.length){const r=await input.read(cache,n,cache.length-n,at+n);if(!r.bytesRead)throw new Error('Не удалось прочитать WebM');n+=r.bytesRead;}
      }
      if(count<=65536)return cache.subarray(at-cacheAt,at-cacheAt+count);
      if(count>4*1024*1024)throw new Error('Слишком большой заголовок WebM');
      const b=Buffer.alloc(count);let n=0;
      while(n<count){const r=await input.read(b,n,count-n,at+n);if(!r.bytesRead)throw new Error('Запись WebM обрывается');n+=r.bytesRead;}return b;
    }
    async function header(at) {
      const b=await read(at,Math.min(12,length-at));const id=vint(b,0,true),s=vint(b,id.n);
      const data=at+id.n+s.n,end=s.value===null?null:data+s.value;
      if(end!==null && end>length)throw new Error('Запись WebM обрывается');
      return {at,id:id.value,data,end};
    }
    const ebml=await header(0);if(ebml.id!==0x1a45dfa3 || !ebml.end)throw new Error('Это не запись WebM');
    const segment=await header(ebml.end);if(segment.id!==0x18538067)throw new Error('Не найден Segment WebM');
    const ranges=[],cues=[];let p=segment.data,info,tracks,videoTrack,clusterTime=0,maxTime=0;
    while(p<length) {
      const h=await header(p);
      if(h.id===0x1f43b675) {
        const begin=p;let q=h.data;
        while(q<(h.end??length)) {
          const c=await header(q);
          if(TOP.has(c.id))break;
          if(c.end!==null && h.end!==null && c.end>h.end)throw new Error('Повреждён кластер WebM');
          if(c.end===null)throw new Error('Неизвестный размер блока WebM');
          if(c.id===0xe7)clusterTime=number(await read(c.data,c.end-c.data));
          if(c.id===0xa3) {
            const b=await read(c.data,Math.min(12,c.end-c.data)),track=vint(b);
            if(b.length<track.n+3)throw new Error('Повреждён видеоблок');
            const time=clusterTime+b.readInt16BE(track.n);maxTime=Math.max(maxTime,time);
            if(track.value===videoTrack && (b[track.n+2]&128))cues.push({time,cluster:begin,relative:c.at-h.data});
          }
          if(c.id===0xa0)throw new Error('Неподдерживаемые блоки WebM');
          q=c.end;
        }
        ranges.push({at:begin,end:q});p=q;
      } else {
        if(h.end===null)throw new Error('Неизвестный размер метаданных');
        if(h.id===0x1549a966)info={...h,body:await read(h.data,h.end-h.data)};
        else if(h.id===0x1654ae6b) {
          tracks={...h,body:await read(h.data,h.end-h.data)};
          for(const entry of children(tracks.body).filter(e=>e.id===0xae)){
            const fields=children(entry.data);
            if(number(fields.find(e=>e.id===0x83)?.data||[])===1)videoTrack=number(fields.find(e=>e.id===0xd7).data);
          }
        } else if(h.id!==0x114d9b74 && h.id!==0x1c53bb6b)ranges.push({at:p,end:h.end});
        p=h.end;
      }
    }
    if(!info || !tracks || !cues.length)throw new Error('В записи нет ключевых видеокадров');
    const duration=Buffer.alloc(8);duration.writeDoubleBE(maxTime+1);
    const newInfo=element('1549a966',Buffer.concat([...children(info.body).filter(e=>e.id!==0x4489 && e.id!==0xbf).map(e=>e.raw),element('4489',duration)]));
    const newTracks=element('1654ae6b',tracks.body);
    const seek=(hex,position)=>element('4dbb',Buffer.concat([element('53ab',Buffer.from(hex,'hex')),uint('53ac',position)]));
    const seekHead=positions=>element('114d9b74',Buffer.concat([seek('1549a966',positions[0]),seek('1654ae6b',positions[1]),seek('1c53bb6b',positions[2])]));
    const seekLength=seekHead([0,0,0]).length;
    let position=seekLength+newInfo.length+newTracks.length;const positions=new Map();
    for(const range of ranges){positions.set(range.at,position);position+=range.end-range.at;}
    const index=element('1c53bb6b',Buffer.concat(cues.map(c=>element('bb',Buffer.concat([uint('b3',c.time),element('b7',Buffer.concat([uint('f7',videoTrack),uint('f1',positions.get(c.cluster)),uint('f0',c.relative)]))])))));
    output=await fs.open(temporary,'wx');owned=true;
    async function write(b){let n=0;while(n<b.length){const r=await output.write(b,n);if(!r.bytesWritten)throw new Error('Диск перестал принимать данные');n+=r.bytesWritten;}}
    await write(await read(0,ebml.end));
    await write(Buffer.from('1853806701ffffffffffffff','hex'));
    await write(seekHead([seekLength,seekLength+newInfo.length,position]));await write(newInfo);await write(newTracks);
    for(const range of ranges){
      for(let at=range.at;at<range.end;at+=65536)await write(await read(at,Math.min(65536,range.end-at)));
    }
    await write(index);await output.sync();await output.close();output=null;
    await input.close();await fs.rename(temporary,filename);owned=false;
  } finally {await input.close().catch(()=>{});await output?.close().catch(()=>{});if(owned)await fs.unlink(temporary).catch(()=>{});}
}
module.exports={indexWebM};
