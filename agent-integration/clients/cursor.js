'use strict';

// Cursor（用户级）：~/.cursor/mcp.json → mcpServers.<名>
const path = require('path');
const { jsonClient } = require('./json-client');

module.exports = jsonClient({
  id: 'cursor',
  label: 'Cursor',
  key: 'mcpServers',
  paths: (env) => {
    const dir = path.join(env.home, '.cursor');
    return { dir, config: path.join(dir, 'mcp.json') };
  },
  entry: (m) => ({ command: m.command, args: m.args.slice() })
});
