// 监控核心：拉取在线榜 + 击杀/开锁/风控/排行榜，维护状态与分类事件
import fs from 'node:fs';
import path from 'node:path';
import { fetchRanking, diffSnapshots, fmtDuration, todayKey, STATUS_ORDER } from './scum.mjs';
import {
  fetchKillLog, fetchUnlockLog, fetchRiskList,
  fetchBunkerLog, fetchVehicleLog, fetchPublicSwitches,
  RANK_LABEL,
} from './sources.mjs';
import { RecordStore } from './records.mjs';

const iso = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');

const SEEN_LIMIT = 800;
const EVENT_LIMIT = 400;
/** 站点秒数约每 10–20 秒批量刷新；两次判定至少间隔 61 秒才可靠 */
export const MIN_INTERVAL_SEC = 61;
export const MAX_INTERVAL_SEC = 3600;
/** 手动刷新距上次判定不足这个秒数时，只更新数据、不重算状态 */
export const MIN_JUDGE_SEC = 61;
/** 其它板块与排行榜的总预算（每个请求），避免拖长一轮 poll */
const EXTRAS_TIMEOUT_MS = 10000;
/** 数据文件保留天数 */
export const RETENTION_DAYS = 14;

const RANK_TYPES = ['kill', 'deathmatch', 'fame', 'total_online'];

/** 开锁目标带房主时的说法：中文目标不加空格，英文类名加空格 */
function ownedTarget(owner, picker, target) {
  if (!owner) return target;
  const who = owner === picker ? '自己的' : `${owner} 的`;
  return `${who}${/^[\u3400-\u9fff]/.test(target) ? '' : ' '}${target}`;
}

function normalizeBaselines(raw) {
  const ranks = {};
  for (const rt of RANK_TYPES) ranks[rt] = Boolean(raw?.ranks?.[rt]);
  return {
    kill: Boolean(raw?.kill),
    unlock: Boolean(raw?.unlock),
    risk: Boolean(raw?.risk),
    ranks,
  };
}

