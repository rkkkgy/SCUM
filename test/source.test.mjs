// 针对 issue #10/#11/#13 的静态检查：这些点主要在界面/脚本里，纯 Node 无法直接跑 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('issue#11: 频率输入不会被轮询无条件覆盖，暂停按钮有 null 保护', () => {
  const html = read('public/index.html');
  assert.match(html, /document\.activeElement !== \$\('intv'\) && !intvDirty/);
  assert.match(html, /intvDirty = true/);
  assert.match(html, /if \(!last\) return toast/);
  assert.match(html, /\$\('toggle'\)\.disabled = true/);
});

test('issue#11/13: 前端使用接口返回的时长文案，不再自己格式化', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /function fmtDur/);
  assert.match(html, /p\.durationText/);
});

test('issue#10: status.mjs 与 /api/status 同源，不再打印不存在的 report.html', () => {
  const src = read('status.mjs');
  assert.match(src, /new Monitor/);
  assert.match(src, /monitor\.status\(\)/);
  assert.doesNotMatch(src, /report\.html/);
  assert.doesNotMatch(src, /group\('partial'\)/);
  assert.doesNotMatch(src, /fmtDelta/);
});

test('事件颜色：前端按 eventTone 输出 tone-* 类，旧 c-* 类已移除', () => {
  const html = read('public/index.html');
  assert.match(html, /<script type="module">/);
  assert.match(html, /import \{ eventTone \} from '\.\/event-tone\.js'/);
  assert.match(html, /class="ev tone-\$\{eventTone\(e\)\}"/);
  assert.doesNotMatch(html, /c-online|c-kill|c-unlock|c-rank|c-risk|c-system/);
  assert.doesNotMatch(html, /class="dotm c-/);
});

test('issue#12: README 不再声称远程仓库未配置 / watch.mjs 会用 CDP', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /还没有配置远程仓库/);
  assert.doesNotMatch(readme, /watch\.mjs.*CDP/);
  assert.doesNotMatch(readme, /55 秒/);
  assert.match(readme, /github\.com\/rkkkgy\/SCUM/);
});

test('issue#13: 已删除零调用导出与重复实现', () => {
  const scum = read('lib/scum.mjs');
  assert.doesNotMatch(scum, /export function fmtDelta/);
  assert.doesNotMatch(scum, /STATUS_LABEL/);
  const config = read('lib/config.mjs');
  assert.doesNotMatch(config, /boardUrl/);
  const cdp = read('lib/cdp.mjs');
  assert.doesNotMatch(cdp, /DEFAULT_PORT/);
  assert.doesNotMatch(cdp, /once\(method/);
  assert.doesNotMatch(cdp, /headless/);
  const monitor = read('lib/monitor.mjs');
  assert.doesNotMatch(monitor, /this\.rows/);
  assert.doesNotMatch(monitor, /lastSkipped/);
  assert.doesNotMatch(monitor, /lastVia/);
  assert.doesNotMatch(monitor, /eventCounts/);
});

test('原始数据：/data 子页面存在、看板有入口、服务端有查询接口', () => {
  const data = read('public/data.html');
  assert.match(data, /原始数据记录/);
  assert.match(data, /\/api\/records\/meta/);
  assert.match(data, /\/api\/records\?/);
  assert.match(data, /\/api\/ranks\?/);
  const index = read('public/index.html');
  assert.match(index, /href="\/data"/);
  const server = read('server.mjs');
  assert.match(server, /p === '\/data'/);
  assert.match(server, /readRecords\(/);
  assert.match(server, /readRankSnapshots\(/);
  const monitor = read('lib/monitor.mjs');
  assert.match(monitor, /new RecordStore/);
  assert.match(monitor, /_recordRaw/);
});

test('issue#8: server 对非法频率与日期返回 400', () => {
  const server = read('server.mjs');
  assert.match(server, /sec < MIN_INTERVAL_SEC \|\| sec > MAX_INTERVAL_SEC/);
  assert.match(server, /isValidDateParam\(date\)/);
  assert.match(server, /json\(res, 400/);
});
