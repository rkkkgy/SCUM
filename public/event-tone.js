// 事件颜色语义：good=绿 / bad=红 / info=蓝 / warn=黄 / muted=灰
// 只根据后端已写入的 category + type 判断，不解析标题文本。
export function eventTone(e) {
  const cat = e?.category || 'online';
  const type = e?.type || '';
  if (cat === 'online') {
    if (type === 'offline') return 'bad';
    if (type === 'new') return 'info';
    return 'good';
  }
  if (cat === 'kill') return 'bad';
  if (cat === 'unlock') return type === 'unlock_fail' ? 'bad' : 'good';
  if (cat === 'rank') return type === 'rank_down' ? 'bad' : 'good';
  if (cat === 'risk') return type === 'risk_remove' ? 'good' : 'bad';
  if (cat === 'system') return type === 'restart' ? 'warn' : 'info';
  return 'muted';
}
