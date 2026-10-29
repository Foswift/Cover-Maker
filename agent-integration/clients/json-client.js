'use strict';

// 「一个 JSON 配置文件、某个键下面按名字放 MCP 服务」这一类客户端的共用写法。
// 每家自己给：配置在哪（paths）、放在哪个键（key）、一条记录长什么样（entry）。
// 客户端目录不存在 = 没装 → 跳过，绝不替没装的软件建配置。

const fs = require('fs');
const { readJson, writeJsonAtomic } = require('../config-io');

function sameEntry(a, b) {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

function jsonClient({ id, label, paths, key, entry }) {
  function register(manifest, env) {
    const p = paths(env);
    if (!fs.existsSync(p.dir)) return { client: id, status: 'skipped', reason: 'not_installed' };
    try {
      const cur = readJson(p.config);
      const value = cur.value || {};
      const want = entry(manifest);
      const servers = value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) ? value[key] : {};
      const had = Object.prototype.hasOwnProperty.call(servers, manifest.name);
      if (had && sameEntry(servers[manifest.name], want)) return { client: id, status: 'unchanged', path: p.config };
      const next = Object.assign({}, value, { [key]: Object.assign({}, servers, { [manifest.name]: want }) });
      const w = writeJsonAtomic(p.config, next, (v) => v && v[key] && sameEntry(v[key][manifest.name], want));
      return { client: id, status: had ? 'updated' : 'installed', path: p.config, backup: w.backupPath };
    } catch (e) {
      return { client: id, status: 'failed', code: 'AGENT_CONFIG_WRITE_FAILED', error: e.message, path: p.config };
    }
  }
  return { id, label, paths, register };
}

module.exports = { jsonClient };
