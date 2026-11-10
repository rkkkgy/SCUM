import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

export const CONFIG = {
  site: 'http://1199.scum8.com',
  port: 9333,
  chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  profileDir: path.join(ROOT, '.chrome-profile'),
  // 可用 SCUM_DATA_DIR 指向临时目录（测试/多实例时避免污染正式数据）
  dataDir: process.env.SCUM_DATA_DIR ? path.resolve(process.env.SCUM_DATA_DIR) : path.join(ROOT, 'data'),
  // 登录脚本的诊断输出（截图、页面状态）
  probeDir: path.join(ROOT, 'data', 'probe'),
  // 服务器在线人数页面（Steam 主列表的第三方镜像，用于和榜单识别数比对）
  // 只带地址的 URL 会自动跳到当前服务器名，改档/改名后不用跟着改
  serverPage: 'https://scumsa.com/servers/202.189.7.201-12102/',
};
