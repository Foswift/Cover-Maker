'use strict';

// Trae（国际版 / 国内版 Trae CN）：VS Code 系，全局配置 <应用数据>/<Trae|Trae CN>/User/mcp.json → mcpServers.<名>
//   ⚠ 官方文档没写路径：Trae CN 的 Mac 路径有人对着真软件核实过，Windows / 国际版是同一规律推出来的，没在真机上验证。
const path = require('path');
const { jsonClient } = require('./json-client');

function trae(id, label, folder) {
  return jsonClient({
    id,
    label,
    key: 'mcpServers',
    paths: (env) => {
      const app = path.join(env.appData, folder);
      return { dir: app, config: path.join(app, 'User', 'mcp.json') };
    },
    entry: (m) => ({ command: m.command, args: m.args.slice() })
  });
}

module.exports = { trae: trae('trae', 'Trae', 'Trae'), traeCn: trae('trae-cn', 'Trae CN', 'Trae CN') };
