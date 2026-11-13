// 把 data/*.jsonl 导入 data/monitor.db
// 用法：
//   node tools/import-jsonl.mjs
//   node tools/import-jsonl.mjs --data-dir=D:\SCUM-Monitor\data --db=D:\SCUM-Monitor\data\monitor.db
//   node tools/import-jsonl.mjs --force
import path from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { CONFIG } from '../lib/config.mjs';
import { importJsonl } from '../lib/db.mjs';

const args = parseArgs();
const dataDir = args['data-dir'] ? path.resolve(args['data-dir']) : CONFIG.dataDir;
const dbPath = args.db ? path.resolve(args.db) : undefined;
const force = Boolean(args.force);
const verbose = !args.quiet;

console.log(`数据目录: ${dataDir}`);
console.log(`数据库:   ${dbPath || path.join(dataDir, 'monitor.db')}`);

const t0 = Date.now();
const r = importJsonl({ dataDir, dbPath, force, verbose });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

console.log('');
console.log(`文件: ${r.files} 个（跳过未变化 ${r.filesSkipped} 个）`);
console.log(`行数: ${r.rows}，新增 ${r.inserted}，跳过 ${r.skipped}`);
console.log(`耗时: ${seconds}s`);

if (r.counts && Object.keys(r.counts).length) {
  console.log('');
  console.log('表行数:');
  for (const [name, n] of Object.entries(r.counts)) {
    console.log(`  ${name.padEnd(24)} ${n}`);
  }
}

if (r.errors.length) {
  console.error('');
  for (const e of r.errors) console.error('错误:', e);
  process.exitCode = 1;
}
