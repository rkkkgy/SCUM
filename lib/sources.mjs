// 站点其它数据板块：击杀日志、开锁日志、风控名单
const SITE = 'https://1199.scum8.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

async function getJson(query, timeoutMs = 20000) {
  const res = await fetch(`${SITE}/publicdata.html?${query}&_=${Date.now()}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${SITE}/publicdata.html`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(text);
  if (!json?.success || !Array.isArray(json.data)) throw new Error(json?.msg || '返回结构异常');
  return json.data;
}

/** 击杀日志（最新 24 条） */
export async function fetchKillLog() {
  const rows = await getJson('fenlei=1');
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
    };
  }).filter((r) => r.killer && r.victim);
}

/** 开锁日志（最新 24 条） */
export async function fetchUnlockLog() {
  const rows = await getJson('fenlei=2');
  return rows.map((r) => {
    const sec = Number(r.second);
    return {
      key: `${r.logtime}|${r.name}|${r.target}|${r.number}`,
      at: r.logtime,
      name: String(r.name || '').trim(),
      target: String(r.targetText || r.target || '').trim(),
      lock: String(r.locktypeText || r.locktype || '').trim(),
      success: String(r.completeText || r.complete || '') === '成功',
      seconds: Number.isFinite(sec) ? sec : null,
      attempts: Number(r.Attempts) || 0,
    };
  }).filter((r) => r.name);
}

/** 风控 / 封禁名单 */
export async function fetchRiskList() {
  const rows = await getJson('fenlei=5');
  return rows.map((r) => ({
    key: `${r.steamid}|${r.startTime}`,
    steamid: String(r.steamid || ''),
    name: String(r.name || '').trim(),
    reason: String(r.publicReason || '').trim(),
    startTime: String(r.startTime || ''),
    endTime: String(r.endTime || ''),
  })).filter((r) => r.name);
}

export const RANK_LABEL = {
  kill: '击杀榜',
  deathmatch: '死斗榜',
  fame: '声望榜',
  total_online: '累计在线榜',
};
