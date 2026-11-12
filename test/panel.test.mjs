import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  decryptMagic, parsePanelLink, aesEncrypt, aesDecrypt, parsePanelResponse,
  buildComparison, readPanelRows, PanelMonitor,
} from '../lib/panel.mjs';

function magicFixture(creds) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(creds))), c.final()]);
  return { m: Buffer.concat([iv, ct]).toString('base64'), s: key.toString('base64') };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scum-panel-'));
}

test('decryptMagic 能解开面板免密链接并还原账号', () => {
  const { m, s } = magicFixture({ account: 'sub_test', password: 'pass123456' });
  assert.deepEqual(JSON.parse(decryptMagic(m, s)), { account: 'sub_test', password: 'pass123456' });
});

test('parsePanelLink 支持 #/auth/login?m=&s= 形式的链接', () => {
  const { m, s } = magicFixture({ account: 'sub_test', password: 'pass123456' });
  const link = `https://web-log.chacca.net/#/auth/login?m=${encodeURIComponent(m)}&s=${encodeURIComponent(s)}&u=abc`;
  assert.deepEqual(parsePanelLink(link), { account: 'sub_test', password: 'pass123456' });
});

test('parsePanelLink 遇到缺参数或坏密文会报错', () => {
  assert.throws(() => parsePanelLink('https://x/#/auth/login?m=abc'), /缺少 m\/s/);
  const { m } = magicFixture({ account: 'a', password: 'b' });
  assert.throws(() => parsePanelLink(`https://x/#/auth/login?m=${encodeURIComponent(m)}&s=bad`), /密钥长度|密文长度/);
});

test('aesEncrypt / aesDecrypt 与面板 sign 往返一致', () => {
  const sign = 'AbCdEf1234567890';
  const obj = { page: 1, type: 'kill', name: '测试' };
  const enc = aesEncrypt(obj, sign);
  assert.deepEqual(JSON.parse(aesDecrypt(enc, sign)), obj);
});

test('parsePanelResponse 同时支持明文对象和加密字符串', () => {
  const sign = 'AbCdEf1234567890';
  const obj = { code: 200, data: [1, 2] };
  assert.deepEqual(parsePanelResponse(JSON.stringify(obj), sign), obj);
  const enc = aesEncrypt(obj, sign);
  assert.deepEqual(parsePanelResponse(JSON.stringify(enc), sign), obj);
});

