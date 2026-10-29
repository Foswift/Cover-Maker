'use strict';

// Cherry Studio：MCP 设置存在它自己的数据库里，没有能改的配置文件；官方只给了安装链接
//   cherrystudio://mcp/install?servers=<base64(JSON)>，打开后 Cherry Studio 弹「审核 / 确认」，用户点了才装上。
//   所以这里只「生成链接」：注册器把它交给主进程用系统打开（status = needs_open）。
//   同一个启动命令只弹一次（看上次的注册记录 env.prev）—— 软件换了位置才再弹。
const fs = require('fs');
const path = require('path');

function paths(env) {
  return { dir: path.join(env.appData, 'CherryStudio') };
}

function installUrl(manifest) {
  const payload = { mcpServers: { [manifest.name]: {
    name: '封面制作器', description: '给抖音 / 小红书 / B站等平台做视频封面', type: 'stdio',
    command: manifest.command, args: manifest.args.slice() } } };
  return 'cherrystudio://mcp/install?servers=' + encodeURIComponent(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'));
}

function register(manifest, env) {
  if (!fs.existsSync(paths(env).dir)) return { client: 'cherry-studio', status: 'skipped', reason: 'not_installed' };
  const prev = env.prev && env.prev['cherry-studio'];
  if (prev && (prev.status === 'needs_open' || prev.status === 'unchanged') && prev.command === manifest.command) {
    return { client: 'cherry-studio', status: 'unchanged', command: manifest.command };
  }
  return { client: 'cherry-studio', status: 'needs_open', url: installUrl(manifest), command: manifest.command };
}

module.exports = { id: 'cherry-studio', label: 'Cherry Studio', paths, register, installUrl };
