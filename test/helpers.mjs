// 测试辅助：临时数据目录、站点 fetch 桩、时间推进
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scum-test-'));
}

export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** 把 Monitor 的“上次判定时间”往前拨，绕过 61 秒的最小判定间隔 */
export function age(monitor, seconds = 62) {
  monitor.state.updatedAt = new Date(Date.now() - seconds * 1000).toISOString();
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function makeBoard(entries) {
  return {
    data: entries.map(([nickname, minutes]) => ({
      nickname,
      rank_value: minutes * 60,
      jinbilist: `${Math.floor(minutes / 60)}小时${minutes % 60}分钟`,
      membership_title: '',
    })),
  };
}

export function makeRankList(names) {
  return {
    data: names.map((nickname, i) => ({
      nickname,
      rank_value: 100 - i,
      jinbilist: `${20 - i}次`,
      membership_title: '',
    })),
  };
}

/**
 * 可变的站点桩：测试里直接改 site.state 控制下一轮返回。
 * handler 按 URL 区分今日榜 / 击杀 / 开锁 / 风控 / 排行榜。
 */
export function createSite(initial = {}) {
  const state = {
    board: [],
    kill: [],
    unlock: [],
    risk: [],
    ranks: {},
    fail: {},
    delayMs: {},
    ...initial,
  };
  const stats = { active: 0, maxActive: 0, calls: [] };

  async function handler(url) {
    const p = url.pathname;
    const fenlei = url.searchParams.get('fenlei');
    const key = fenlei === '4' ? `rank:${url.searchParams.get('rankingType')}` : `fenlei:${fenlei}`;
    stats.calls.push(key);
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      const delay = state.delayMs[key] || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (state.fail[key]) throw new Error(`stub failure: ${key}`);
      if (fenlei === '1') return jsonResponse({ success: true, data: state.kill });
      if (fenlei === '2') return jsonResponse({ success: true, data: state.unlock });
      if (fenlei === '5') return jsonResponse({ success: true, data: state.risk });
      if (fenlei === '4') {
        const type = url.searchParams.get('rankingType');
        if (type === 'today_online') return jsonResponse(makeBoard(state.board));
        return jsonResponse(makeRankList(state.ranks[type] || []));
      }
      return jsonResponse({ error: 'not found' }, 404);
    } finally {
      stats.active--;
    }
  }

  const install = () => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, opts) => handler(new URL(String(url)), opts);
    return () => {
      globalThis.fetch = original;
    };
  };

  return { state, stats, handler, install };
}