test('buildComparison 找出新名单多出的人、旧名单多出的人并算差值', () => {
  const dir = tmpDir();
  try {
    const oldStatus = {
      counts: { online: 2, strictOnline: 1, new: 1, idle: 1, total: 3, serverOnline: 3 },
      players: [
        { name: 'A', status: 'online' },
        { name: 'C', status: 'new' },
        { name: 'B', status: 'idle' },
      ],
    };
    const cmp = buildComparison({
      oldStatus,
      overview: { online: 2, active24h: 9, killsToday: 10 },
      online: [
        { gameName: 'B', steamid: '2', region: 'B1' },
        { gameName: 'D', steamid: '4', region: 'D1' },
      ],
      logs: {
        lock: { total: 5 },
        bomb: { total: 2 },
        kill: { total: 10 },
        vehicle: { total: 3 },
        admin: { total: 1 },
      },
      dataDir: dir,
      date: '2026-11-12',
      now: new Date('2026-11-12T12:00:00+08:00'),
    });
    assert.equal(cmp.old.online, 2);
    assert.equal(cmp.old.strictOnline, 1);
    assert.equal(cmp.new.online, 2);
    assert.equal(cmp.diff.online, 0);
    assert.equal(cmp.diff.strict, 1);
    assert.deepEqual(cmp.details.missingInOld.map((x) => x.name), ['B', 'D']);
    assert.deepEqual(cmp.details.extraInOld.map((x) => x.name).sort(), ['A', 'C']);
    assert.equal(cmp.new.logs.kill, 10);
    assert.equal(cmp.diff.kill, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readPanelRows 最新在前并遵守 limit', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'compare-2026-11-12.jsonl'), [
      JSON.stringify({ n: 1 }),
      JSON.stringify({ n: 2 }),
      JSON.stringify({ n: 3 }),
    ].join('\n') + '\n');
    const r = readPanelRows(dir, 'compare', '2026-11-12', { limit: 2 });
    assert.equal(r.total, 3);
    assert.deepEqual(r.items.map((x) => x.n), [3, 2]);
    assert.throws(() => readPanelRows(dir, 'bad', '2026-11-12'), /prefix/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('看板有新旧对照区块，/panel 页面和服务端接口存在', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'public', 'panel.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  assert.match(index, /新日志监控/);
  assert.match(index, /renderPanel\(s, s\.panel\)/);
  assert.match(index, /href="\/panel"/);
  assert.match(page, /\/api\/panel\/compare/);
  assert.match(server, /'\/api\/panel\/status'/);
  assert.match(server, /public', 'panel\.html'/);
});

test('PanelMonitor 能落盘快照/记录/对照，并算出在线差', async () => {
  const dir = tmpDir();
  const { m, s } = magicFixture({ account: 'sub_test', password: 'pass123456' });
  fs.writeFileSync(path.join(dir, 'panel-link.txt'), `https://web-log.chacca.net/#/auth/login?m=${encodeURIComponent(m)}&s=${encodeURIComponent(s)}`);
  const fakeFetch = async (url) => {
    const pathname = new URL(url).pathname;
    let body;
    if (pathname.endsWith('/login')) {
      body = { code: 200, msg: 'ok', data: { accessToken: 'token', webLogExpireTime: '2026-11-18T00:00:00+08:00' } };
    } else if (pathname.endsWith('/dashboard_overview')) {
      body = { code: 200, data: { online: { current: 3 }, active24h: { current: 9 }, killsToday: { current: 7 }, lastLogTime: '2026-11-12T12:00:00+08:00' } };
    } else if (pathname.endsWith('/online_players')) {
      body = { code: 200, data: [{ gameName: 'A', steamid: '1', time: '2026-11-12 10:00:00', region: 'B1' }, { gameName: 'B', steamid: '2' }, { gameName: 'C', steamid: '3' }] };
    } else {
      body = { code: 200, total: 10, data: [{ time: '2026-11-12 11:00:00', name: 'A', steamid: '1', target: 'T', elapsedTime: '1.0', failedAttempts: '0', isSuccess: 1 }] };
    }
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const old = { counts: { online: 2, strictOnline: 1, new: 1, idle: 1, total: 3, serverOnline: 5 }, players: [{ name: 'A', status: 'online' }, { name: 'B', status: 'new' }, { name: 'D', status: 'idle' }] };
    const m = new PanelMonitor({ dataDir: dir, oldStatus: () => old, fetchImpl: fakeFetch });
    const r = await m.poll();
    assert.equal(r.ok, true);
    const st = m.status();
    assert.equal(st.online, 3);
    assert.equal(st.rosterCount, 3);
    assert.equal(st.logs.kill.total, 10);
    assert.equal(st.comparison.diff.online, 1);
    assert.deepEqual(st.comparison.details.missingInOld.map((x) => x.name), ['C']);
    assert.equal(fs.existsSync(path.join(dir, `panel-${st.comparison.at.slice(0, 10)}.jsonl`)), true);
    assert.equal(fs.existsSync(path.join(dir, `compare-${st.comparison.at.slice(0, 10)}.jsonl`)), true);
    assert.equal(fs.existsSync(path.join(dir, `panel-records-${st.comparison.at.slice(0, 10)}.jsonl`)), true);
    const lines = fs.readFileSync(path.join(dir, `compare-${st.comparison.at.slice(0, 10)}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PanelMonitor 未配置链接时给出明确错误，不抛异常', async () => {
  const dir = tmpDir();
  try {
    const m = new PanelMonitor({ dataDir: dir, oldStatus: () => null });
    const r = await m.poll();
    assert.equal(r.ok, false);
    assert.match(r.error, /panel-link/);
    const s = m.status();
    assert.equal(s.configured, false);
    assert.equal(s.online, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
