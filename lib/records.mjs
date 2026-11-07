// 原始数据记录：所有来源的完整字段都落盘，供 /data 子页面查看
// - records-YYYY-MM-DD.jsonl：按来源+键去重后的单条记录（击杀/开锁/载具/地堡/封禁/开关）
// - ranks-YYYY-MM-DD.jsonl：每轮一份完整的 5 个排行榜快照
import fs from 'node:fs';
import path from 'node:path';
import { todayKey } from './scum.mjs';
import { toCsv } from './csv.mjs';

const iso = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');

export const RECORD_SOURCES = {
  kill: '击杀',
  unlock: '开锁',
  vehicle: '载具',
  bunker_status: '地堡状态',
  bunker_unlock: '地堡开锁',
  ban: '封禁',
  switches: '功能开关',
};

export const RANK_TYPES = ['today_online', 'total_online', 'kill', 'deathmatch', 'fame'];
export const RANK_TYPE_LABEL = {
  today_online: '今日在线',
  total_online: '累计在线',
  kill: '击杀',
  deathmatch: '死斗',
  fame: '声望',
};

export class RecordStore {
  constructor({ dataDir, now = new Date() }) {
    this.dataDir = dataDir;
    this.date = todayKey(now);
    this.seen = new Set();
    this.switchesSig = null;
    this._load();
  }

  recordsFile(date = this.date) {
    return path.join(this.dataDir, `records-${date}.jsonl`);
  }

  ranksFile(date = this.date) {
    return path.join(this.dataDir, `ranks-${date}.jsonl`);
  }

  /** 启动时读回当天已记录的键，重启后不会重复落盘 */
  _load() {
    for (const ev of parseJsonl(this.recordsFile())) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.source && ev.key != null) this.seen.add(`${ev.source}|${ev.key}`);
      if (ev.source === 'switches') this.switchesSig = JSON.stringify(ev.data ?? null);
    }
  }

  /** 跨天时换文件、清空去重集合 */
  _roll(now) {
    const d = todayKey(now);
    if (d !== this.date) {
      this.date = d;
      this.seen.clear();
      this.switchesSig = null;
    }
  }

  /** 记录一条；同一天内相同 source+key 只记一次，返回是否新写入 */
  record(now, source, key, data) {
    this._roll(now);
    const id = `${source}|${key}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    const ev = { at: iso(now), ts: now.toISOString(), source, key: String(key), data };
    try {
      fs.appendFileSync(this.recordsFile(), JSON.stringify(ev) + '\n');
    } catch {
      this.seen.delete(id);
      return false;
    }
    return true;
  }

  /** 功能开关只在变化时记一条 */
  recordSwitches(now, data) {
    const sig = JSON.stringify(data ?? null);
    if (sig === this.switchesSig) return false;
    if (!this.record(now, 'switches', sig, data)) return false;
    this.switchesSig = sig;
    return true;
  }

  /** 每轮记录 5 个排行榜的完整快照（用数组压缩字段名） */
  recordRanks(now, boards) {
    this._roll(now);
    const out = { at: iso(now), ts: now.toISOString(), boards: {} };
    for (const type of RANK_TYPES) {
      const list = boards?.[type];
      if (!Array.isArray(list) || !list.length) continue;
      out.boards[type] = list.map((it) => [
        it.rank,
        it.nickname,
        Number(it.seconds ?? 0) || 0,
        it.text || '',
        it.title || '',
      ]);
    }
    if (!Object.keys(out.boards).length) return false;
    try {
      fs.appendFileSync(this.ranksFile(), JSON.stringify(out) + '\n');
      return true;
    } catch {
      return false;
    }
  }
}

function parseJsonl(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) out.push(ev);
    } catch {
      // 坏行跳过，不能让整份数据打不开
    }
  }
  return out;
}

const matchQuery = (ev, q) => JSON.stringify(ev).toLowerCase().includes(q.toLowerCase());

/** 记录对应的“事件时间”：优先站点日志时间，其次封禁开始时间，最后才是入库时间 */
export function recordEventTime(ev) {
  const d = ev?.data || {};
  return String(d.logtime || d.startTime || ev?.at || '');
}

/** 读取某天的原始记录（按事件时间倒序，最新在前），支持来源过滤、全文搜索、分页 */
export function readRecords(dataDir, date, { source = '', q = '', limit = 100, offset = 0 } = {}) {
  const all = parseJsonl(path.join(dataDir, `records-${date}.jsonl`)).filter(
    (ev) => (!source || ev.source === source) && (!q || matchQuery(ev, q)),
  );
  // 站点把一批记录同时回传，入库时间 at 全都一样；展示时必须按各自的 logtime 排
  all.sort((a, b) => {
    const ta = recordEventTime(a);
    const tb = recordEventTime(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    // 事件时间相同则后入库的在前；at 也相同则保持站点返回顺序（稳定排序）
    if (a.at === b.at) return 0;
    return a.at < b.at ? 1 : -1;
  });
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

/** 某天各来源的条数、排行榜快照数、事件时间范围 */
export function readRecordMeta(dataDir, date) {
  const events = parseJsonl(path.join(dataDir, `records-${date}.jsonl`));
  const sources = {};
  for (const ev of events) sources[ev.source] = (sources[ev.source] || 0) + 1;
  const ranks = parseJsonl(path.join(dataDir, `ranks-${date}.jsonl`)).length;
  const times = events.map(recordEventTime).filter(Boolean).sort();
  return {
    date,
    total: events.length,
    sources,
    ranks,
    firstAt: times[0] || null,
    lastAt: times[times.length - 1] || null,
  };
}

export const RANK_COLUMNS = ['名次', '玩家', '数值', '文本', '头衔'];

/** 读取排行榜快照（最新在前），type 为空时返回整份 boards */
export function readRankSnapshots(dataDir, date, { type = '', limit = 50, offset = 0 } = {}) {
  const snaps = parseJsonl(path.join(dataDir, `ranks-${date}.jsonl`)).filter(
    (s) => s.boards && (!type || s.boards[type]),
  );
  snaps.reverse();
  const items = snaps.slice(offset, offset + limit).map((s) => ({
    at: s.at,
    ts: s.ts,
    rows: type ? s.boards[type] : s.boards,
  }));
  return { total: snaps.length, items, columns: RANK_COLUMNS };
}

/** 原始记录导出 CSV */
export function buildRecordsCsv(items) {
  const rows = items.map((ev) => [
    ev.at || '',
    RECORD_SOURCES[ev.source] || ev.source || '',
    ev.key || '',
    JSON.stringify(ev.data ?? null),
  ]);
  return '\ufeff' + toCsv(['时间', '来源', '键', '数据'], rows);
}
