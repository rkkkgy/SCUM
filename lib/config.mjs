import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

export const CONFIG = {
  site: 'http://1199.scum8.com',
  // 登录后能看到“今日在线时间榜”的页面
  boardUrl: 'https://1199.scum8.com/publicdata.html?view=ranking',
  port: 9333,
  chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  profileDir: path.join(ROOT, '.chrome-profile'),
  dataDir: path.join(ROOT, 'data'),
  // 登录脚本的诊断输出（截图、页面状态）
  probeDir: path.join(ROOT, 'data', 'probe'),
};
