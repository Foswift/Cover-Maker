'use strict';

// 一次把所有适配器跑一遍：逐个注册，单个失败只记进报告，不影响别的、也不抛出。
// 结果写到封面制作器自己的 userData/agent-registration.json（下次启动 / 排查时看）。

const fs = require('fs');
const path = require('path');
const { MANIFEST_VERSION } = require('./manifest');

function registerOne(adapter, manifest, env) {
  return adapter.register(manifest, env);
}

function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { return null; }
}

// needs_open：只能靠打开安装链接、让用户在对方软件里点确认的（Cherry Studio）→ 链接放进 open_urls，由主进程用系统打开
function registerClients({ adapters, manifest, env, statePath, appVersion, now }) {
  const report = { ok: true, installed: [], updated: [], unchanged: [], skipped: [], failed: [], restart_required: [], open_urls: [] };
  const clients = {};
  const prevState = statePath ? readState(statePath) : null;
  const envWithPrev = Object.assign({}, env, { prev: (prevState && prevState.clients) || {} });
  for (const a of adapters) {
    let r;
    try {
      r = registerOne(a, manifest, envWithPrev) || { client: a.id, status: 'failed', code: 'AGENT_CONFIG_WRITE_FAILED', error: '没有返回' };
    } catch (e) {
      r = { client: a.id, status: 'failed', code: e.code || 'AGENT_CONFIG_WRITE_FAILED', error: e.message };
    }
    clients[a.id] = r;
    if (r.status === 'installed' || r.status === 'updated') {
      report[r.status].push(a.id);
      report.restart_required.push(a.id);          // 已经开着的 Agent 要重启才读到新配置
    } else if (r.status === 'needs_open') report.open_urls.push({ client: a.id, url: r.url });
    else if (r.status === 'unchanged') report.unchanged.push(a.id);
    else if (r.status === 'skipped') report.skipped.push({ client: a.id, reason: r.reason });
    else report.failed.push({ client: a.id, code: r.code || 'AGENT_CONFIG_WRITE_FAILED', error: r.error || '' });
  }
  if (statePath) {
    const state = { manifest_version: MANIFEST_VERSION, app_version: appVersion,
                    last_run_at: (now || (() => new Date().toISOString()))(), command: manifest.command, clients };
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    } catch (e) { /* 记不下来不影响注册结果 */ }
  }
  return report;
}

module.exports = { registerClients, registerOne };
