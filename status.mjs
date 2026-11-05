// 查看最近一次（或指定日期）的状态：谁在线、谁下线、最近事件
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG as CFG } from './lib/config.mjs';
import { fmtDuration, fmtDelta, todayKey } from './lib/scum.mjs';

const date = process.argv[2] || todayKey();
const dir = CFG.dataDir;

let state;
try {
  state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
} catch {
  console.error('还没有监控数据，请先运行 node watch.mjs');
  process.exit(1);
}
if (state.date !== date) {
  console.error(`本地状态日期是 ${state.date}，不是 ${date}`);
}

const players = Object.entries(state.players || {});
players.sort((a, b) => b[1].seconds - a[1].seconds);
const group = (st) => players.filter(([, p]) => p.status === st);

const line = (name, p) => {
  const extra = p.delta > 0 ? `  +${p.delta}分钟` : '';
  console.log(`  ${name.padEnd(18, ' ')} ${fmtDuration(p.minutes * 60).padStart(12, ' ')}${extra}`);
};

console.log(`\n=== SCUM 今日在线（${state.date}）最后刷新：${state.updatedAt || '—'} ===`);
console.log(`榜上 ${players.length} 人，刷新 ${state.round} 次\n`);

const on = [...group('online'), ...group('partial')];
console.log(`【在线】${on.length} 人`);
for (const [n, p] of on) line(n, p);

const idle = group('idle');
console.log(`\n【在榜但时长无变化】${idle.length} 人`);
for (const [n, p] of idle) line(n, p);

const dropped = group('dropped');
if (dropped.length) {
  console.log(`\n【已掉出榜单】${dropped.length} 人`);
  for (const [n, p] of dropped) line(n, p);
}

const evFile = path.join(dir, `events-${date}.jsonl`);
if (fs.existsSync(evFile)) {
  const evs = fs
    .readFileSync(evFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-25)
    .map((l) => JSON.parse(l))
    .reverse();
  if (evs.length) {
    console.log(`\n【最近事件】`);
    for (const e of evs) {
      const t = e.type === 'online' ? '上线' : e.type === 'offline' ? '下线' : '新上榜';
      console.log(`  ${e.at}  ${e.nickname}  ${t}`);
    }
  }
}

console.log(`\n明细报告: ${path.join(dir, 'report.html')}`);
