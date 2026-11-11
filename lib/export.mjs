// 事件导出：日期校验 / 逐行容错读取 / CSV 组装
import fs from 'node:fs';
import path from 'node:path';
import { toCsv } from './csv.mjs';

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateParam(date) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) return false;
  // 校验真实日历日期：2026-13-99 / 2026-02-30 这类格式正确但不存在的日期也要拒绝
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const EVENT_LABELS = { online: '在线', kill: '击杀', unlock: '开锁', rank: '榜单', risk: '风控', system: '系统' };
const TYPE_LABEL = { online: '上线', offline: '下线', new: '新上榜' };
export const EVENT_CATEGORIES = ['online', 'kill', 'unlock', 'rank', 'risk', 'system'];
export { EVENT_LABELS };

/** 读取某天事件；坏行跳过而不是让整份导出失败 */
export function readEvents(dataDir, date) {
  if (!isValidDateParam(date)) throw new Error('date 参数必须是 YYYY-MM-DD');
  const file = path.join(dataDir, `events-${date}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
      rows.push(ev);
    } catch {
      // 坏行跳过
    }
  }
  return rows;
}

export function buildEventsCsv(rows) {
  const body = rows
    .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
    .map((e) => [
    e.at || '',
    EVENT_LABELS[e.category || 'online'] || '在线',
    e.nickname || '',
    e.title || TYPE_LABEL[e.type] || e.type || '',
    e.detail || '',
  ]);
  return '\ufeff' + toCsv(['时间', '类别', '玩家', '事件', '说明'], body);
}

/** 按类别 / 关键字过滤事件（历史事件页和 CSV 共用） */
export function filterEvents(rows, { category = '', q = '' } = {}) {
  const needle = String(q || '').toLowerCase();
  return (rows || []).filter((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (category && (e.category || 'online') !== category) return false;
    if (!needle) return true;
    // 只搜内容字段，不要把 JSON 的键名（category 等）也算进去
    const hay = `${e.at || ''} ${e.nickname || ''} ${e.title || ''} ${e.detail || ''}`.toLowerCase();
    return hay.includes(needle);
  });
}

/** 某天各分类的事件条数 */
export function eventCounts(rows) {
  const counts = {};
  for (const e of rows || []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const c = e.category || 'online';
    counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
}

/** 生成下载文件名里使用的安全日期（调用前已校验） */
export function eventsCsvFilename(date) {
  return `scum-events-${date}.csv`;
}
