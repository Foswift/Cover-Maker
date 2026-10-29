'use strict';

// Mac 上自动接入 Agent 的两个坑（用户 2026-10-22「为什么我在mac上测试agent说没有mcp接口」，包是直接传到 Mac 上的）：
//   ① App Translocation：从网上 / 微信 / AirDrop 传来的、没公证的 .app 直接双击，macOS 会把它挪到一个随机的临时只读目录里跑
//      （/private/var/folders/…/AppTranslocation/…）。这时 process.execPath 是临时路径，写进 Agent 配置后软件一关就失效
//      → Agent 启动不了封面制作器 =「没有 MCP」。判断出来就不写配置、提示用户挪进「应用程序」。
//   ② 从 Finder 打开的软件拿不到终端里的 PATH（brew / npm / nvm / Claude Code 自己装的命令都不在）→ 找不到 claude / codex / hermes / openclaw。
//      先问登录 shell 要一份真实 PATH，再补一批常见目录。
// 纯函数为主（测试里直接喂假数据）。

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function isTranslocated(execPath) {
  return /\/AppTranslocation\//.test(String(execPath || ''));
}

const MARK = '__CM_PATH__';
// 登录 shell 打出来的 PATH 夹在标记中间（.zshrc 里有 echo 之类的输出也不怕）
function parseShellPath(out) {
  const s = String(out || '');
  const a = s.indexOf(MARK), b = a >= 0 ? s.indexOf(MARK, a + MARK.length) : -1;
  return a >= 0 && b > a ? s.slice(a + MARK.length, b).trim() : '';
}

function loginShellPath(exec) {
  const run = exec || ((cmd, args) => cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const shell = process.env.SHELL || '/bin/zsh';
  try { return parseShellPath(run(shell, ['-ilc', 'printf "%s%s%s" "' + MARK + '" "$PATH" "' + MARK + '"'])); } catch (e) { return ''; }
}

// 常见的命令安装位置（Mac / Linux）。nvm 每个 Node 版本一个 bin 目录，列出来
function extraToolDirs(home, readdir) {
  const ls = readdir || ((p) => { try { return fs.readdirSync(p); } catch (e) { return []; } });
  const dirs = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin',
    path.posix.join(home, '.local', 'bin'), path.posix.join(home, '.claude', 'local'), path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.volta', 'bin'), path.posix.join(home, '.bun', 'bin'), path.posix.join(home, '.hermes', 'bin')];
  const nvm = path.posix.join(home, '.nvm', 'versions', 'node');
  ls(nvm).slice().sort().reverse().forEach((v) => dirs.push(path.posix.join(nvm, v, 'bin')));
  return dirs;
}

// 当前 PATH + 登录 shell 的 PATH + 常见目录，去重、保持先后
function mergePath(current, shellPath, extra) {
  const out = [];
  [current, shellPath].forEach((s) => String(s || '').split(':').forEach((p) => { if (p && out.indexOf(p) < 0) out.push(p); }));
  (extra || []).forEach((p) => { if (p && out.indexOf(p) < 0) out.push(p); });
  return out.join(':');
}

module.exports = { isTranslocated, parseShellPath, loginShellPath, extraToolDirs, mergePath, MARK };
