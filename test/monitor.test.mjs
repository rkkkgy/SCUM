import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Monitor, pruneOldData, acquireLock, releaseLock } from '../lib/monitor.mjs';
import { todayKey, fmtDuration, parseMinutes, diffSnapshots } from '../lib/scum.mjs';
import { readRecords, readRecordMeta, readRankSnapshots } from '../lib/records.mjs';
import { age, createSite, removeDir, tempDataDir } from './helpers.mjs';

function onlineEvents(m) {
  return m.events.filter((e) => e.category === 'online');
}

test('issue#1: 基线之后的第一次有效比对会写上线事件', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10], ['B', 10]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  const r1 = await m.poll();
  assert.equal(r1.ok, true);
  assert.equal(m.state.round, 1);

  site.state.board = [['A', 12], ['B', 10]];
  age(m);
  const r2 = await m.poll();
  assert.equal(r2.ok, true);

  const ev = onlineEvents(m).find((e) => e.nickname === 'A' && e.type === 'online');
  assert.ok(ev, '第二轮应该为 A 写入上线事件，而不是被 round<=1 抑制');
  assert.match(ev.detail, /\+120 秒/);
  assert.equal(m.state.players.A.status, 'online');
});

test('issue#2: 掉榜玩家写 dropped 下线事件并从状态中删除（重启也不复活）', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10], ['B', 10]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();

  site.state.board = [['A', 12], ['B', 12], ['C', 5]];
  age(m);
  await m.poll();
  assert.equal(m.state.players.B.status, 'online');
  assert.equal(m.state.players.C.status, 'new');

  site.state.board = [['A', 14]];
  age(m);
  await m.poll();

  const evB = onlineEvents(m).find((e) => e.nickname === 'B' && e.type === 'offline');
  assert.ok(evB, 'B 掉榜后应有下线事件');
  assert.equal(evB.reason, 'dropped');
  assert.match(evB.detail, /掉出今日榜前 30/);
  const evC = onlineEvents(m).find((e) => e.nickname === 'C' && e.type === 'offline');
  assert.ok(evC, '上一轮只是新上榜的 C 掉榜也应记录，避免无声消失');
  assert.equal(evC.reason, 'dropped');
  assert.equal(m.state.players.B, undefined, 'state.players 应删除掉榜玩家');
  assert.equal(m.state.players.C, undefined, 'state.players 应删除掉榜玩家');
  assert.deepEqual(m.state.board, ['A']);

  const restarted = new Monitor({ dataDir: dir, intervalSec: 120 });
  const s = restarted.status();
  assert.equal(s.players.some((p) => p.name === 'B'), false, '重启后不应出现幽灵在线');
  assert.equal(s.players.length, 1);
});

test('issue#2: 旧 state 同步时会过滤掉不在最近快照里的幽灵玩家', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const state = {
    date: todayKey(),
    round: 3,
    updatedAt: new Date().toISOString(),
    players: {
      A: { minutes: 10, seconds: 600, status: 'online' },
      Ghost: { minutes: 99, seconds: 5940, status: 'online' },
    },
    board: ['A'],
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  assert.deepEqual(m.status().players.map((p) => p.name), ['A']);
});

test('issue#2: 旧版 state 没有 board 时回退到当天最后快照过滤幽灵', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const state = {
    date: todayKey(),
    round: 5,
    updatedAt: new Date().toISOString(),
    players: {
      A: { minutes: 10, seconds: 600, status: 'online' },
      Ghost: { minutes: 99, seconds: 5940, status: 'online' },
    },
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(
    path.join(dir, `snapshots-${todayKey()}.jsonl`),
    JSON.stringify({ at: '2026-11-06 01:00:00', items: [{ nickname: 'A', minutes: 10 }] }) + '\n',
  );
  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  assert.deepEqual(m.status().players.map((p) => p.name), ['A']);
});

test('issue#2: idle 后掉榜不重复记下线事件', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10], ['B', 10]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();

  site.state.board = [['A', 12], ['B', 12]];
  age(m);
  await m.poll();

  site.state.board = [['A', 14], ['B', 12]]; // B 分钟没涨 -> 下线
  age(m);
  await m.poll();
  assert.equal(m.state.players.B.status, 'idle');

  site.state.board = [['A', 16]]; // B 之后掉出前 30
  age(m);
  await m.poll();

  const offB = onlineEvents(m).filter((e) => e.nickname === 'B' && e.type === 'offline');
  assert.equal(offB.length, 1, '已判 idle 的玩家掉榜时不应再写一条下线');
  assert.equal(offB[0].reason, undefined);
  assert.equal(m.state.players.B, undefined);
});

