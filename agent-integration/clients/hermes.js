'use strict';

// Hermes（Nous Research）：配置是一个很大的 YAML（HERMES_HOME/config.yaml 的 mcp_servers）。
//   `hermes mcp add` 会先连服务、再问「要不要全部启用」，没人回答就取消 —— 开机自动跑用不了；
//   `hermes config set` 写不了列表（args）。所以借 Hermes 自己的 Python 环境，调它保存 MCP 配置的那个函数
//   （hermes_cli.mcp_config._save_mcp_server：用 Hermes 自己的 load_config / save_config 读写 YAML）。
//   导不进来（Hermes 改版了）→ unsupported_version，什么都不写。
// exec(cmd, args, opts) 同 cli-client；env.hermesEnv：额外环境变量（测试里指临时 HERMES_HOME）。

const fs = require('fs');
const path = require('path');
const { defaultExec } = require('./cli-client');

const PY = [
  'import json, sys',
  'try:',
  '    from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server',
  'except Exception as e:',
  '    print(json.dumps({"status": "unsupported", "error": str(e)})); sys.exit(0)',
  'want = json.loads(sys.argv[1]); name = want.pop("__name")',
  'cur = _get_mcp_servers().get(name)',
  'if isinstance(cur, dict) and all(cur.get(k) == v for k, v in want.items()):',
  '    print(json.dumps({"status": "unchanged"}))',
  'else:',
  '    merged = dict(cur) if isinstance(cur, dict) else {}',
  '    merged.update(want)',
  '    _save_mcp_server(name, merged)',
  '    print(json.dumps({"status": "updated" if isinstance(cur, dict) else "installed"}))'
].join('\n');

// 2026-10-22（用户 Mac 实测 Hermes「没发现封面制作器的 server」）：Mac / Linux 上 `which hermes` 给的常是
//   ~/.local/bin/hermes 这个软链，真身在 ~/.hermes/hermes-agent/venv/bin/hermes，Python 在真身旁边 →
//   依次找：hermes 旁边 → 软链真身旁边 → 脚本第一行 #! 写的那个 Python。
function readHeadDefault(p) {
  try { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(512); const n = fs.readSync(fd, b, 0, 512, 0); fs.closeSync(fd); return b.slice(0, n).toString('utf8'); } catch (e) { return ''; }
}
function pythonNextTo(bin, e) {
  const exists = e.fileExists || fs.existsSync;
  const realpath = e.realpath || ((p) => { try { return fs.realpathSync(p); } catch (err) { return p; } });
  const readHead = e.readHead || readHeadDefault;
  const win = (e.platform || process.platform) === 'win32';
  const names = win ? ['python.exe'] : ['python3', 'python'];
  const dirs = [path.dirname(bin)];
  const real = realpath(bin);
  if (real && real !== bin) dirs.push(path.dirname(real));
  const cands = [];
  dirs.forEach((d) => names.forEach((n) => cands.push(path.join(d, n))));
  if (!win) {
    [bin, real].forEach((p) => {
      const m = /^#!\s*(\S+)/.exec(String(readHead(p) || ''));
      if (m && /python/i.test(path.basename(m[1]))) cands.push(m[1]);
    });
  }
  return cands.find((p) => exists(p)) || null;
}

function register(manifest, env, exec) {
  const run = exec || defaultExec;
  const e = env || {};
  const where = run(process.platform === 'win32' ? 'where' : 'which', ['hermes']);
  const bin = where.code === 0 ? String(where.stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean) : null;
  if (!bin) return { client: 'hermes', status: 'skipped', reason: 'not_installed' };
  const py = pythonNextTo(bin, e);
  if (!py) return { client: 'hermes', status: 'skipped', reason: 'unsupported_version', error: '找不到 Hermes 自带的 Python：' + path.dirname(bin) };
  const want = { __name: manifest.name, command: manifest.command, args: manifest.args.slice(),
                 enabled: true, timeout: manifest.timeout, connect_timeout: manifest.connectTimeout };
  const r = run(py, ['-c', PY, JSON.stringify(want)], { shell: false, env: e.hermesEnv, timeout: 60000 });
  let out = null;
  try { out = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch (err) { out = null; }
  if (r.code !== 0 || !out) {
    return { client: 'hermes', status: 'failed', code: 'AGENT_CONFIG_WRITE_FAILED', error: (r.stderr || r.stdout || '').trim().slice(-300) };
  }
  if (out.status === 'unsupported') return { client: 'hermes', status: 'skipped', reason: 'unsupported_version', error: out.error };
  return { client: 'hermes', status: out.status };
}

module.exports = { id: 'hermes', label: 'Hermes', register, PY };
