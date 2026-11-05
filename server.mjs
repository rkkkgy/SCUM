// 本地 Web 服务：启动即开始监控，网页端可看状态、改频率、手动刷新
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { CONFIG as CFG } from './lib/config.mjs';
import { Monitor, clampInterval } from './lib/monitor.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const PORT = Number(args.port || 8788);
const OPEN = Boolean(args.open);

const monitor = new Monitor({
  dataDir: CFG.dataDir,
  intervalSec: args.interval ? Number(args.interval) : undefined,
});
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

monitor.onPoll = (r) => {
  if (!r.ok) return log('刷新失败:', r.error);
  if (r.skipped) return log('距上次判定不足 1 分钟，本次仅更新数据，不改变在线状态');
  const s = monitor.status();
  log(`刷新完成：榜上 ${s.counts.total} 人，判定在线 ${s.counts.online} 人`);
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
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

    if (p === '/api/status') return json(res, 200, monitor.status());

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const sec = clampInterval(body.intervalSec);
      monitor.setInterval(sec);
      log(`刷新频率已改为 ${sec} 秒`);
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
      const file = path.join(CFG.dataDir, `events-${date}.jsonl`);
      const rows = fs.existsSync(file)
        ? fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
      const label = { online: '上线', offline: '下线', new: '新上榜' };
      const head = '时间,玩家,事件,今日在线分钟数,区间增量分钟\n';
      const body = rows
        .map((e) => [e.at, e.nickname, label[e.type] || e.type, e.minutes ?? '', e.delta ?? ''].join(','))
        .join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="scum-events-${date}.csv"`,
      });
      return res.end('\ufeff' + head + body);
    }

    // 静态文件兜底（仅限 public 目录）
    const safe = path.normalize(p).replace(/^([/\\])+/, '');
    const pubDir = path.join(import.meta.dirname, 'public');
    const file = path.join(pubDir, safe);
    if (file.startsWith(pubDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
