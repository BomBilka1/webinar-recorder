function captureTypes(mode) {
  if (mode === 'window') return ['window'];
  if (mode === 'screen') return ['screen'];
  throw new Error('Выберите окно приложения или весь экран');
}
function matches(source,mode,excludedId) {
  return source.id !== excludedId && source.id.startsWith(`${captureTypes(mode)[0]}:`);
}
function selectSource(sources,mode,id,excludedId) {
  const source = sources.find(item => item.id === id && matches(item,mode,excludedId));
  if (!source) throw new Error('Выбранное окно или экран недоступны. Обновите список и выберите источник заново.');
  return source;
}
function describeSources(sources,mode,excludedId,displays = []) {
  captureTypes(mode);
  return sources.filter(source => matches(source,mode,excludedId)).map((source,index) => {
    const display = displays.find(item => String(item.id) === source.display_id);
    const name = mode === 'screen'
      ? `Экран ${index+1}${display ? ` · ${display.size.width}×${display.size.height}` : ''}`
      : source.name;
    return {id:source.id,name,kind:mode,
      thumbnail:source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
      icon:source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null};
  });
}
module.exports = {captureTypes,selectSource,describeSources};
