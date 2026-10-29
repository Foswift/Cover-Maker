'use strict';

// Claude Code：`claude mcp add -s user <名> -- <命令> <参数…>`（user 级 = 任何目录下都能用）
// `claude mcp get` 找不到时也返回 0，只能看输出里的「No MCP server named」。
const { cliClient } = require('./cli-client');

module.exports = cliClient({
  id: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  getArgs: (name) => ['mcp', 'get', name],
  isMissing: (text) => /No MCP server named/i.test(text),
  removeArgs: (name) => ['mcp', 'remove', '-s', 'user', name],
  addArgs: (m) => ['mcp', 'add', '-s', 'user', m.name, '--', m.command].concat(m.args)
});
