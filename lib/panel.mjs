// 新日志面板（茶c-SCUM 控制台）接入层
// - 只读：登录、拉在线总览/在线名单/五类日志
// - 独立记录：panel-*.jsonl、panel-records-*.jsonl、compare-*.jsonl
// - 不改动旧监控的统计逻辑，只读取旧监控的 status 做对照
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { todayKey } from './scum.mjs';
import { readEvents, eventCounts } from './export.mjs';

export const PANEL_BASE = 'https://web-log.chacca.net';
export const PANEL_API = '/prod-api';
export const PANEL_INTERVAL_MS = 120000;
export const PANEL_LINK_FILE = 'panel-link.txt';
export const PANEL_RETENTION_DAYS = 14;

/** 面板五类日志：key 用于本地文件，type 用于接口 */
export const PANEL_LOG_DEFS = {
  lock: { type: 'gamePlay:lockPicking', label: '撬锁' },
  bomb: { type: 'gamePlay:bombFefusalMiniGame', label: '剪线' },
  kill: { type: 'kill', label: '击杀' },
  vehicle: { type: 'vehicle:destruction', label: '载具' },
  admin: { type: 'admin:command', label: '管理命令' },
};

/** 面板页面里的 RSA 公钥（前端登录用它加密随机 sign） */
const PANEL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCu+3Zo9zMeNdjF33nBRWOAjq5ax8//Dy+23qr4R9R/PJ+vclyMhnObVwYy66Dl+72JsKtGSuZD2+ylskHL8HEkf6VfZGhUAj7HBjucDj/my0ZUATu5V9Y80DNq+9610gVK2gSfDi4ybOghOeFQve7ptedoBoFSGfJMpfktYYzEuwIDAQAB
-----END PUBLIC KEY-----`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const iso = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');

const dayStart = (d = new Date()) => `${todayKey(d)} 00:00:00`;
const dayEnd = (d = new Date()) => `${todayKey(d)} 23:59:59`;

function decodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 从 hash/query 里取 m、s；不把 base64 里的 + 当空格 */
function linkParams(link) {
  const raw = String(link || '').trim();
  if (!raw) throw new Error('未配置面板链接');
  const hashAt = raw.indexOf('#');
  let query = '';
  if (hashAt >= 0) {
    const h = raw.slice(hashAt + 1);
    query = h.includes('?') ? h.slice(h.indexOf('?') + 1) : h;
  } else if (raw.includes('?')) {
    query = raw.slice(raw.indexOf('?') + 1);
  } else {
    query = raw;
  }
  const out = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decodeParam(eq >= 0 ? part.slice(0, eq) : part);
    const v = decodeParam(eq >= 0 ? part.slice(eq + 1) : '');
    out[k] = v;
  }
  if (!out.m || !out.s) throw new Error('面板链接缺少 m/s 参数');
  return out;
}

/** 用 s（base64 key）解开 m（IV+密文），返回 {account,password} */
export function decryptMagic(m, s) {
  const key = Buffer.from(s, 'base64');
  const raw = Buffer.from(m, 'base64');
  if (![16, 24, 32].includes(key.length)) throw new Error('面板链接密钥长度不正确');
  if (raw.length <= 16) throw new Error('面板链接密文长度不正确');
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  const d = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export function parsePanelLink(link) {
  const { m, s } = linkParams(link);
  const text = decryptMagic(m, s);
  let creds;
  try {
    creds = JSON.parse(text);
  } catch {
    throw new Error('面板链接内容不是 JSON');
  }
  if (!creds?.account || !creds?.password) throw new Error('面板链接缺少账号或密码');
  return { account: creds.account, password: creds.password };
}

export function randomSign(len = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function rsaSign(sign) {
  return crypto
    .publicEncrypt(
      { key: PANEL_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(sign),
    )
    .toString('base64');
}

export function aesEncrypt(obj, sign) {
  const key = Buffer.from(sign, 'utf8');
  if (![16, 24, 32].includes(key.length)) throw new Error('面板 sign 长度不正确');
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
}

export function aesDecrypt(text, sign) {
  const key = Buffer.from(sign, 'utf8');
  if (![16, 24, 32].includes(key.length)) throw new Error('面板 sign 长度不正确');
  const raw = Buffer.from(text, 'base64');
  if (raw.length <= 16) throw new Error('面板响应密文长度不正确');
  const d = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, raw.subarray(0, 16));
  return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
}

/** 响应可能是普通 JSON，也可能是 JSON 字符串里再套一层 AES 密文 */
export function parsePanelResponse(text, sign) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    v = text;
  }
  if (typeof v === 'string') {
    try {
      return JSON.parse(aesDecrypt(v, sign));
    } catch {
      return { code: 500, msg: '面板响应解密失败', raw: v.slice(0, 200) };
    }
  }
  return v;
}

function isAuthError(j) {
  const msg = String(j?.msg || j?.message || '');
  return Number(j?.code) === 401 || (Number(j?.code) === 403 && /认证|token|登录|过期|失效/i.test(msg));
}

/** 面板 API 客户端：登录一次，后续请求体 AES 加密、响应 AES 解密 */
export class PanelClient {
  constructor({ link, base = PANEL_BASE, fetchImpl = fetch, timeoutMs = 25000 } = {}) {
    this.link = link;
    this.base = base.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.creds = parsePanelLink(link);
    this.token = null;
    this.sign = null;
    this.expiresAt = null;
    this.loginAt = null;
  }

  async _fetch(pathname, options = {}) {
    return this.fetchImpl(this.base + pathname, {
      ...options,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async login() {
    const sign = randomSign(16);
    const res = await this._fetch(PANEL_API + '/login', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Origin: this.base,
        Referer: this.base + '/',
      },
      body: JSON.stringify({
        username: this.creds.account,
        password: this.creds.password,
        appType: 'matrix',
        sign: rsaSign(sign),
      }),
    });
    const j = await res.json().catch(() => null);
    if (Number(j?.code) !== 200 || !j?.data?.accessToken) {
      throw new Error(`面板登录失败：${j?.msg || res.status}`);
    }
    this.token = j.data.accessToken;
    this.sign = sign;
    this.expiresAt = j.data.webLogExpireTime || null;
    this.loginAt = new Date().toISOString();
    return this;
  }

  async _ensure() {
    if (!this.token || !this.sign) await this.login();
  }

  async _api(pathname, payload) {
    await this._ensure();
    const call = async () => {
      const res = await this._fetch(PANEL_API + pathname, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          Origin: this.base,
          Referer: this.base + '/',
        },
        body: JSON.stringify({ data: aesEncrypt(payload, this.sign) }),
      });
      const text = await res.text();
      return parsePanelResponse(text, this.sign);
    };
    let j = await call();
    if (isAuthError(j)) {
      this.token = null;
      this.sign = null;
      await this.login();
      j = await call();
    }
    if (Number(j?.code) !== 200) throw new Error(`面板接口失败：${j?.msg || j?.code || '未知错误'}`);
    return j;
  }

  async overview() {
    const j = await this._api('/common/analysis/dashboard_overview', { key: 123 });
    return {
      online: Number(j.data?.online?.current) || 0,
      previous: Number(j.data?.online?.previous) || 0,
      active24h: Number(j.data?.active24h?.current) || 0,
      killsToday: Number(j.data?.killsToday?.current) || 0,
      lastLogTime: j.data?.lastLogTime || null,
      expiresAt: j.webLogExpireTime || this.expiresAt || null,
    };
  }

  async onlinePlayers() {
    const j = await this._api('/common/analysis/online_players', { key: 123 });
    return Array.isArray(j.data) ? j.data : [];
  }

  /** 五类日志的今日总数 + 最近 size 条 */
  async logs({ begin = dayStart(), end = dayEnd(), size = 50 } = {}) {
    const out = {};
    for (const [key, def] of Object.entries(PANEL_LOG_DEFS)) {
      const j = await this._api('/webLog/serverLog/log', {
        page: 1,
        size,
        type: def.type,
        begin,
        end,
      });
      out[key] = {
        type: def.type,
        label: def.label,
        total: Number(j.total) || 0,
        rows: Array.isArray(j.data) ? j.data : [],
      };
    }
    return out;
  }
}

/** 新日志面板监控：定时拉取、落盘、和旧监控对照 */
export class PanelMonitor {
  constructor({
    dataDir,
    linkFile,
    intervalMs = PANEL_INTERVAL_MS,
    oldStatus = () => null,
    fetchImpl = fetch,
    now = () => new Date(),
  } = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.linkFile = linkFile || path.join(dataDir, PANEL_LINK_FILE);
    this.intervalMs = Math.max(30000, Number(intervalMs) || PANEL_INTERVAL_MS);
    this.oldStatus = oldStatus;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.client = null;
    this.link = null;
    this.timer = null;
    this.lastAt = null;
    this.lastError = null;
    this.overview = null;
    this.online = [];
    this.logs = {};
    this.comparison = null;
    this.recordsDate = null;
    this.seenRecords = new Set();
    this._inflight = null;
  }

  _readLink() {
    try {
      return fs.readFileSync(this.linkFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  _file(prefix, date = todayKey(this.now())) {
    return path.join(this.dataDir, `${prefix}-${date}.jsonl`);
  }

  _append(file, obj) {
    try {
      fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    } catch (e) {
      this.lastError = `写入 ${path.basename(file)} 失败：${e.message}`;
    }
  }

  _loadSeen(date) {
    this.seenRecords.clear();
    this.recordsDate = date;
    let text = '';
    try {
      text = fs.readFileSync(this._file('panel-records', date), 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.key) this.seenRecords.add(`${row.type}|${row.key}`);
      } catch {
        // 坏行跳过
      }
    }
  }

  _recordKey(type, row) {
    if (type === 'vehicle') return String(row.uid ?? `${row.time}|${row.type}|${row.vehicleId}`);
    if (type === 'kill') {
      return `${row.time}|${row.killerSteamid || row.killerName}|${row.victimSteamid || row.victimName}|${row.weapon || ''}`;
    }
    if (type === 'admin') return `${row.time}|${row.steamId}|${row.defaultCode || row.code || ''}`;
    if (type === 'bomb') {
      return `${row.time}|${row.steamid}|${row.target}|${row.isSuccess}|${row.elapsedTime}|${row.failedAttempts}`;
    }
    return `${row.time}|${row.steamid}|${row.targetId || row.target}|${row.ownerSteamid}|${row.elapsedTime}|${row.failedAttempts}`;
  }

  _storeRecords(type, rows, now) {
    const date = todayKey(now);
    if (this.recordsDate !== date) this._loadSeen(date);
    for (const row of rows || []) {
      const key = this._recordKey(type, row);
      const id = `${type}|${key}`;
      if (this.seenRecords.has(id)) continue;
      this.seenRecords.add(id);
      this._append(this._file('panel-records', date), {
        at: iso(now),
        ts: now.toISOString(),
        type,
        key,
        data: row,
      });
    }
  }

  _prune(now) {
    const cutoff = todayKey(new Date(now.getTime() - PANEL_RETENTION_DAYS * 86400000));
    let names = [];
    try {
      names = fs.readdirSync(this.dataDir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = name.match(/^(?:panel|panel-records|compare)-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m || m[1] >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.dataDir, name));
      } catch {}
    }
  }

  async poll() {
    if (this._inflight) return this._inflight;
    this._inflight = this._poll().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _poll() {
    const now = this.now();
    const link = this._readLink();
    if (!link) {
      this.lastError = '未配置 data/panel-link.txt';
      return { ok: false, error: this.lastError, configured: false };
    }

    try {
      if (!this.client || this.link !== link) {
        this.client = new PanelClient({ link, fetchImpl: this.fetchImpl });
        this.link = link;
      }
      const [overview, online] = [await this.client.overview(), await this.client.onlinePlayers()];
      const logs = await this.client.logs({ begin: dayStart(now), end: dayEnd(now), size: 50 });

      this._storeRecords('lock', logs.lock.rows, now);
      this._storeRecords('bomb', logs.bomb.rows, now);
      this._storeRecords('kill', logs.kill.rows, now);
      this._storeRecords('vehicle', logs.vehicle.rows, now);
      this._storeRecords('admin', logs.admin.rows, now);

      const latest = {};
      for (const [key, def] of Object.entries(PANEL_LOG_DEFS)) {
        latest[key] = { total: logs[key].total, rows: logs[key].rows.slice(0, 5) };
      }

      const snapshot = {
        at: iso(now),
        ts: now.toISOString(),
        overview,
        online,
        logs: latest,
      };
      this._append(this._file('panel', todayKey(now)), snapshot);

      const comparison = buildComparison({
        oldStatus: this.oldStatus?.() || null,
        overview,
        online,
        logs,
        dataDir: this.dataDir,
        date: todayKey(now),
        now,
      });
      this._append(this._file('compare', todayKey(now)), comparison);

      this.overview = overview;
      this.online = online;
      this.logs = logs;
      this.comparison = comparison;
      this.lastAt = now.toISOString();
      this.lastError = null;
      this._prune(now);
      return { ok: true, at: this.lastAt, online: overview.online, logs: latest };
    } catch (e) {
      this.lastError = e.message;
      const errorRow = { at: iso(now), ts: now.toISOString(), error: e.message };
      this._append(this._file('panel', todayKey(now)), errorRow);
      this._append(this._file('compare', todayKey(now)), { ...errorRow, old: null, new: null, diff: null });
      return { ok: false, error: e.message };
    }
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.intervalMs);
    this.poll().catch(() => {});
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  status() {
    const roster = (this.online || []).map((p) => ({
      name: p.gameName || p.name || p.steamid || '(未知)',
      steamid: p.steamid || '',
      ip: p.ip || '',
      loginAt: p.time || null,
      region: p.region || '',
      location: p.location || '',
      isBot: Number(p.isBot) || 0,
      isDrone: Number(p.isDrone) || 0,
      isBan: Number(p.isBan) || 0,
    }));
    const logs = {};
    for (const [key, def] of Object.entries(PANEL_LOG_DEFS)) {
      const item = this.logs?.[key];
      logs[key] = {
        label: def.label,
        total: item?.total ?? null,
        latest: (item?.rows || []).slice(0, 5),
      };
    }
    return {
      enabled: Boolean(this.link),
      configured: Boolean(this.link),
      online: this.overview?.online ?? null,
      active24h: this.overview?.active24h ?? null,
      killsToday: this.overview?.killsToday ?? null,
      lastLogTime: this.overview?.lastLogTime ?? null,
      expiresAt: this.overview?.expiresAt ?? this.client?.expiresAt ?? null,
      rosterCount: roster.length,
      roster,
      logs,
      lastAt: this.lastAt,
      lastError: this.lastError,
      comparison: this.comparison,
      intervalMs: this.intervalMs,
    };
  }
}

function oldRecordCounts(dataDir, date) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(path.join(dataDir, `records-${date}.jsonl`), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.source) out[row.source] = (out[row.source] || 0) + 1;
    } catch {}
  }
  return out;
}

/**
 * 新旧对照：旧监控来自 monitor.status()，新面板来自本次拉取。
 * 只读旧数据，不修改旧监控的任何状态。
 */
export function buildComparison({
  oldStatus,
  overview,
  online,
  logs,
  dataDir,
  date = todayKey(),
  now = new Date(),
} = {}) {
  const oldPlayers = Array.isArray(oldStatus?.players) ? oldStatus.players : [];
  const oldOnline = oldPlayers.filter((p) => p.status === 'online' || p.status === 'new');
  const oldStrict = oldPlayers.filter((p) => p.status === 'online');
  const oldNames = new Set(oldOnline.map((p) => p.name));
  const oldStrictNames = new Set(oldStrict.map((p) => p.name));

  let oldEvents = {};
  try {
    oldEvents = eventCounts(readEvents(dataDir, date));
  } catch {
    oldEvents = eventCounts(oldStatus?.events || []);
  }
  const oldRecords = oldRecordCounts(dataDir, date);

  const newRoster = (online || []).map((p) => ({
    name: p.gameName || p.name || p.steamid || '(未知)',
    steamid: p.steamid || '',
    ip: p.ip || '',
    loginAt: p.time || null,
    region: p.region || '',
    location: p.location || '',
  }));
  const newNames = new Set(newRoster.map((p) => p.name));
  const newOnline = Number(overview?.online) || 0;

  const missingInOld = newRoster.filter((p) => !oldNames.has(p.name));
  const extraInOld = oldOnline
    .filter((p) => !newNames.has(p.name))
    .map((p) => ({ name: p.name, status: p.status, minutes: p.minutes ?? null }));
  const missingStrict = newRoster.filter((p) => !oldStrictNames.has(p.name));

  const newTotals = {};
  for (const key of Object.keys(PANEL_LOG_DEFS)) newTotals[key] = Number(logs?.[key]?.total) || 0;

  const diff = {
    online: newOnline - oldOnline.length,
    strict: newOnline - oldStrict.length,
    server: Number.isFinite(oldStatus?.counts?.serverOnline)
      ? newOnline - oldStatus.counts.serverOnline
      : null,
    kill: newTotals.kill - Number(oldEvents.kill || 0),
    unlock: newTotals.lock - Number(oldEvents.unlock || 0),
    recordsKill: newTotals.kill - Number(oldRecords.kill || 0),
    recordsUnlock: newTotals.lock - Number(oldRecords.unlock || 0),
    recordsVehicle: newTotals.vehicle - Number(oldRecords.vehicle || 0),
  };

  return {
    at: iso(now),
    ts: now.toISOString(),
    old: {
      available: Boolean(oldStatus),
      updatedAt: oldStatus?.updatedAt || null,
      lastPollAt: oldStatus?.lastPollAt || null,
      online: oldOnline.length,
      strictOnline: oldStrict.length,
      new: Number(oldStatus?.counts?.new) || 0,
      idle: Number(oldStatus?.counts?.idle) || 0,
      total: Number(oldStatus?.counts?.total) || 0,
      serverOnline: oldStatus?.counts?.serverOnline ?? null,
      names: oldOnline.map((p) => p.name),
      strictNames: oldStrict.map((p) => p.name),
      events: oldEvents,
      records: oldRecords,
    },
    new: {
      online: newOnline,
      rosterCount: newRoster.length,
      active24h: Number(overview?.active24h) || 0,
      killsToday: Number(overview?.killsToday) || 0,
      lastLogTime: overview?.lastLogTime || null,
      logs: newTotals,
      names: newRoster.map((p) => p.name),
    },
    diff,
    details: {
      missingInOld,
      missingStrict,
      extraInOld,
    },
    notes: [
      '旧监控 online 含今日新上榜；strict 仅判定在线',
      '新面板 kill/lock/bomb/vehicle/admin 为面板今日总数（begin/end 过滤）',
      '旧 records 是工具抓到的原始记录条数，可能少于面板全天；用于看覆盖差距',
    ],
  };
}

/** 读面板落盘文件（panel / panel-records / compare），最新在前 */
export function readPanelRows(dataDir, prefix, date, { limit = 200 } = {}) {
  if (!['panel', 'panel-records', 'compare'].includes(prefix)) {
    throw new Error('prefix 必须是 panel / panel-records / compare');
  }
  const file = path.join(dataDir, `${prefix}-${date}.jsonl`);
  if (!fs.existsSync(file)) return { date, total: 0, items: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const rows = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    try {
      rows.push(JSON.parse(lines[i]));
    } catch {
      // 坏行跳过
    }
  }
  return { date, total: lines.length, items: rows };
}
