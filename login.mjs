// 第一步：打开 Chrome，让你手动登录。登录状态保存在独立用户目录，后续复用。
import fs from 'node:fs';
import path from 'node:path';
import {
  launchChrome, waitForChrome, cdpVersion, openPage, navigate,
  bringToFront, pageSnapshot, screenshot,
} from './lib/cdp.mjs';
import { CONFIG as CFG } from './lib/config.mjs';

const PORT = CFG.port;
fs.mkdirSync(CFG.probeDir, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  let version = await cdpVersion(PORT);
  if (!version) {
    log('启动 Chrome...', CFG.chromePath);
    launchChrome({
      chromePath: CFG.chromePath,
      profileDir: CFG.profileDir,
      port: PORT,
      startUrl: CFG.site + '/',
    });
    version = await waitForChrome(PORT, 60000);
  } else {
    log('复用已开启调试端口的 Chrome:', version.Browser);
  }
  log('Chrome 就绪:', version.Browser);

  const { cdp, target } = await openPage(PORT);
  if (!/scum8\.com/.test(target.url)) {
    await navigate(cdp, CFG.site + '/', { waitMs: 2500 });
  }
  await bringToFront(cdp);
  log('已打开', CFG.site);
  log('请在这个 Chrome 窗口里完成登录（Steam / 微信 / QQ 等）。');
  log('登录成功后脚本会自动识别并退出，浏览器保持打开。');

  const deadline = Date.now() + 30 * 60 * 1000;
  let lastText = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    let snap;
    try {
      snap = await pageSnapshot(cdp);
    } catch {
      continue; // 页面正在跳转
    }
    const text = snap.bodyText || '';
    // 登录后导航栏会显示“玩家：xxx / 在线人数 / 退出登录”，未登录则是“登录/注册”
    const signedIn = /玩家[:：]\s*\S/.test(text) || /退出登录/.test(text);
    if (text !== lastText) {
      lastText = text;
      fs.writeFileSync(
        path.join(CFG.probeDir, 'login-status.json'),
        JSON.stringify({ at: new Date().toISOString(), signedIn, ...snap }, null, 2),
      );
      log('当前页面:', snap.url, signedIn ? '（已登录）' : '（未登录）');
    }
    if (signedIn) {
      log('LOGIN_OK 已登录:', snap.url);
      await screenshot(cdp, path.join(CFG.probeDir, 'after-login.png'));
      fs.writeFileSync(
        path.join(CFG.probeDir, 'login-detected.json'),
        JSON.stringify({ at: new Date().toISOString(), snap }, null, 2),
      );
      cdp.close();
      return;
    }
  }
  log('等待登录超时（30 分钟）。');
  cdp.close();
  process.exitCode = 2;
}

main().catch((e) => {
  console.error('失败:', e.stack || e.message);
  process.exit(1);
});