test('issue#3: 55–60 秒的手动刷新只更新数据，不重算状态；≥61 秒才判定', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();
  site.state.board = [['A', 12]];
  age(m);
  await m.poll();
  assert.equal(m.state.players.A.status, 'online');
  const eventsAfterOnline = m.events.length;

  // 58 秒：秒数增量太小，必须跳过状态重算
  m.state.updatedAt = new Date(Date.now() - 58_000).toISOString();
  const skipped = await m.poll();
  assert.equal(skipped.skipped, true);
  assert.equal(m.state.round, 2);
  assert.equal(m.events.length, eventsAfterOnline);
  assert.equal(m.state.players.A.status, 'online');

  // 60.9 秒：不能因为四舍五入提前到 61 秒
  m.state.updatedAt = new Date(Date.now() - 60_900).toISOString();
  const skippedLate = await m.poll();
  assert.equal(skippedLate.skipped, true);
  assert.equal(m.state.round, 2);

  // 62 秒：可以正常判定，A 没涨分钟应下线
  m.state.updatedAt = new Date(Date.now() - 62_000).toISOString();
  const judged = await m.poll();
  assert.equal(judged.skipped, undefined);
  const off = onlineEvents(m).find((e) => e.nickname === 'A' && e.type === 'offline');
  assert.ok(off);
});

test('issue#14: 分钟没跳但秒数在涨时判在线，秒数真的不动才判下线', async (t) => {
  const dir = tempDataDir();
  // 601 秒 = 10 分 01 秒；649 秒还是 10 分钟，整分钟数没变
  const site = createSite({ board: [['A', 10, 601]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 61 });
  await m.poll();

  site.state.board = [['A', 10, 649]]; // 秒 +48，分钟仍是 10
  age(m);
  await m.poll();
  assert.equal(m.state.players.A.status, 'online', '秒数涨了就不该判下线');
  assert.equal(m.state.players.A.minutes, 10);
  assert.equal(onlineEvents(m).filter((e) => e.type === 'offline').length, 0);
  const ev = onlineEvents(m).find((e) => e.nickname === 'A' && e.type === 'online');
  assert.ok(ev);
  assert.match(ev.detail, /\+48 秒/);

  site.state.board = [['A', 10, 649]]; // 秒数也不动 -> 真没在线时长增长
  age(m);
  await m.poll();
  assert.equal(m.state.players.A.status, 'idle');
  assert.equal(onlineEvents(m).filter((e) => e.nickname === 'A' && e.type === 'offline').length, 1);
});

test('issue#4: 空榜单 / 缺字段视为抓取失败，保留上一轮状态', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();
  const round = m.state.round;

  site.state.board = [];
  age(m);
  const r = await m.poll();
  assert.equal(r.ok, false);
  assert.match(r.error, /榜单为空/);
  assert.equal(m.state.round, round, '失败时不应推进轮次');
  assert.equal(m.state.players.A.minutes, 10, '失败时应保留原状态');
  assert.match(m.lastError, /榜单为空/);
  assert.equal(m.status().counts.total, 1);

  site.state.board = [['', 8]];
  age(m);
  const r2 = await m.poll();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /字段异常/);
});

test('issue#5: 某来源首轮失败时，下一轮仍按基线处理，不补发历史事件', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10]] });
  site.state.fail['fenlei:1'] = true;
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();
  assert.equal(m.baselines.kill, false, '失败来源不应被标记为已建基线');
  assert.ok(m.extraErrors.kill);

  site.state.fail['fenlei:1'] = false;
  site.state.kill = [
    { logtime: '2026-11-06 01:00:00', Killername: 'K', Victimername: 'V', WeaponCode: 'w', Weapon: 'AK-47', distance: 2480 },
  ];
  site.state.board = [['A', 12]];
  age(m);
  await m.poll();

  assert.equal(m.baselines.kill, true);
  assert.equal(m.events.filter((e) => e.category === 'kill').length, 0, '历史击杀不应被补发');
  assert.ok(m.events.some((e) => e.type === 'source_ready' && /击杀日志已接入/.test(e.title)));
});

