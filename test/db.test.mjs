import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let DatabaseSync = null;
let dbmod = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
  dbmod = await import('../lib/db.mjs');
} catch {
  // Node 20 没有 node:sqlite；跳过数据库测试，监控本身仍可用
}
const skipDb = dbmod ? false : '需要 Node.js 22.5+ 的 node:sqlite';
const { importJsonl, openDatabase, parseTimestamp, parseCoordinates, localDateOf } = dbmod || {};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scum-db-'));
}

function writeJsonl(dir, name, rows) {
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function fixture(dir) {
  const at = '2026-11-12 23:00:00';
  const ts = '2026-11-12T15:00:00.000Z';
  writeJsonl(dir, 'events-2026-11-12', [{
    at, ts, nickname: 'A', type: 'online', minutes: 10, delta: 5,
    category: 'online', title: '上线', detail: 'A 上线', seconds: 600,
  }]);
  writeJsonl(dir, 'records-2026-11-12', [{
    at, ts, source: 'kill', key: '2026-11-12 23:00:00|A|B|AK',
    data: {
      logtime: at, Gametime: '01:00:00', Killername: 'A', Killersteamid: '76561198749602331',
      Victimername: 'B', Victimersteamid: '76561199321767465', Weapon: 'AK', distance: '2',
    },
  }]);
  writeJsonl(dir, 'ranks-2026-11-12', [{
    at, ts, boards: { today_online: [[1, 'A', 600, '10分钟', '']] },
  }]);
  writeJsonl(dir, 'snapshots-2026-11-12', [{
    at, ts, via: 'http', items: [{ rank: 1, nickname: 'A', seconds: 600, text: '10分钟', title: '' }],
  }]);
  writeJsonl(dir, 'panel-2026-11-12', [{
    at, ts,
    overview: { online: 1, previous: 0, active24h: 3, killsToday: 1, lastLogTime: at, expiresAt: '2026-11-18T00:00:00+08:00' },
    online: [{
      time: at, ip: '1.2.3.4', steamid: '76561198749602331', gameName: 'A', type: 'login',
      location: 'X=100 Y=200 Z=300', region: 'B1', isDrone: 0, content: 'login', isBot: 0, isBan: 0,
      serverId: null, uid: 1,
    }],
    logs: {},
  }]);
  writeJsonl(dir, 'panel-records-2026-11-12', [
    {
      at, ts, type: 'lock', key: 'lk1',
      data: {
        time: at, name: 'A', steamid: '76561198749602331', isSuccess: 1, elapsedTime: '12.5',
        failedAttempts: '2', target: 'Box', lockType: 'Advanced', ownerName: 'B',
        ownerSteamid: '76561199321767465', location: 'X=-1 Y=-2 Z=-3', region: 'B1',
        content: 'lock content', targetId: '9', serverId: 's1',
      },
    },
    {
      at, ts, type: 'bomb', key: 'bm1',
      data: {
        time: at, name: 'A', steamid: '76561198749602331', isSuccess: 0, elapsedTime: '3.2',
        failedAttempts: '0', target: 'Vest', minigameType: 'BP_BombDefusalMinigame_C',
        ownerName: 'World', ownerSteamid: 'N/A', location: '1 2 3', region: 'B2', content: 'bomb',
      },
    },
    {
      at, ts, type: 'kill', key: 'k1',
      data: {
        time: at, weapon: 'AK', timeOfDayText: '01:00:00', serverDistance: 2, clientDistance: 2,
        region: 'B1', killerServerLocation: '10 20 30', victimServerLocation: '11 21 31',
        killerIsGameEvent: 0, killerName: 'A', killerSteamid: '76561198749602331',
        killerHasImmortality: 0, victimName: 'B', victimSteamid: '76561199321767465',
        victimIsGameEvent: 0, context: '2026.11.12-23.00.00: {"Killer":{"ProfileName":"A"}}',
        serverId: 's1',
      },
    },
    {
      at, ts, type: 'vehicle', key: 'shared-uid',
      data: {
        time: at, type: 'Disappeared', typeText: '消失', vehicle: 'Dirtbike_ES', vehicleId: '1',
        owner: 'B', ownerName: 'B', ownerSteamid: '76561199321767465', location: '1 2 3',
        region: 'B1', content: 'v1', serverId: 's1', uid: 1,
      },
    },
    {
      at, ts, type: 'vehicle', key: 'shared-uid',
      data: {
        time: '2026-11-12 23:01:00', type: 'Destroyed', typeText: '已损毁', vehicle: 'WolfsWagen_ES',
        vehicleId: '2', owner: 'B', ownerName: 'B', ownerSteamid: '76561199321767465',
        location: '4 5 6', region: 'B1', content: 'v2', serverId: 's1', uid: 1,
      },
    },
    {
      at, ts, type: 'admin', key: 'ad1',
      data: { time: at, steamId: '76561198749602331', game_name: 'A', defaultCode: 'announce x', code: '公告 x' },
    },
  ]);
  writeJsonl(dir, 'compare-2026-11-12', [{
    at, ts,
    old: {
      available: true, updatedAt: ts, lastPollAt: ts, online: 1, strictOnline: 1, new: 0, idle: 0,
      total: 1, serverOnline: 2, names: ['A'], strictNames: ['A'],
      events: { kill: 1 }, records: { vehicle: 1 },
    },
    new: {
      online: 1, rosterCount: 1, active24h: 3, killsToday: 1, lastLogTime: at,
      logs: { lock: 1, bomb: 1, kill: 1, vehicle: 2, admin: 1 }, names: ['A'],
    },
    diff: { online: 0, strict: 0, server: -1, kill: 0, unlock: 0, recordsKill: 0, recordsUnlock: 0, recordsVehicle: 1 },
    details: {
      missingInOld: [{ name: 'C', steamid: '76561199823261066', ip: '5.6.7.8', region: 'C1', location: '7 8 9', loginAt: at }],
      missingStrict: [],
      extraInOld: [{ name: 'D', status: 'idle', minutes: 1 }],
    },
    notes: ['test'],
  }]);
}

test('时间/坐标转换：本地时间按 +08:00 转 UTC', { skip: skipDb }, () => {
  assert.equal(parseTimestamp('2026-11-12 23:00:00'), '2026-11-12T15:00:00.000Z');
  assert.equal(parseTimestamp('2026-11-12T15:00:00.000Z'), '2026-11-12T15:00:00.000Z');
  assert.equal(localDateOf('2026-11-12T15:00:00.000Z'), '2026-11-12');
  assert.deepEqual(parseCoordinates('X=-1 Y=2 Z=3.5'), [-1, 2, 3.5]);
  assert.equal(parseCoordinates('bad'), null);
});

test('导入 JSONL：规范化表、子表、视图、玩家维度和幂等', { skip: skipDb }, () => {
  const dir = tmpDir();
  try {
    fixture(dir);
    const first = importJsonl({ dataDir: dir });
    assert.deepEqual(first.errors, []);
    assert.equal(first.files, 7);
    assert.equal(first.counts.events, 1);
    assert.equal(first.counts.records, 1);
    assert.equal(first.counts.ranking_snapshots, 1);
    assert.equal(first.counts.rank_entries, 1);
    assert.equal(first.counts.board_snapshots, 1);
    assert.equal(first.counts.board_entries, 1);
    assert.equal(first.counts.panel_snapshots, 1);
    assert.equal(first.counts.panel_online_players, 1);
    assert.equal(first.counts.panel_lock_logs, 1);
    assert.equal(first.counts.panel_bomb_logs, 1);
    assert.equal(first.counts.panel_kill_logs, 1);
    assert.equal(first.counts.panel_vehicle_logs, 2);
    assert.equal(first.counts.panel_admin_logs, 1);
    assert.equal(first.counts.compare_snapshots, 1);
    assert.equal(first.counts.compare_missing_players, 1);
    assert.equal(first.counts.compare_extra_players, 1);
    assert.ok(first.counts.players >= 3);

    const dbPath = path.join(dir, 'monitor.db');
    const db = openDatabase({ dataDir: dir, dbPath });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v_panel_logs').get().n, 6);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v_latest_panel_online').get().n, 1);
      assert.equal(db.prepare('SELECT context_json IS NOT NULL AS ok FROM panel_kill_logs').get().ok, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rank_entries WHERE board_type = ?').get('today_online').n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM player_names WHERE name = ?').get('A').n, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      db.close();
    }

    const second = importJsonl({ dataDir: dir });
    assert.deepEqual(second.errors, []);
    assert.equal(second.filesSkipped, 7);
    assert.equal(second.inserted, 0);
    assert.equal(second.counts.panel_vehicle_logs, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
