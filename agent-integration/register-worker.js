'use strict';

// 在 Electron utilityProcess 里跑自动注册（main.js 的 runAgentRegister 起它）：
// 调 claude / codex 命令要同步等几秒，放主进程会卡住整个软件。
// 输入：process.argv 最后一个参数 = JSON { manifest, statePath, appVersion, envRoot?, cli }
// 输出：parentPort.postMessage({ ok, report }) 后退出。

const os = require('os');
const path = require('path');
const { buildManifest } = require('./manifest');
const { defaultEnv } = require('./detect');
const { registerClients } = require('./registry');

function withToolPaths() {
  // 从 Finder / 开始菜单打开的软件，PATH 里常常没有 npm / brew / nvm / Claude Code 装命令的目录 → 补上
  const home = os.homedir();
  if (process.platform === 'win32') {
    const extra = [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm')];
    const cur = String(process.env.PATH || process.env.Path || '').split(';');
    const merged = cur.concat(extra.filter((p) => cur.indexOf(p) < 0)).join(';');
    process.env.PATH = merged; process.env.Path = merged;
    return;
  }
  // Mac / Linux：先问登录 shell 要真实 PATH（用户终端里能用的命令这里也能用），再补常见目录（见 mac-env.js）
  const macEnv = require('./mac-env');
  process.env.PATH = macEnv.mergePath(process.env.PATH, macEnv.loginShellPath(), macEnv.extraToolDirs(home));
}

function main() {
  const input = JSON.parse(process.argv[process.argv.length - 1]);
  const manifest = buildManifest(input.manifest);
  let env;
  const { trae, traeCn } = require('./clients/trae');
  // 只看文件 / 目录的几家（自检的假 home 里也跑）；Cherry Studio 只生成安装链接，打不打开由主进程决定
  const adapters = [require('./clients/claude'), require('./clients/cursor'), require('./clients/vscode'), trae, traeCn, require('./clients/cherry-studio'), require('./clients/dsh')];
  if (input.envRoot) {
    // 自检：假 home / appData，只跑写 JSON 的那几家（绝不调真的 claude / codex 命令）
    env = { platform: process.platform, home: path.join(input.envRoot, 'home'), appData: path.join(input.envRoot, 'appdata') };
  } else {
    env = defaultEnv();
    if (input.cli !== false) {
      withToolPaths();
      adapters.push(require('./clients/claude-code'), require('./clients/codex'), require('./clients/hermes'), require('./clients/openclaw'));
    }
  }
  return registerClients({ adapters, manifest, env, statePath: input.statePath, appVersion: input.appVersion });
}

let result;
try { result = { ok: true, report: main() }; } catch (e) { result = { ok: false, error: e && e.message || String(e) }; }
if (process.parentPort) process.parentPort.postMessage(result);
else process.stdout.write(JSON.stringify(result) + '\n');
setTimeout(() => process.exit(0), 50);
