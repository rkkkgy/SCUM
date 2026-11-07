import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RecordStore, readRecords, readRecordMeta, readRankSnapshots, buildRecordsCsv } from '../lib/records.mjs';
import { todayKey } from '../lib/scum.mjs';
import { pruneOldData } from '../lib/monitor.mjs';
import { removeDir, tempDataDir } from './helpers.mjs';

const at = (d) => new Date(`${d}T12:00:00+08:00`);

test('原始记录：同一天相同 source+key 只写一次，重启后也不会重复', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const now = at('2026-11-08');
  const store = new RecordStore({ dataDir: dir, now });

  assert.equal(store.record(now, 'kill', 'k1', { a: 1 }), true);
  assert.equal(store.record(now, 'kill', 'k1', { a: 2 }), false);
  assert.equal(store.record(now, 'unlock', 'k1', { a: 3 }), true, '不同来源可以同键');

  const restarted = new RecordStore({ dataDir: dir, now });
  assert.equal(restarted.record(now, 'kill', 'k1', { a: 9 }), false, '重启后读回已见键');
  assert.equal(restarted.record(now, 'kill', 'k2', { a: 9 }), true);

  const { total, items } = readRecords(dir, '2026-11-08');
  assert.equal(total, 3);
  assert.deepEqual(items.map((e) => e.source).sort(), ['kill', 'kill', 'unlock']);
  assert.deepEqual(items.find((e) => e.key === 'k1' && e.source === 'kill').data, { a: 1 });
});

test('原始记录：功能开关只在变化时记录', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const now = at('2026-11-08');
  const store = new RecordStore({ dataDir: dir, now });
  const a = { Killdata: 'true', vehiclelog: 'true' };
  assert.equal(store.recordSwitches(now, a), true);
  assert.equal(store.recordSwitches(now, { ...a }), false);
  assert.equal(store.recordSwitches(now, { ...a, Killdata: 'false' }), true);
  assert.equal(readRecordMeta(dir, '2026-11-08').sources.switches, 2);
});

test('原始记录：按来源 / 关键字过滤并分页，按 logtime 倒序', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const now = at('2026-11-08');
  const store = new RecordStore({ dataDir: dir, now });
  store.record(now, 'kill', 'k1', { logtime: '2026-11-08 10:00:00', Killername: '甲', Victimername: '乙' });
  store.record(now, 'kill', 'k2', { logtime: '2026-11-08 11:00:00', Killername: '丙', Victimername: '丁' });
  store.record(now, 'vehicle', 'v1', { logtime: '2026-11-08 10:30:00', carownername: '甲' });

  const kill = readRecords(dir, '2026-11-08', { source: 'kill' });
  assert.equal(kill.total, 2);
  assert.equal(kill.items[0].key, 'k2', 'logtime 最新的在前');

  const search = readRecords(dir, '2026-11-08', { q: '甲' });
  assert.equal(search.total, 2);

  const page = readRecords(dir, '2026-11-08', { limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].key, 'v1', '跨来源也按 logtime 交错排序');
});

test('原始记录：入库晚但 logtime 早的记录不会排到前面', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const now = at('2026-11-08');
  const store = new RecordStore({ dataDir: dir, now });
  // 站点一批回传，at 全相同；logtime 才是真实发生顺序
  store.record(now, 'kill', 'ten', { logtime: '2026-11-08 10:00:00' });
  store.record(now, 'unlock', 'nine', { logtime: '2026-11-08 09:00:00' });
  store.record(now, 'vehicle', 'eleven', { logtime: '2026-11-08 11:00:00' });
  store.record(now, 'bunker_unlock', 'no-time', {});

  const rows = readRecords(dir, '2026-11-08').items;
  assert.deepEqual(rows.map((r) => r.key), ['no-time', 'eleven', 'ten', 'nine']);
});

test('原始记录：封禁按 startTime、开关按入库时间参与排序', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const now = at('2026-11-08');
  const store = new RecordStore({ dataDir: dir, now });
  store.record(now, 'kill', 'k', { logtime: '2026-11-07 22:00:00' });
  store.record(now, 'ban', 'b', { startTime: '2026-11-07 01:00:00' });
  store.record(now, 'switches', 's', {});

  const rows = readRecords(dir, '2026-11-08').items;
  assert.deepEqual(rows.map((r) => r.key), ['s', 'k', 'b']);
});

test('原始记录：跨天换文件，相同键可以重新记录', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const d1 = at('2026-11-08');
  const d2 = at('2026-11-09');
  const store = new RecordStore({ dataDir: dir, now: d1 });
  assert.equal(store.record(d1, 'kill', 'k1', { a: 1 }), true);
  assert.equal(store.record(d2, 'kill', 'k1', { a: 2 }), true);
  assert.equal(readRecords(dir, '2026-11-08').total, 1);
  assert.equal(readRecords(dir, '2026-11-09').total, 1);
});

test('排行榜快照：压缩成数组行，可按类型读取', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const now = at('2026-11-08');
  const store = new RecordStore({ dataDir: dir, now });
  const boards = {
    today_online: [
      { rank: 1, nickname: 'A', seconds: 600, text: '10分钟', title: 'vip' },
      { rank: 2, nickname: 'B', seconds: 300, text: '5分钟', title: '' },
    ],
    kill: [{ rank: 1, nickname: 'A', seconds: 5, text: '5次', title: '' }],
  };
  assert.equal(store.recordRanks(now, boards), true);
  assert.equal(store.recordRanks(now, boards), true, '快照每轮都写');

  const today = readRankSnapshots(dir, '2026-11-08', { type: 'today_online' });
  assert.equal(today.total, 2);
  assert.deepEqual(today.items[0].rows[0], [1, 'A', 600, '10分钟', 'vip']);

  const kill = readRankSnapshots(dir, '2026-11-08', { type: 'kill' });
  assert.equal(kill.items[0].rows.length, 1);
  assert.equal(readRankSnapshots(dir, '2026-11-08', { type: 'fame' }).total, 0);
});

test('原始记录 CSV：字段被正确转义', () => {
  const csv = buildRecordsCsv([
    { at: '2026-11-08 12:00:00', source: 'kill', key: 'a,b', data: { name: 'x"y' } },
  ]);
  assert.match(csv, /时间,来源,键,数据/);
  assert.match(csv, /"a,b"/);
  assert.match(csv, /""name"":""x/);
});

test('保留策略会清理 records- / ranks- 旧文件', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  for (const name of ['records-2020-01-01.jsonl', 'ranks-2020-01-01.jsonl', 'records-2026-11-01.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  const removed = pruneOldData(dir, { days: 14, now: new Date('2026-11-08T12:00:00') });
  assert.equal(removed, 2);
  assert.equal(fs.existsSync(path.join(dir, 'records-2026-11-01.jsonl')), true);
  assert.equal(todayKey(new Date('2026-11-08T12:00:00')), '2026-11-08');
});
