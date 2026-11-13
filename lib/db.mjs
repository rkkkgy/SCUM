// SQLite 镜像/分析库：把 data/*.jsonl 规范化后写入 data/monitor.db
// 设计说明见 db/README.md；JSONL 仍是监控运行时的第一手数据，数据库是查询层。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, CONFIG } from './config.mjs';

export const DB_FILE_NAME = 'monitor.db';
export const SCHEMA_VERSION = 1;
export const SCHEMA_FILE = path.join(ROOT, 'db', 'schema.sql');

const LOCAL_TZ = '+08:00';
const FILE_RE = /^(events|records|ranks|snapshots|panel|panel-records|compare)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const PREFIX_ORDER = ['events', 'records', 'snapshots', 'ranks', 'panel', 'panel-records', 'compare'];

const iso = (d = new Date()) => d.toISOString();

/** 无时区的本地时间按 Asia/Shanghai 解释；带 Z/偏移的按 ISO 解析，统一输出 UTC ISO */
export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}${LOCAL_TZ}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 统一成本地展示字符串（UTC+8），用于 local_at / event_local */
export function toLocalString(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    return s.replace('T', ' ').slice(0, 19);
  }
  const utc = parseTimestamp(s);
  if (!utc) return null;
  const d = new Date(new Date(utc).getTime() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function localDateOf(value) {
  const local = toLocalString(value);
  return local ? local.slice(0, 10) : null;
}

/** 从 "X=1 Y=2 Z=3" 或 "1 2 3" 提取坐标；失败返回 null */
export function parseCoordinates(value) {
  if (value == null || value === '') return null;
  const nums = String(value).match(/[-+]?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) return null;
  const [x, y, z] = nums.slice(0, 3).map(Number);
  return [x, y, z].every(Number.isFinite) ? [x, y, z] : null;
}

function sOrNull(v) {
  return v == null || v === '' ? null : String(v);
}

function iOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function rOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 只返回可被 SQLite JSON1 校验通过的 JSON 文本；面板 context 常带时间前缀，需要截出 {...} */
function jsonTextOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const part = s.slice(start, end + 1);
    try {
      JSON.parse(part);
      return part;
    } catch {}
  }
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

function boolInt(v, fallback = 0) {
  if (v == null || v === '') return fallback;
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'Yes') return 1;
  return 0;
}

function validSteamid(v) {
  return v != null && /^\d{17}$/.test(String(v));
}

function listDataFiles(dataDir) {
  const files = [];
  for (const name of fs.readdirSync(dataDir)) {
    const m = name.match(FILE_RE);
    if (!m) continue;
    files.push({
      name,
      prefix: m[1],
      date: m[2],
      file: path.join(dataDir, name),
    });
  }
  files.sort((a, b) => {
    const pa = PREFIX_ORDER.indexOf(a.prefix);
    const pb = PREFIX_ORDER.indexOf(b.prefix);
    return pa - pb || a.date.localeCompare(b.date) || a.name.localeCompare(b.name);
  });
  return files;
}

