'use strict';

// DeepSeek Harness（dsh）：写全局补丁 $DSH_HOME/cordis.patch.yml（默认 ~/.dsh），对所有 profile 生效、优先级高于 profile 自己的。
//   文件是 Cordis 条目列表（顶层 YAML 列表，每条 id / name / config）；id 是新的就插入一行。
//   官方没有「添加 MCP」的命令，只能自己写 YAML —— 为了不碰用户的其它内容：
//     · 我们那条用两行注释标记圈起来，以后只替换标记中间这段；
//     · 文件顶层不是列表（或读不懂）→ 不写，报 unsupported_format；
//     · 用户自己（标记外）写过 id: mcp-cover-maker → 当作用户自己管，不动。
//   字符串一律用 JSON 写（JSON 字符串就是合法的 YAML 双引号字符串，中文 / 空格 / 反斜杠都安全）。
//   依据：deepseek-ai/deepseek-harness 的 packages/mcp/mcp-client README 与 apps/cli/reference README。

const fs = require('fs');
const path = require('path');
const { writeTextAtomic } = require('../config-io');

const BEGIN = '# >>> cover-maker：封面制作器自动写入，请勿手改这一段 >>>';
const END = '# <<< cover-maker <<<';
const ID = 'mcp-cover-maker';

function home(env) {
  return (env && env.dshHome) || path.join(env.home, '.dsh');
}

function paths(env) {
  const dir = home(env);
  return { dir, config: path.join(dir, 'cordis.patch.yml') };
}

function block(manifest) {
  return [
    BEGIN,
    '- id: ' + ID,
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: ' + manifest.name,
    '    transport: stdio',
    '    command: ' + JSON.stringify(manifest.command),
    '    args: ' + JSON.stringify(manifest.args),
    END
  ].join('\n');
}

// 去掉注释和空行后，剩下的内容必须是顶层列表（每个顶格行都以「- 」开头）才敢往后追加
function isTopLevelList(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  return lines.every((l) => /^\s/.test(l) || /^-(\s|$)/.test(l)) && (!lines.length || /^-(\s|$)/.test(lines[0]));
}

function register(manifest, env) {
  const p = paths(env);
  if (!fs.existsSync(p.dir)) return { client: 'dsh', status: 'skipped', reason: 'not_installed' };
  try {
    const exists = fs.existsSync(p.config);
    const raw = exists ? fs.readFileSync(p.config, 'utf8').replace(/^﻿/, '') : '';
    const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
    const want = block(manifest).split('\n').join(eol);
    const b = raw.indexOf(BEGIN);
    const e = b >= 0 ? raw.indexOf(END, b) : -1;
    let next;
    let had = false;
    if (b >= 0 && e > b) {
      had = true;
      const current = raw.slice(b, e + END.length);
      if (current === want) return { client: 'dsh', status: 'unchanged', path: p.config };
      next = raw.slice(0, b) + want + raw.slice(e + END.length);
    } else {
      if (new RegExp('^\\s*-?\\s*id:\\s*[\'"]?' + ID + '[\'"]?\\s*$', 'm').test(raw)) {
        return { client: 'dsh', status: 'skipped', reason: 'user_managed', path: p.config };
      }
      if (!isTopLevelList(raw)) {
        return { client: 'dsh', status: 'failed', code: 'AGENT_CONFIG_WRITE_FAILED', error: 'cordis.patch.yml 的顶层不是条目列表，没有改它：' + p.config };
      }
      const body = raw.replace(/\s+$/, '');
      next = (body ? body + eol + eol : '') + want + eol;
    }
    const w = writeTextAtomic(p.config, next, () => fs.readFileSync(p.config, 'utf8').indexOf(want) >= 0);
    return { client: 'dsh', status: had ? 'updated' : 'installed', path: p.config, backup: w.backupPath };
  } catch (err) {
    return { client: 'dsh', status: 'failed', code: 'AGENT_CONFIG_WRITE_FAILED', error: err.message, path: p.config };
  }
}

module.exports = { id: 'dsh', label: 'DeepSeek Harness', paths, register, block, BEGIN, END };
