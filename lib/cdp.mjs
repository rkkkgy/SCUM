// 无第三方依赖的 Chrome DevTools Protocol 小工具（Node 24 自带 WebSocket / fetch）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PORT = 9333;

/** 探测指定端口上是否已有开启调试端口的 Chrome */
export async function cdpVersion(port = DEFAULT_PORT, timeout = 1200) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** 启动一个独立的 Chrome 实例（独立用户目录，登录状态可持久保存） */
export function launchChrome({ chromePath, profileDir, port = DEFAULT_PORT, startUrl, headless = false }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--no-service-autorun',
    '--password-store=basic',
    '--lang=zh-CN',
    '--window-size=1440,900',
  ];
  if (headless) args.push('--headless=new');
  args.push(startUrl || 'about:blank');

  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

export async function waitForChrome(port = DEFAULT_PORT, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await cdpVersion(port);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome 调试端口 ${port} 在 ${timeoutMs}ms 内没有就绪`);
}

export async function listTargets(port = DEFAULT_PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  return r.json();
}

/** 找到一个页面 target；没有就新建一个 */
export async function ensurePage(port = DEFAULT_PORT, url = 'about:blank') {
  const targets = await listTargets(port);
  const pages = targets.filter((t) => t.type === 'page');
  // 优先复用已经打开的站点页面
  const site = pages.find((p) => /scum8\.com/.test(p.url));
  if (site) return site;
  if (pages.length) return pages[0];
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5000),
  });
  return r.json();
}

/** 极简 CDP 客户端 */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl, timeoutMs = 15000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`连接 CDP 失败: ${e?.message || 'unknown'}`));
      });
    });
    return new CDP(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待事件 ${method} 超时`)), timeoutMs);
      this.on(method, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export async function openPage(port = DEFAULT_PORT) {
  const target = await ensurePage(port);
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Runtime.enable').catch(() => {});
  return { cdp, target };
}

export async function evaluate(cdp, expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || '页面内脚本执行失败');
  }
  return r.result?.value;
}

export async function navigate(cdp, url, { waitMs = 1500 } = {}) {
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, waitMs));
}

export async function screenshot(cdp, outFile) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(data, 'base64'));
  return outFile;
}

export async function bringToFront(cdp) {
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

/** 抓取当前页面可见文本、标题、URL */
export async function pageSnapshot(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const pick = (sels) => {
        for (const s of sels) { const el = document.querySelector(s); if (el && el.innerText && el.innerText.trim()) return el.innerText.trim(); }
        return null;
      };
      return {
        url: location.href,
        title: document.title,
        ready: document.readyState,
        bodyText: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 6000),
        localKeys: Object.keys(localStorage || {}),
        sessionKeys: Object.keys(sessionStorage || {}),
        cookieNames: (document.cookie || '').split(';').map(s => s.split('=')[0].trim()).filter(Boolean),
      };
    })()`,
  );
}
