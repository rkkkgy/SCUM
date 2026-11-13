-- SCUM 监控数据库 v1
-- 设计原则：
-- 1) 查询字段规范化成列，原始 JSON 只作为审计/追溯（raw_json），不把 JSON 当查询主路径
-- 2) 时间统一存 UTC ISO-8601 TEXT，另存 local_date 供按天报表；不用本地时间做唯一排序
-- 3) STRICT 表 + 明确类型；外键 + 子表索引；WAL 模式；JSON 列做 json_valid 校验
-- 4) 事实表（每轮/每条记录）和维度表（players/player_names）分开
-- 5) 导入可重复执行：自然唯一键 + import_files 文件哈希

PRAGMA foreign_keys = ON;
PRAGMA application_id = 0x5343554D; -- "SCUM"
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  inserted_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  error TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS import_files (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  local_date TEXT,
  rows INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  imported_at TEXT NOT NULL,
  UNIQUE (file_name, sha256)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_import_files_prefix
  ON import_files (prefix, local_date);

-- 玩家维度：SteamID 是自然键；名字会改，所以另存名字历史
CREATE TABLE IF NOT EXISTS players (
  steamid TEXT PRIMARY KEY CHECK (length(steamid) = 17),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_name TEXT,
  last_ip TEXT,
  last_region TEXT,
  last_location TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS player_names (
  steamid TEXT NOT NULL REFERENCES players(steamid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (steamid, name)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_player_names_name
  ON player_names (name);

-- 旧监控：事件流水
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  local_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  category TEXT NOT NULL,
  event_type TEXT NOT NULL,
  nickname TEXT,
  title TEXT,
  detail TEXT,
  minutes INTEGER,
  delta_seconds INTEGER,
  reason TEXT,
  seconds INTEGER,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (source_file, source_line)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_date_category
  ON events (local_date, category, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_nickname
  ON events (nickname, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_category_time
  ON events (category, occurred_at);

-- 旧监控：原始记录（kill/unlock/vehicle/bunker/ban/switches）
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  ingested_at TEXT NOT NULL,
  ingested_at_local TEXT,
  local_date TEXT NOT NULL,
  source TEXT NOT NULL,
  record_key TEXT NOT NULL,
  occurred_at TEXT,
  player_name TEXT,
  steamid TEXT,
  target TEXT,
  region TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (source, record_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_records_source_time
  ON records (source, occurred_at);
CREATE INDEX IF NOT EXISTS idx_records_steamid
  ON records (steamid, occurred_at);
CREATE INDEX IF NOT EXISTS idx_records_date_source
  ON records (local_date, source);

-- 旧监控：5 个排行榜快照 + 榜单行
CREATE TABLE IF NOT EXISTS ranking_snapshots (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  local_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (captured_at)
) STRICT;

CREATE TABLE IF NOT EXISTS rank_entries (
  snapshot_id INTEGER NOT NULL REFERENCES ranking_snapshots(id) ON DELETE CASCADE,
  board_type TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  nickname TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  text TEXT,
  title TEXT,
  PRIMARY KEY (snapshot_id, board_type, rank)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_rank_entries_board_nickname
  ON rank_entries (board_type, nickname);
CREATE INDEX IF NOT EXISTS idx_rank_entries_board_rank
  ON rank_entries (board_type, rank);

-- 旧监控：今日榜原始快照
CREATE TABLE IF NOT EXISTS board_snapshots (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  local_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  via TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (captured_at)
) STRICT;

CREATE TABLE IF NOT EXISTS board_entries (
  snapshot_id INTEGER NOT NULL REFERENCES board_snapshots(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  nickname TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  text TEXT,
  title TEXT,
  PRIMARY KEY (snapshot_id, rank)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_board_entries_nickname
  ON board_entries (nickname);

-- 新面板：每轮在线总览
CREATE TABLE IF NOT EXISTS panel_snapshots (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  local_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  online_count INTEGER CHECK (online_count IS NULL OR online_count >= 0),
  previous_online INTEGER CHECK (previous_online IS NULL OR previous_online >= 0),
  active24h INTEGER CHECK (active24h IS NULL OR active24h >= 0),
  kills_today INTEGER CHECK (kills_today IS NULL OR kills_today >= 0),
  last_log_at TEXT,
  expires_at TEXT,
  error TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (captured_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_panel_snapshots_date
  ON panel_snapshots (local_date, captured_at);

-- 新面板：每轮在线名单（快照事实；玩家资料可随快照变化，保留原值）
CREATE TABLE IF NOT EXISTS panel_online_players (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES panel_snapshots(id) ON DELETE CASCADE,
  steamid TEXT NOT NULL CHECK (length(steamid) = 17),
  player_name TEXT,
  ip TEXT,
  region TEXT,
  location_raw TEXT,
  x REAL,
  y REAL,
  z REAL,
  login_at TEXT,
  login_at_local TEXT,
  is_drone INTEGER NOT NULL DEFAULT 0 CHECK (is_drone IN (0, 1)),
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  is_ban INTEGER NOT NULL DEFAULT 0 CHECK (is_ban IN (0, 1)),
  uid TEXT,
  server_id TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (snapshot_id, steamid)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_panel_online_steamid
  ON panel_online_players (steamid, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_panel_online_region
  ON panel_online_players (region);

-- 新面板：撬锁日志
CREATE TABLE IF NOT EXISTS panel_lock_logs (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  event_at TEXT NOT NULL,
  event_local TEXT NOT NULL,
  event_date TEXT NOT NULL,
  player_name TEXT,
  steamid TEXT,
  is_success INTEGER CHECK (is_success IS NULL OR is_success IN (0, 1)),
  elapsed_seconds REAL,
  failed_attempts INTEGER,
  target TEXT,
  target_id TEXT,
  lock_type TEXT,
  default_lock_type TEXT,
  owner_name TEXT,
  owner_steamid TEXT,
  region TEXT,
  location_raw TEXT,
  x REAL,
  y REAL,
  z REAL,
  server_id TEXT,
  content TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (record_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_panel_lock_date ON panel_lock_logs (event_date, event_at);
CREATE INDEX IF NOT EXISTS idx_panel_lock_steamid ON panel_lock_logs (steamid, event_at);

-- 新面板：剪线（拆弹）日志
CREATE TABLE IF NOT EXISTS panel_bomb_logs (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  event_at TEXT NOT NULL,
  event_local TEXT NOT NULL,
  event_date TEXT NOT NULL,
  player_name TEXT,
  steamid TEXT,
  is_success INTEGER CHECK (is_success IS NULL OR is_success IN (0, 1)),
  elapsed_seconds REAL,
  failed_attempts INTEGER,
  target TEXT,
  minigame_type TEXT,
  owner_name TEXT,
  owner_steamid TEXT,
  region TEXT,
  location_raw TEXT,
  x REAL,
  y REAL,
  z REAL,
  server_id TEXT,
  content TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (record_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_panel_bomb_date ON panel_bomb_logs (event_date, event_at);
CREATE INDEX IF NOT EXISTS idx_panel_bomb_steamid ON panel_bomb_logs (steamid, event_at);

-- 新面板：击杀日志
CREATE TABLE IF NOT EXISTS panel_kill_logs (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  event_at TEXT NOT NULL,
  event_local TEXT NOT NULL,
  event_date TEXT NOT NULL,
  weapon TEXT,
  time_of_day TEXT,
  server_distance REAL,
  client_distance REAL,
  region TEXT,
  killer_name TEXT,
  killer_steamid TEXT,
  killer_location_raw TEXT,
  killer_x REAL,
  killer_y REAL,
  killer_z REAL,
  killer_is_game_event INTEGER CHECK (killer_is_game_event IS NULL OR killer_is_game_event IN (0, 1)),
  killer_has_immortality INTEGER CHECK (killer_has_immortality IS NULL OR killer_has_immortality IN (0, 1)),
  victim_name TEXT,
  victim_steamid TEXT,
  victim_location_raw TEXT,
  victim_x REAL,
  victim_y REAL,
  victim_z REAL,
  victim_is_game_event INTEGER CHECK (victim_is_game_event IS NULL OR victim_is_game_event IN (0, 1)),
  context_json TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
  server_id TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (record_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_panel_kill_date ON panel_kill_logs (event_date, event_at);
CREATE INDEX IF NOT EXISTS idx_panel_kill_killer ON panel_kill_logs (killer_steamid, event_at);
CREATE INDEX IF NOT EXISTS idx_panel_kill_victim ON panel_kill_logs (victim_steamid, event_at);

-- 新面板：载具日志
CREATE TABLE IF NOT EXISTS panel_vehicle_logs (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  event_at TEXT NOT NULL,
  event_local TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_type TEXT,
  type_text TEXT,
  vehicle TEXT,
  vehicle_id TEXT,
  owner_raw TEXT,
  owner_name TEXT,
  owner_steamid TEXT,
  region TEXT,
  location_raw TEXT,
  x REAL,
  y REAL,
  z REAL,
  uid TEXT,
  server_id TEXT,
  content TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (record_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_panel_vehicle_date ON panel_vehicle_logs (event_date, event_at);
CREATE INDEX IF NOT EXISTS idx_panel_vehicle_owner ON panel_vehicle_logs (owner_steamid, event_at);

-- 新面板：管理命令日志
CREATE TABLE IF NOT EXISTS panel_admin_logs (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  event_at TEXT NOT NULL,
  event_local TEXT NOT NULL,
  event_date TEXT NOT NULL,
  steamid TEXT,
  player_name TEXT,
  raw_command TEXT,
  command_text TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (record_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_panel_admin_date ON panel_admin_logs (event_date, event_at);
CREATE INDEX IF NOT EXISTS idx_panel_admin_steamid ON panel_admin_logs (steamid, event_at);

-- 新旧对照快照
CREATE TABLE IF NOT EXISTS compare_snapshots (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  compared_at TEXT NOT NULL,
  local_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  old_available INTEGER CHECK (old_available IS NULL OR old_available IN (0, 1)),
  old_updated_at TEXT,
  old_last_poll_at TEXT,
  old_online INTEGER,
  old_strict_online INTEGER,
  old_new INTEGER,
  old_idle INTEGER,
  old_total INTEGER,
  old_server_online INTEGER,
  new_online INTEGER,
  new_roster_count INTEGER,
  new_active24h INTEGER,
  new_kills_today INTEGER,
  new_last_log_at TEXT,
  diff_online INTEGER,
  diff_strict INTEGER,
  diff_server INTEGER,
  diff_kill INTEGER,
  diff_unlock INTEGER,
  diff_records_kill INTEGER,
  diff_records_unlock INTEGER,
  diff_records_vehicle INTEGER,
  notes_json TEXT CHECK (notes_json IS NULL OR json_valid(notes_json)),
  error TEXT,
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  UNIQUE (compared_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_compare_date
  ON compare_snapshots (local_date, compared_at);

CREATE TABLE IF NOT EXISTS compare_missing_players (
  compare_id INTEGER NOT NULL REFERENCES compare_snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('online', 'strict')),
  player_name TEXT NOT NULL,
  steamid TEXT NOT NULL DEFAULT '',
  ip TEXT,
  region TEXT,
  location_raw TEXT,
  login_at TEXT,
  PRIMARY KEY (compare_id, kind, player_name, steamid)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_compare_missing_player
  ON compare_missing_players (player_name, steamid);

CREATE TABLE IF NOT EXISTS compare_extra_players (
  compare_id INTEGER NOT NULL REFERENCES compare_snapshots(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  status TEXT,
  minutes INTEGER,
  PRIMARY KEY (compare_id, player_name)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS compare_counts (
  compare_id INTEGER NOT NULL REFERENCES compare_snapshots(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('old_events', 'old_records', 'new_logs')),
  name TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (compare_id, side, name)
) STRICT, WITHOUT ROWID;

-- 统一日志视图：跨五类日志查询
CREATE VIEW IF NOT EXISTS v_panel_logs AS
SELECT 'lock' AS log_type, id, event_at, event_date, player_name, steamid,
       target, region, is_success, elapsed_seconds,
       lock_type AS detail, raw_json
  FROM panel_lock_logs
UNION ALL
SELECT 'bomb', id, event_at, event_date, player_name, steamid,
       target, region, is_success, elapsed_seconds,
       minigame_type, raw_json
  FROM panel_bomb_logs
UNION ALL
SELECT 'kill', id, event_at, event_date, killer_name, killer_steamid,
       victim_name, region, NULL, NULL,
       weapon, raw_json
  FROM panel_kill_logs
UNION ALL
SELECT 'vehicle', id, event_at, event_date, owner_name, owner_steamid,
       vehicle, region, NULL, NULL,
       type_text, raw_json
  FROM panel_vehicle_logs
UNION ALL
SELECT 'admin', id, event_at, event_date, player_name, steamid,
       raw_command, NULL, NULL, NULL,
       command_text, raw_json
  FROM panel_admin_logs;

CREATE VIEW IF NOT EXISTS v_latest_panel_online AS
SELECT p.*
  FROM panel_online_players p
 WHERE p.snapshot_id = (
       SELECT id
         FROM panel_snapshots
        WHERE error IS NULL
        ORDER BY captured_at DESC
        LIMIT 1
       );

CREATE VIEW IF NOT EXISTS v_latest_compare AS
SELECT *
  FROM compare_snapshots
 WHERE compared_at = (
       SELECT MAX(compared_at)
         FROM compare_snapshots
        WHERE error IS NULL
       );

CREATE VIEW IF NOT EXISTS v_daily_event_counts AS
SELECT local_date, category, COUNT(*) AS event_count
  FROM events
 GROUP BY local_date, category;

CREATE VIEW IF NOT EXISTS v_daily_panel_log_counts AS
SELECT event_date AS local_date, log_type, COUNT(*) AS log_count
  FROM v_panel_logs
 GROUP BY event_date, log_type;

CREATE VIEW IF NOT EXISTS v_player_online_summary AS
SELECT steamid,
       MAX(player_name) AS last_name,
       COUNT(*) AS snapshot_count,
       MIN(login_at) AS first_login_at,
       MAX(login_at) AS last_login_at,
       MAX(region) AS last_region
  FROM panel_online_players
 GROUP BY steamid;
