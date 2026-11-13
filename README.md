# SCUM 1199 服 · 在线排查与数据监控

定时拉取 1199.scum8.com 的公开数据，比对玩家今日累计在线时长的增量判断谁在线，同时记录击杀、开锁、地堡、载具、风控、排行榜的变化，并把榜单识别到的在线人数和服务器显示的总在线人数做比对（榜单只有前 30）。
带一个本地网页控制台：可改检测频率、手动刷新、暂停/恢复，事件按类别分页签查看；另有 `/data` 子页面把所有接口的原始字段原样落盘、随时翻查。

## 监控哪些数据

| 板块 | 接口 | 记录内容 |
|---|---|---|
| 今日在线榜 | `fenlei=4&rankingType=today_online` | 谁上线 / 谁下线 |
| 击杀日志 | `fenlei=1` | 「A 用 AK-47 击杀 B · 24.8 米」，含双方 SteamID |
| 开锁日志 | `fenlei=2` | 「A 撬开了 B 的军用武器柜 T4 · 房主 B · 中级银锁 · 4.7 秒」，房主为空或“无归属”时省略 |
| 封禁名单 | `fenlei=5` | 新被列入 / 移出风险名单，含开始/结束时间 |
| 排行榜 | `fenlei=4&rankingType=kill/deathmatch/fame/total_online` | 击杀榜、死斗榜、声望榜、累计在线榜的名次变化 |
| 地堡状态 | `/user/logdata/bunker` | A1/A3/C4/D1 当前激活/锁定 |
| 地堡密码门 | 同上 `meta.unlockLogs` | 谁在试密码、成功/失败、耗时 |
| 载具日志 | `/api/severlog/vehicle` | 车辆消失/回收、车型、车主、坐标 |
| 功能开关 | `/api/page/publicdata` | 站点把哪些数据模块打开了 |
| 服务器在线 | SCUMSA 服务器页（Steam 主列表） | 服务器显示的总在线/上限，和榜单识别数比对 |

「最近事件」按 全部 / 在线 / 击杀 / 开锁 / 榜单 / 风控 / 系统 分了页签，每条带标题和细节说明。
所有来源的**完整字段**另外写进 `records-*.jsonl` / `ranks-*.jsonl`，在 `/data` 子页面查看（见下）。

## 一键启动

双击 **`启动监控.cmd`** —— 会在后台起服务、自动打开浏览器面板，并立即开始监测。

面板地址：**http://127.0.0.1:8788** （服务只监听本机，不对外网开放）

命令行方式：

```bat
node server.mjs --open             :: 启动并打开浏览器
node server.mjs --port=8789        :: 换端口
node server.mjs --interval=120     :: 指定初始频率（之后以面板设置为准）
```

停止：在黑色窗口里按 `Ctrl+C`，或直接关掉窗口。

> 同一时间只允许一个监控进程。重复启动会提示「已经有监控在运行了」，避免两个进程同时写 `data/` 把状态搞乱（`data/monitor.lock` 单实例锁）。

## 网页面板能做什么

| 功能 | 说明 |
|---|---|
| 检测频率 | 输入 61–3600 秒，点「应用」立即生效；会写入 `data/settings.json`，重启后仍保留 |
| 立即刷新 | 不等倒计时，马上抓一次并重算在线名单，同时重新计时（距上次判定不足 61 秒时只更新数据，不改状态） |
| 暂停 / 开始 | 暂停后不再自动抓取，但页面仍可手动刷新 |
| 事件页签 | 全部 / 在线 / 击杀 / 开锁 / 榜单 / 风控 / 系统，各自带条数 |
| 历史事件 | 看板只加载最近 200 条；完整历史去 `/events` 页面查（保留 14 天） |
| 事件颜色 | 上线 / 开锁成功 / 名次上升 / 移出风控为绿色，下线 / 开锁失败 / 击杀 / 名次下降 / 新增风控为红色，新上榜与系统接入为蓝色，跨天为黄色 |
| 导出事件 CSV | 下载当天全部事件（含类别、标题、说明），Excel 可直接打开；支持 `?date=` / `&category=` / `&q=` |
| 自动更新 | 页面每 2 秒同步一次状态，并显示距下次刷新的倒计时 |