test('issue#6: 第 2 名掉到第 4 名会写 rank_down（不是掉出前 20 才写）', async (t) => {
  const dir = tempDataDir();
  const names = ['P1', 'P2', 'P3', 'P4', 'P5'];
  const ranks = {
    kill: [...names],
    deathmatch: [...names],
    fame: [...names],
    total_online: [...names],
  };
  const site = createSite({ board: [['A', 10]], ranks });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();

  site.state.ranks = {
    kill: ['P1', 'P3', 'P4', 'P2', 'P5'],
    deathmatch: [...names],
    fame: [...names],
    total_online: [...names],
  };
  site.state.board = [['A', 12]];
  age(m);
  await m.poll();

  const down = m.events.find((e) => e.category === 'rank' && e.type === 'rank_down' && e.nickname === 'P2');
  assert.ok(down, 'P2 从第 2 掉到第 4 应记录 rank_down');
  assert.match(down.title, /跌出击杀榜前三（第 4 名）/);
  assert.match(down.detail, /第 2 → 第 4 名/);
});

test('issue#7: 三个日志 + 四个排行榜并行抓取', async (t) => {
  const dir = tempDataDir();
  const names = ['P1', 'P2', 'P3'];
  const site = createSite({
    board: [['A', 10]],
    ranks: { kill: [...names], deathmatch: [...names], fame: [...names], total_online: [...names] },
  });
  const slowKeys = ['fenlei:1', 'fenlei:2', 'fenlei:5', 'rank:kill', 'rank:deathmatch', 'rank:fame', 'rank:total_online'];
  for (const key of slowKeys) site.state.delayMs[key] = 150;
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  const started = Date.now();
  await m.poll();
  const used = Date.now() - started;

  assert.ok(site.stats.maxActive >= 7, `应有 7 个请求并发，实际最大并发 ${site.stats.maxActive}`);
  assert.ok(used < 900, `并行抓取耗时应明显低于串行（实际 ${used}ms）`);
});

test('issue#9: 单行坏 JSON 不会清空全部历史事件', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const file = path.join(dir, `events-${todayKey()}.jsonl`);
  const good = (name) => JSON.stringify({ at: '2026-11-06 01:00:00', category: 'online', type: 'online', nickname: name, title: `${name} 上线` });
  fs.writeFileSync(file, [good('A'), '{ this is not json', 'null', '123', good('B')].join('\n') + '\n');

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  assert.equal(m.badEventLines, 3);
  assert.deepEqual(m.events.map((e) => e.nickname), ['B', 'A']);
});

test('跨天重启：加载到昨天状态后，第一次成功 poll 补发跨天事件', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 5]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      date: '2000-01-01',
      round: 7,
      updatedAt: new Date().toISOString(),
      players: { Ghost: { minutes: 99, seconds: 5940, status: 'online' } },
      board: ['Ghost'],
    }),
  );
  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  assert.equal(m.pendingRestart, true);
  assert.equal(m.status().players.length, 0, '旧日期玩家不应复活');
  await m.poll();
  const ev = m.events.find((e) => e.type === 'restart');
  assert.ok(ev, '重启后第一次 poll 应补发跨天事件');
  assert.match(ev.title, /检测到跨天/);
  assert.equal(m.pendingRestart, false);
});

test('issue#9: 超过保留天数的数据文件会被清理（只读 CLI 不清理）', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const oldEvent = 'events-2020-01-01.jsonl';
  const oldSnap = 'snapshots-2020-01-01.jsonl';
  for (const name of [oldEvent, oldSnap, 'events-2026-11-01.jsonl', 'state.json']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  const removed = pruneOldData(dir, { days: 14, now: new Date('2026-11-06T12:00:00') });
  assert.equal(removed, 2);
  assert.equal(fs.existsSync(path.join(dir, 'events-2026-11-01.jsonl')), true);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), true);

  // 只读的 status.mjs 不应删数据
  fs.writeFileSync(path.join(dir, 'events-2019-01-01.jsonl'), '');
  new Monitor({ dataDir: dir, intervalSec: 120, pruneData: false });
  assert.equal(fs.existsSync(path.join(dir, 'events-2019-01-01.jsonl')), true, 'pruneData:false 不应删除旧文件');
  new Monitor({ dataDir: dir, intervalSec: 120 });
  assert.equal(fs.existsSync(path.join(dir, 'events-2019-01-01.jsonl')), false, '正常启动应清理旧文件');
});

