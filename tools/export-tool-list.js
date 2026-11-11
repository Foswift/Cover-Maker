'use strict';
// 导出「AI 能调用的工具清单」到桌面（人类可读 md + 机器可读 json）
//   用法：node tools/export-tool-list.js
//   数据源 = agent-core/tool-definitions.js（唯一来源）；同时核对 renderer/index.html 的 AGENT_TOOLS，
//   标出「主进程实现 / 渲染层实现 / 缺失」——「缺失」非空说明有假接口，必须修。
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const { TOOLS, CAPABILITIES } = require(path.join(root, 'agent-core', 'tool-definitions.js'));
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const start = html.indexOf('const AGENT_TOOLS = {');
const seg = start >= 0 ? html.slice(start) : '';
const rendererKeys = new Set();
const re = /\n\s{8,16}(?:async\s+)?([a-z_][a-z0-9_]*)\s*\(/g;
let m;
while ((m = re.exec(seg))) rendererKeys.add(m[1]);

const MAIN_SIDE = new Set(['export_images', 'create_cover', 'get_agent_status', 'cancel_cover_task', 'list_capabilities']);

const GROUPS = [
  ['画布 / 平台 / 自定义像素', ['get_canvas', 'set_platforms', 'set_frame_transform', 'list_custom_ratios', 'add_custom_ratio', 'rename_custom_ratio', 'remove_custom_ratio']],
  ['建元素', ['add_text', 'add_text_path', 'add_image', 'add_shape', 'add_sticker', 'add_sticker_image', 'duplicate_elements']],
  ['改元素 / 图层 / 对齐', ['update_element', 'skew_element', 'resize_element', 'set_element_state', 'set_layer_order', 'align_elements', 'delete_element', 'list_shapes', 'list_capabilities']],
  ['照片：取景 / 擦除 / 抠主体', ['fit_image_to_frame', 'erase_element', 'clear_erase', 'extract_subject']],
  ['模板 / 字体库条目', ['list_templates', 'get_template', 'save_template', 'rename_template', 'delete_template', 'apply_template', 'import_templates', 'export_template', 'export_templates', 'save_to_font_library']],
  ['参考线 / 标尺', ['get_guides', 'set_guide_preferences', 'add_guide', 'remove_guide', 'clear_guides', 'new_guide_layout']],
  ['颜色', ['sample_color', 'extract_palette', 'get_color_pins', 'set_color_pins', 'get_color_scheme']],
  ['字体（导入库）', ['list_fonts', 'check_fonts', 'import_fonts', 'remove_font']],
  ['贴纸库', ['list_stickers', 'import_stickers', 'remove_sticker', 'hide_builtin_sticker', 'restore_builtin_stickers']],
  ['复刻参考图', ['set_reference_image', 'clear_reference_image', 'measure_reference', 'compare_with_reference']],
  ['输出 / 撤销 / 设置 / 状态', ['screenshot', 'export_images', 'undo', 'redo', 'get_app_settings', 'set_theme', 'set_language', 'create_cover', 'get_agent_status', 'cancel_cover_task']]
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const grouped = new Set();
GROUPS.forEach(([, list]) => list.forEach((n) => grouped.add(n)));
const rest = TOOLS.map((t) => t.name).filter((n) => !grouped.has(n));

function where(n) {
  if (MAIN_SIDE.has(n)) return '主进程';
  if (rendererKeys.has(n)) return '渲染层';
  return '❌ 缺失';
}
function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ');
  const i = t.indexOf('。');
  return i > 0 ? t.slice(0, i) : t;
}
function params(t) {
  const props = (t.inputSchema && t.inputSchema.properties) || {};
  const req = new Set((t.inputSchema && t.inputSchema.required) || []);
  const names = Object.keys(props);
  if (!names.length) return '—';
  return names.map((k) => (req.has(k) ? '**' + k + '**' : k)).join(', ');
}
function row(n) {
  const t = byName.get(n);
  if (!t) return '| ' + n + ' | —— schema 里没有 | | |';
  return '| `' + n + '` | ' + firstSentence(t.description) + ' | ' + params(t) + ' | ' + where(n) + ' |';
}

const missing = TOOLS.map((t) => t.name).filter((n) => where(n) === '❌ 缺失');
const now = new Date();
const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' '
  + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

let md = '';
md += '# 封面制作器 · AI 可调用工具清单\n\n';
md += '导出时间：' + stamp + '　|　工具总数：**' + TOOLS.length + '**　|　版本：' + require(path.join(root, 'package.json')).version + '\n\n';
md += '同一个软件里的两层：**主进程**（导出写文件、一键成片、状态、能力表）和**渲染层**（其余全部，直接改画布）。\n\n';
md += '- 简单调用：`POST http://127.0.0.1:37651/call/<工具名>`，请求头 `Authorization` 写 Bearer 加空格再跟令牌；令牌在 `cover-maker/agent.json` 的 token 字段，body 是 JSON 参数\n';
md += '- 标准 MCP：`POST http://127.0.0.1:37651/mcp`（Streamable HTTP），`tools/list` / `tools/call`\n';
md += '- 说明书：浏览器打开 `http://127.0.0.1:37651/`\n\n';
md += '> 参数列里 **加粗** = 必填。字段级能力（斜切 / 透视 / 形状宽高 / 圆角 / 线条端点 / 气泡尾巴 / 渐变…）不是独立工具，是 `update_element` 的字段，详见 `list_capabilities`。\n\n';
GROUPS.forEach(([title, list]) => {
  const rows = list.filter((n) => byName.has(n)).map(row);
  if (!rows.length) return;
  md += '## ' + title + '（' + rows.length + '）\n\n| 工具 | 作用 | 参数 | 实现 |\n|---|---|---|---|\n' + rows.join('\n') + '\n\n';
});
if (rest.length) {
  md += '## 其它（' + rest.length + '）\n\n| 工具 | 作用 | 参数 | 实现 |\n|---|---|---|---|\n' + rest.map(row).join('\n') + '\n\n';
}
md += '## 字段级能力（update_element 能改什么）\n\n';
Object.keys(CAPABILITIES.element_types).forEach((t) => {
  const v = CAPABILITIES.element_types[t];
  md += '- **' + t + '**：' + v.fields.join(', ') + (v.note ? '\n  - ' + v.note : '') + '\n';
});
md += '\n专用工具：' + CAPABILITIES.specialized_tools.join(', ') + '\n\n';
md += '---\n\n核对结果：schema ' + TOOLS.length + ' 个，渲染层已实现 ' + TOOLS.filter((t) => where(t.name) === '渲染层').length
  + ' 个，主进程 ' + TOOLS.filter((t) => where(t.name) === '主进程').length + ' 个，缺失 ' + missing.length + ' 个'
  + (missing.length ? '（' + missing.join(', ') + '）' : '（无假接口）') + '。\n';

const desktop = path.join(os.homedir(), 'Desktop');
const mdPath = path.join(desktop, '封面制作器-AI工具清单.md');
const jsonPath = path.join(desktop, '封面制作器-AI工具清单.json');
fs.writeFileSync(mdPath, md, 'utf8');
fs.writeFileSync(jsonPath, JSON.stringify({
  generated_at: now.toISOString(), version: require(path.join(root, 'package.json')).version,
  endpoint: { call: 'POST http://127.0.0.1:37651/call/<tool>', mcp: 'POST http://127.0.0.1:37651/mcp',
              token_file: 'cover-maker/agent.json', guide: 'http://127.0.0.1:37651/' },
  counts: { total: TOOLS.length, renderer: TOOLS.filter((t) => where(t.name) === '渲染层').length,
            main: TOOLS.filter((t) => where(t.name) === '主进程').length, missing: missing.length },
  tools: TOOLS.map((t) => ({ name: t.name, where: where(t.name), description: t.description,
                             annotations: t.annotations || null, inputSchema: t.inputSchema })),
  capabilities: CAPABILITIES
}, null, 2), 'utf8');

console.log('[export] 工具总数', TOOLS.length, '| 渲染层', TOOLS.filter((t) => where(t.name) === '渲染层').length,
            '| 主进程', TOOLS.filter((t) => where(t.name) === '主进程').length, '| 缺失', missing.length, missing);
console.log('[export]', mdPath);
console.log('[export]', jsonPath);
