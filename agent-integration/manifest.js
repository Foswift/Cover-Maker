'use strict';

// 所有 Agent 的配置都从这一份生成：启动命令 + 参数（数组，路径含中文 / 空格也不手工加引号）。
// 改了这里的结构就把 MANIFEST_VERSION + 1 —— 老用户下次启动会按新版本重新注册。

const MANIFEST_VERSION = 1;

function buildManifest({ isPackaged, execPath, appPath }) {
  return Object.freeze({
    name: 'cover-maker',
    transport: 'stdio',
    manifest_version: MANIFEST_VERSION,
    command: execPath,
    args: Object.freeze(isPackaged ? ['--mcp-stdio'] : [appPath, '--mcp-stdio']),
    timeout: 120,
    connectTimeout: 60
  });
}

module.exports = { buildManifest, MANIFEST_VERSION };
