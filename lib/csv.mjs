// CSV 输出：按 RFC 4180 转义，并阻止 Excel 公式注入。
// 玩家昵称、事件标题都属于外部可控文本，必须逐字段处理。
export function csvField(value) {
  let s = value == null ? '' : String(value);
  // 以 = + - @ 或制表符/回车开头的单元格会被 Excel 当公式执行
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.join('\r\n');
}
