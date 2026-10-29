'use strict';

// VS Code（用户级）：Code/User/mcp.json → servers.<名>（VS Code 的键叫 servers，且要写 type）
const path = require('path');
const { jsonClient } = require('./json-client');

module.exports = jsonClient({
  id: 'vscode',
  label: 'VS Code',
  key: 'servers',
  paths: (env) => {
    const dir = path.join(env.appData, 'Code', 'User');
    return { dir, config: path.join(dir, 'mcp.json') };
  },
  entry: (m) => ({ type: 'stdio', command: m.command, args: m.args.slice() })
});
