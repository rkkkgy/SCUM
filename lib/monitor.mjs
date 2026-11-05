// 监控核心：拉取榜单、比对增量、维护状态与事件（CLI 与 Web 服务共用）
import fs from 'node:fs';
import path from 'node:path';
import { fetchRanking, diffSnapshots, todayKey } from './scum.mjs';

const iso = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');

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
    this.events = [];
    this.cur = new Map();
    this.rows = [];
    this._timer = null;
    this._inflight = null;
    this.state = this._loadState();
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
      if (s.date !== todayKey()) return { date: todayKey(), round: 0, updatedAt: null, players: {} };
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
      this.events = lines.slice(-200).map((l) => JSON.parse(l)).reverse();
    } catch {
      this.events = [];
    }
  }

  _saveState() {
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

  async _doPoll() {
    const now = new Date();
    if (this.state.date !== todayKey(now)) {
      // 跨天：今日榜重置
      this.state = { date: todayKey(now), round: 0, updatedAt: null, players: {} };
      this.cur = new Map();
      this.rows = [];
      this.events = [];
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
        if (type) {
          const ev = {
            at: iso(now),
            ts: now.toISOString(),
            nickname: r.name,
            type,
            minutes: r.minutes,
            delta: r.delta,
          };
          newEvents.push(ev);
          fs.appendFileSync(this._eventsFile(), JSON.stringify(ev) + '\n');
        }
      }
    }

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
    this.events = [...newEvents.reverse(), ...this.events].slice(0, 200);
    this.onPoll?.({ ok: true });
    return { ok: true, added: newEvents.length };
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
      via: this.lastVia,
      elapsed: this.lastElapsed,
      counts: {
        total: players.length,
        online: players.filter((p) => p.status === 'online').length,
        idle: players.filter((p) => p.status === 'idle').length,
      },
      players,
      events: this.events.slice(0, 30),
    };
  }
}

export function clampInterval(sec) {
  const n = Number(sec);
  // 榜单统计粒度是分钟，间隔低于 61 秒会出现“同一分钟还没跳”而被误判为下线
  if (!Number.isFinite(n)) return 120;
  return Math.min(3600, Math.max(61, Math.round(n)));
}

function readSettings(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  } catch {
    return null;
  }
}
