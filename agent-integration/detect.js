'use strict';

// 本机环境（各适配器按它拼配置路径）；测试里换成假的 home / appData。

const os = require('os');
const path = require('path');

function defaultEnv() {
  const platform = process.platform;
  const home = os.homedir();
  const appData = platform === 'win32'
    ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return { platform, home, appData, dshHome: process.env.DSH_HOME || undefined };
}

module.exports = { defaultEnv };
