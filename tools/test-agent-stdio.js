'use strict';

// M249 Task 10：stdio 转发进程（`--mcp-stdio`）真进程集成测试。
//   用独立数据目录 C:/tmp/cm_agent_stdio_profile（每次清空 = 「软件从没开过」）→ 转发进程得自己把软件拉起来；
//   验证：每条请求一行合法 JSON-RPC、stdout 没有日志混入、拉起来的窗口可见且没最小化、关掉 stdin 后软件还在跑。
//   只结束本测试拉起来的那个进程（按 pid），不碰用户开着的封面制作器。

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PROFILE = process.platform === 'win32' ? 'C:/tmp/cm_agent_stdio_profile' : path.join(os.tmpdir(), 'cm_agent_stdio_profile');

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid);
  } catch (e) { /* already gone */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

async function run() {
  require('../agent-core/tool-definitions');

  const electron = require('electron');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const bridge = cp.spawn(electron, [ROOT, '--mcp-stdio', '--user-data-dir=' + PROFILE], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const lines = [];
  const waiters = [];
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    stdout += chunk;
    let i;
    while ((i = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, i);
      stdout = stdout.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(line);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  bridge.stderr.setEncoding('utf8');
  bridge.stderr.on('data', (x) => { stderr += x; });
  const exited = new Promise((resolve) => bridge.on('exit', (code) => resolve(code)));

  const nextLine = (ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('stdio: no response in ' + ms + 'ms; stderr tail: ' + stderr.slice(-800))), ms);
    waiters.push((line) => { clearTimeout(t); resolve(line); });
  });
  let rid = 0;
  const request = async (method, params, ms) => {
    const id = ++rid;
    const wait = nextLine(ms || 20000);
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    const msg = JSON.parse(await wait);                      // throws if a log line leaked into stdout
    assert.equal(msg.jsonrpc, '2.0');
    assert.equal(msg.id, id, 'responses come back in order, one line each');
    return msg;
  };

  let guiPid = null;
  try {
    // First request has to launch the app: allow up to 60 s.
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent-stdio', version: '1' } }, 60000);
    assert.equal(init.result.serverInfo.name, 'cover-maker', JSON.stringify(init));
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');   // notification: no reply expected

    const list = await request('tools/list');
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('create_cover') && names.includes('get_agent_status'), names.join(','));

    const ping = await request('ping');
    assert.deepEqual(ping.result, {});

    // Window may still be fading in right after launch: poll briefly.
    let st = null;
    for (let i = 0; i < 20; i += 1) {
      const r = await request('tools/call', { name: 'get_agent_status', arguments: {} });
      st = JSON.parse(r.result.content.find((c) => c.type === 'text').text);
      if (st.window_visible) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    guiPid = st.pid;
    assert.ok(guiPid && guiPid !== bridge.pid, 'the GUI is a separate process');
    assert.equal(st.window_open, true);
    assert.equal(st.window_visible, true, 'agent-launched window is shown');
    assert.equal(st.window_minimized, false);

    assert.equal(lines.every((l) => { try { JSON.parse(l); return true; } catch (e) { return false; } }), true, 'stdout carries JSON-RPC only');

    bridge.stdin.end();
    const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res('timeout'), 10000))]);
    assert.notEqual(code, 'timeout', 'bridge exits when stdin closes');
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(alive(guiPid), true, 'the GUI keeps running after the agent disconnects');
    assert.equal(stdout.trim(), '', 'no trailing non-JSON output');
  } finally {
    try { bridge.kill(); } catch (e) { /* gone */ }
    killPid(guiPid);
  }
}

module.exports = { run };

if (require.main === module) {
  run().then(() => {
    console.log('[agent-stdio] PASS');
  }).catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