export function openDatabase({ dataDir = CONFIG.dataDir, dbPath, schema = true } = {}) {
  const file = dbPath || path.join(dataDir, DB_FILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  try {
    db.prepare('PRAGMA journal_mode = WAL').get();
  } catch {
    // 某些内存/只读环境不支持 WAL，继续用默认 journal
  }
  if (schema) applySchema(db);
  return db;
}

export function applySchema(db) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  db.exec(sql);
  db.prepare(
    'INSERT OR IGNORE INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)',
  ).run(SCHEMA_VERSION, iso(), 'normalized monitor schema');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

function tableCounts(db) {
  const tables = [
    'events', 'records', 'ranking_snapshots', 'rank_entries', 'board_snapshots', 'board_entries',
    'panel_snapshots', 'panel_online_players', 'panel_lock_logs', 'panel_bomb_logs',
    'panel_kill_logs', 'panel_vehicle_logs', 'panel_admin_logs',
    'compare_snapshots', 'compare_missing_players', 'compare_extra_players', 'compare_counts',
    'players', 'player_names', 'import_files', 'import_runs',
  ];
  const out = {};
  for (const t of tables) out[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  return out;
}

function insertReturningId(db, table, columns, values, conflictColumn = 'captured_at', conflictValue) {
  const cols = columns.join(',');
  const marks = columns.map(() => '?').join(',');
  const res = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${marks})`).run(...values);
  if (res.changes > 0) return { id: Number(res.lastInsertRowid), inserted: true };
  const row = db.prepare(`SELECT id FROM ${table} WHERE ${conflictColumn} = ?`).get(conflictValue);
  return { id: row ? Number(row.id) : null, inserted: false };
}

function upsertPlayer(db, steamid, name, at, { ip = null, region = null, location = null } = {}) {
  if (!validSteamid(steamid)) return;
  const seen = at || iso();
  db.prepare(`
    INSERT INTO players(steamid, first_seen_at, last_seen_at, last_name, last_ip, last_region, last_location)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(steamid) DO UPDATE SET
      first_seen_at = MIN(players.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(players.last_seen_at, excluded.last_seen_at),
      last_name = COALESCE(excluded.last_name, players.last_name),
      last_ip = COALESCE(excluded.last_ip, players.last_ip),
      last_region = COALESCE(excluded.last_region, players.last_region),
      last_location = COALESCE(excluded.last_location, players.last_location)
  `).run(String(steamid), seen, seen, sOrNull(name), sOrNull(ip), sOrNull(region), sOrNull(location));
  if (name) {
    db.prepare(`
      INSERT INTO player_names(steamid, name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(steamid, name) DO UPDATE SET
        first_seen_at = MIN(player_names.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(player_names.last_seen_at, excluded.last_seen_at)
    `).run(String(steamid), String(name), seen, seen);
  }
}

function importEvent(db, row, file, line) {
  const localAt = toLocalString(row.at) || toLocalString(row.ts);
  const occurredAt = parseTimestamp(row.ts) || parseTimestamp(row.at);
  if (!localAt || !occurredAt) return false;
  const res = db.prepare(`
    INSERT OR IGNORE INTO events(
      source_file, source_line, occurred_at, local_at, local_date, category, event_type,
      nickname, title, detail, minutes, delta_seconds, reason, seconds, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    file, line, occurredAt, localAt, localAt.slice(0, 10),
    sOrNull(row.category) || 'online', sOrNull(row.type) || '',
    sOrNull(row.nickname), sOrNull(row.title), sOrNull(row.detail),
    iOrNull(row.minutes), iOrNull(row.delta), sOrNull(row.reason), iOrNull(row.seconds),
    JSON.stringify(row),
  );
  return res.changes > 0;
}

function importRecord(db, row, file, line) {
  const d = row.data && typeof row.data === 'object' ? row.data : {};
  const source = sOrNull(row.source) || '';
  const key = sOrNull(row.key);
  if (!source || !key) return false;
  const ingestedAt = parseTimestamp(row.ts) || parseTimestamp(row.at);
  const ingestedLocal = toLocalString(row.at);
  const occurredLocal =
    d.logtime || (source === 'ban' ? d.startTime : null) || (source === 'switches' ? row.at : null);
  const occurredAt = parseTimestamp(occurredLocal) || ingestedAt;
  const localDate = localDateOf(occurredLocal) || localDateOf(row.at) || localDateOf(row.ts);
  if (!ingestedAt || !localDate) return false;

  let playerName = null;
  let steamid = null;
  let target = null;
  let region = null;
  switch (source) {
    case 'kill':
      playerName = d.Killername;
      steamid = d.Killersteamid;
      target = d.Victimername;
      break;
    case 'unlock':
      playerName = d.name;
      steamid = d.steamid;
      target = d.targetText || d.target;
      break;
    case 'vehicle':
      playerName = d.carownername;
      steamid = d.carownerSteamid;
      target = d.Vehicletype;
      break;
    case 'bunker_status':
      target = d.Bunkername;
      break;
    case 'bunker_unlock':
      playerName = d.name;
      steamid = d.steamid;
      break;
    case 'ban':
      playerName = d.name;
      steamid = d.steamid;
      target = d.publicReason;
      break;
    default:
      break;
  }
  upsertPlayer(db, steamid, playerName, occurredAt);

  const res = db.prepare(`
    INSERT OR IGNORE INTO records(
      source_file, source_line, ingested_at, ingested_at_local, local_date, source, record_key,
      occurred_at, player_name, steamid, target, region, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    file, line, ingestedAt, ingestedLocal, localDate, source, key,
    occurredAt, sOrNull(playerName), sOrNull(steamid), sOrNull(target), sOrNull(region),
    JSON.stringify(row),
  );
  return res.changes > 0;
}

function importRanking(db, row, file, line) {
  const capturedAt = parseTimestamp(row.ts) || parseTimestamp(row.at);
  const localAt = toLocalString(row.at) || toLocalString(row.ts);
  if (!capturedAt || !localAt) return 0;
  const { id } = insertReturningId(
    db, 'ranking_snapshots',
    ['source_file', 'source_line', 'captured_at', 'local_at', 'local_date', 'raw_json'],
    [file, line, capturedAt, localAt, localAt.slice(0, 10), JSON.stringify(row)],
    'captured_at', capturedAt,
  );
  if (!id) return 0;
  let added = 0;
  for (const [boardType, entries] of Object.entries(row.boards || {})) {
    for (const item of entries || []) {
      const [rank, nickname, seconds, text, title] = item;
      const res = db.prepare(`
        INSERT OR IGNORE INTO rank_entries(snapshot_id, board_type, rank, nickname, seconds, text, title)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, String(boardType), iOrNull(rank) ?? 0, String(nickname ?? ''), iOrNull(seconds) ?? 0, sOrNull(text), sOrNull(title));
      added += res.changes;
    }
  }
  return added;
}

function importBoardSnapshot(db, row, file, line) {
  const capturedAt = parseTimestamp(row.ts) || parseTimestamp(row.at);
  const localAt = toLocalString(row.at) || toLocalString(row.ts);
  if (!capturedAt || !localAt) return 0;
  const { id } = insertReturningId(
    db, 'board_snapshots',
    ['source_file', 'source_line', 'captured_at', 'local_at', 'local_date', 'via', 'raw_json'],
    [file, line, capturedAt, localAt, localAt.slice(0, 10), sOrNull(row.via), JSON.stringify(row)],
    'captured_at', capturedAt,
  );
  if (!id) return 0;
  let added = 0;
  for (const item of row.items || []) {
    const res = db.prepare(`
      INSERT OR IGNORE INTO board_entries(snapshot_id, rank, nickname, seconds, text, title)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, iOrNull(item.rank) ?? 0, String(item.nickname ?? ''), iOrNull(item.seconds) ?? 0, sOrNull(item.text), sOrNull(item.title));
    added += res.changes;
  }
  return added;
}

function importPanelSnapshot(db, row, file, line) {
  const capturedAt = parseTimestamp(row.ts) || parseTimestamp(row.at);
  const localAt = toLocalString(row.at) || toLocalString(row.ts);
  if (!capturedAt || !localAt) return 0;
  const o = row.overview || {};
  const { id } = insertReturningId(
    db, 'panel_snapshots',
    ['source_file', 'source_line', 'captured_at', 'local_at', 'local_date',
      'online_count', 'previous_online', 'active24h', 'kills_today', 'last_log_at', 'expires_at', 'error', 'raw_json'],
    [file, line, capturedAt, localAt, localAt.slice(0, 10),
      iOrNull(o.online), iOrNull(o.previous), iOrNull(o.active24h), iOrNull(o.killsToday),
      parseTimestamp(o.lastLogTime), parseTimestamp(o.expiresAt), sOrNull(row.error), JSON.stringify(row)],
    'captured_at', capturedAt,
  );
  if (!id) return 0;
  let added = 0;
  for (const p of row.online || []) {
    if (!validSteamid(p.steamid)) continue;
    const coords = parseCoordinates(p.location);
    const loginAt = parseTimestamp(p.time);
    const loginLocal = toLocalString(p.time);
    const res = db.prepare(`
      INSERT OR IGNORE INTO panel_online_players(
        snapshot_id, steamid, player_name, ip, region, location_raw, x, y, z,
        login_at, login_at_local, is_drone, is_bot, is_ban, uid, server_id, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, String(p.steamid), sOrNull(p.gameName || p.name), sOrNull(p.ip), sOrNull(p.region), sOrNull(p.location),
      coords?.[0] ?? null, coords?.[1] ?? null, coords?.[2] ?? null,
      loginAt, loginLocal, boolInt(p.isDrone), boolInt(p.isBot), boolInt(p.isBan),
      sOrNull(p.uid), sOrNull(p.serverId), JSON.stringify(p),
    );
    added += res.changes;
    upsertPlayer(db, p.steamid, p.gameName || p.name, loginAt, {
      ip: p.ip, region: p.region, location: p.location,
    });
  }
  return added;
}

function importPanelRecord(db, row, file, line) {
  const type = sOrNull(row.type);
  const d = row.data && typeof row.data === 'object' ? row.data : {};
  // 旧版面板记录把共用 uid 当 key，载具事件会互相覆盖；这里按事件字段重建
  const key = type === 'vehicle'
    ? `${sOrNull(d.time) || ''}|${sOrNull(d.type) || ''}|${sOrNull(d.vehicleId) || ''}|${sOrNull(d.ownerSteamid) || sOrNull(d.owner) || ''}`
    : sOrNull(row.key);
  if (!type || !key) return false;
  const eventLocal = toLocalString(d.time) || toLocalString(row.at);
  const eventAt = parseTimestamp(d.time) || parseTimestamp(row.at);
  if (!eventLocal || !eventAt) return false;
  const eventDate = eventLocal.slice(0, 10);
  const raw = JSON.stringify(row);
  let res;
  switch (type) {
    case 'lock': {
      const c = parseCoordinates(d.location);
      res = db.prepare(`
        INSERT OR IGNORE INTO panel_lock_logs(
          source_file, source_line, record_key, event_at, event_local, event_date,
          player_name, steamid, is_success, elapsed_seconds, failed_attempts,
          target, target_id, lock_type, default_lock_type, owner_name, owner_steamid,
          region, location_raw, x, y, z, server_id, content, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        file, line, key, eventAt, eventLocal, eventDate,
        sOrNull(d.name), sOrNull(d.steamid), iOrNull(d.isSuccess), rOrNull(d.elapsedTime), iOrNull(d.failedAttempts),
        sOrNull(d.target), sOrNull(d.targetId), sOrNull(d.lockType), sOrNull(d.defaultLockType),
        sOrNull(d.ownerName), sOrNull(d.ownerSteamid), sOrNull(d.region), sOrNull(d.location),
        c?.[0] ?? null, c?.[1] ?? null, c?.[2] ?? null, sOrNull(d.serverId), sOrNull(d.content), raw,
      );
      upsertPlayer(db, d.steamid, d.name, eventAt);
      upsertPlayer(db, d.ownerSteamid, d.ownerName, eventAt);
      break;
    }
    case 'bomb': {
      const c = parseCoordinates(d.location);
      res = db.prepare(`
        INSERT OR IGNORE INTO panel_bomb_logs(
          source_file, source_line, record_key, event_at, event_local, event_date,
          player_name, steamid, is_success, elapsed_seconds, failed_attempts,
          target, minigame_type, owner_name, owner_steamid,
          region, location_raw, x, y, z, server_id, content, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        file, line, key, eventAt, eventLocal, eventDate,
        sOrNull(d.name), sOrNull(d.steamid), iOrNull(d.isSuccess), rOrNull(d.elapsedTime), iOrNull(d.failedAttempts),
        sOrNull(d.target), sOrNull(d.minigameType), sOrNull(d.ownerName), sOrNull(d.ownerSteamid),
        sOrNull(d.region), sOrNull(d.location), c?.[0] ?? null, c?.[1] ?? null, c?.[2] ?? null,
        sOrNull(d.serverId), sOrNull(d.content), raw,
      );
      upsertPlayer(db, d.steamid, d.name, eventAt);
      upsertPlayer(db, d.ownerSteamid, d.ownerName, eventAt);
      break;
    }
    case 'kill': {
      const kc = parseCoordinates(d.killerServerLocation);
      const vc = parseCoordinates(d.victimServerLocation);
      const context = jsonTextOrNull(d.context);
      res = db.prepare(`
        INSERT OR IGNORE INTO panel_kill_logs(
          source_file, source_line, record_key, event_at, event_local, event_date,
          weapon, time_of_day, server_distance, client_distance, region,
          killer_name, killer_steamid, killer_location_raw, killer_x, killer_y, killer_z,
          killer_is_game_event, killer_has_immortality,
          victim_name, victim_steamid, victim_location_raw, victim_x, victim_y, victim_z,
          victim_is_game_event, context_json, server_id, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        file, line, key, eventAt, eventLocal, eventDate,
        sOrNull(d.weapon), sOrNull(d.timeOfDayText || d.timeOfDay), rOrNull(d.serverDistance), rOrNull(d.clientDistance), sOrNull(d.region),
        sOrNull(d.killerName), sOrNull(d.killerSteamid), sOrNull(d.killerServerLocation),
        kc?.[0] ?? null, kc?.[1] ?? null, kc?.[2] ?? null,
        boolInt(d.killerIsGameEvent), boolInt(d.killerHasImmortality),
        sOrNull(d.victimName), sOrNull(d.victimSteamid), sOrNull(d.victimServerLocation),
        vc?.[0] ?? null, vc?.[1] ?? null, vc?.[2] ?? null,
        boolInt(d.victimIsGameEvent), context, sOrNull(d.serverId), raw,
      );
      upsertPlayer(db, d.killerSteamid, d.killerName, eventAt);
      upsertPlayer(db, d.victimSteamid, d.victimName, eventAt);
      break;
    }
    case 'vehicle': {
      const c = parseCoordinates(d.location);
      res = db.prepare(`
        INSERT OR IGNORE INTO panel_vehicle_logs(
          source_file, source_line, record_key, event_at, event_local, event_date,
          event_type, type_text, vehicle, vehicle_id, owner_raw, owner_name, owner_steamid,
          region, location_raw, x, y, z, uid, server_id, content, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        file, line, key, eventAt, eventLocal, eventDate,
        sOrNull(d.type), sOrNull(d.typeText), sOrNull(d.vehicle), sOrNull(d.vehicleId),
        sOrNull(d.owner), sOrNull(d.ownerName), sOrNull(d.ownerSteamid),
        sOrNull(d.region), sOrNull(d.location), c?.[0] ?? null, c?.[1] ?? null, c?.[2] ?? null,
        sOrNull(d.uid), sOrNull(d.serverId), sOrNull(d.content), raw,
      );
      upsertPlayer(db, d.ownerSteamid, d.ownerName, eventAt);
      break;
    }
    case 'admin': {
      res = db.prepare(`
        INSERT OR IGNORE INTO panel_admin_logs(
          source_file, source_line, record_key, event_at, event_local, event_date,
          steamid, player_name, raw_command, command_text, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        file, line, key, eventAt, eventLocal, eventDate,
        sOrNull(d.steamId), sOrNull(d.game_name), sOrNull(d.defaultCode), sOrNull(d.code), raw,
      );
      upsertPlayer(db, d.steamId, d.game_name, eventAt);
      break;
    }
    default:
      return false;
  }
  return Boolean(res?.changes);
}

function importCompare(db, row, file, line) {
  const comparedAt = parseTimestamp(row.ts) || parseTimestamp(row.at);
  const localAt = toLocalString(row.at) || toLocalString(row.ts);
  if (!comparedAt || !localAt) return 0;
  const old = row.old || {};
  const nw = row.new || {};
  const diff = row.diff || {};
  const details = row.details || {};
  const notes = row.notes == null ? null : JSON.stringify(row.notes);
  const { id } = insertReturningId(
    db, 'compare_snapshots',
    ['source_file', 'source_line', 'compared_at', 'local_at', 'local_date',
      'old_available', 'old_updated_at', 'old_last_poll_at', 'old_online', 'old_strict_online',
      'old_new', 'old_idle', 'old_total', 'old_server_online',
      'new_online', 'new_roster_count', 'new_active24h', 'new_kills_today', 'new_last_log_at',
      'diff_online', 'diff_strict', 'diff_server', 'diff_kill', 'diff_unlock',
      'diff_records_kill', 'diff_records_unlock', 'diff_records_vehicle',
      'notes_json', 'error', 'raw_json'],
    [file, line, comparedAt, localAt, localAt.slice(0, 10),
      row.old ? boolInt(old.available) : null, parseTimestamp(old.updatedAt), parseTimestamp(old.lastPollAt),
      iOrNull(old.online), iOrNull(old.strictOnline), iOrNull(old.new), iOrNull(old.idle),
      iOrNull(old.total), iOrNull(old.serverOnline),
      iOrNull(nw.online), iOrNull(nw.rosterCount), iOrNull(nw.active24h), iOrNull(nw.killsToday),
      parseTimestamp(nw.lastLogTime), iOrNull(diff.online), iOrNull(diff.strict), iOrNull(diff.server),
      iOrNull(diff.kill), iOrNull(diff.unlock), iOrNull(diff.recordsKill), iOrNull(diff.recordsUnlock),
      iOrNull(diff.recordsVehicle), notes, sOrNull(row.error), JSON.stringify(row)],
    'compared_at', comparedAt,
  );
  if (!id) return 0;
  let added = 0;
  const addMissing = (kind, list) => {
    for (const p of list || []) {
      const res = db.prepare(`
        INSERT OR IGNORE INTO compare_missing_players(
          compare_id, kind, player_name, steamid, ip, region, location_raw, login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, kind, String(p.name ?? ''), String(p.steamid ?? ''),
        sOrNull(p.ip), sOrNull(p.region), sOrNull(p.location), parseTimestamp(p.loginAt));
      added += res.changes;
      upsertPlayer(db, p.steamid, p.name, parseTimestamp(p.loginAt));
    }
  };
  addMissing('online', details.missingInOld);
  addMissing('strict', details.missingStrict);
  for (const p of details.extraInOld || []) {
    const res = db.prepare(`
      INSERT OR IGNORE INTO compare_extra_players(compare_id, player_name, status, minutes)
      VALUES (?, ?, ?, ?)
    `).run(id, String(p.name ?? ''), sOrNull(p.status), iOrNull(p.minutes));
    added += res.changes;
  }
  const addCounts = (side, obj) => {
    for (const [name, count] of Object.entries(obj || {})) {
      const res = db.prepare(`
        INSERT OR IGNORE INTO compare_counts(compare_id, side, name, count) VALUES (?, ?, ?, ?)
      `).run(id, side, String(name), iOrNull(count) ?? 0);
      added += res.changes;
    }
  };
  addCounts('old_events', old.events);
  addCounts('old_records', old.records);
  addCounts('new_logs', nw.logs);
  return added;
}

function importLine(db, prefix, row, file, line) {
  switch (prefix) {
    case 'events':
      return importEvent(db, row, file, line) ? 1 : 0;
    case 'records':
      return importRecord(db, row, file, line) ? 1 : 0;
    case 'ranks':
      return importRanking(db, row, file, line);
    case 'snapshots':
      return importBoardSnapshot(db, row, file, line);
    case 'panel':
      return importPanelSnapshot(db, row, file, line);
    case 'panel-records':
      return importPanelRecord(db, row, file, line) ? 1 : 0;
    case 'compare':
      return importCompare(db, row, file, line);
    default:
      return 0;
  }
}

/**
 * 把 dataDir 下的 JSONL 导入 SQLite。
 * 幂等：文件哈希相同会跳过；即使强制重导，事实表的自然唯一键也会去重。
 */
export function importJsonl({
  dataDir = CONFIG.dataDir,
  dbPath,
  force = false,
  verbose = false,
  now = new Date(),
  db: externalDb,
} = {}) {
  const db = externalDb || openDatabase({ dataDir, dbPath });
  const startedAt = now.toISOString();
  const run = db.prepare(
    'INSERT INTO import_runs(started_at, source_dir, status) VALUES (?, ?, ?)',
  ).run(startedAt, dataDir, 'running');
  const runId = Number(run.lastInsertRowid);
  const stats = {
    runId,
    dbPath: dbPath || path.join(dataDir, DB_FILE_NAME),
    files: 0,
    filesSkipped: 0,
    rows: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
    counts: {},
  };

  try {
    const files = listDataFiles(dataDir);
    for (const info of files) {
      stats.files += 1;
      const bytes = fs.readFileSync(info.file);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const already = db.prepare(
        'SELECT 1 AS ok FROM import_files WHERE file_name = ? AND sha256 = ?',
      ).get(info.name, sha256);
      if (already && !force) {
        stats.filesSkipped += 1;
        if (verbose) console.log(`skip ${info.name} (same hash)`);
        continue;
      }

      const rawText = bytes.toString('utf8');
      const lines = rawText.split('\n');
      const endsWithNewline = rawText.endsWith('\n');
      let rowCount = 0;
      let inserted = 0;
      let skipped = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;
          let row;
          try {
            row = JSON.parse(line);
          } catch (e) {
            // 监控可能正在追加最后一行；文件末尾半行先跳过，下次新哈希会重导
            if (i === lines.length - 1 && !endsWithNewline) {
              skipped += 1;
              break;
            }
            throw new Error(`${info.name}:${i + 1} JSON 解析失败：${e.message}`);
          }
          rowCount += 1;
          const n = importLine(db, info.prefix, row, info.name, i + 1);
          if (n > 0) inserted += n;
          else skipped += 1;
        }
        db.prepare(`
          INSERT OR REPLACE INTO import_files(
            run_id, file_name, prefix, local_date, rows, inserted, skipped, sha256, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, info.name, info.prefix, info.date, rowCount, inserted, skipped, sha256, iso());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      stats.rows += rowCount;
      stats.inserted += inserted;
      stats.skipped += skipped;
      if (verbose) console.log(`${info.name}: ${rowCount} 行，新增 ${inserted}，跳过 ${skipped}`);
    }

    db.prepare(`
      UPDATE import_runs
         SET finished_at = ?, status = 'ok', total_rows = ?, inserted_rows = ?, skipped_rows = ?
       WHERE id = ?
    `).run(iso(), stats.rows, stats.inserted, stats.skipped, runId);
    db.exec('ANALYZE;');
    stats.counts = tableCounts(db);
  } catch (e) {
    stats.errors.push(e.message);
    try {
      db.prepare(`
        UPDATE import_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?
      `).run(iso(), e.message, runId);
    } catch {}
  } finally {
    if (!externalDb) db.close();
  }
  return stats;
}
