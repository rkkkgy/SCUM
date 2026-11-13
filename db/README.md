# SQLite 查询库

`data/monitor.db` 是 JSONL 的**规范化查询镜像**，不是监控运行时的唯一数据源。监控仍然写 `data/*.jsonl`；数据库用于 SQL 分析、长期留存和后续做报表。

## 为什么这样设计

参考的 SQLite / 数据建模规则：

- [STRICT Tables](https://sqlite.org/stricttables.html)：所有表使用 `STRICT`，列类型固定为 `INTEGER` / `REAL` / `TEXT`，避免 SQLite 动态类型把数字/字符串混进同一列。
- [Foreign Key Support](https://sqlite.org/foreignkeys.html)：打开 `PRAGMA foreign_keys=ON`，子表用外键 + `ON DELETE CASCADE`；每个外键子列建索引。
- [Write-Ahead Logging](https://sqlite.org/wal.html)：`journal_mode=WAL`，读写并发更好；导入完成后自动 checkpoint。
- [SQLite Forum: dates as ISO8601](https://www2.sqlite.org/forum/forumpost/b96ebbf56a3e21d2?raw)：日期时间统一存 ISO-8601 UTC 文本，SQLite 日期函数可直接使用；另存 `local_date` 供按天报表。
- [JSON Functions](https://sqlite.org/json1.html)：原始供应商 JSON 存 `raw_json`，并用 `CHECK(json_valid(raw_json))` 保证可解析；常用字段拆成普通列，查询不依赖 JSON 扫描。
- 规范化：快照 -> 头部表 + 明细表；在线名单、榜单行、对照差集、计数分别建表；玩家用 `players` 维度 + `player_names` 名字历史。
- 幂等导入：`import_files` 记录文件 SHA-256，重复导入自动跳过；事实表另有自然唯一键兜底。

## 表结构

### 元数据

| 表 | 用途 |
|---|---|
| `schema_migrations` | 数据库版本 |
| `import_runs` | 每次导入的起止时间、状态、行数 |
| `import_files` | 每个 JSONL 文件的行数、插入/跳过数、SHA-256 |

### 玩家维度

| 表 | 用途 |
|---|---|
| `players` | SteamID -> 最近名字/IP/区域/坐标、首次/最近出现 |
| `player_names` | SteamID + 名字的曾用名历史 |

### 旧监控

| 表 | 来源 | 说明 |
|---|---|---|
| `events` | `events-*.jsonl` | 上线/下线/击杀/开锁/榜单/风控/系统事件 |
| `records` | `records-*.jsonl` | 击杀/开锁/载具/地堡/封禁/开关的原始记录 |
| `ranking_snapshots` + `rank_entries` | `ranks-*.jsonl` | 5 个排行榜快照，榜单行按 `board_type + rank` 拆行 |
| `board_snapshots` + `board_entries` | `snapshots-*.jsonl` | 今日榜原始快照 |

### 新面板

| 表 | 来源 | 说明 |
|---|---|---|
| `panel_snapshots` | `panel-*.jsonl` | 每轮在线总览（在线数/24h 活跃/今日击杀/到期时间） |
| `panel_online_players` | `panel-*.jsonl` 的 `online[]` | 每个快照的完整在线名单，坐标拆成 `x/y/z` |
| `panel_lock_logs` | `panel-records-*.jsonl` `lock` | 撬锁 |
| `panel_bomb_logs` | `panel-records-*.jsonl` `bomb` | 剪线/拆弹 |
| `panel_kill_logs` | `panel-records-*.jsonl` `kill` | 击杀，含双方坐标、距离、上下文 JSON |
| `panel_vehicle_logs` | `panel-records-*.jsonl` `vehicle` | 载具生命周期 |
| `panel_admin_logs` | `panel-records-*.jsonl` `admin` | 管理命令 |

### 新旧对照

| 表 | 用途 |
|---|---|
| `compare_snapshots` | 每轮对照头：两边在线数、差值、日志计数差 |
| `compare_missing_players` | 新名单里旧监控没识别到的人（`kind=online` / `strict`） |
| `compare_extra_players` | 旧监控在线但新名单没有的人 |
| `compare_counts` | 旧事件/旧记录/新日志按类别的计数 |

### 视图

| 视图 | 用途 |
|---|---|
| `v_panel_logs` | 五类面板日志统一查询（`log_type` 区分） |
| `v_latest_panel_online` | 最近一轮非错误快照的在线名单 |
| `v_latest_compare` | 最近一轮有效对照 |
| `v_daily_event_counts` | 按天/类别统计事件 |
| `v_daily_panel_log_counts` | 按天/日志类型统计面板日志 |
| `v_player_online_summary` | 玩家在线快照次数、首次/最近登录 |

## 导入

需要 **Node.js 22.5+**（使用内置 `node:sqlite`；监控本身仍支持 20.11+）。

服务启动后会自动同步：启动约 10 秒先跑一次，之后每 **5 分钟**一次；看板顶部有状态和「立即同步」按钮。自动同步使用独立子进程，不阻塞采集；只重读 SHA 变化的 JSONL。`SCUM_DB_SYNC_SEC` 可改间隔，`SCUM_DB_SYNC=0` 可关闭。

也可以手动执行：

```bat
node tools/import-jsonl.mjs
npm run db:import
```

指定目录/数据库：

```bat
node tools/import-jsonl.mjs --data-dir=D:\SCUM-Monitor\data --db=D:\SCUM-Monitor\data\monitor.db
```

强制重导（会重新扫描所有文件，依靠唯一键去重）：

```bat
node tools/import-jsonl.mjs --force
```

默认数据库：`data/monitor.db`；WAL 模式会临时产生 `-wal` / `-shm` 文件。

## 查询示例

当前在线：

```sql
SELECT player_name, steamid, ip, region, x, y, z, login_at
  FROM v_latest_panel_online
 ORDER BY player_name;
```

今日各类日志数量：

```sql
SELECT event_date, log_type, COUNT(*) AS n
  FROM v_panel_logs
 WHERE event_date = '2026-11-13'
 GROUP BY event_date, log_type
 ORDER BY n DESC;
```

最近对照：

```sql
SELECT compared_at, old_online, new_online, diff_online,
       diff_kill, diff_unlock, diff_records_vehicle
  FROM compare_snapshots
 WHERE error IS NULL
 ORDER BY compared_at DESC
 LIMIT 20;
```

旧监控漏识别的人：

```sql
SELECT c.compared_at, m.player_name, m.steamid, m.region, m.ip
  FROM compare_missing_players m
  JOIN compare_snapshots c ON c.id = m.compare_id
 WHERE m.kind = 'online'
 ORDER BY c.compared_at DESC
 LIMIT 50;
```

某玩家最近击杀：

```sql
SELECT event_at, killer_name, victim_name, weapon, region, server_distance
  FROM panel_kill_logs
 WHERE killer_steamid = '76561198749602331'
 ORDER BY event_at DESC
 LIMIT 20;
```

## 保留与备份

- 自动同步只追加/更新，不删除行；数据库不会自动清理历史。
- JSONL 仍按 14 天清理，数据库可以保留更久。
- 自动同步每 5 分钟读一次变化文件；监控正在追加的末行不完整时会跳过，下次补上。
- 备份：停止导入后复制 `data/monitor.db`（以及同目录的 `-wal`/`-shm`，如果存在）；或执行 `VACUUM INTO 'monitor-backup.db'`。
- 不建议在导入过程中直接复制正在写入的数据库文件。

## 已知数据差异

- 旧 `events` 有些早期记录没有 `category/title/detail`，导入时回退为 `online` / 空。
- 旧 `records` 按 `source + record_key` 去重，所以行数可能小于 JSONL 原始行数。
- 新面板旧版 JSONL 里载具记录的 `key` 曾误用共享 `uid`；导入器对 `vehicle` 用事件时间/类型/载具 ID/车主重建唯一键，未来监控也已修正。
- 新面板 `panel_kill_logs.context` 常带时间前缀，导入器截取 `{...}` 部分存 `context_json`，完整原文仍在 `raw_json`。
- `players.last_*` 是最近一次见到的资料，不是历史每一刻；历史快照以 `panel_online_players` 为准。
