// 站点其它数据板块：击杀日志、开锁日志、封禁名单、地堡、载具、功能开关
import { CONFIG } from './config.mjs';

const SITE = 'https://1199.scum8.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${SITE}/publicdata.html`,
};

async function fetchJson(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON: ${text.slice(0, 120)}`);
  }
}

async function getList(query, timeoutMs = 20000) {
  const json = await fetchJson(`${SITE}/publicdata.html?${query}&_=${Date.now()}`, timeoutMs);
  if (!json?.success || !Array.isArray(json.data)) throw new Error(json?.msg || '返回结构异常');
  return json.data;
}

/** 击杀日志（最新 24 条）；raw 保留站点返回的全部字段 */
export async function fetchKillLog({ timeoutMs = 20000 } = {}) {
  const rows = await getList('fenlei=1', timeoutMs);
  return rows.map((r) => {
    const dist = Number(r.distance);
    return {
      key: `${r.logtime}|${r.Killername}|${r.Victimername}|${r.WeaponCode}`,
      at: r.logtime,
      killer: String(r.Killername || '').trim(),
      victim: String(r.Victimername || '').trim(),
      weapon: String(r.Weapon || '').trim(),
      distance: Number.isFinite(dist) && dist > 0 ? dist / 100 : null,
      gameTime: r.Gametime || '',
      raw: r,
    };
  }).filter((r) => r.killer && r.victim);
}

/** 开锁日志（最新 24 条）；raw 含 ownerName / ownerSteamid 等全部字段 */
export async function fetchUnlockLog({ timeoutMs = 20000 } = {}) {
  const rows = await getList('fenlei=2', timeoutMs);
  return rows.map((r) => {
    const sec = Number(r.second);
    // ownerName 可能是空、"无归属" 或 "N/A"，这些都不算有房主
    const ownerRaw = String(r.ownerName || '').trim();
    const owner = ownerRaw && ownerRaw !== '无归属' && !/^N\/A$/i.test(ownerRaw) ? ownerRaw : '';
    return {
      key: `${r.logtime}|${r.name}|${r.target}|${r.number}`,
      at: r.logtime,
      name: String(r.name || '').trim(),
      target: String(r.targetText || r.target || '').trim(),
      lock: String(r.locktypeText || r.locktype || '').trim(),
      success: String(r.completeText || r.complete || '') === '成功',
      seconds: Number.isFinite(sec) ? sec : null,
      attempts: Number(r.Attempts) || 0,
      owner,
      ownerSteamid: owner ? String(r.ownerSteamid || '').trim() : '',
      raw: r,
    };
  }).filter((r) => r.name);
}

/** 封禁 / 风控名单 */
export async function fetchRiskList({ timeoutMs = 20000 } = {}) {
  const rows = await getList('fenlei=5', timeoutMs);
  return rows.map((r) => ({
    key: `${r.steamid}|${r.startTime}`,
    steamid: String(r.steamid || ''),
    name: String(r.name || '').trim(),
    reason: String(r.publicReason || '').trim(),
    startTime: String(r.startTime || ''),
    endTime: String(r.endTime || ''),
    raw: r,
  })).filter((r) => r.name);
}

/** 地堡：当前状态 + 密码门开锁记录（路径是 /user/，但公开可读） */
export async function fetchBunkerLog({ timeoutMs = 20000 } = {}) {
  const json = await fetchJson(`${SITE}/user/logdata/bunker?_=${Date.now()}`, timeoutMs);
  if (!json?.success) throw new Error(json?.msg || '地堡数据异常');
  return {
    statuses: Array.isArray(json.data) ? json.data : [],
    unlockLogs: Array.isArray(json.meta?.unlockLogs) ? json.meta.unlockLogs : [],
  };
}

/** 载具日志：注意站点拼写是 severlog 而不是 serverlog */
export async function fetchVehicleLog({ timeoutMs = 20000 } = {}) {
  const json = await fetchJson(`${SITE}/api/severlog/vehicle?_=${Date.now()}`, timeoutMs);
  if (!json?.success || !Array.isArray(json.data)) throw new Error(json?.msg || '载具数据异常');
  return json.data;
}

/** 公开数据页的功能开关（哪些板块被站点打开） */
export async function fetchPublicSwitches({ timeoutMs = 20000 } = {}) {
  // 页面配置里有 switches / rankingTypes / vehicleAvailable，比 queryswitch 更全
  try {
    const page = await fetchJson(`${SITE}/api/page/publicdata?_=${Date.now()}`, timeoutMs);
    if (page?.success) {
      return {
        switches: page.data?.switches || page.switches || {},
        rankingTypes: page.data?.rankingTypes || page.rankingTypes || [],
        vehicleAvailable: page.data?.vehicleAvailable ?? page.vehicleAvailable ?? null,
      };
    }
  } catch {
    // 老版本站点没有 /api/page/publicdata 时回退到 queryswitch
  }
  const json = await fetchJson(`${SITE}/publicdata.html?queryswitch=yes&_=${Date.now()}`, timeoutMs);
  if (!json?.success) throw new Error(json?.msg || '开关数据异常');
  return { switches: json.data || {}, rankingTypes: [], vehicleAvailable: null };
}

/** 服务器在线人数（SCUMSA 页面，来自 Steam 主列表）：用来和榜单识别数比对 */
export async function fetchServerPopulation({ timeoutMs = 15000 } = {}) {
  const res = await fetch(CONFIG.serverPage, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const pair = html.match(/(\d+)\s+of\s+(\d+)\s+players/i);
  const online = Number((html.match(/"playersOnline"\s*:\s*(\d+)/) || [])[1] ?? pair?.[1]);
  const max = Number(pair?.[2]);
  if (!Number.isFinite(online) || !Number.isFinite(max) || max <= 0) {
    throw new Error('服务器页解析失败（找不到 playersOnline / 上限）');
  }
  const lastSeen = (html.match(/<dt>\s*Last seen\s*<\/dt>\s*<dd>([^<]*)<\/dd>/i) || [])[1]?.trim() || '';
  const name = (html.match(/<title>([^<]*)<\/title>/i) || [])[1]
    ?.replace(/\s+—\s+SCUMSA\s*$/i, '')
    .trim() || '';
  return { online, max, lastSeen, name, source: 'scumsa' };
}

export const RANK_LABEL = {
  kill: '击杀榜',
  deathmatch: '死斗榜',
  fame: '声望榜',
  total_online: '累计在线榜',
};
