'use strict';

// Claude Desktop：claude_desktop_config.json → mcpServers.<名>
const path = require('path');
const { jsonClient } = require('./json-client');

module.exports = jsonClient({
  id: 'claude',
  label: 'Claude Desktop',
  key: 'mcpServers',
  paths: (env) => {
    const dir = path.join(env.appData, 'Claude');
    return { dir, config: path.join(dir, 'claude_desktop_config.json') };
  },
  entry: (m) => ({ command: m.command, args: m.args.slice() })
});
