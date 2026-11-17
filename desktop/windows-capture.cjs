const {spawn}=require('node:child_process');
function windowHandle(id){const match=/^window:(\d+):\d+$/.exec(String(id));if(!match || BigInt(match[1])===0n)throw new Error('Неверный идентификатор окна');return match[1];}
class WindowsCapture {
  constructor(binary){this.binary=binary;this.children=new Set();}
  launch(mode,id){
    if(!this.binary)throw new Error('Захват приложения отсутствует в этой сборке');
    this.stopping=false;
    const child=spawn(this.binary,[mode,windowHandle(id)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    this.children.add(child);child.once('close',()=>this.children.delete(child));return child;
  }
  watch(id,onState,onError){
    const child=this.launch('watch',id);let text='';
    child.stdout.on('data',b=>{text+=b;let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n);text=text.slice(n+1);try{onState(JSON.parse(line));}catch{onError(new Error('Не удалось прочитать состояние окна'));}}});
    child.once('error',onError);return child;
  }
  async audio(id,onData,onError){
    const child=this.launch('audio',id);let ready=false,error='',remainder=Buffer.alloc(0);
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{child.kill();reject(new Error('Приложение не предоставило звук за 20 секунд'));},20000);
      child.stdout.on('data',data=>{
        const buffer=Buffer.concat([remainder,data]);const size=buffer.length-buffer.length%4;
        if(size)onData(buffer.subarray(0,size));remainder=Buffer.from(buffer.subarray(size));
      });
      child.stderr.on('data',b=>{error=(error+b.toString()).slice(-2000);if(!ready && error.includes('READY')){ready=true;clearTimeout(timeout);resolve();}});
      child.once('error',e=>{clearTimeout(timeout);if(!ready)reject(e);else onError(e);});
      child.once('exit',(code,signal)=>{clearTimeout(timeout);if(!ready)reject(new Error(`Не удалось захватить звук приложения: ${error}`));else if(!signal && !this.stopping)onError(new Error(`Захват звука приложения остановился (${code})`));});
    });return child;
  }
  stop(){this.stopping=true;for(const child of this.children)child.kill();this.children.clear();}
}
module.exports={WindowsCapture,windowHandle};
