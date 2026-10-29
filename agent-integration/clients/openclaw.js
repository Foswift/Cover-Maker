'use strict';

// OpenClaw：2026.3.31 起原生支持 MCP，官方命令 `openclaw mcp set <名> '<JSON>'`（存进 openclaw.json 的 mcp.servers）。
//   老版本 / 中文分支（openclaw-cn 2026.2.5 实测）没有 mcp 命令：敲 `openclaw mcp --help` 不报错、退出码也是 0，
//   只是把主帮助打一遍 —— 所以靠「帮助里的用法行是不是 openclaw … mcp」判断，不是就跳过、什么都不写。
//   依据：docs.openclaw.ai/cli/mcp、/cli/mcp/registry；openclaw/openclaw issue #29053。
const { cliClient } = require('./cli-client');

function hasMcpCommand(text) {
  return /(usage|用法)\s*[:：]\s*\S*openclaw\S*\s+mcp\b/i.test(String(text || ''));
}

module.exports = Object.assign(cliClient({
  id: 'openclaw',
  label: 'OpenClaw',
  bin: 'openclaw',
  supports: (run) => { const r = run('openclaw', ['mcp', '--help']); return r.code === 0 && hasMcpCommand(r.stdout + '\n' + r.stderr); },
  getArgs: (name) => ['mcp', 'show', name],
  isMissing: (text) => /not found|no (mcp )?server|unknown server|does not exist|未找到|不存在/i.test(text),
  removeArgs: (name) => ['mcp', 'unset', name],
  addArgs: (m) => ['mcp', 'set', m.name, JSON.stringify({ command: m.command, args: m.args.slice(), transport: 'stdio' })]
}), { hasMcpCommand });
