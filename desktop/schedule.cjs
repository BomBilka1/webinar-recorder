function planTimes({startAt,endAt,durationMinutes=0}={},now=Date.now()) {
  const start=startAt!==undefined && startAt!==null && startAt!==''?Number(startAt):now;
  const duration=Number(durationMinutes);
  if(!Number.isFinite(start) || start<now-60000 || start>now+7*86400000)throw new Error('Начало записи должно быть в ближайшие 7 дней');
  if(!Number.isFinite(duration)||duration<0||duration>10080)throw new Error('Длительность: от 0 до 10080 минут');
  const end=endAt!==undefined && endAt!==null && endAt!==''?Number(endAt):(duration?Math.max(start,now)+duration*60000:null);
  if(end!==null && (!Number.isFinite(end)||end<=Math.max(start,now)||end>now+14*86400000))throw new Error('Окончание должно быть позже начала записи (не более 14 дней)');
  return {startAt:Math.max(start,now),endAt:end};
}
class Schedule {
  constructor({startAt,endAt,onStart,onStop,now=Date.now,interval=setInterval,clear=clearInterval}) {
    Object.assign(this,{startAt,endAt,onStart,onStop,now,clear});this.started=false;this.stopped=false;
    this.timer=interval(()=>this.tick(),500);
  }
  tick(){
    if(this.stopped)return;
    const now=this.now();
    if(this.endAt && now>=this.endAt){this.stopped=true;this.dispose();this.onStop();return;}
    if(!this.started && now>=this.startAt){this.started=true;this.onStart();}
  }
  dispose(){this.clear(this.timer);this.stopped=true;}
}
module.exports={planTimes,Schedule};