## 原始数据子页面 `/data`

面板右上角「原始数据 →」，或直接打开 **http://127.0.0.1:8788/data** 。

- 日期选择：按天查看，默认今天
- 页签：全部 / 击杀 / 开锁 / 载具 / 地堡状态 / 地堡开锁 / 封禁 / 功能开关 / 排行榜
- 排序：按事件时间（`logtime`）倒序；封禁没有 logtime 时用 `startTime`，功能开关用入库时间
- 搜索：昵称、SteamID 或任意字段内容
- 每条记录可展开看站点返回的完整 JSON；排行榜快照可展开成表格
- 导出 CSV：当前日期 + 当前分类

每轮抓取写两类文件：

| 文件 | 内容 |
|---|---|
| `data/records-YYYY-MM-DD.jsonl` | 一条记录一行，同一天内相同「来源+键」只写一次；重启后会从文件恢复去重集合 |
| `data/ranks-YYYY-MM-DD.jsonl` | 每轮一份 5 个排行榜的完整快照，行格式 `[名次, 玩家, 数值, 文本, 头衔]` |

记录的是站点原样返回的字段，不再裁剪：击杀/开锁的 SteamID、房主、锁号、坐标、会员头衔、封禁结束时间等都在 `data` 里。

文件按**抓取日期**分；页面列表和日期范围按**事件时间**排。所以 0 点后第一次抓取补回来的昨晚记录会写进当天文件，但排序仍按各自的 `logtime`。

`ranks-*.jsonl` 每天约 10–15 MB（每轮一份 139 行的五榜快照），和事件/记录文件一样保留 14 天后自动清理。

## 历史事件 `/events`

看板的「最近事件」为了轻量，只加载最近 200 条（内存里最多 400 条）；**完整事件流水**在 `data/events-YYYY-MM-DD.jsonl`，保留 14 天。

打开 **http://127.0.0.1:8788/events**：

- 日期选择，默认今天
- 类别页签：全部 / 在线 / 击杀 / 开锁 / 榜单 / 风控 / 系统，带当天条数
- 搜索玩家、标题或说明
- 分页加载全部事件，不受 200 条限制
- 导出当前筛选的 CSV

也可以直接下载某天（Excel 可打开）：

```text
http://127.0.0.1:8788/api/export/events.csv?date=2026-11-10
http://127.0.0.1:8788/api/export/events.csv?date=2026-11-10&category=online
http://127.0.0.1:8788/api/export/events.csv?date=2026-11-10&q=JEFF
```

不想开页面时，直接用编辑器打开 `data/events-YYYY-MM-DD.jsonl` 也可以，一行一条 JSON。

## 在线人数比对

今日榜只统计前 30 名，服务器显示的是**全部在线**。看板新增一张「服务器在线」卡片：

```text
29/128
服务器显示 · 本工具 14 · 榜外约 15 · 3 min ago
```

- 大数字：服务器显示的在线 / 上限
- `本工具`：前 30 榜里判定在线 + 新上榜
- `榜外约`：服务器在线 − 本工具，正数就是前 30 之外（或还没判出来）的人
- 最后是 SCUMSA 的数据新鲜度（它从 Steam 主列表取数）
- 0 点重建基线时显示「基线中」，不拿 0 去和服务器比