test('issue#11/13: status 计数与 UI 口径一致，并提供现成时长文案', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10], ['B', 10]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();
  let s = m.status();
  assert.equal(s.counts.total, 2);
  assert.equal(s.counts.new, 2);
  assert.equal(s.counts.online, 2, '在线卡片应包含新上榜，与列表一致');
  assert.equal(s.counts.strictOnline, 0);
  assert.equal(s.players[0].durationText, '10分');
  assert.equal(s.eventCounts, undefined);
  assert.equal(s.elapsed, undefined);

  site.state.board = [['A', 12], ['B', 10]];
  age(m);
  await m.poll();
  s = m.status();
  assert.equal(s.counts.online, 1);
  assert.equal(s.counts.new, 0);
  assert.equal(s.counts.idle, 1);
  assert.equal(s.players.find((p) => p.name === 'A').status, 'online');
});

test('issue#7: 调度按固定节拍推进，抓取耗时不会累加到检测频率', async (t) => {
  const dir = tempDataDir();
  const m = new Monitor({ dataDir: dir, intervalSec: 61 });
  t.after(() => {
    m.stop();
    removeDir(dir);
  });
  m.running = true;
  let polls = 0;
  m.poll = async () => {
    polls++;
    await new Promise((r) => setTimeout(r, 40));
    return { ok: true };
  };
  const started = Date.now();
  await m._tick();
  assert.equal(polls, 1);
  const gap = m.nextPollAt - started;
  assert.ok(gap >= 61_000 && gap < 61_400, `下一轮应基于本轮开始时间 + 61s（实际 ${gap}ms）`);
});

test('跨天：排行榜基线重置，避免用昨天的名次误报涨跌', async (t) => {
  const dir = tempDataDir();
  const names = ['P1', 'P2', 'P3'];
  const site = createSite({
    board: [['A', 10]],
    ranks: { kill: [...names], deathmatch: [...names], fame: [...names], total_online: [...names] },
  });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();
  assert.equal(m.baselines.ranks.kill, true);

  m.state.date = '2000-01-01';
  site.state.board = [['A', 12]];
  site.state.ranks.kill = ['P2', 'P1', 'P3'];
  age(m);
  await m.poll();

  assert.equal(m.events.filter((e) => e.category === 'rank').length, 0, '跨天首轮不应产生榜单涨跌事件');
  assert.equal(m.baselines.ranks.kill, true, '跨天后重新建立基线');
});

test('跨天：检测到跨天时重建基线并记录系统事件', async (t) => {
  const dir = tempDataDir();
  const site = createSite({ board: [['A', 10]] });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 120 });
  await m.poll();
  // 模拟进程跨过零点：state 仍是昨天的日期和玩家
  m.state.date = '2000-01-01';
  m.state.round = 9;
  site.state.board = [['A', 1]];
  age(m);
  const r = await m.poll();

  assert.equal(r.ok, true);
  assert.equal(m.state.date, todayKey());
  assert.equal(m.state.round, 1, '跨天重建基线后轮次从 1 开始');
  const ev = m.events.find((e) => e.type === 'restart');
  assert.ok(ev);
  assert.match(ev.title, /检测到跨天/);
  assert.equal(m.state.players.A.status, 'new');
});

