// 命令行版监控（不启动网页时使用）
//   node watch.mjs                  每 120 秒刷新，一直运行
//   node watch.mjs --interval=90    每 90 秒刷新（最短 61 秒）
//   node watch.mjs --once           只刷新一次
//   node watch.mjs --minutes=30     运行 30 分钟后自动停止
import { CONFIG as CFG } from './lib/config.mjs';
import { parseArgs } from './lib/args.mjs';
import { Monitor, acquireLock, releaseLock } from './lib/monitor.mjs';

const args = parseArgs();

const RUN_MINUTES = Number(args.minutes || 0);
const ONCE = Boolean(args.once);
const lock = acquireLock(CFG.dataDir);
if (!lock.ok) {
  console.error(`已经有监控在运行了（进程 ${lock.pid}），如需重启请先关掉原来的。`);
  process.exit(1);
}
const monitor = new Monitor({
  dataDir: CFG.dataDir,
  intervalSec: args.interval ? Number(args.interval) : undefined,
  type: String(args.type || 'today_online'),
});

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${stamp()}]`, ...a);

monitor.onPoll = (r) => {
  if (!r.ok) return log('刷新失败:', r.error);
  const s = monitor.status();
  log(`第 ${s.round} 次刷新｜榜上 ${s.counts.total} 人｜在线 ${s.counts.strictOnline} 人｜新上榜 ${s.counts.new} 人`);
  if (s.server) log(`服务器显示 ${s.server.online}/${s.server.max} 在线｜本工具识别 ${s.counts.online}｜榜外约 ${s.counts.notDetected ?? 0}`);
  for (const p of s.players.filter((x) => x.status === 'online')) {
    log(`  ● ${p.name}  ${p.durationText}  (+${p.delta ?? 0}秒)`);
  }
  if (s.counts.idle) log(`  ○ 无变化 ${s.counts.idle} 人`);
  for (const e of s.events.slice(0, 3)) {
    if (e.ts && Date.now() - new Date(e.ts).getTime() < 10000) log(`  → ${e.title}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try {
    log(`开始监控：间隔 ${monitor.intervalSec}s${RUN_MINUTES ? `，运行 ${RUN_MINUTES} 分钟` : ''}`);
    if (ONCE) {
      await monitor.poll();
      return;
    }
    // 用 Monitor 自己的定时器，保证与网页端行为一致
    monitor.start();
    const deadline = RUN_MINUTES ? Date.now() + RUN_MINUTES * 60000 : Infinity;
    while (Date.now() < deadline) await sleep(1000);
    monitor.stop();
    log('监控结束，数据已保存到 data/');
  } finally {
    releaseLock(CFG.dataDir);
  }
}

process.on('SIGINT', () => {
  monitor.stop();
  releaseLock(CFG.dataDir);
  log('已停止');
  process.exit(0);
});

process.on('exit', () => releaseLock(CFG.dataDir));

main().catch((e) => {
  console.error('运行失败:', e.stack || e.message);
  process.exit(1);
});