数据来源是 [SCUMSA 服务器页](https://scumsa.com/servers/202.189.7.201-12102/)（只带地址，会自动跳到当前服务器名），每 2 分钟最多抓一次；页面不可用时卡片显示 `—`，不影响监控。服务器换地址时改 `lib/config.mjs` 里的 `serverPage`。

注意：这个差值是**近似**的。服务器数来自 Steam 主列表，可能比游戏内晚几十秒；本工具只认得前 30 名，所以差值大不代表有人掉线，只代表榜单外还有人。

**新日志面板（茶c 控制台）的在线数更准**：它直接给出服务器当前在线和完整在线名单，不再受前 30 限制。看板已把新旧两套数据并排展示，并每 2 分钟记录一次差异，见下一节。

## 新日志面板（茶c 控制台）· 新旧并行

看板新增一块「新日志监控 · 茶c 控制台」，和旧监控并排对照；**旧监控的统计逻辑、事件生成、在线判定完全没改**，新面板只读旧监控的 `status()` 做对比。

### 配置

1. 在 `data/panel-link.txt` 里放服主给的免密链接（整行，`https://web-log.chacca.net/#/auth/login?m=...&s=...`）。
2. 重启监控。
3. 看板出现「新日志监控 · 茶c 控制台」；未配置时显示提示，旧监控不受影响。

链接本身是**登录凭证**，`data/` 已在 `.gitignore` 里，不要提交、不要发群。面板账号到期时间以面板返回的 `webLogExpireTime` 为准（当前这份到 **2026-11-18 00:00**）。

看板的新面板在线名单会显示 **IP、坐标、区域**；这些只在本机页面和 `data/` 里，不要公开截图或转发 `data/`。

### 抓取内容与频率

每 **120 秒**抓一次，独立于旧监控的检测频率：

| 数据 | 来源 | 内容 |
|---|---|---|
| 在线总览 | `dashboard_overview` | 当前在线、24h 活跃、今日击杀、最后日志时间 |
| 在线名单 | `online_players` | 全部在线玩家：登录时间、游戏名、SteamID、IP、区域、坐标、机器人/无人机/封禁标记 |
| 撬锁 | `webLog/serverLog/log` `gamePlay:lockPicking` | 操作人、锁类型、成功/失败、耗时、尝试次数、房主、目标物品+ID、区域+坐标 |
| 剪线 | `gamePlay:bombFefusalMiniGame` | 操作人、结果、耗时、尝试次数、目标、主人、区域+坐标 |
| 击杀 | `kill` | 击杀者/受害者 + SteamID、武器、距离、区域、双方坐标、游戏时间、原始 JSON |
| 载具 | `vehicle:destruction` | 事件类型（消失/损毁/未活动）、车型、载具ID、车主、区域+坐标 |
| 管理命令 | `admin:command` | 操作人、SteamID、原始指令、中文翻译 |

日志接口统一走 `POST /prod-api/webLog/serverLog/log`，用 `type` 区分；请求/响应 AES 加密，登录用 `m/s` 解出账号密码，再用 RSA 加密随机 `sign` 换 token。

### 看板对照

- **在线**：新面板在线 vs 旧监控 `counts.online`（含新上榜）/ `strictOnline`（仅判定在线）/ SCUMSA
- **在线名单表**：新面板当前全部在线玩家，默认展开全部行（不限制高度，随页面滚动），逐行显示 **玩家 / SteamID / IP / 区域 / 坐标 / 登录时间 / 机器人/无人机/封禁标记**；窄屏时表格可横向滚动
- **名单差异**：新名单里旧监控没识别到的人（榜外/基线未判）、旧监控在线但新名单没有的人（旧误判/已下线）
- **日志**：今日击杀、开锁/撬锁、剪线、载具、管理命令的旧/新条数和差值（口径不同，差值只作参考）
- **最近记录**：五类新日志的最近 10 条

看板上的「新旧对照 →」或直接打开 **http://127.0.0.1:8788/panel**，可以按日期查历史对照流水：每条记录的时间、旧/新在线、差、漏识别/旧多出人数、旧/新击杀/开锁/剪线/载具/管理条数。

### 落盘文件（保留 14 天）

| 文件 | 内容 |
|---|---|
| `data/panel-YYYY-MM-DD.jsonl` | 每轮快照：在线总览、完整在线名单、五类日志今日总数 + 最近 5 条 |
| `data/panel-records-YYYY-MM-DD.jsonl` | 五类日志的去重原始记录（按类型+时间/玩家/目标等键去重） |
| `data/compare-YYYY-MM-DD.jsonl` | 每轮新旧对照：两边在线数、名单差集、日志条数差、旧事件/旧原始记录计数 |

`compare-*.jsonl` 是后续调整统计逻辑的主要依据：每一行都有 `old`、`new`、`diff`、`details`、`notes`，时间戳是抓取时间。

### 新面板接口

```text
GET  /api/panel/status
POST /api/panel/refresh
GET  /api/panel/compare?date=2026-11-12&limit=200
GET  /api/panel/snapshots?date=2026-11-12&limit=100
GET  /api/panel/records?date=2026-11-12&limit=200
```

`/api/status` 也会带一个 `panel` 字段，看板就是从这里取的。

## SQLite 查询库（可选）

JSONL 继续作为监控运行时的第一手数据；另外可以把它们规范化导入 **`data/monitor.db`**，方便用 SQL 做统计、长期留存和后续报表。

```text
data/monitor.db
```

### 导入

需要 **Node.js 22.5+**（使用内置 `node:sqlite`；监控本身仍支持 20.11+）：

```bat
node tools/import-jsonl.mjs
npm run db:import
```

指定数据目录 / 数据库：

```bat
node tools/import-jsonl.mjs --data-dir=D:\SCUM-Monitor\data --db=D:\SCUM-Monitor\data\monitor.db
```

强制重导（仍靠唯一键去重）：

```bat
node tools/import-jsonl.mjs --force
```

- 幂等：同一文件 SHA-256 会跳过；事实表另有自然唯一键兜底。
- **自动同步**：服务启动后约 10 秒先同步一次，之后每 **5 分钟**同步一次；看板顶部有「SQLite 同步」状态和「立即同步」按钮。
- 同步只重读 SHA 变化的 JSONL；监控正在追加的末尾半行会跳过，下次同步再补。新数据通常 **5 分钟内**进入数据库。
- 频率用环境变量 `SCUM_DB_SYNC_SEC` 调整（60–86400 秒）；`SCUM_DB_SYNC=0` 可关闭自动同步，只保留手动命令。
- 数据库不会自动清理历史；JSONL 仍按 14 天清理，SQLite 可以保留更久。
- 导入时不要同时复制正在写入的数据库文件；备份用 `VACUUM INTO` 或停写后复制。

### 表结构

| 表 / 视图 | 内容 |
|---|---|
| `events` / `records` | 旧监控事件流水、原始记录 |
| `ranking_snapshots` + `rank_entries` | 5 个排行榜快照及榜单行 |
| `board_snapshots` + `board_entries` | 今日榜原始快照 |
| `panel_snapshots` + `panel_online_players` | 新面板每轮总览 + 完整在线名单（IP/坐标拆列） |
| `panel_lock_logs` / `panel_bomb_logs` / `panel_kill_logs` / `panel_vehicle_logs` / `panel_admin_logs` | 五类新面板日志 |
| `compare_snapshots` + `compare_missing_players` + `compare_extra_players` + `compare_counts` | 新旧对照及差集 |
| `players` / `player_names` | SteamID 维度、名字历史 |
| `v_panel_logs` / `v_latest_panel_online` / `v_latest_compare` | 常用查询视图 |

详细设计、索引用途和 SQL 示例见 [`db/README.md`](db/README.md)。当前全部 JSONL 约 2.6 万行，展开排行榜/在线快照后约 125 万行，数据库约 200 MB；占用主要来自 `rank_entries` 的 5 榜历史。

## 判定原理

今日榜接口里有两个字段：

- `jinbilist`：给人看的文本，如 `19小时27分钟`，只有**整分钟**；
- `rank_value`：今日累计在线**秒数**，站点约每 10–20 秒批量刷新一次。

程序用 `rank_value` 的秒数判定在线（分钟只用来显示），所以：

- 秒数**涨了** → 这区间在线；
- 秒数**一秒没涨** → 不在线，如果上一轮还是在线，就在「最近事件」里记一条**下线**；
- 新出现 → 今天首次上榜；从榜上消失 → 掉出前 30。

不要用 `jinbilist` 的分钟数判定：61 秒的间隔里，在线玩家的秒数通常只涨 40–60 秒，未必跨过整分钟；
用分钟判定会周期性出现「下线 61 秒后又上线、而且分钟数 +2」的假事件（2026-11-07 白天的抖动就是这个原因）。

两次判定间隔仍限制在 61 秒以上：小于 61 秒时秒数增量太小，站点的批量刷新也可能还没轮到。

今日榜按自然日统计，跨天后会从 0 重新累计。程序检测到跨天时会记一条「检测到跨天，今日榜已重置」的系统事件并自动重建基线（并不主动验证站点是否重启）。

重建基线的第一轮只把榜上的人记为「在榜无变化」，**不算在线、也不写「今日首次上榜」**；下一轮秒数涨了才判上线，没涨就掉榜的也不写「下线」。所以零点刚过时「在线 0 人」是正常的，榜上 30 个 0 分钟只是站点重置后的占位名单，不代表 30 个人在线。首次启动（没有 state）的第一轮同样按基线处理。

其它板块每次刷新都会抓一遍：击杀/开锁日志只对**新出现的记录**（按 时间+玩家+目标 去重）产生事件；风控名单对新增和移除都记；排行榜只在**进入前三、名次上升 ≥3 位、跌出前三**时记，避免刷屏。

站点的秒数大约每 10–20 秒批量刷新一次，所以「本区间增长」常见 40–60 秒，偶尔 20 或 80 秒，属正常。

手动「立即刷新」如果距上次判定不足 61 秒，只更新显示的数字，不重算在线状态，避免手快连点造成假下线（这次刷新也不落盘，重启后以最后一次判定为准）。

掉出前 30 名的玩家会写一条带 `reason=dropped` 的下线事件，并从 `state.players` 删除，不再长期显示为在线；上一轮只是「新上榜」的玩家掉榜也同样会记录，已经判过「无变化/下线」的玩家掉榜时不会重复记下线。

## 文件

| 文件 | 作用 |
|---|---|
| `启动监控.cmd` | 一键启动（后端 + 自动开浏览器） |
| `server.mjs` | 本地 Web 服务，启动即开始监控 |
| `public/index.html` | 网页面板（无外部依赖） |
| `public/data.html` | 原始数据子页面（无外部依赖） |
| `public/events.html` | 历史事件子页面（无外部依赖） |
| `public/panel.html` | 新旧监控对照记录子页面（无外部依赖） |
| `lib/monitor.mjs` | 监控核心：抓取、比对、状态与事件 |
| `lib/scum.mjs` | 榜单接口、时长格式化、差异判定 |
| `lib/sources.mjs` | 击杀 / 开锁 / 封禁 / 地堡 / 载具 / 开关接口 |
| `lib/records.mjs` | 原始数据落盘、去重、查询与 CSV |
| `lib/csv.mjs`、`lib/export.mjs` | CSV 转义与事件导出 |
| `lib/args.mjs` | 命令行参数解析 |
| `lib/panel.mjs` | 新日志面板：登录/解密、在线与日志抓取、新旧对照、落盘 |
| `lib/db.mjs` | JSONL -> SQLite 规范化导入 |
| `lib/dbsync.mjs` | 自动增量同步调度（独立子进程、启动/5 分钟/手动） |
| `db/schema.sql` | SQLite 表、索引、视图定义 |
| `db/README.md` | 数据库设计说明与查询示例 |
| `tools/import-jsonl.mjs` | 数据库导入 CLI（`npm run db:import`） |
| `lib/cdp.mjs` | 控制 Chrome 的小工具（登录脚本用） |
| `login.mjs` / `1-登录.cmd` | 打开独立 Chrome 窗口供手动登录 |
| `watch.mjs` | 纯命令行版监控（不需要网页时用） |
| `status.mjs` | 命令行查看最近状态（与 `/api/status` 同源） |
| `test/` | `node:test` 测试（`npm test`） |
| `data/state.json` | 最近一次状态（重启后接着算） |
| `data/snapshots-*.jsonl` | 每轮抓取的原始榜单 |
| `data/events-*.jsonl` | 完整事件流水（上线/下线/击杀/开锁/榜单/风控），保留 14 天 |
| `data/records-*.jsonl` | 全部来源的原始记录（去重后） |
| `data/ranks-*.jsonl` | 每轮 5 个排行榜的完整快照 |
| `data/panel-*.jsonl` | 新面板每轮快照（在线总览/名单/日志总数） |
| `data/panel-records-*.jsonl` | 新面板五类日志的去重原始记录 |
| `data/compare-*.jsonl` | 新旧监控每轮对照与差异 |
| `data/monitor.db` | SQLite 查询库（可选导入，约 200 MB） |
| `data/panel-link.txt` | 新面板免密链接（**登录凭证，勿提交**） |

`events-*.jsonl` / `snapshots-*.jsonl` / `records-*.jsonl` / `ranks-*.jsonl` 默认只保留 **14 天**，启动时会清理更早的文件；旧文件里的坏行会被跳过并计入 `badEventLines`，不会让整份历史事件清空。新面板的 `panel-*` / `panel-records-*` / `compare-*` 同样保留 14 天，由新面板自己清理，不改旧监控的清理逻辑。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 完整状态（玩家、计数、事件、下次刷新时间） |
| POST | `/api/config` | `{"intervalSec":120}` 改频率（不在 61–3600 之间返回 400） |
| POST | `/api/refresh` | 立即刷新一次 |
| POST | `/api/start` / `/api/stop` | 开始 / 暂停 |
| GET | `/api/export/events.csv` | 导出事件 CSV，支持 `?date=YYYY-MM-DD&category=online&q=JEFF`；非法日期返回 400 |
| GET | `/events` | 历史事件子页面 |
| GET | `/panel` | 新旧监控对照记录子页面 |
| GET | `/api/events` | 历史事件，支持 `?date=&category=&q=&limit=&offset=` |
| GET | `/data` | 原始数据子页面 |
| GET | `/api/records/meta` | 各来源条数、排行榜快照数（`?date=YYYY-MM-DD`） |
| GET | `/api/records` | 原始记录，支持 `?date=&source=&q=&limit=&offset=` |
| GET | `/api/ranks` | 排行榜快照，支持 `?date=&type=&limit=&offset=` |
| GET | `/api/records/export.csv` | 导出原始记录 CSV，支持 `?date=&source=&q=` |
| GET | `/api/panel/status` | 新日志面板状态（在线/名单/五类日志/最近对照） |
| POST | `/api/panel/refresh` | 立即抓一次新日志面板 |
| GET | `/api/panel/compare` | 新旧对照记录，支持 `?date=YYYY-MM-DD&limit=200` |
| GET | `/api/panel/snapshots` | 新面板每轮快照，支持 `?date=&limit=` |
| GET | `/api/panel/records` | 新面板去重日志记录，支持 `?date=&limit=` |
| GET | `/api/db/status` | SQLite 自动同步状态（上次/下次/错误） |
| POST | `/api/db/sync` | 立即执行一次 JSONL -> SQLite 增量同步 |

## 测试

```bat
npm test          :: Node 内置测试器，无需安装依赖
```

## 版本管理

已用 Git 管理，主分支 `main`，远程仓库为 `github.com/rkkkgy/SCUM`。

```bat
git status                       :: 看改动
git add -A
git commit -m "改了什么"          :: 提交
git push origin main             :: 推送
git log --oneline                :: 历史
```

**不会被提交的内容**（见 `.gitignore`）：

- `data/` —— 监控记录、状态、截图、看板，都是运行产物
- `.chrome-profile/` —— 浏览器用户目录，里面有登录 Cookie，绝对不要提交
- `node_modules/`、日志、编辑器配置

仓库身份目前用的是本机占位名，想改成自己的：

```bat
git config user.name "你的名字"
git config user.email "you@example.com"
```

## 注意

- 榜单只显示**今日在线时长前 30 名**，第 30 名之后的在线玩家抓不到（页面「在线人数」可能比识别结果多 1～2 人，就是这个原因）。
- 建议间隔 61～300 秒。小于 61 秒会被接口拒绝并返回 400（秒数增量太小，容易和上一轮判定重叠）。
- 未变化即下线：一个在线玩家如果在整个区间内在线秒数一秒都没涨，下一轮就会被判下线并写入事件。
- 接口返回空榜单或缺少 `nickname` 字段时，程序会当作抓取失败并保留上一轮状态，不会把所有人误判为下线。
- 接口目前不需要登录也能读；`watch.mjs` 和网页端一样直接用 `fetch` 请求公开接口，不使用浏览器登录态。登录窗口主要供人工核对。
- 站点改版后如果接口变了，面板会显示刷新失败，把报错发我即可。
