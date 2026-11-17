const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
class RecordingLibrary {
  constructor(filename){this.filename=filename;this.items=[];this.pending=Promise.resolve();}
  async load(){
    try {const value=JSON.parse(await fs.readFile(this.filename,'utf8'));if(!Array.isArray(value))throw new Error('Invalid history');this.items=value;}
    catch(e){if(e.code!=='ENOENT')throw new Error('Не удалось прочитать историю записей. Исходные видео остаются в выбранных папках.');}
    for(const entry of this.items)if(['recording','processing','waiting'].includes(entry.status))entry.status='interrupted';
    await this.save();return this.list();
  }
  save(){
    const data=JSON.stringify(this.items,null,2);
    const operation=this.pending.then(async()=>{
      await fs.mkdir(path.dirname(this.filename),{recursive:true});
      const temp=`${this.filename}.tmp`;const h=await fs.open(temp,'w');
      try{await h.writeFile(data);await h.sync();}finally{await h.close();}
      await fs.rename(temp,this.filename);
    });this.pending=operation.catch(()=>{});return operation;
  }
  list(){return structuredClone(this.items).reverse();}
  get(id){const entry=this.items.find(item=>item.id===id);if(!entry)throw new Error('Запись не найдена в истории');return entry;}
  async add(data){const entry={id:randomUUID(),created:new Date().toISOString(),status:'recording',duration:0,segments:[],...data};this.items.push(entry);await this.save();return entry;}
  async patch(id,change){Object.assign(this.get(id),change);await this.save();return this.get(id);}
}
module.exports={RecordingLibrary};
