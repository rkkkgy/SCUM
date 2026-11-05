// 命令行版监控（不启动网页时使用）
//   node watch.mjs                  每 120 秒刷新，一直运行
//   node watch.mjs --interval=90    每 90 秒刷新（最短 61 秒）
//   node watch.mjs --once           只刷新一次
//   node watch.mjs --minutes=30     运行 30 分钟后自动停止
import { CONFIG as CFG } from './lib/config.mjs';
import { Monitor } from './lib/monitor.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const RUN_MINUTES = Number(args.minutes || 0);
const ONCE = Boolean(args.once);
const monitor = new Monitor({
  dataDir: CFG.dataDir,
  intervalSec: args.interval ? Number(args.interval) : undefined,
  type: String(args.type || 'today_online'),
});

const stamp = () =>
  new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const fmt = (min) => {
  min = Math.max(0, Math.round(min));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d}天${h}小时${m}分`;
  if (h) return `${h}小时${m}分`;
  return `${m}分`;
};

monitor.onPoll = (r) => {
  if (!r.ok) return log('刷新失败:', r.error);
  const s = monitor.status();
  const online = s.players.filter((p) => p.status === 'online');
  log(`第 ${s.round} 次刷新｜榜上 ${s.counts.total} 人｜在线 ${s.counts.online} 人`);
  for (const p of online) {
    log(`  ● ${p.name}  ${fmt(p.minutes)}  (+${p.delta ?? 0}分)`);
  }
  if (s.counts.idle) log(`  ○ 无变化 ${s.counts.idle} 人`);
  for (const e of s.events.slice(0, 3)) {
    if (e.at.slice(11) > new Date(Date.now() - 5000).toTimeString().slice(0, 8)) {
      log(`  → ${e.nickname} ${e.type === 'online' ? '上线' : e.type === 'offline' ? '下线' : '新上榜'}`);
    }
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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
}

process.on('SIGINT', () => {
  monitor.stop();
  log('已停止');
  process.exit(0);
});

main().catch((e) => {
  console.error('运行失败:', e.stack || e.message);
  process.exit(1);
});
