// 查看最近一次状态：谁在线、谁新上榜、最近事件（与 /api/status 同源）
import { CONFIG as CFG } from './lib/config.mjs';
import { Monitor } from './lib/monitor.mjs';

const monitor = new Monitor({ dataDir: CFG.dataDir, pruneData: false });
const s = monitor.status();
const argDate = process.argv[2];
if (argDate && argDate !== s.date) {
  console.error(`本地状态日期是 ${s.date}，不是 ${argDate}`);
}

console.log(`\n=== SCUM 今日在线（${s.date}）最后刷新：${s.updatedAt || '—'} ===`);
console.log(`榜上 ${s.counts.total} 人，刷新 ${s.round} 次\n`);

const line = (p) => {
  const delta = p.delta > 0 ? `  +${p.delta}分钟` : '';
  console.log(`  ${p.name.padEnd(18, ' ')} ${p.durationText.padStart(12, ' ')}${delta}`);
};

const online = s.players.filter((p) => p.status === 'online' || p.status === 'new');
console.log(`【在线 / 新上榜】${online.length} 人`);
for (const p of online) line(p);

const idle = s.players.filter((p) => p.status === 'idle');
console.log(`\n【在榜但时长无变化】${idle.length} 人`);
for (const p of idle) line(p);

if (s.counts.total === 0) {
  console.log('\n还没有监控数据。请先运行：node watch.mjs 或 node server.mjs');
}

const CATEGORY = { online: '在线', kill: '击杀', unlock: '开锁', rank: '榜单', risk: '风控', system: '系统' };
const events = s.events.slice(0, 25);
if (events.length) {
  console.log('\n【最近事件】');
  for (const e of events) {
    console.log(`  ${e.at}  [${CATEGORY[e.category] || '在线'}]  ${e.title}`);
  }
}
