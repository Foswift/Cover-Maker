'use strict';

// M249 Task 11~15：自动把封面制作器写进各家 Agent 的 MCP 配置。
// 全部在临时目录里跑（假的 home / appData），绝不碰本机真实的 Agent 配置。

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'agent-configs');

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-agent-reg-' + tag + '-'));
}
function readText(p) { return fs.readFileSync(p, 'utf8'); }
function backupsOf(p) {
  const dir = path.dirname(p);
  const base = path.basename(p);
  return fs.readdirSync(dir).filter((f) => f.startsWith(base + '.cover-maker.bak-'));
}

async function run() {
  const { readJson, writeJsonAtomic, restoreBackup } = require('../agent-integration/config-io');
  const { buildManifest, MANIFEST_VERSION } = require('../agent-integration/manifest');
  const { defaultEnv } = require('../agent-integration/detect');
  const claude = require('../agent-integration/clients/claude');
  const cursor = require('../agent-integration/clients/cursor');
  const vscode = require('../agent-integration/clients/vscode');
  const { registerClients, registerOne } = require('../agent-integration/registry');
  const claudeCode = require('../agent-integration/clients/claude-code');
  const codex = require('../agent-integration/clients/codex');
  const { quoteWin } = require('../agent-integration/clients/cli-client');

  // ---------- Task 11: config-io ----------
  {
    const dir = tmpDir('io');
    const target = path.join(dir, 'mcp.json');
    fs.copyFileSync(path.join(FIX, 'json-existing.json'), target);
    const before = readText(target);
    const r0 = readJson(target);
    assert.equal(r0.exists, true);
    assert.equal(r0.value.mcpServers.filesystem.command, 'npx');

    const next = JSON.parse(JSON.stringify(r0.value));
    next.mcpServers['cover-maker'] = { command: 'D:/新 路径/封面制作器.exe', args: ['--mcp-stdio'] };
    const w = writeJsonAtomic(target, next, (v) => v.mcpServers['cover-maker'].args[0] === '--mcp-stdio', { now: () => 1000 });
    assert.equal(w.created, false);
    assert.equal(path.dirname(w.backupPath), dir, 'backup sits next to the target');
    assert.equal(readText(w.backupPath), before, 'backup is the untouched original');
    const raw = fs.readFileSync(target);
    assert.notEqual(raw[0], 0xEF, 'UTF-8 without BOM');
    const after = JSON.parse(raw.toString('utf8'));
    assert.equal(after.globalShortcut, 'Ctrl+Space', 'unrelated settings survive');
    assert.equal(Object.keys(after.mcpServers).length, 2, 'existing entry updated, not duplicated');
    assert.equal(after.mcpServers['cover-maker'].command, 'D:/新 路径/封面制作器.exe');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'no temp files left behind');

    // validation failure → original content restored, error thrown
    const good = readText(target);
    assert.throws(() => writeJsonAtomic(target, { broken: true }, () => false, { now: () => 2000 }),
      (e) => e.code === 'AGENT_CONFIG_WRITE_FAILED');
    assert.equal(readText(target), good, 'restored after failed validation');

    restoreBackup(target, w.backupPath);
    assert.equal(readText(target), before);

    // only the newest 3 backups are kept
    for (let i = 0; i < 5; i += 1) writeJsonAtomic(target, { n: i }, null, { now: () => 3000 + i });
    assert.equal(backupsOf(target).length, 3);

    // missing / empty / broken files
    assert.deepEqual(readJson(path.join(dir, 'nope.json')), { exists: false, value: null });
    const empty = path.join(dir, 'empty.json');
    fs.copyFileSync(path.join(FIX, 'json-empty.json'), empty);
    assert.deepEqual(readJson(empty), { exists: true, value: {} });
    const bom = path.join(dir, 'bom.json');
    fs.writeFileSync(bom, '\uFEFF{"a":1}');
    assert.deepEqual(readJson(bom).value, { a: 1 });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ "a": 1, // comment\n }');
    assert.throws(() => readJson(bad), (e) => e.code === 'CONFIG_PARSE_FAILED', 'never overwrite a file we cannot parse');

    // brand-new file in a missing folder
    const fresh = path.join(dir, 'sub', 'dir', 'new.json');
    const wf = writeJsonAtomic(fresh, { x: 1 }, null, {});
    assert.equal(wf.created, true);
    assert.equal(wf.backupPath, null);
    assert.deepEqual(JSON.parse(readText(fresh)), { x: 1 });
  }

  // ---------- Task 12: manifest ----------
  {
    const packaged = buildManifest({ isPackaged: true, execPath: 'C:/Program Files/封面 制作器/封面制作器.exe', appPath: 'ignored' });
    assert.deepEqual(packaged, {
      name: 'cover-maker', transport: 'stdio', manifest_version: MANIFEST_VERSION,
      command: 'C:/Program Files/封面 制作器/封面制作器.exe', args: ['--mcp-stdio'],
      timeout: 120, connectTimeout: 60
    });
    const dev = buildManifest({ isPackaged: false, execPath: 'D:/x/electron.exe', appPath: 'D:/claw project/cover-maker' });
    assert.equal(dev.command, 'D:/x/electron.exe');
    assert.deepEqual(dev.args, ['D:/claw project/cover-maker', '--mcp-stdio'], 'paths stay as array items, never hand-quoted');
    assert.equal(Object.isFrozen(dev), true);
  }

  // ---------- Task 13: Claude Desktop / Cursor / VS Code ----------
  const manifest = buildManifest({ isPackaged: true, execPath: 'C:/Apps/封面制作器/封面制作器.exe', appPath: '' });
  function fakeEnv(platform) {
    const root = tmpDir('env-' + platform);
    const home = path.join(root, 'home');
    const appData = path.join(root, 'appdata');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(appData, { recursive: true });
    return { platform, home, appData };
  }
  {
    const win = { platform: 'win32', home: 'C:/Users/me', appData: 'C:/Users/me/AppData/Roaming' };
    const mac = { platform: 'darwin', home: '/Users/me', appData: '/Users/me/Library/Application Support' };
    const norm = (p) => p.replace(/\\/g, '/');
    assert.equal(norm(claude.paths(win).config), 'C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json');
    assert.equal(norm(cursor.paths(win).config), 'C:/Users/me/.cursor/mcp.json');
    assert.equal(norm(vscode.paths(win).config), 'C:/Users/me/AppData/Roaming/Code/User/mcp.json');
    assert.equal(norm(claude.paths(mac).config), '/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
    assert.equal(norm(cursor.paths(mac).config), '/Users/me/.cursor/mcp.json');
    assert.equal(norm(vscode.paths(mac).config), '/Users/me/Library/Application Support/Code/User/mcp.json');
    const d = defaultEnv();
    assert.ok(d.platform && d.home && d.appData);
  }
  for (const [adapter, fixture, key] of [[claude, 'claude.json', 'mcpServers'], [cursor, 'cursor.json', 'mcpServers'], [vscode, 'vscode.json', 'servers']]) {
    const env = fakeEnv(adapter.id);
    const p = adapter.paths(env);
    // not installed: no folder → skipped, nothing created
    const r0 = registerOne(adapter, manifest, env);
    assert.deepEqual(r0, { client: adapter.id, status: 'skipped', reason: 'not_installed' });
    assert.equal(fs.existsSync(p.config), false, adapter.id + ': nothing written for a missing client');
    // installed with an existing config → entry added, others kept
    fs.mkdirSync(p.dir, { recursive: true });
    fs.copyFileSync(path.join(FIX, fixture), p.config);
    const r1 = registerOne(adapter, manifest, env);
    assert.equal(r1.status, 'installed', JSON.stringify(r1));
    const v1 = JSON.parse(readText(p.config));
    assert.ok(v1[key].filesystem, adapter.id + ': other servers kept');
    assert.deepEqual(v1[key]['cover-maker'].args, ['--mcp-stdio']);
    assert.equal(v1[key]['cover-maker'].command, manifest.command);
    if (adapter === vscode) { assert.equal(v1[key]['cover-maker'].type, 'stdio'); assert.deepEqual(v1.inputs, []); }
    if (adapter === claude) assert.equal(v1.globalShortcut, 'Ctrl+Space');
    // second run: already correct → unchanged, no new backup
    const nBak = backupsOf(p.config).length;
    assert.equal(registerOne(adapter, manifest, env).status, 'unchanged');
    assert.equal(backupsOf(p.config).length, nBak, adapter.id + ': no extra backup when nothing changes');
    // app moved → updated in place
    const moved = buildManifest({ isPackaged: true, execPath: 'D:/新位置/封面制作器.exe', appPath: '' });
    assert.equal(registerOne(adapter, moved, env).status, 'updated');
    const v2 = JSON.parse(readText(p.config));
    assert.equal(v2[key]['cover-maker'].command, 'D:/新位置/封面制作器.exe');
    assert.equal(Object.keys(v2[key]).length, 2);
    // installed but config file not there yet → created
    fs.rmSync(p.config);
    assert.equal(registerOne(adapter, manifest, env).status, 'installed');
    // broken config → failed, file untouched
    fs.writeFileSync(p.config, '{ not json');
    const rb = registerOne(adapter, manifest, env);
    assert.equal(rb.status, 'failed');
    assert.equal(rb.code, 'AGENT_CONFIG_WRITE_FAILED');
    assert.equal(readText(p.config), '{ not json');
  }

  // ---------- CLI clients (Claude Code / Codex): fake exec, never the real commands ----------
  function fakeCli(state) {
    const calls = [];
    const exec = (bin, args) => {
      calls.push([bin].concat(args).join(' '));
      if (!state.installed) return { code: 1, stdout: '', stderr: 'not found' };
      if (args[0] === '--version') return { code: 0, stdout: '1.0.0', stderr: '' };
      const sub = args[1];
      if (sub === 'get') {
        if (!state.entry) return bin === 'claude' ? { code: 0, stdout: 'No MCP server named "cover-maker".', stderr: '' } : { code: 1, stdout: '', stderr: "Error: No MCP server named 'cover-maker' found." };
        return { code: 0, stdout: 'cover-maker:\n  Command: ' + state.entry.join(' ') + '\n', stderr: '' };
      }
      if (sub === 'remove') { state.entry = null; return { code: 0, stdout: 'removed', stderr: '' }; }
      if (sub === 'add') { if (state.failAdd) return { code: 1, stdout: '', stderr: 'permission denied' }; state.entry = args.slice(args.indexOf('--') + 1); return { code: 0, stdout: 'added', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unknown' };
    };
    return { calls, exec };
  }
  for (const adapter of [claudeCode, codex]) {
    const st = { installed: false, entry: null };
    const f = fakeCli(st);
    assert.deepEqual(adapter.register(manifest, {}, f.exec), { client: adapter.id, status: 'skipped', reason: 'not_installed' });
    st.installed = true;
    assert.equal(adapter.register(manifest, {}, f.exec).status, 'installed');
    assert.deepEqual(st.entry, [manifest.command, '--mcp-stdio']);
    const addCall = f.calls.find((c) => / mcp add /.test(c));
    if (adapter === claudeCode) assert.ok(addCall.includes(' -s user '), 'Claude Code registers at user scope');
    f.calls.length = 0;
    assert.equal(adapter.register(manifest, {}, f.exec).status, 'unchanged');
    assert.equal(f.calls.some((c) => / mcp (add|remove) /.test(c)), false, 'no writes when already registered');
    const moved = buildManifest({ isPackaged: true, execPath: 'D:/新位置/封面制作器.exe', appPath: '' });
    assert.equal(adapter.register(moved, {}, f.exec).status, 'updated');
    assert.deepEqual(st.entry, ['D:/新位置/封面制作器.exe', '--mcp-stdio']);
    st.failAdd = true; st.entry = null;
    const bad = adapter.register(manifest, {}, f.exec);
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /permission denied/);
  }
  assert.equal(quoteWin('C:/Program Files/封面 制作器/a.exe'), '"C:/Program Files/封面 制作器/a.exe"');
  assert.equal(quoteWin('say "hi"'), '"say ""hi"""');

  // ---------- Trae / Trae CN / Cherry Studio / Hermes ----------
  {
    const { trae, traeCn } = require('../agent-integration/clients/trae');
    const cherry = require('../agent-integration/clients/cherry-studio');
    const hermes = require('../agent-integration/clients/hermes');
    const norm = (p) => p.replace(/\\/g, '/');
    const win = { platform: 'win32', home: 'C:/Users/me', appData: 'C:/Users/me/AppData/Roaming' };
    assert.equal(norm(trae.paths(win).config), 'C:/Users/me/AppData/Roaming/Trae/User/mcp.json');
    assert.equal(norm(traeCn.paths(win).config), 'C:/Users/me/AppData/Roaming/Trae CN/User/mcp.json');

    // Trae: only the app folder exists (User/mcp.json not yet) → created with mcpServers
    for (const adapter of [trae, traeCn]) {
      const env = fakeEnv(adapter.id);
      assert.equal(registerOne(adapter, manifest, env).status, 'skipped');
      fs.mkdirSync(adapter.paths(env).dir, { recursive: true });
      assert.equal(registerOne(adapter, manifest, env).status, 'installed');
      const v = JSON.parse(readText(adapter.paths(env).config));
      assert.deepEqual(v.mcpServers['cover-maker'], { command: manifest.command, args: ['--mcp-stdio'] });
      assert.equal(registerOne(adapter, manifest, env).status, 'unchanged');
    }

    // Cherry Studio: link only, once per command
    {
      const env = fakeEnv('cherry');
      assert.equal(cherry.register(manifest, env).status, 'skipped');
      fs.mkdirSync(cherry.paths(env).dir, { recursive: true });
      const r = cherry.register(manifest, Object.assign({ prev: {} }, env));
      assert.equal(r.status, 'needs_open');
      assert.match(r.url, /^cherrystudio:\/\/mcp\/install\?servers=/);
      const payload = JSON.parse(Buffer.from(decodeURIComponent(r.url.split('servers=')[1]), 'base64').toString('utf8'));
      assert.deepEqual(payload.mcpServers['cover-maker'].args, ['--mcp-stdio']);
      assert.equal(payload.mcpServers['cover-maker'].type, 'stdio');
      assert.equal(payload.mcpServers['cover-maker'].command, manifest.command);
      const prev = { 'cherry-studio': { status: 'needs_open', command: manifest.command } };
      assert.equal(cherry.register(manifest, Object.assign({ prev }, env)).status, 'unchanged', 'do not pop the dialog again');
      const moved = buildManifest({ isPackaged: true, execPath: 'D:/新位置/封面制作器.exe', appPath: '' });
      assert.equal(cherry.register(moved, Object.assign({ prev }, env)).status, 'needs_open', 'app moved → offer again');

      // through the registry: url lands in open_urls, state remembers it, second run is quiet
      const statePath = path.join(tmpDir('cherry-state'), 'agent-registration.json');
      const r1 = registerClients({ adapters: [cherry], manifest, env, statePath, appVersion: '1.1.0' });
      assert.equal(r1.open_urls.length, 1);
      assert.equal(r1.open_urls[0].client, 'cherry-studio');
      const r2 = registerClients({ adapters: [cherry], manifest, env, statePath, appVersion: '1.1.0' });
      assert.deepEqual(r2.open_urls, []);
      assert.deepEqual(r2.unchanged, ['cherry-studio']);
    }

    // Hermes with a fake exec
    {
      const calls = [];
      const fakeExec = (state) => (cmd, args, opts) => {
        calls.push(cmd);
        if (cmd === 'where' || cmd === 'which') return state.installed ? { code: 0, stdout: 'C:/h/venv/Scripts/hermes.exe\r\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
        assert.equal(opts.shell, false, 'python.exe is spawned directly, not through cmd.exe');
        assert.equal(args[0], '-c');
        const want = JSON.parse(args[2]);
        assert.equal(want.__name, 'cover-maker');
        assert.deepEqual(want.args, ['--mcp-stdio']);
        assert.equal(want.enabled, true);
        return { code: 0, stdout: 'noise\n' + JSON.stringify({ status: state.answer }) + '\n', stderr: '' };
      };
      const env = { fileExists: (p) => /python(\.exe|3)?$/.test(p) };
      assert.equal(hermes.register(manifest, env, fakeExec({ installed: false })).reason, 'not_installed');
      assert.equal(hermes.register(manifest, env, fakeExec({ installed: true, answer: 'installed' })).status, 'installed');
      assert.equal(hermes.register(manifest, env, fakeExec({ installed: true, answer: 'unsupported' })).reason, 'unsupported_version');
      assert.equal(hermes.register(manifest, { fileExists: () => false }, fakeExec({ installed: true })).reason, 'unsupported_version');

      // 2026-10-22 用户 Mac 实测「Hermes 说没发现封面制作器的 server」：Mac 上 `which hermes` = ~/.local/bin/hermes（软链），
      //   真身在 ~/.hermes/hermes-agent/venv/bin/hermes，Python 在真身旁边 → 要跟着软链找；脚本第一行 #! 写的 Python 也要认
      const macExec = (stdout) => (cmd, args) => {
        if (cmd === 'where' || cmd === 'which') return { code: 0, stdout: stdout, stderr: '' };
        return { code: 0, stdout: JSON.stringify({ status: 'installed', py: cmd }) + '\n', stderr: '' };
      };
      const viaLink = { platform: 'darwin',
        realpath: (p) => (p === '/Users/u/.local/bin/hermes' ? '/Users/u/.hermes/hermes-agent/venv/bin/hermes' : p),
        readHead: () => '',
        fileExists: (p) => /hermes-agent[\\/]venv[\\/]bin[\\/]python3$/.test(p) };
      assert.equal(hermes.register(manifest, viaLink, macExec('/Users/u/.local/bin/hermes\n')).status, 'installed', 'Mac: hermes is a symlink → python next to the real file');
      const viaShebang = { platform: 'darwin', realpath: (p) => p,
        readHead: (p) => (p === '/Users/u/.local/bin/hermes' ? '#!/Users/u/.hermes/hermes-agent/venv/bin/python3.11\nimport sys\n' : ''),
        fileExists: (p) => /python3\.11$/.test(p) };
      assert.equal(hermes.register(manifest, viaShebang, macExec('/Users/u/.local/bin/hermes\n')).status, 'installed', 'Mac: python from the #! line of the hermes script');
    }

    // Hermes for real, but in a throw-away HERMES_HOME (only when Hermes is installed here)
    {
      const { defaultExec } = require('../agent-integration/clients/cli-client');
      const found = defaultExec(process.platform === 'win32' ? 'where' : 'which', ['hermes']);
      if (found.code === 0) {
        const home = tmpDir('hermes-home');
        const env = { hermesEnv: { HERMES_HOME: home } };
        const exec = (cmd, args, opts) => defaultExec(cmd, args, Object.assign({}, opts, { env: Object.assign({}, opts && opts.env, env.hermesEnv) }));
        const r1 = hermes.register(manifest, env, exec);
        assert.equal(r1.status, 'installed', JSON.stringify(r1));
        const yaml = readText(path.join(home, 'config.yaml'));
        assert.match(yaml, /mcp_servers:/);
        assert.match(yaml, /cover-maker:/);
        assert.match(yaml, /--mcp-stdio/);
        // PyYAML writes Chinese as \uXXXX escapes; "unchanged" proves Hermes reads the exact path back
        assert.equal(hermes.register(manifest, env, exec).status, 'unchanged');
        const moved = buildManifest({ isPackaged: true, execPath: 'D:/新位置/封面制作器.exe', appPath: '' });
        assert.equal(hermes.register(moved, env, exec).status, 'updated');
        assert.equal(hermes.register(moved, env, exec).status, 'unchanged');
        console.log('[agent-registry] hermes real write in temp HERMES_HOME: ok');
      } else {
        console.log('[agent-registry] hermes not installed here: real-write check skipped');
      }
    }
  }

  // ---------- DeepSeek Harness / OpenClaw ----------
  {
    const dsh = require('../agent-integration/clients/dsh');
    const openclaw = require('../agent-integration/clients/openclaw');

    // DeepSeek Harness: not installed → nothing created
    const env = fakeEnv('dsh');
    const p = dsh.paths(env);
    assert.equal(dsh.register(manifest, env).reason, 'not_installed');
    assert.equal(fs.existsSync(p.dir), false);
    // installed, no patch file yet → created with our block only
    fs.mkdirSync(p.dir, { recursive: true });
    assert.equal(dsh.register(manifest, env).status, 'installed');
    const t1 = readText(p.config);
    assert.ok(t1.startsWith(dsh.BEGIN));
    assert.match(t1, /- id: mcp-cover-maker/);
    assert.match(t1, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(t1, /command: "C:\/Apps\/封面制作器\/封面制作器\.exe"/);
    assert.match(t1, /args: \["--mcp-stdio"\]/);
    assert.equal(dsh.register(manifest, env).status, 'unchanged');
    // user's existing entries (CRLF file) are kept byte for byte, ours appended once
    const userPart = '# my settings\r\n- id: model\r\n  config:\r\n    name: deepseek-chat\r\n';
    fs.writeFileSync(p.config, userPart);
    assert.equal(dsh.register(manifest, env).status, 'installed');
    const t2 = readText(p.config);
    assert.ok(t2.startsWith(userPart.replace(/\s+$/, '')), 'user content untouched');
    assert.equal(t2.split(dsh.BEGIN).length, 2, 'block appears once');
    assert.ok(!/[^\r]\n/.test(t2), 'keeps the file\'s CRLF line endings');
    assert.equal(dsh.register(manifest, env).status, 'unchanged');
    // app moved → only our block is replaced
    const moved = buildManifest({ isPackaged: true, execPath: 'D:/新 位置/封面制作器.exe', appPath: '' });
    assert.equal(dsh.register(moved, env).status, 'updated');
    const t3 = readText(p.config);
    assert.ok(t3.startsWith(userPart.replace(/\s+$/, '')));
    assert.match(t3, /D:\/新 位置\/封面制作器\.exe/);
    assert.equal(t3.split(dsh.BEGIN).length, 2);
    assert.equal(dsh.register(moved, env).status, 'unchanged');
    // top level is a mapping → refuse, untouched
    fs.writeFileSync(p.config, 'plugins:\n  - id: x\n');
    assert.equal(dsh.register(manifest, env).status, 'failed');
    assert.equal(readText(p.config), 'plugins:\n  - id: x\n');
    // user wrote their own cover-maker entry → leave it alone
    fs.writeFileSync(p.config, "- id: mcp-cover-maker\n  name: '@deepseek-ai/dsh-mcp-client'\n");
    assert.equal(dsh.register(manifest, env).reason, 'user_managed');
    // DSH_HOME override
    const custom = path.join(tmpDir('dsh-home'), 'h');
    fs.mkdirSync(custom);
    assert.equal(dsh.register(manifest, Object.assign({}, env, { dshHome: custom })).status, 'installed');
    assert.ok(fs.existsSync(path.join(custom, 'cordis.patch.yml')));

    // OpenClaw: detection of the mcp sub-command
    assert.equal(openclaw.hasMcpCommand('Usage: openclaw mcp [options] [command]'), true);
    assert.equal(openclaw.hasMcpCommand('用法： openclaw-cn [options] [command]\n  config  配置工具'), false, 'CN fork prints the main help instead');
    function fakeOc(state) {
      const calls = [];
      const exec = (bin, args) => {
        calls.push(args.join(' '));
        if (!state.installed) return { code: 1, stdout: '', stderr: '' };
        if (args[0] === '--version') return { code: 0, stdout: state.version, stderr: '' };
        if (args[0] === 'mcp' && args[1] === '--help') return { code: 0, stdout: state.newCli ? 'Usage: openclaw mcp [options] [command]' : '用法： openclaw-cn [options] [command]', stderr: '' };
        if (args[1] === 'show') return state.entry ? { code: 0, stdout: JSON.stringify(state.entry), stderr: '' } : { code: 1, stdout: '', stderr: 'MCP server "cover-maker" not found' };
        if (args[1] === 'unset') { state.entry = null; return { code: 0, stdout: '', stderr: '' }; }
        if (args[1] === 'set') { state.entry = JSON.parse(args[3]); return { code: 0, stdout: 'saved', stderr: '' }; }
        return { code: 1, stdout: '', stderr: '?' };
      };
      return { calls, exec };
    }
    const st = { installed: true, version: '2026.2.5', newCli: false, entry: null };
    const f = fakeOc(st);
    assert.equal(openclaw.register(manifest, {}, f.exec).reason, 'unsupported_version');
    assert.equal(f.calls.some((c) => c.startsWith('mcp set')), false, 'nothing written on an old version');
    st.newCli = true;
    assert.equal(openclaw.register(manifest, {}, f.exec).status, 'installed');
    assert.deepEqual(st.entry, { command: manifest.command, args: ['--mcp-stdio'], transport: 'stdio' });
    assert.equal(openclaw.register(manifest, {}, f.exec).status, 'unchanged');
    assert.equal(openclaw.register(buildManifest({ isPackaged: true, execPath: 'D:/新位置/封面制作器.exe', appPath: '' }), {}, f.exec).status, 'updated');
    assert.equal(openclaw.register(manifest, {}, fakeOc({ installed: false }).exec).reason, 'not_installed');

    // the real OpenClaw on this machine (if any): must be detected correctly and never written to when unsupported
    const { defaultExec } = require('../agent-integration/clients/cli-client');
    const real = defaultExec('openclaw', ['mcp', '--help']);
    if (real.code === 0 && !openclaw.hasMcpCommand(real.stdout + real.stderr)) {
      assert.equal(openclaw.register(manifest, {}, (b, a, o) => (a[0] === '--version' || a[1] === '--help') ? defaultExec(b, a, o) : assert.fail('must not run ' + a.join(' '))).reason, 'unsupported_version');
      console.log('[agent-registry] local OpenClaw has no mcp command → skipped (unsupported_version): ok');
    }
  }

  // ---------- Mac：临时路径（App Translocation）+ 从 Finder 打开时找命令 ----------
  {
    const macEnv = require('../agent-integration/mac-env');
    assert.equal(macEnv.isTranslocated('/private/var/folders/xy/abc/T/AppTranslocation/1F2E-33/d/封面制作器.app/Contents/MacOS/封面制作器'), true);
    assert.equal(macEnv.isTranslocated('/Applications/封面制作器.app/Contents/MacOS/封面制作器'), false);
    assert.equal(macEnv.isTranslocated('/Users/me/Downloads/封面制作器.app/Contents/MacOS/封面制作器'), false);
    assert.equal(macEnv.isTranslocated('C:\\Program Files\\封面制作器\\封面制作器.exe'), false);
    // login shell output may carry noise from .zshrc
    assert.equal(macEnv.parseShellPath('welcome!\n' + macEnv.MARK + '/opt/homebrew/bin:/usr/bin' + macEnv.MARK + '\n'), '/opt/homebrew/bin:/usr/bin');
    assert.equal(macEnv.parseShellPath('no markers'), '');
    assert.equal(macEnv.loginShellPath(() => { throw new Error('no shell'); }), '', 'a broken shell never breaks registration');
    assert.equal(macEnv.loginShellPath(() => 'x' + macEnv.MARK + '/a:/b' + macEnv.MARK), '/a:/b');
    const dirs = macEnv.extraToolDirs('/Users/me', (p) => (p === '/Users/me/.nvm/versions/node' ? ['v18.20.0', 'v22.11.0'] : []));
    assert.ok(dirs.includes('/Users/me/.claude/local'), 'Claude Code\'s own install dir');
    assert.ok(dirs.includes('/opt/homebrew/bin'));
    assert.ok(dirs.includes('/Users/me/.local/bin'));
    assert.ok(dirs.indexOf('/Users/me/.nvm/versions/node/v22.11.0/bin') >= 0 && dirs.indexOf('/Users/me/.nvm/versions/node/v22.11.0/bin') < dirs.indexOf('/Users/me/.nvm/versions/node/v18.20.0/bin'), 'newest nvm node first');
    assert.equal(macEnv.mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', ['/bin', '/Users/me/.claude/local']), '/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.claude/local', 'merged in order, no duplicates');
  }

  // ---------- Task 15: registry ----------
  {
    const fakeAdapters = [
      { id: 'claude', register: () => ({ client: 'claude', status: 'installed' }) },
      { id: 'cursor', register: () => ({ client: 'cursor', status: 'updated' }) },
      { id: 'vscode', register: () => ({ client: 'vscode', status: 'skipped', reason: 'not_installed' }) },
      { id: 'codex', register: () => ({ client: 'codex', status: 'unchanged' }) },
      { id: 'broken', register: () => { throw Object.assign(new Error('disk full'), { code: 'AGENT_CONFIG_WRITE_FAILED' }); } }
    ];
    const stateDir = tmpDir('state');
    const statePath = path.join(stateDir, 'agent-registration.json');
    const report = registerClients({ adapters: fakeAdapters, manifest, env: {}, statePath, appVersion: '1.1.0', now: () => '2026-10-21T00:00:00.000Z' });
    assert.deepEqual(report, {
      ok: true,
      installed: ['claude'],
      updated: ['cursor'],
      unchanged: ['codex'],
      skipped: [{ client: 'vscode', reason: 'not_installed' }],
      failed: [{ client: 'broken', code: 'AGENT_CONFIG_WRITE_FAILED', error: 'disk full' }],
      restart_required: ['claude', 'cursor'],
      open_urls: []
    });
    const state = JSON.parse(readText(statePath));
    assert.equal(state.manifest_version, MANIFEST_VERSION);
    assert.equal(state.app_version, '1.1.0');
    assert.equal(state.last_run_at, '2026-10-21T00:00:00.000Z');
    assert.equal(state.clients.claude.status, 'installed');
    assert.equal(state.clients.broken.status, 'failed');

    // real adapters end-to-end in a fake home: only the installed ones get written
    const env = fakeEnv('all');
    fs.mkdirSync(cursor.paths(env).dir, { recursive: true });
    const r = registerClients({ adapters: [claude, cursor, vscode], manifest, env, statePath, appVersion: '1.1.0', now: () => 'x' });
    assert.deepEqual(r.installed, ['cursor']);
    assert.deepEqual(r.skipped.map((s) => s.client), ['claude', 'vscode']);
    assert.equal(fs.existsSync(claude.paths(env).config), false);
    const again = registerClients({ adapters: [claude, cursor, vscode], manifest, env, statePath, appVersion: '1.1.0', now: () => 'y' });
    assert.deepEqual(again.unchanged, ['cursor']);
    assert.deepEqual(again.restart_required, []);
  }
}

module.exports = { run };

if (require.main === module) {
  run().then(() => {
    console.log('[agent-registry] PASS');
  }).catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
