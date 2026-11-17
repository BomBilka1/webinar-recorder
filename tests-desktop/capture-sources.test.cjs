const test = require('node:test');
const assert = require('node:assert/strict');
const {captureTypes,selectSource,describeSources} = require('../desktop/capture-sources.cjs');
const image = {isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,test'};
const sources = [{id:'window:10:0',name:'Приложение',thumbnail:image,appIcon:image},
  {id:'window:11:0',name:'Запись вебинара'},
  {id:'screen:0:0',name:'Screen 1',display_id:'100',thumbnail:image},
  {id:'screen:1:0',name:'Screen 2',display_id:'200'}];
test('window and monitor modes cannot capture each other or the control window', () => {
  assert.deepEqual(captureTypes('window'),['window']);assert.deepEqual(captureTypes('screen'),['screen']);
  assert.equal(selectSource(sources,'window','window:10:0','window:11:0').name,'Приложение');
  assert.throws(()=>selectSource(sources,'window','screen:0:0'));
  assert.throws(()=>selectSource(sources,'screen','window:10:0'));
  assert.throws(()=>selectSource(sources,'window','window:11:0','window:11:0'));
  assert.throws(()=>captureTypes('desktop'));
});
test('closed source is rejected instead of recording a different window', () => {
  assert.throws(()=>selectSource(sources,'window','window:999:0'),/недоступны/);
});
test('picker contains only windows and serializes optional thumbnails', () => {
  const result=describeSources(sources,'window','window:11:0');
  assert.equal(result.length,1);assert.equal(result[0].id,'window:10:0');
  assert.equal(result[0].thumbnail,image.toDataURL());assert.equal(result[0].icon,image.toDataURL());
});
test('monitors are numbered, show resolution and tolerate missing thumbnails', () => {
  const result=describeSources(sources,'screen','window:11:0',[{id:100,size:{width:1920,height:1080}}]);
  assert.deepEqual(result.map(item=>item.name),['Экран 1 · 1920×1080','Экран 2']);
  assert.equal(result[1].thumbnail,null);assert.equal(result[1].icon,null);
});