test('原始数据：全部来源的完整字段落盘，重复记录只存一次', async (t) => {
  const dir = tempDataDir();
  const site = createSite({
    board: [['A', 10], ['B', 10]],
    kill: [{
      Gametime: '18:51:28', Killcoordinate: '', Killersteamid: '111',
      Killername: 'A', Victimcoordinate: '', Victimername: 'B', Victimersteamid: '222',
      Weapon: '简易地雷', WeaponCode: 'Mine_C [Explosion]', distance: '2480',
      logtime: '2026-11-07 22:51:06',
    }],
    unlock: [{
      Attempts: '3', complete: '成功', completeText: '成功', locktype: 'Basic',
      locktypeText: '基础铁锁', logtime: '2026-11-07 22:52:00', name: 'A', number: '22',
      ownerName: 'B', ownerSteamid: '222', second: '12.5', steamid: '111',
      target: 'BP_Door_C', targetText: '门锁',
    }],
    risk: [{ endTime: '', name: 'C', publicReason: '联合风控', startTime: '2026-11-07 01:00:00', steamid: '333' }],
    vehicle: [{
      Operationtype: 'Disappeared', VehicleID: '1001', Vehicletype: 'WolfsWagen_ES',
      carownerSteamid: '111', carownername: 'A', carownernumber: '1',
      coordinate: 'X=1 Y=2 Z=3', logtime: '2026-11-07 22:53:00',
    }],
    bunkerStatus: [{ Bunkername: 'D1', Bunkerstatus: 'Active', BunkerstatusText: '激活中', logtime: '2026-11-07 22:00:48' }],
    bunkerUnlock: [{
      Numberfailures: '0', Operationresult: 'Yes', OperationresultText: '解锁成功',
      logtime: '2026-11-07 22:54:00', name: 'A', steamid: '111', time: '36.7',
    }],
    ranks: { kill: ['A', 'B'], deathmatch: ['A'], fame: ['A'], total_online: ['A'] },
  });
  const restore = site.install();
  t.after(() => {
    restore();
    removeDir(dir);
  });

  const m = new Monitor({ dataDir: dir, intervalSec: 61 });
  await m.poll();
  const date = todayKey();
  let meta = readRecordMeta(dir, date);
  assert.equal(meta.sources.kill, 1);
  assert.equal(meta.sources.unlock, 1);
  assert.equal(meta.sources.ban, 1);
  assert.equal(meta.sources.vehicle, 1);
  assert.equal(meta.sources.bunker_status, 1);
  assert.equal(meta.sources.bunker_unlock, 1);
  assert.equal(meta.sources.switches, 1);
  assert.equal(meta.ranks, 1, '每轮应写一份 5 个排行榜的快照');

  // 完整字段必须原样保留，不能只剩摘要
  const kill = readRecords(dir, date, { source: 'kill' }).items[0];
  assert.equal(kill.data.Killersteamid, '111');
  assert.equal(kill.data.Victimersteamid, '222');
  const unlock = readRecords(dir, date, { source: 'unlock' }).items[0];
  assert.equal(unlock.data.ownerSteamid, '222');

  const ranks = readRankSnapshots(dir, date, { type: 'today_online' });
  assert.equal(ranks.total, 1);
  assert.equal(ranks.items[0].rows.length, 2);

  // 第二轮同样的记录不应重复落盘，但排行榜快照会继续追加
  site.state.board = [['A', 12], ['B', 10]];
  age(m);
  await m.poll();
  meta = readRecordMeta(dir, date);
  assert.equal(meta.sources.kill, 1);
  assert.equal(meta.sources.vehicle, 1);
  assert.equal(meta.ranks, 2);
});

test('全新解压：data 目录不存在时也能创建单实例锁并启动', (t) => {
  const dir = tempDataDir();
  t.after(() => removeDir(dir));
  const fresh = path.join(dir, 'data');
  assert.equal(fs.existsSync(fresh), false, '前置条件：data 目录还不存在');

  const lock = acquireLock(fresh);
  assert.equal(lock.ok, true);
  assert.equal(fs.existsSync(path.join(fresh, 'monitor.lock')), true);

  releaseLock(fresh);
  assert.equal(fs.existsSync(path.join(fresh, 'monitor.lock')), false);
});

test('scum 工具函数：时长解析与差异判定', () => {
  assert.equal(fmtDuration(600), '10分');
  assert.equal(fmtDuration(3660), '1小时1分');
  assert.equal(fmtDuration(90000), '1天1小时0分');
  assert.equal(parseMinutes('19小时27分钟'), 19 * 60 + 27);
  assert.equal(parseMinutes('1天23小时'), 47 * 60);
  assert.equal(parseMinutes('', 120), 2);
  const rows = diffSnapshots(new Map([['A', 600], ['B', 600]]), new Map([['A', 720], ['C', 300]]));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [['A', 'online'], ['C', 'new'], ['B', 'dropped']]);
});
