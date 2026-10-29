'use strict';

// Codex CLI：`codex mcp add <名> -- <命令> <参数…>`（写进 ~/.codex/config.toml，由 codex 自己写）
const { cliClient } = require('./cli-client');

module.exports = cliClient({
  id: 'codex',
  label: 'Codex',
  bin: 'codex',
  getArgs: (name) => ['mcp', 'get', name],
  isMissing: (text) => /not found|no mcp server|does not exist/i.test(text),
  removeArgs: (name) => ['mcp', 'remove', name],
  addArgs: (m) => ['mcp', 'add', m.name, '--', m.command].concat(m.args)
});
