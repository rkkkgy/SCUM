// 站点数据访问与在线判定逻辑
export const SITE = 'https://1199.scum8.com';
export const BOARD_URL = (type = 'today_online') =>
  `${SITE}/publicdata.html?fenlei=4&rankingType=${type}&_=${Date.now()}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export async function fetchRanking(type = 'today_online', { timeoutMs = 20000 } = {}) {
  const res = await fetch(BOARD_URL(type), {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${SITE}/publicdata.html?view=ranking`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON: ${text.slice(0, 120)}`);
  }
  const list = json?.data;
  if (!Array.isArray(list)) throw new Error(`返回结构异常: ${text.slice(0, 120)}`);
  return list.map((it, i) => {
    const seconds = Number(it.rank_value ?? 0) || 0;
    const text = String(it.jinbilist ?? '').trim();
    return {
      rank: i + 1,
      nickname: String(it.nickname ?? '').trim(),
      seconds,
      minutes: parseMinutes(text, seconds),
      text,
      title: String(it.membership_title ?? '').trim(),
    };
  }).filter((p) => p.nickname);
}

/** 秒 -> 中文时长 */
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时${m}分`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分`;
}

/** 秒 -> 简短增量，例如 +2分10秒 */
export function fmtDelta(sec) {
  sec = Math.round(sec);
  if (sec <= 0) return '0';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}小时`);
  if (m) parts.push(`${m}分`);
  if (!h && s) parts.push(`${s}秒`);
  return '+' + parts.join('');
}

/**
 * 把 "19小时27分钟" / "1天23小时" / "55分钟" 解析成分钟数。
 * 站点统计粒度是分钟，所以一律以分钟为判定单位。
 */
export function parseMinutes(text, secondsFallback = 0) {
  const s = String(text || '');
  const d = s.match(/(\d+)\s*天/);
  const h = s.match(/(\d+)\s*小时/);
  const m = s.match(/(\d+)\s*分/);
  if (d || h || m) {
    return (Number(d?.[1] || 0) * 24 + Number(h?.[1] || 0)) * 60 + Number(m?.[1] || 0);
  }
  return Math.floor(Number(secondsFallback || 0) / 60);
}

/**
 * 比较两次快照，判定每个人的状态。
 * prev/cur: Map<nickname, minutes>
 * 分钟数不变 => 这分钟内没有在线时长增长 => 不在线。
 */
export function diffSnapshots(prev, cur) {
  const out = [];
  const seen = new Set();
  for (const [name, minutes] of cur) {
    seen.add(name);
    const before = prev.has(name) ? prev.get(name) : null;
    const delta = before == null ? null : minutes - before;
    let status;
    if (before == null) status = 'new'; // 本次才出现在榜上
    else if (delta <= 0) status = 'idle'; // 分钟数没变 -> 不在线
    else status = 'online'; // 分钟数涨了 -> 在线
    out.push({ name, minutes, delta, status });
  }
  for (const [name, minutes] of prev) {
    if (!seen.has(name)) out.push({ name, minutes, delta: null, status: 'dropped' });
  }
  // 在线优先，其次按时长倒序
  const order = { online: 0, new: 1, idle: 2, dropped: 3 };
  out.sort((a, b) => order[a.status] - order[b.status] || b.minutes - a.minutes);
  return out;
}

export const STATUS_LABEL = {
  online: '在线',
  new: '新上榜',
  idle: '无变化',
  dropped: '已掉榜',
};

/** 读取本地状态 */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