export class Monitor {
  constructor({ dataDir, intervalSec, type = 'today_online', pruneData = true }) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.intervalSec = clampInterval(intervalSec ?? readSettings(dataDir)?.intervalSec ?? 120);
    this.type = type;
    this.running = false;
    this.lastError = null;
    this.lastPollAt = null;
    this.nextPollAt = null;
    this.extraErrors = {};
    this.events = [];
    this.cur = new Map();
    this.items = [];
    this.badEventLines = 0;
    this._timer = null;
    this._inflight = null;
    this.pendingRestart = false;
    this.state = this._loadState();
    this.seen = this.state.seen || { kill: [], unlock: [], risk: [] };
    this.ranks = this.state.ranks || {};
    this.baselines = normalizeBaselines(this.state.baselines);
    this.records = new RecordStore({ dataDir });
    this.recordError = null;
    this._loadEvents();
    if (pruneData) pruneOldData(this.dataDir);
  }

  _settingsFile() {
    return path.join(this.dataDir, 'settings.json');
  }

  _stateFile() {
    return path.join(this.dataDir, 'state.json');
  }

  _eventsFile(date = todayKey()) {
    return path.join(this.dataDir, `events-${date}.jsonl`);
  }

  _loadState() {
    const blank = {
      date: todayKey(),
      round: 0,
      updatedAt: null,
      players: {},
      board: [],
      seen: { kill: [], unlock: [], risk: [] },
      ranks: {},
      baselines: normalizeBaselines(),
    };
    try {
      const s = JSON.parse(fs.readFileSync(this._stateFile(), 'utf8'));
      if (s.date !== todayKey()) {
        // 跨天：只重置“今日”相关数据，seen/ranks 继续沿用。
        // 记一个标志，等第一次成功 poll 时补发“检测到跨天”事件（只读的 status.mjs 不会触发）。
        this.pendingRestart = true;
        return { ...s, date: todayKey(), round: 0, updatedAt: null, players: {}, board: [] };
      }
      // 只保留最近一次快照里仍存在的玩家，避免旧版本残留的“幽灵在线”。
      // 旧版 state 没有 board 字段时，回退到当天最后一个快照。
      let board = Array.isArray(s.board) ? new Set(s.board) : null;
      if (!board) {
        try {
          const snap = path.join(this.dataDir, `snapshots-${todayKey()}.jsonl`);
          const lines = fs.readFileSync(snap, 'utf8').trim().split('\n');
          const last = JSON.parse(lines[lines.length - 1]);
          if (Array.isArray(last.items)) {
            board = new Set(last.items.map((i) => i.nickname).filter(Boolean));
          }
        } catch {}
      }
      const players = {};
      for (const [name, p] of Object.entries(s.players || {})) {
        if (p.status === 'dropped') continue;
        if (board && !board.has(name)) continue;
        // 旧版 state 的 seconds 是由分钟数乘出来的，兼容读取。
        const seconds = Number(p.seconds ?? (p.minutes || 0) * 60) || 0;
        players[name] = { ...p, seconds, minutes: Math.floor(seconds / 60) };
        this.cur.set(name, seconds);
      }
      return { ...s, players };
    } catch {
      return blank;
    }
  }

  _loadEvents() {
    this.badEventLines = 0;
    let lines;
    try {
      lines = fs.readFileSync(this._eventsFile(), 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      this.events = [];
      return;
    }
    const parsed = [];
    for (const line of lines.slice(-EVENT_LIMIT)) {
      try {
        const ev = JSON.parse(line);
        // 有效 JSON 但不是对象（null/数字/数组）同样视为坏行，不能让后续 .map 崩溃
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('not an object');
        parsed.push(ev);
      } catch {
        this.badEventLines++;
      }
    }
    this.events = parsed
      .map((e) => {
        const category = e.category || 'online';
        const title =
          e.title ||
          (category === 'online'
            ? e.type === 'offline'
              ? `${e.nickname} 下线`
              : e.type === 'new'
                ? `${e.nickname} 今日首次上榜`
                : `${e.nickname} 上线`
            : '');
        return { category, ...e, title };
      })
      .reverse();
  }

  _saveState() {
    this.state.seen = this.seen;
    this.state.ranks = this.ranks;
    this.state.baselines = this.baselines;
    fs.writeFileSync(this._stateFile(), JSON.stringify(this.state, null, 2));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._schedule(300); // 启动后很快先刷一次
  }

  stop() {
    this.running = false;
    this.nextPollAt = null;
    clearTimeout(this._timer);
    this._timer = null;
  }

  setInterval(sec) {
    this.intervalSec = clampInterval(sec);
    try {
      fs.writeFileSync(this._settingsFile(), JSON.stringify({ intervalSec: this.intervalSec }, null, 2));
    } catch {}
    if (this.running) this._schedule(this.intervalSec * 1000);
  }

  _schedule(delayMs) {
    clearTimeout(this._timer);
    this.nextPollAt = Date.now() + delayMs;
    this._timer = setTimeout(() => this._tick(), delayMs);
  }

  /** 手动刷新后重新计时，避免紧接着又自动刷一次 */
  reschedule() {
    if (this.running) this._schedule(this.intervalSec * 1000);
  }

  async _tick() {
    if (!this.running) return;
    const startedAt = Date.now();
    await this.poll();
    if (!this.running) return;
    // 按固定节拍排下一轮：以本轮实际开始时间为基准，而不是 poll 完成时间，
    // 否则抓取耗时会被累加到“检测频率”上；也不能用预定的 nextPollAt，
    // 定时器抖动会让 61 秒档出现 60.999 秒而被误判为“手动刷新”跳过。
    const remaining = startedAt + this.intervalSec * 1000 - Date.now();
    this._schedule(Math.max(1000, remaining));
  }

  /** 立即刷新一次（手动刷新也走这里） */
  async poll() {
    if (this._inflight) return this._inflight;
    this._inflight = this._doPoll().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  _push(ev, list) {
    list.push(ev);
    fs.appendFileSync(this._eventsFile(), JSON.stringify(ev) + '\n');
  }

  async _doPoll() {
    const now = new Date();

    let items;
    try {
      items = await fetchRanking(this.type);
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      this.lastPollAt = now;
      this.onPoll?.({ ok: false, error: e.message });
      return { ok: false, error: e.message };
    }

    const dayChanged = this.pendingRestart || this.state.date !== todayKey(now);
    if (dayChanged) {
      // 先拿到有效榜单再重置，避免接口抖动时把今天的状态清空。
      this.state = {
        ...this.state,
        date: todayKey(now),
        round: 0,
        updatedAt: null,
        players: {},
        board: [],
      };
      this.cur = new Map();
      this.items = [];
      this.pendingRestart = false;
      // 新一天的排行榜重新建立基线，避免拿昨天的名次误报涨跌
      this.baselines.ranks = Object.fromEntries(RANK_TYPES.map((rt) => [rt, false]));
    }

    const prev = new Map(
      Object.entries(this.state.players || {}).map(([n, v]) => [
        n,
        Number(v.seconds ?? (v.minutes || 0) * 60) || 0,
      ]),
    );
    const prevAt = this.state.updatedAt ? new Date(this.state.updatedAt).getTime() : null;
    const elapsed = prevAt ? Math.max(0, Math.floor((now.getTime() - prevAt) / 1000)) : 0;
    const isBaseline = prev.size === 0;
    const cur = new Map(items.map((p) => [p.nickname, p.seconds]));

    // 距上次判定不足 61 秒时（例如手连续点“立即刷新”），秒数增量太小，
    // 此时只更新显示数据，不重算在线状态，避免把在线的人误判成下线。
    if (!isBaseline && elapsed < MIN_JUDGE_SEC) {
      this.cur = cur;
      this.items = items;
      this.lastPollAt = now;
      this.onPoll?.({ ok: true, skipped: true });
      return { ok: true, skipped: true };
    }

    const rows = isBaseline ? [] : diffSnapshots(prev, cur);
    const newEvents = [];

    if (dayChanged) {
      this._push({
        at: iso(now),
        ts: now.toISOString(),
        category: 'system',
        type: 'restart',
        title: '检测到跨天，今日榜已重置',
        detail: '今日在线时长从 0 重新累计，已重建基线',
      }, newEvents);
    }

    if (!isBaseline) {
      for (const r of rows) {
        const old = this.state.players[r.name];
        let type = null;
        let reason;
        if (r.status === 'online') {
          if (!old || old.status === 'idle' || old.status === 'new') type = 'online';
        } else if (r.status === 'idle') {
          if (old && old.status === 'online') type = 'offline';
        } else if (r.status === 'new') {
          type = 'new';
        } else if (r.status === 'dropped') {
          // 掉出前 30：写一条带 reason 的下线事件，并从 state.players 删除。
          // 已判为 idle 的玩家上一轮已经记过下线，掉榜时不再重复记。
          if (old && old.status === 'idle') continue;
          type = 'offline';
          reason = 'dropped';
        }
        if (!type) continue;
        const title =
          type === 'online' ? `${r.name} 上线` : type === 'offline' ? `${r.name} 下线` : `${r.name} 今日首次上榜`;
        const detail =
          type === 'online'
            ? `今日 ${fmtDuration(r.seconds)}，本区间 +${r.delta ?? 0} 秒`
            : reason === 'dropped'
              ? `已掉出今日榜前 30（今日 ${fmtDuration(r.seconds)}）`
              : type === 'offline'
                ? `今日 ${fmtDuration(r.seconds)}，本区间无增长`
                : `今日 ${fmtDuration(r.seconds)}`;
        const ev = {
          at: iso(now),
          ts: now.toISOString(),
          category: 'online',
          type,
          nickname: r.name,
          title,
          detail,
          minutes: r.minutes,
          seconds: r.seconds,
          delta: r.delta,
        };
        if (reason) ev.reason = reason;
        this._push(ev, newEvents);
      }
    }

    // 其它数据板块（内部并行）
    const extras = await this._pollExtras(now);
    for (const ev of extras.events) this._push(ev, newEvents);
    // 所有来源的完整字段都落盘，供 /data 子页面查看
    this._recordRaw(now, items, extras.raw);

    // 只保留当前榜单上的玩家，掉榜者会被删除，避免 state 只增不减。
    const nextPlayers = {};
    for (const [name, seconds] of cur) {
      const r = rows.find((x) => x.name === name);
      const old = this.state.players[name];
      // 跨天/首次启动的第一轮只是基线：榜上的人先记“在榜无变化”，不能算在线。
      // 否则 0 点今日榜重置时，整榜 30 个 0 分钟的玩家会被全部当成“今日首次上榜/在线”。
      const status = r ? r.status : 'idle';
      nextPlayers[name] = {
        seconds,
        minutes: Math.floor(seconds / 60),
        status,
        delta: r?.delta ?? null,
        lastSeen: now.toISOString(),
        onlineSince: status === 'online' ? old?.onlineSince || now.toISOString() : null,
      };
    }
    this.state.players = nextPlayers;
    this.state.board = [...cur.keys()];
    this.state.date = todayKey(now);
    this.state.round = (this.state.round || 0) + 1;
    this.state.updatedAt = now.toISOString();
    this._saveState();

    fs.appendFileSync(
      path.join(this.dataDir, `snapshots-${todayKey(now)}.jsonl`),
      JSON.stringify({ at: iso(now), ts: now.toISOString(), items }) + '\n',
    );

    this.cur = cur;
    this.items = items;
    this.lastPollAt = now;
    this.events = [...newEvents.reverse(), ...this.events].slice(0, EVENT_LIMIT);
    this.onPoll?.({ ok: true, added: newEvents.length });
    return { ok: true, added: newEvents.length };
  }

  /** 击杀 / 开锁 / 风控 / 地堡 / 载具 / 开关 / 排行榜（全部并行，基线按来源分别建立） */
  async _pollExtras(now) {
    const out = [];
    const raw = { ranks: {} };
    const seenOf = (k) => new Set(this.seen[k] || []);
    const markSeen = (k, keys) => {
      const list = [...(this.seen[k] || []), ...keys];
      this.seen[k] = list.slice(-SEEN_LIMIT);
    };

    const tasks = [
      { key: 'kill', promise: fetchKillLog({ timeoutMs: EXTRAS_TIMEOUT_MS }) },
      { key: 'unlock', promise: fetchUnlockLog({ timeoutMs: EXTRAS_TIMEOUT_MS }) },
      { key: 'risk', promise: fetchRiskList({ timeoutMs: EXTRAS_TIMEOUT_MS }) },
      { key: 'bunker', promise: fetchBunkerLog({ timeoutMs: EXTRAS_TIMEOUT_MS }) },
      { key: 'vehicle', promise: fetchVehicleLog({ timeoutMs: EXTRAS_TIMEOUT_MS }) },
      { key: 'switches', promise: fetchPublicSwitches({ timeoutMs: EXTRAS_TIMEOUT_MS }) },
      ...RANK_TYPES.map((rt) => ({ key: `rank_${rt}`, promise: fetchRanking(rt, { timeoutMs: EXTRAS_TIMEOUT_MS }) })),
    ];
    const settled = await Promise.allSettled(tasks.map((t) => t.promise));
    const result = {};
    tasks.forEach((t, i) => {
      result[t.key] = settled[i];
    });

    this.extraErrors = {};
    const failure = (key, r) => {
      this.extraErrors[key] = r.reason?.message || String(r.reason);
    };

    if (result.kill.status === 'fulfilled') {
      const rows = result.kill.value;
      raw.kill = rows;
      const seen = seenOf('kill');
      const fresh = rows.filter((r) => !seen.has(r.key));
      if (!this.baselines.kill) {
        // 首次成功抓到该来源：只建立基线，不把窗口里的历史记录补发成新事件。
        if (rows.length) {
          const k = rows[0];
          out.push({
            at: iso(now), ts: now.toISOString(), category: 'system', type: 'source_ready', nickname: '系统',
            title: `击杀日志已接入：最近 ${rows.length} 条`,
            detail: `最新 ${k.at} ${k.killer} 击杀 ${k.victim}（${k.weapon}）`,
          });
        }
      } else {
        for (const r of fresh.slice(0, 8).reverse()) {
          out.push({
            at: r.at || iso(now),
            ts: now.toISOString(),
            category: 'kill',
            type: 'kill',
            nickname: r.killer,
            title: `${r.killer} 击杀了 ${r.victim}`,
            detail: [r.weapon, r.distance ? `${r.distance.toFixed(1)} 米` : ''].filter(Boolean).join(' · '),
            weapon: r.weapon,
            distance: r.distance,
          });
        }
      }
      markSeen('kill', fresh.map((r) => r.key));
      this.baselines.kill = true;
    } else {
      failure('kill', result.kill);
    }

    if (result.unlock.status === 'fulfilled') {
      const rows = result.unlock.value;
      raw.unlock = rows;
      const seen = seenOf('unlock');
      const fresh = rows.filter((r) => !seen.has(r.key));
      if (!this.baselines.unlock) {
        if (rows.length) {
          const u = rows[0];
          out.push({
            at: iso(now), ts: now.toISOString(), category: 'system', type: 'source_ready', nickname: '系统',
            title: `开锁日志已接入：最近 ${rows.length} 条`,
            detail: `最新 ${u.at} ${u.name} ${u.success ? '撬开' : '尝试'} ${ownedTarget(u.owner, u.name, u.target)}（${u.lock}）`,
          });
        }
      } else {
        for (const r of fresh.slice(0, 8).reverse()) {
          out.push({
            at: r.at || iso(now),
            ts: now.toISOString(),
            category: 'unlock',
            type: r.success ? 'unlock' : 'unlock_fail',
            nickname: r.name,
            title: `${r.name} ${r.success ? '撬开了' : '尝试撬开'} ${ownedTarget(r.owner, r.name, r.target)}`,
            detail: [
              r.owner ? `房主 ${r.owner}` : '',
              r.lock,
              r.success ? '成功' : '失败',
              r.seconds != null ? `${r.seconds} 秒` : '',
              r.attempts ? `重试 ${r.attempts} 次` : '',
            ].filter(Boolean).join(' · '),
          });
        }
      }
      markSeen('unlock', fresh.map((r) => r.key));
      this.baselines.unlock = true;
    } else {
      failure('unlock', result.unlock);
    }

    if (result.risk.status === 'fulfilled') {
      const rows = result.risk.value;
      raw.ban = rows;
      const seen = seenOf('risk');
      const curKeys = new Set(rows.map((r) => r.key));
      if (!this.baselines.risk) {
        out.push({
          at: iso(now), ts: now.toISOString(), category: 'system', type: 'source_ready', nickname: '系统',
          title: `风控名单已接入：当前 ${rows.length} 人`,
          detail: rows.map((r) => `${r.name}（${r.reason}）`).join('、') || '当前没有记录',
        });
      } else {
        for (const r of rows.filter((x) => !seen.has(x.key)).slice(0, 5)) {
          out.push({
            at: r.startTime || iso(now),
            ts: now.toISOString(),
            category: 'risk',
            type: 'risk_add',
            nickname: r.name,
            title: `${r.name} 被列入风险名单`,
            detail: r.reason || '无说明',
          });
        }
        const gone = [...seen].filter((k) => !curKeys.has(k));
        for (const k of gone.slice(0, 5)) {
          const name = k.split('|')[0];
          out.push({
            at: iso(now),
            ts: now.toISOString(),
            category: 'risk',
            type: 'risk_remove',
            nickname: name,
            title: '风险名单有记录被移除',
            detail: `steamid ${name}`,
          });
        }
      }
      this.seen.risk = [...curKeys].slice(-SEEN_LIMIT);
      this.baselines.risk = true;
    } else {
      failure('risk', result.risk);
    }

    if (result.bunker.status === 'fulfilled') {
      raw.bunker = result.bunker.value;
    } else {
      failure('bunker', result.bunker);
    }

    if (result.vehicle.status === 'fulfilled') {
      raw.vehicle = result.vehicle.value;
    } else {
      failure('vehicle', result.vehicle);
    }

    if (result.switches.status === 'fulfilled') {
      raw.switches = result.switches.value;
    } else {
      failure('switches', result.switches);
    }

    // 排行榜名次变化
    for (const rt of RANK_TYPES) {
      const res = result[`rank_${rt}`];
      if (res.status !== 'fulfilled') {
        failure(`rank_${rt}`, res);
        continue;
      }
      const list = res.value;
      raw.ranks[rt] = list;
      const curRank = {};
      for (const it of list.slice(0, 20)) curRank[it.nickname] = { rank: it.rank, text: it.text };
      const prevRank = this.ranks[rt] || {};
      if (this.baselines.ranks[rt]) {
        let emitted = 0;
        for (const [name, cur] of Object.entries(curRank)) {
          if (emitted >= 5) break;
          const old = prevRank[name];
          const better = old && cur.rank < old.rank && (cur.rank <= 3 || old.rank - cur.rank >= 3);
          const entered = !old && cur.rank <= 3;
          if (!better && !entered) continue;
          out.push({
            at: iso(now),
            ts: now.toISOString(),
            category: 'rank',
            type: old ? 'rank_up' : 'rank_enter',
            nickname: name,
            title: old
              ? `${name} 在${RANK_LABEL[rt]}升至第 ${cur.rank}`
              : `${name} 进入${RANK_LABEL[rt]}前三`,
            detail: old ? `第 ${old.rank} → 第 ${cur.rank} 名 · ${cur.text}` : `${cur.text} · 第 ${cur.rank} 名`,
          });
          emitted++;
        }
        for (const [name, old] of Object.entries(prevRank)) {
          if (emitted >= 6) break;
          if (old.rank > 3) continue;
          const cur = curRank[name];
          if (cur && cur.rank <= 3) continue;
          out.push({
            at: iso(now),
            ts: now.toISOString(),
            category: 'rank',
            type: 'rank_down',
            nickname: name,
            title: cur ? `${name} 跌出${RANK_LABEL[rt]}前三（第 ${cur.rank} 名）` : `${name} 跌出${RANK_LABEL[rt]}前三`,
            detail: cur ? `第 ${old.rank} → 第 ${cur.rank} 名` : `原第 ${old.rank} 名，已掉出前 20`,
          });
          emitted++;
        }
      }
      this.ranks[rt] = curRank;
      this.baselines.ranks[rt] = true;
    }

    return { events: out, raw };
  }

  /** 把所有来源的完整原始记录写入 records/ranks 文件（失败不影响监控主流程） */
  _recordRaw(now, items, raw = {}) {
    try {
      for (const r of raw.kill || []) this.records.record(now, 'kill', r.key, r.raw ?? r);
      for (const r of raw.unlock || []) this.records.record(now, 'unlock', r.key, r.raw ?? r);
      for (const r of raw.ban || []) this.records.record(now, 'ban', r.key, r.raw ?? r);

      for (const r of raw.vehicle || []) {
        this.records.record(now, 'vehicle', `${r.logtime}|${r.Operationtype}|${r.VehicleID}`, r);
      }

      const bunker = raw.bunker;
      for (const r of bunker?.statuses || []) {
        this.records.record(now, 'bunker_status', `${r.logtime}|${r.Bunkername}|${r.Bunkerstatus}`, r);
      }
      for (const r of bunker?.unlockLogs || []) {
        this.records.record(now, 'bunker_unlock', `${r.logtime}|${r.name}|${r.Operationresult}|${r.time}`, r);
      }

      if (raw.switches) this.records.recordSwitches(now, raw.switches);

      const boards = { [this.type]: items, ...(raw.ranks || {}) };
      this.records.recordRanks(now, boards);
      this.recordError = null;
    } catch (e) {
      this.recordError = e.message;
    }
  }

  status() {
    const players = [...this.cur.entries()].map(([name, seconds]) => {
      const p = this.state.players[name] || {};
      const item = this.items.find((i) => i.nickname === name);
      return {
        name,
        minutes: Math.floor(seconds / 60),
        seconds,
        durationText: fmtDuration(seconds),
        text: item?.text || '',
        title: item?.title || '',
        status: p.status || 'new',
        delta: p.delta ?? null,
        onlineSince: p.onlineSince || null,
      };
    });
    players.sort((a, b) => (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4) || b.minutes - a.minutes);

    const count = (st) => players.filter((p) => p.status === st).length;
    const online = count('online');
    const fresh = count('new');

    return {
      running: this.running,
      intervalSec: this.intervalSec,
      type: this.type,
      date: this.state.date,
      round: this.state.round || 0,
      updatedAt: this.state.updatedAt,
      lastPollAt: this.lastPollAt?.toISOString() || null,
      nextPollAt: this.nextPollAt,
      serverNow: Date.now(),
      lastError: this.lastError,
      extraErrors: this.extraErrors,
      recordError: this.recordError,
      badEventLines: this.badEventLines,
      counts: {
        total: players.length,
        // 与页面上“在线”列表口径一致：判定在线 + 今日新上榜
        online: online + fresh,
        strictOnline: online,
        new: fresh,
        idle: count('idle'),
      },
      players,
      events: this.events.slice(0, 200),
    };
  }
}

export function clampInterval(sec) {
  const n = Number(sec);
  // 榜单统计粒度是分钟，间隔低于 61 秒会出现“同一分钟还没跳”而被误判为下线
  if (!Number.isFinite(n)) return 120;
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.round(n)));
}

/** 删除超过保留天数的 events-*.jsonl / snapshots-*.jsonl，返回删除数量 */
export function pruneOldData(dataDir, { days = RETENTION_DAYS, now = new Date() } = {}) {
  const cutoff = todayKey(new Date(now.getTime() - days * 86400000));
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = name.match(/^(?:events|snapshots|records|ranks)-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m || m[1] >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dataDir, name));
      removed++;
    } catch {}
  }
  return removed;
}

/** 单实例锁：防止命令行版和网页版同时写同一份数据 */
export function acquireLock(dataDir) {
  // 全新解压的目录里还没有 data/，锁文件会写不进去（ENOENT），先确保目录存在
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {}
  const file = path.join(dataDir, 'monitor.lock');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // 进程还活着
        return { ok: false, pid };
      } catch {
        // 进程已退出，接管
      }
    }
  } catch {}
  fs.writeFileSync(file, String(process.pid));
  return { ok: true };
}

export function releaseLock(dataDir) {
  const file = path.join(dataDir, 'monitor.lock');
  try {
    if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.unlinkSync(file);
  } catch {}
}

function readSettings(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  } catch {
    return null;
  }
}
