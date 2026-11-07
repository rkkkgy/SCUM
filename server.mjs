// 本地 Web 服务：启动即开始监控，网页端可看状态、改频率、手动刷新
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { CONFIG as CFG } from './lib/config.mjs';
import { parseArgs } from './lib/args.mjs';
import { Monitor, acquireLock, releaseLock, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC } from './lib/monitor.mjs';
import { buildEventsCsv, eventsCsvFilename, isValidDateParam, readEvents } from './lib/export.mjs';
import {
  buildRecordsCsv, readRecords, readRecordMeta, readRankSnapshots,
  RECORD_SOURCES, RANK_TYPES, RANK_TYPE_LABEL,
} from './lib/records.mjs';

const args = parseArgs();
const PORT = Number(args.port || 8788);
const OPEN = Boolean(args.open);

const lock = acquireLock(CFG.dataDir);
if (!lock.ok) {
  console.error(`已经有监控在运行了（进程 ${lock.pid}），不要重复启动。`);
  console.error(`直接打开 http://127.0.0.1:${PORT} 即可；要重启请先关掉原来那个窗口。`);
  process.exit(1);
}

const monitor = new Monitor({
  dataDir: CFG.dataDir,
  intervalSec: args.interval ? Number(args.interval) : undefined,
});
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

monitor.onPoll = (r) => {
  if (!r.ok) return log('刷新失败:', r.error);
  if (r.skipped) return log('距上次判定不足 61 秒，本次仅更新数据，不改变在线状态');
  const s = monitor.status();
  log(`刷新完成：榜上 ${s.counts.total} 人，判定在线 ${s.counts.strictOnline} 人，新上榜 ${s.counts.new} 人`);
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 取客户端传入的日期；缺省为今天，非法返回 null */
function dateParam(url) {
  const date = url.searchParams.get('date') || monitor.status().date;
  return isValidDateParam(date) ? date : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(import.meta.dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (p === '/data' || p === '/data.html') {
      const html = fs.readFileSync(path.join(import.meta.dirname, 'public', 'data.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (p === '/api/status') return json(res, 200, monitor.status());

    if (p === '/api/records/meta') {
      const date = dateParam(url);
      if (!date) return json(res, 400, { error: 'date 参数必须是 YYYY-MM-DD' });
      return json(res, 200, {
        ...readRecordMeta(CFG.dataDir, date),
        sourcesLabel: RECORD_SOURCES,
        rankTypes: RANK_TYPES,
        rankTypeLabel: RANK_TYPE_LABEL,
      });
    }

    if (p === '/api/records') {
      const date = dateParam(url);
      if (!date) return json(res, 400, { error: 'date 参数必须是 YYYY-MM-DD' });
      const source = url.searchParams.get('source') || '';
      const q = url.searchParams.get('q') || '';
      const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100);
      const offset = clampInt(url.searchParams.get('offset'), 0, 1e9, 0);
      return json(res, 200, { date, ...readRecords(CFG.dataDir, date, { source, q, limit, offset }) });
    }

    if (p === '/api/ranks') {
      const date = dateParam(url);
      if (!date) return json(res, 400, { error: 'date 参数必须是 YYYY-MM-DD' });
      const type = url.searchParams.get('type') || '';
      if (type && !RANK_TYPES.includes(type)) return json(res, 400, { error: '未知的排行榜类型' });
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
      const offset = clampInt(url.searchParams.get('offset'), 0, 1e9, 0);
      return json(res, 200, { date, type, ...readRankSnapshots(CFG.dataDir, date, { type, limit, offset }) });
    }

    if (p === '/api/records/export.csv') {
      const date = dateParam(url);
      if (!date) return json(res, 400, { error: 'date 参数必须是 YYYY-MM-DD' });
      const source = url.searchParams.get('source') || '';
      const q = url.searchParams.get('q') || '';
      const { items } = readRecords(CFG.dataDir, date, { source, q, limit: 1e9, offset: 0 });
      const csv = buildRecordsCsv(items);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="scum-records-${date}.csv"`,
      });
      return res.end(csv);
    }

    if (p === '/api/config' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
      const sec = Number(body.intervalSec);
      if (!Number.isFinite(sec) || sec < MIN_INTERVAL_SEC || sec > MAX_INTERVAL_SEC) {
        return json(res, 400, {
          ok: false,
          error: `检测频率需在 ${MIN_INTERVAL_SEC}–${MAX_INTERVAL_SEC} 秒之间（小于 61 秒秒数增量太小）`,
        });
      }
      monitor.setInterval(Math.round(sec));
      log(`刷新频率已改为 ${monitor.intervalSec} 秒`);
      return json(res, 200, { ok: true, intervalSec: monitor.intervalSec, status: monitor.status() });
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      const r = await monitor.poll();
      if (monitor.running) monitor.reschedule();
      return json(res, 200, { ...r, status: monitor.status() });
    }

    if (p === '/api/start' && req.method === 'POST') {
      monitor.start();
      log('已开始监控');
      return json(res, 200, { ok: true, running: true, status: monitor.status() });
    }

    if (p === '/api/stop' && req.method === 'POST') {
      monitor.stop();
      log('已暂停监控');
      return json(res, 200, { ok: true, running: false, status: monitor.status() });
    }

    if (p === '/api/export/events.csv') {
      const date = url.searchParams.get('date') || monitor.status().date;
      if (!isValidDateParam(date)) {
        return json(res, 400, { error: 'date 参数必须是 YYYY-MM-DD' });
      }
      const csv = buildEventsCsv(readEvents(CFG.dataDir, date));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${eventsCsvFilename(date)}"`,
      });
      return res.end(csv);
    }

    // 静态文件兜底（仅限 public 目录）
    const safe = path.normalize(p).replace(/^([/\\])+/, '');
    const pubDir = path.join(import.meta.dirname, 'public');
    const file = path.join(pubDir, safe);
    const rel = path.relative(pubDir, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可能监控已经在运行，直接打开 http://127.0.0.1:${PORT} 即可；或换个端口：node server.mjs --port=8789`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}`;
  console.log('SCUM 在线监控已启动');
  console.log(`  控制台: ${link}`);
  console.log(`  刷新间隔: ${monitor.intervalSec} 秒`);
  console.log('  按 Ctrl+C 停止');
  monitor.start();
  if (OPEN) exec(`start "" "${link}"`, { shell: 'cmd.exe' });
});

process.on('SIGINT', () => {
  console.log('\n正在停止...');
  monitor.stop();
  releaseLock(CFG.dataDir);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});

process.on('exit', () => releaseLock(CFG.dataDir));
