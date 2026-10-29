'use strict';

// 有官方命令行的 Agent（Claude Code、Codex）：用它自己的 `mcp add / remove / get` 注册，不直接改它的配置文件
// （Claude Code 运行时会不停重写 ~/.claude.json，直接改容易被它覆盖或互相踩）。
// exec(cmd, args) → { code, stdout, stderr }；测试里换成假的，不跑真命令。

const cp = require('child_process');

function norm(s) {
  return String(s || '').replace(/\\/g, '/').toLowerCase();
}

// Windows 上 claude / codex 是 npm 装的 .cmd，只能经 cmd.exe 跑 → 每个参数自己加引号（路径里有空格 / 中文）
function quoteWin(a) {
  return '"' + String(a).replace(/"/g, '""') + '"';
}

// opts.shell：默认 Windows 走 cmd.exe（.cmd 外壳要它）；直接跑 .exe（比如 python.exe）时传 false，参数由 Node 自己转义
// opts.env：额外环境变量（测试里给 Hermes 指临时 HERMES_HOME）
function defaultExec(cmd, args, opts) {
  const o = opts || {};
  const shell = o.shell != null ? o.shell : process.platform === 'win32';
  const env = o.env ? Object.assign({}, process.env, o.env) : process.env;
  const r = cp.spawnSync(shell ? quoteWin(cmd) : cmd, shell ? args.map(quoteWin) : args,
    { shell, env, encoding: 'utf8', timeout: o.timeout || 30000, windowsHide: true });
  return { code: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? r.error.message : '') };
}

// supports(run)：可选。装了但这个版本没有 MCP 命令 → false → skipped / unsupported_version（什么都不写）
function cliClient({ id, label, bin, addArgs, removeArgs, getArgs, isMissing, supports }) {
  function register(manifest, env, exec) {
    const run = exec || (env && env.exec) || defaultExec;
    const probe = run(bin, ['--version']);
    if (probe.code !== 0) return { client: id, status: 'skipped', reason: 'not_installed' };
    if (supports && !supports(run)) return { client: id, status: 'skipped', reason: 'unsupported_version' };
    try {
      const got = run(bin, getArgs(manifest.name));
      const text = got.stdout + '\n' + got.stderr;
      const had = got.code === 0 && !isMissing(text);
      if (had && norm(text).includes(norm(manifest.command)) && manifest.args.every((a) => norm(text).includes(norm(a)))) {
        return { client: id, status: 'unchanged' };
      }
      if (had) run(bin, removeArgs(manifest.name));
      const add = run(bin, addArgs(manifest));
      if (add.code !== 0) {
        return { client: id, status: 'failed', code: 'AGENT_CONFIG_WRITE_FAILED', error: (add.stderr || add.stdout).trim().slice(0, 300) };
      }
      return { client: id, status: had ? 'updated' : 'installed' };
    } catch (e) {
      return { client: id, status: 'failed', code: 'AGENT_CONFIG_WRITE_FAILED', error: e.message };
    }
  }
  return { id, label, register };
}

module.exports = { cliClient, defaultExec, quoteWin };
