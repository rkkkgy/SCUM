import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildEventsCsv,
  eventsCsvFilename,
  isValidDateParam,
  readEvents,
  filterEvents,
  eventCounts,
} from '../lib/export.mjs';
import { csvField, toCsv } from '../lib/csv.mjs';
import { removeDir, tempDataDir } from './helpers.mjs';

test('issue#8: CSV 字段按 RFC 4180 转义并阻止公式注入', () => {
  assert.equal(csvField('普通文本'), '普通文本');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('a"b'), '"a""b"');
  assert.equal(csvField('a\nb'), '"a\nb"');
  assert.equal(csvField('=1+1'), "'=1+1");
  assert.equal(csvField('+86'), "'+86");
  assert.equal(csvField('-1'), "'-1");
  assert.equal(csvField('@cmd'), "'@cmd");
  assert.equal(csvField(null), '');
  assert.equal(toCsv(['a', 'b'], [['1,2', '3"4']]), 'a,b\r\n"1,2","3""4"');
});

test('issue#8: 事件 CSV 中逗号/引号/换行昵称不会串列', () => {
  const csv = buildEventsCsv([
    {
      at: '2026-11-06 01:00:00',
      category: 'kill',
      nickname: 'bad,name"x\nnext',
      title: '=HYPERLINK("http://x")',
      detail: 'a,b',
    },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"bad,name""x\nnext"/);
  assert.match(lines[1], /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(lines[1], /"a,b"$/);
});

test('issue#8: date 参数必须严格匹配 YYYY-MM-DD，且不能越界读取', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  assert.equal(isValidDateParam('2026-11-06'), true);
  assert.equal(isValidDateParam('2024-02-29'), true);
  assert.equal(isValidDateParam('2026-02-29'), false);
  assert.equal(isValidDateParam('2026-02-30'), false);
  assert.equal(isValidDateParam('2026-13-99'), false);
  assert.equal(isValidDateParam('2026-00-10'), false);
  assert.equal(isValidDateParam('2026-1-6'), false);
  assert.equal(isValidDateParam('../../../lib/monitor'), false);
  assert.equal(isValidDateParam('2026-11-06/../x'), false);
  assert.equal(isValidDateParam(null), false);
  assert.throws(() => readEvents(dir, '../../../lib/monitor'), /YYYY-MM-DD/);
  assert.equal(eventsCsvFilename('2026-11-06'), 'scum-events-2026-11-06.csv');
});

test('issue#8/9: 导出读取时跳过坏行', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const file = path.join(dir, 'events-2026-11-06.jsonl');
  fs.writeFileSync(file, '{"nickname":"A"}\nnot-json\nnull\n{"nickname":"B"}\n');
  const rows = readEvents(dir, '2026-11-06');
  assert.deepEqual(rows.map((r) => r.nickname), ['A', 'B']);
  assert.deepEqual(readEvents(dir, '2026-11-07'), []);
  // 直接传入 null 行也不能让导出崩溃
  assert.equal(buildEventsCsv([null, { nickname: 'C', title: 'ok' }]).split('\r\n').length, 2);
});

test('历史事件：按类别 / 关键字过滤并统计条数', () => {
  const rows = [
    { at: '2026-11-06 10:00:00', category: 'online', nickname: 'A', title: 'A 上线' },
    { at: '2026-11-06 10:01:00', category: 'kill', nickname: 'A', title: 'A 击杀了 B', detail: 'AK-47' },
    { at: '2026-11-06 10:02:00', category: 'kill', nickname: 'C', title: 'C 击杀了 D' },
    null,
  ];
  assert.equal(filterEvents(rows, { category: 'kill' }).length, 2);
  assert.equal(filterEvents(rows, { q: 'B' }).length, 1);
  assert.equal(filterEvents(rows, { category: 'kill', q: 'C' }).length, 1);
  assert.deepEqual(eventCounts(rows), { online: 1, kill: 2 });
});
