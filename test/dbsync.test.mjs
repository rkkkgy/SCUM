import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DbSyncService } from '../lib/dbsync.mjs';

test('DbSyncService 启动后自动同步，并记录状态', async () => {
  let calls = 0;
  const svc = new DbSyncService({
    available: true,
    enabled: true,
    startupDelayMs: 5,
    intervalSec: 60,
    runImpl: async () => {
      calls += 1;
      return { ok: true, code: 0, stdout: '文件: 1 个\n表行数: 1', stderr: '' };
    },
  });
  try {
    svc.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls >= 1);
    const s = svc.status();
    assert.equal(s.running, false);
    assert.ok(s.lastSyncAt);
    assert.match(s.lastSummary, /表行数/);
    const r = await svc.trigger('manual');
    assert.equal(r.ok, true);
    assert.equal(svc.status().lastError, null);
  } finally {
    svc.stop();
  }
});

test('DbSyncService 运行中不会并发启动第二个导入', async () => {
  let resolveRun;
  const svc = new DbSyncService({
    available: true,
    enabled: true,
    runImpl: () => new Promise((resolve) => { resolveRun = resolve; }),
  });
  const first = svc.trigger('manual');
  await new Promise((r) => setTimeout(r, 5));
  const second = await svc.trigger('manual');
  assert.equal(second.running, true);
  assert.equal(second.ok, false);
  resolveRun({ ok: true, code: 0, stdout: 'done', stderr: '' });
  const done = await first;
  assert.equal(done.ok, true);
  svc.stop();
});

test('DbSyncService 在 node:sqlite 不可用时给出明确错误', async () => {
  const svc = new DbSyncService({ available: false, enabled: true });
  const r = await svc.trigger('manual');
  assert.equal(r.ok, false);
  assert.match(r.error, /22\.5/);
  assert.equal(svc.status().available, false);
});

test('看板有 SQLite 同步状态和手动同步入口', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  assert.match(html, /SQLite 同步/);
  assert.match(html, /dbSync/);
  assert.match(server, /'\/api\/db\/sync'/);
  assert.match(server, /dbSync\.start\(\)/);
});
