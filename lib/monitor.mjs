// 监控核心：拉取在线榜 + 击杀/开锁/风控/排行榜，维护状态与分类事件
import fs from 'node:fs';
import path from 'node:path';
import { fetchRanking, diffSnapshots, fmtDuration, todayKey } from './scum.mjs';
import { fetchKillLog, fetchUnlockLog, fetchRiskList, RANK_LABEL } from './sources.mjs';

const iso = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');

const SEEN_LIMIT = 800;

export const CATEGORIES = ['online', 'kill', 'unlock', 'rank', 'risk', 'system'];

export class Monitor {
  constructor({ dataDir, intervalSec, type = 'today_online' }) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.intervalSec = clampInterval(intervalSec ?? readSettings(dataDir)?.intervalSec ?? 120);
    this.type = type;
    this.running = false;
    this.lastError = null;
    this.lastPollAt = null;
    this.nextPollAt = null;
    this.lastVia = null;
    this.lastElapsed = 0;
    this.extraErrors = {};
    this.events = [];
    this.cur = new Map();
    this.rows = [];
    this._timer = null;
    this._inflight = null;
    this.state = this._loadState();
    this.seen = this.state.seen || { kill: [], unlock: [], risk: [] };
    this.ranks = this.state.ranks || {};
    this.extrasInit = Boolean(this.state.extrasInit);
    this._loadEvents();
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
    try {
      const s = JSON.parse(fs.readFileSync(this._stateFile(), 'utf8'));
      if (s.date !== todayKey()) {
        // 跨天：只重置“今日”相关数据，seen/ranks 继续沿用
        return { ...s, date: todayKey(), round: 0, updatedAt: null, players: {} };
      }
      for (const [name, p] of Object.entries(s.players || {})) {
        this.cur.set(name, p.minutes ?? Math.floor((p.seconds || 0) / 60));
      }
      return s;
    } catch {
      return { date: todayKey(), round: 0, updatedAt: null, players: {} };
    }
  }

  _loadEvents() {
    try {
      const lines = fs.readFileSync(this._eventsFile(), 'utf8').trim().split('\n').filter(Boolean);
      this.events = lines
        .slice(-400)
        .map((l) => JSON.parse(l))
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
    } catch {
      this.events = [];
    }
  }

  _saveState() {
    this.state.seen = this.seen;
    this.state.ranks = this.ranks;
    this.state.extrasInit = this.extrasInit;
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
    await this.poll();
    if (this.running) this._schedule(this.intervalSec * 1000);
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
    const dayChanged = this.state.date !== todayKey(now);
    if (dayChanged) {
      this.state = {
        ...this.state,
        date: todayKey(now),
        round: 0,
        updatedAt: null,
        players: {},
      };
      this.cur = new Map();
      this.rows = [];
    }
    const prev = new Map(
      Object.entries(this.state.players || {}).map(([n, v]) => [n, v.minutes ?? Math.floor((v.seconds || 0) / 60)]),
    );
    const prevAt = this.state.updatedAt ? new Date(this.state.updatedAt).getTime() : null;
    const elapsed = prevAt ? Math.max(1, Math.round((now.getTime() - prevAt) / 1000)) : 0;
    const isBaseline = prev.size === 0;

    let items;
    try {
      items = await fetchRanking(this.type);
      this.lastError = null;
      this.lastVia = 'http';
    } catch (e) {
      this.lastError = e.message;
      this.lastPollAt = new Date();
      this.onPoll?.({ ok: false, error: e.message });
      return { ok: false, error: e.message };
    }

    const cur = new Map(items.map((p) => [p.nickname, p.minutes]));

    // 距上次判定不足 1 分钟时（例如手连续点“立即刷新”），榜单还没跳分钟，
    // 此时只更新显示数据，不重算在线状态，避免把在线的人误判成下线。
    if (!isBaseline && elapsed < 55) {
      this.cur = cur;
      this.items = items;
      this.lastPollAt = now;
      this.lastSkipped = true;
      this.onPoll?.({ ok: true, skipped: true });
      return { ok: true, skipped: true };
    }
    this.lastSkipped = false;

    const rows = isBaseline ? [] : diffSnapshots(prev, cur);
    const suppressEvents = isBaseline || (this.state.round || 0) <= 1;
    const newEvents = [];

    if (dayChanged) {
      this._push({
        at: iso(now),
        ts: now.toISOString(),
        category: 'system',
        type: 'restart',
        title: '每日 00:00 服务器重启',
        detail: '今日榜已清零，所有玩家时长从 0 重新累计',
      }, newEvents);
    }

    if (!isBaseline && !suppressEvents) {
      for (const r of rows) {
        const old = this.state.players[r.name];
        let type = null;
        if (r.status === 'online') {
          if (!old || old.status === 'idle' || old.status === 'new') type = 'online';
        } else if (r.status === 'idle') {
          if (old && old.status === 'online') type = 'offline';
        } else if (r.status === 'new') {
          type = 'new';
        }
        if (!type) continue;
        const title =
          type === 'online' ? `${r.name} 上线` : type === 'offline' ? `${r.name} 下线` : `${r.name} 今日首次上榜`;
        const detail =
          type === 'online'
            ? `今日 ${fmtDuration(r.minutes * 60)}，本区间 +${r.delta ?? 0} 分钟`
            : type === 'offline'
              ? `今日 ${fmtDuration(r.minutes * 60)}，本区间无增长`
              : `今日 ${fmtDuration(r.minutes * 60)}`;
        this._push({
          at: iso(now),
          ts: now.toISOString(),
          category: 'online',
          type,
          nickname: r.name,
          title,
          detail,
          minutes: r.minutes,
          delta: r.delta,
        }, newEvents);
      }
    }

    // 其它数据板块
    const extras = await this._pollExtras(now);
    for (const ev of extras) this._push(ev, newEvents);

    for (const [name, minutes] of cur) {
      const r = rows.find((x) => x.name === name);
      const old = this.state.players[name];
      const status = r ? r.status : 'new';
      this.state.players[name] = {
        minutes,
        seconds: minutes * 60,
        status,
        delta: r?.delta ?? null,
        lastSeen: now.toISOString(),
        onlineSince: status === 'online' ? old?.onlineSince || now.toISOString() : null,
      };
    }
    this.state.date = todayKey(now);
    this.state.round = (this.state.round || 0) + 1;
    this.state.updatedAt = now.toISOString();
    this._saveState();

    fs.appendFileSync(
      path.join(this.dataDir, `snapshots-${todayKey(now)}.jsonl`),
      JSON.stringify({ at: iso(now), ts: now.toISOString(), via: this.lastVia, items }) + '\n',
    );

    this.cur = cur;
    this.items = items;
    this.rows = rows;
    this.lastPollAt = now;
    this.lastElapsed = elapsed;
    this.events = [...newEvents.reverse(), ...this.events].slice(0, 400);
    this.onPoll?.({ ok: true, added: newEvents.length });
    return { ok: true, added: newEvents.length };
  }

  /** 击杀 / 开锁 / 风控 / 排行榜 */
  async _pollExtras(now) {
    const out = [];
    const first = !this.extrasInit;
    const seenOf = (k) => new Set(this.seen[k] || []);
    const markSeen = (k, keys) => {
      const list = [...(this.seen[k] || []), ...keys];
      this.seen[k] = list.slice(-SEEN_LIMIT);
    };

    const settled = await Promise.allSettled([fetchKillLog(), fetchUnlockLog(), fetchRiskList()]);
    this.extraErrors = {};
    const [killRes, unlockRes, riskRes] = settled;

    if (killRes.status === 'fulfilled') {
      const seen = seenOf('kill');
      const fresh = killRes.value.filter((r) => !seen.has(r.key));
      if (!first) {
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
    } else {
      this.extraErrors.kill = killRes.reason?.message || String(killRes.reason);
    }

    if (unlockRes.status === 'fulfilled') {
      const seen = seenOf('unlock');
      const fresh = unlockRes.value.filter((r) => !seen.has(r.key));
      if (!first) {
        for (const r of fresh.slice(0, 8).reverse()) {
          out.push({
            at: r.at || iso(now),
            ts: now.toISOString(),
            category: 'unlock',
            type: r.success ? 'unlock' : 'unlock_fail',
            nickname: r.name,
            title: `${r.name} ${r.success ? '撬开了' : '尝试撬开'} ${r.target}`,
            detail: [r.lock, r.success ? '成功' : '失败', r.seconds != null ? `${r.seconds} 秒` : '', r.attempts ? `重试 ${r.attempts} 次` : '']
              .filter(Boolean)
              .join(' · '),
          });
        }
      }
      markSeen('unlock', fresh.map((r) => r.key));
    } else {
      this.extraErrors.unlock = unlockRes.reason?.message || String(unlockRes.reason);
    }

    if (riskRes.status === 'fulfilled') {
      const seen = seenOf('risk');
      const curKeys = new Set(riskRes.value.map((r) => r.key));
      if (!first) {
        for (const r of riskRes.value.filter((x) => !seen.has(x.key)).slice(0, 5)) {
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
            title: `风险名单有记录被移除`,
            detail: `steamid ${name}`,
          });
        }
      }
      this.seen.risk = [...curKeys].slice(-SEEN_LIMIT);
    } else {
      this.extraErrors.risk = riskRes.reason?.message || String(riskRes.reason);
    }

    // 首次接入：不把历史记录当成“新事件”，只播报一次各板块的基线情况
    if (first) {
      if (killRes.status === 'fulfilled' && killRes.value.length) {
        const k = killRes.value[0];
        out.push({
          at: iso(now), ts: now.toISOString(), category: 'system', type: 'source_ready', nickname: '系统',
          title: `击杀日志已接入：最近 ${killRes.value.length} 条`,
          detail: `最新 ${k.at} ${k.killer} 击杀 ${k.victim}（${k.weapon}）`,
        });
      }
      if (unlockRes.status === 'fulfilled' && unlockRes.value.length) {
        const u = unlockRes.value[0];
        out.push({
          at: iso(now), ts: now.toISOString(), category: 'system', type: 'source_ready', nickname: '系统',
          title: `开锁日志已接入：最近 ${unlockRes.value.length} 条`,
          detail: `最新 ${u.at} ${u.name} ${u.success ? '撬开' : '尝试'} ${u.target}（${u.lock}）`,
        });
      }
      if (riskRes.status === 'fulfilled') {
        out.push({
          at: iso(now), ts: now.toISOString(), category: 'system', type: 'source_ready', nickname: '系统',
          title: `风控名单已接入：当前 ${riskRes.value.length} 人`,
          detail: riskRes.value.map((r) => `${r.name}（${r.reason}）`).join('、') || '当前没有记录',
        });
      }
    }

    // 排行榜名次变化
    for (const rt of ['kill', 'deathmatch', 'fame', 'total_online']) {
      try {
        const list = await fetchRanking(rt);
        const curRank = {};
        for (const it of list.slice(0, 20)) curRank[it.nickname] = { rank: it.rank, text: it.text };
        const prevRank = this.ranks[rt] || {};
        if (!first) {
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
            if (!curRank[name] && old.rank <= 3) {
              out.push({
                at: iso(now),
                ts: now.toISOString(),
                category: 'rank',
                type: 'rank_down',
                nickname: name,
                title: `${name} 跌出${RANK_LABEL[rt]}前三`,
                detail: `原第 ${old.rank} 名`,
              });
              emitted++;
            }
          }
        }
        this.ranks[rt] = curRank;
      } catch (e) {
        this.extraErrors[`rank_${rt}`] = e.message;
      }
    }

    if (first) this.extrasInit = true;
    return out;
  }

  status() {
    const players = [...this.cur.entries()].map(([name, minutes]) => {
      const p = this.state.players[name] || {};
      const item = (this.items || []).find((i) => i.nickname === name);
      return {
        name,
        minutes,
        seconds: minutes * 60,
        text: item?.text || '',
        title: item?.title || '',
        status: p.status || 'new',
        delta: p.delta ?? null,
        onlineSince: p.onlineSince || null,
      };
    });
    const rank = (s) => ({ online: 0, new: 1, idle: 2, dropped: 3 }[s] ?? 4);
    players.sort((a, b) => rank(a.status) - rank(b.status) || b.minutes - a.minutes);

    const eventCounts = {};
    for (const e of this.events) eventCounts[e.category || 'online'] = (eventCounts[e.category || 'online'] || 0) + 1;

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
      via: this.lastVia,
      elapsed: this.lastElapsed,
      counts: {
        total: players.length,
        online: players.filter((p) => p.status === 'online').length,
        idle: players.filter((p) => p.status === 'idle').length,
      },
      eventCounts,
      players,
      events: this.events.slice(0, 200),
    };
  }
}

export function clampInterval(sec) {
  const n = Number(sec);
  // 榜单统计粒度是分钟，间隔低于 61 秒会出现“同一分钟还没跳”而被误判为下线
  if (!Number.isFinite(n)) return 120;
  return Math.min(3600, Math.max(61, Math.round(n)));
}

/** 单实例锁：防止命令行版和网页版同时写同一份数据 */
export function acquireLock(dataDir) {
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
