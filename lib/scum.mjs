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
  // 空榜单 / 字段改名不能当成“全服没人”，否则会静默把所有人判下线。
  if (list.length === 0) throw new Error('榜单为空');
  const items = list
    .map((it, i) => {
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
    })
    .filter((p) => p.nickname);
  if (items.length === 0) throw new Error('榜单字段异常：缺少 nickname');
  return items;
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

/** 玩家状态排序权重（页面 / CLI / 事件处理共用一份） */
export const STATUS_ORDER = { online: 0, new: 1, idle: 2, dropped: 3 };

/**
 * 比较两次快照，判定每个人的状态。
 * prev/cur: Map<nickname, 今日在线秒数>
 *
 * 站点接口的 rank_value 就是“今日在线秒数”，约每 10–20 秒批量刷新一次；
 * 而 jinbilist 文本只有整分钟。用秒判定，才不会因为“这一轮恰好没跨过整分钟”
 * 把在线的人误判成下线（61 秒间隔下这种情况很常见）。
 * 秒数不涨 => 这段时间没有累计在线时长 => 不在线。
 */
export function diffSnapshots(prev, cur) {
  const out = [];
  const seen = new Set();
  for (const [name, seconds] of cur) {
    seen.add(name);
    const before = prev.has(name) ? prev.get(name) : null;
    const delta = before == null ? null : seconds - before;
    let status;
    if (before == null) status = 'new'; // 本次才出现在榜上
    else if (delta <= 0) status = 'idle'; // 秒数没涨 -> 不在线
    else status = 'online'; // 秒数涨了 -> 在线
    out.push({ name, seconds, minutes: Math.floor(seconds / 60), delta, status });
  }
  for (const [name, seconds] of prev) {
    if (!seen.has(name)) {
      out.push({ name, seconds, minutes: Math.floor(seconds / 60), delta: null, status: 'dropped' });
    }
  }
  out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.seconds - a.seconds);
  return out;
}

/** 读取本地状态 */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
