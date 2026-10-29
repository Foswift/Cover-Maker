// 封面制作器 · AI 调用（MCP）—— 2026-10-20 用户「如果我想要让 agent 去调用怎么办」→「先做 mcp」
//
// 两条入口，最后都落到同一个本机 HTTP 端点（只听 127.0.0.1）：
//   ① 软件开着（默认打开）→ 主进程起本机服务：GET / = 给 AI 的说明书（带令牌）、POST /call/<工具> = 简单调用、POST /mcp = 标准 MCP（Streamable HTTP，回 JSON）；
//      用户只要对 agent 说「用封面制作器…它在 http://127.0.0.1:37651 ，先打开看说明」（2026-10-20「改为不需要用户去点击」）；
//      Claude Code 这类支持 http 的 agent 直接连：http://127.0.0.1:<端口>/mcp，带 Authorization: Bearer <令牌>。
//   ② `封面制作器 --mcp-stdio`：给 Claude Desktop 这类只会起本地命令的 agent 用。这个进程**不开窗口**，
//      只把 stdin 的每行 JSON-RPC 转发给 ① 的端点、把回复写到 stdout；软件没开就先把它打开（等最多 40 秒）。
//
// 工具真正干活的是渲染层的 window.__cmAgent.call(name, args)（renderer/index.html「9. AI 调用」），
//   主进程这边只做：协议、鉴权、开关、导出写文件、把截图变成 MCP 的图片内容。
//
// 安全：只绑 127.0.0.1；必须带令牌（存在 userData/agent.json，第一次打开时随机生成）；带了 Origin 头且不是本机的一律拒（防网页 DNS 重绑定）；
//   默认打开（用户 2026-10-20「默认打开」：没设置过 = 开；在「帮助 → AI 调用」里关掉才写 enabled:false）。
'use strict';

const http = require('http');
const crypto = require('crypto');
const { TOOLS, hasTool } = require('./agent-core/tool-definitions');
const { TaskQueue } = require('./agent-core/task-queue');
const { createCoverRunner } = require('./agent-core/create-cover');

const SERVER_NAME = 'cover-maker';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PORT = 37651;

module.exports = function createMcp(deps) {
    const { app, fs, path, getWin, dialog, clipboard, cp } = deps;
    let server = null;
    let listening = null;          // { port }

    // ---------- 设置（userData/agent.json）----------
    function cfgPath() { return path.join(app.getPath('userData'), 'agent.json'); }
    function readCfg() {
        try { const j = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); return (j && typeof j === 'object') ? j : {}; } catch (e) { return {}; }
    }
    function writeCfg(c) {
        try { fs.mkdirSync(path.dirname(cfgPath()), { recursive: true }); fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2)); } catch (e) { console.warn('[cover-maker] 写 agent.json 失败:', e.message); }
    }
    function ensureToken(c) {
        if (!c.token) c.token = crypto.randomBytes(24).toString('hex');
        if (!c.port) c.port = DEFAULT_PORT;
        return c;
    }

    // ---------- 工具清单（共享定义见 agent-core/tool-definitions.js）----------

    // ---------- 调渲染层 ----------
    async function callRenderer(name, args) {
        const w = getWin();
        if (!w) return { ok: false, error: '封面制作器的窗口没开' };
        try {
            const r = await w.webContents.executeJavaScript(
                'window.__cmAgent ? window.__cmAgent.call(' + JSON.stringify(name) + ', ' + JSON.stringify(args || {}) + ') : { ok: false, error: "画布还没准备好" }', true);
            return r || { ok: false, error: '没有返回' };
        } catch (e) {
            return { ok: false, error: '执行出错：' + (e && e.message ? e.message : String(e)) };
        }
    }

    async function exportTo(args) {
        const r = await callRenderer('render_export', {});
        if (!r.ok) return r;
        let dir = String((args && args.dir) || '').trim();
        if (!dir) dir = path.join(app.getPath('pictures'), '封面制作器导出');
        if (!path.isAbsolute(dir)) return { ok: false, error: 'dir 要写绝对路径' };
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: '建不了文件夹：' + e.message }; }
        const files = [];
        for (const f of r.files) {
            const name = String(f.name || 'cover.png').replace(/[\\/:*?"<>|]/g, '_');
            const p = path.join(dir, name);
            try { fs.writeFileSync(p, Buffer.from(String(f.dataURL).split(',')[1] || '', 'base64')); files.push({ path: p, width: f.width, height: f.height }); }
            catch (e) { return { ok: false, error: '写文件失败：' + e.message }; }
        }
        return { ok: true, dir: dir, files: files };
    }

    // M249：create_cover 一键做封面（编排在 agent-core/create-cover.js；同一时间只跑一个，其余排队）
    let taskSeq = 0;
    const covers = createCoverRunner({
        queue: new TaskQueue(),
        call: callRenderer,
        exportTo: exportTo,
        fileExists: (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
        makeTaskId: () => 'cover-' + Date.now().toString(36) + '-' + (++taskSeq)
    });
    async function agentStatus() {
        const canvas = getWin() ? await callRenderer('get_canvas', {}) : { ok: false, error: '窗口没开' };
        const w = getWin();
        return { ok: true, version: app.getVersion(), pid: process.pid, window_open: !!w,
                 window_visible: !!w && w.isVisible(), window_minimized: !!w && w.isMinimized(),
                 canvas_ready: !!canvas.ok, canvas_error: canvas.ok ? undefined : canvas.error,
                 platforms: canvas.ok ? canvas.platforms : undefined, element_count: canvas.ok ? canvas.elements.length : undefined,
                 tasks: covers.status(), tools: TOOLS.map((t) => t.name) };
    }

    // 真正执行一个工具（MCP 和 /call 共用）：导出在主进程写文件；截图给了 save_to 就顺手存成 PNG
    async function execTool(name, args) {
        console.log('[cover-maker] AI 工具:', name, JSON.stringify(args || {}).slice(0, 300));
        if (name === 'create_cover') return covers.createCover(args || {});
        if (name === 'get_agent_status') return agentStatus();
        if (name === 'cancel_cover_task') return covers.cancel(args && args.task_id);
        const r = name === 'export_images' ? await exportTo(args) : await callRenderer(name, args);
        if (name === 'screenshot' && r && r.ok && r.dataURL && args && args.save_to) {
            const to = String(args.save_to);
            if (!path.isAbsolute(to)) return Object.assign({}, r, { ok: false, error: 'save_to 要写绝对路径' });
            try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, Buffer.from(String(r.dataURL).split(',')[1] || '', 'base64')); r.saved_to = to; }
            catch (e) { return { ok: false, error: '截图存不了：' + e.message }; }
        }
        return r || { ok: false, error: '没有返回' };
    }
    async function runTool(name, args) {
        if (!hasTool(name)) return { isError: true, content: [{ type: 'text', text: '没有这个工具：' + name }] };
        const r = await execTool(name, args);
        if (name === 'screenshot' && r && r.ok && r.dataURL) {
            const data = String(r.dataURL).split(',')[1] || '';
            return { content: [{ type: 'image', data: data, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ ok: true, width: r.width, height: r.height, frame: r.frame, saved_to: r.saved_to }) }] };
        }
        if (name === 'create_cover' && r && r.ok && r.preview && r.preview.dataURL) {      // 做好的第一块框直接给 agent 看
            const o = Object.assign({}, r, { preview: { frame: r.preview.frame } });
            return { content: [{ type: 'image', data: String(r.preview.dataURL).split(',')[1] || '', mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(o) }] };
        }
        return { isError: !(r && r.ok), content: [{ type: 'text', text: JSON.stringify(r) }] };
    }
    // /call 用：普通 JSON；截图存了文件就不再塞 base64（省得 agent 的终端被一大坨字符刷屏）
    async function runToolPlain(name, args) {
        const r = await execTool(name, args);
        if (name === 'screenshot' && r && r.ok && r.saved_to) { const o = Object.assign({}, r); delete o.dataURL; return o; }
        if (name === 'create_cover' && r && r.preview) return Object.assign({}, r, { preview: { frame: r.preview.frame, note: '看图打开 files 里的 PNG，或调 screenshot 带 save_to' } });
        return r;
    }

    // ---------- JSON-RPC ----------
    async function handleRpc(msg) {
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
            return { jsonrpc: '2.0', id: (msg && msg.id) != null ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
        }
        const isNote = msg.id === undefined || msg.id === null;
        const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result: result });
        try {
            switch (msg.method) {
                case 'initialize': {
                    const want = msg.params && msg.params.protocolVersion;
                    return ok({ protocolVersion: PROTOCOLS.indexOf(want) >= 0 ? want : PROTOCOLS[0],
                                capabilities: { tools: { listChanged: false } },
                                serverInfo: { name: SERVER_NAME, title: '封面制作器', version: app.getVersion() },
                                instructions: '封面制作器：给抖音 / 小红书 / B站等平台做视频封面。最省事：create_cover 一次做完（标题 + 平台 + 风格 + 可选图片 → 自动排版、截图、导出，返回文件路径）。用户给了参考图：先分清背景、主体、标题、副标题、贴纸/装饰及谁遮住谁。如果主体和任一文字/贴纸重叠，必须自动调用 extract_subject，不要等用户再要求抠图；原图固定在最底层。主体通常在上，但必须逐个判断每个重叠元素：覆盖主体的放主体上方，被主体遮挡的放主体下方。细调时先 get_canvas 读取每个独立元素的 role / layer_rank / z_index；改变前后关系必须整批调用 set_layer_order（bottom_to_top），不要靠逐个 to_front 猜顺序。参考图上有文字时，必须先判断参考图用的字体（认不出名字就写风格最接近的常见字体名），调用 check_fonts；返回里有 tell_user 就必须先停下来，把那句话告诉用户，等用户选好（下载安装 / 导入这个字体，或用哪个相近字体）再继续做，不要先做完再说，也不要自己悄悄换字体。坐标都按框的比例（0~1）给。' });
                }
                case 'ping': return ok({});
                case 'tools/list': return ok({ tools: TOOLS });
                case 'tools/call': {
                    const p = msg.params || {};
                    return ok(await runTool(String(p.name || ''), p.arguments || {}));
                }
                default:
                    if (isNote) return null;                                   // notifications/initialized 之类：不回
                    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
            }
        } catch (e) {
            return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } };
        }
    }

    // ---------- HTTP 服务 ----------
    //   用户 2026-10-20「改为不需要用户去点击」：用户只对 agent 说一句「用封面制作器…它在 http://127.0.0.1:37651 ，先打开看说明」——
    //   · GET /（或 /help）= 说明书（Markdown 纯文本）：怎么调、全部工具和参数、**令牌**；能发请求的 agent 读完就会用；
    //   · POST /call/<工具名> + JSON 参数 = 一行 curl 就能调（不用懂 MCP）；POST /mcp = 标准 MCP（Claude Code / Cursor 等）；
    //   · 说明书带令牌但网页拿不到：① 不发任何 CORS 头 → 浏览器里的网页读不到回复；② Host 必须是 127.0.0.1 / localhost
    //     → 挡 DNS 重绑定（恶意域名解析到 127.0.0.1 冒充同源）；③ 带外站 Origin 一律 403。动手的接口（/mcp、/call）仍要令牌。
    //   · 端口固定：37651 被占 → 依次试到 37660（不再随机），说明书地址和「那一句话」才一直对得上。
    const PORT_SPAN = 10;
    let token = null;
    function originOk(req) {
        const o = req.headers.origin;
        if (!o || o === 'null') return true;
        return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(o);
    }
    function hostOk(req) { return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host || '')); }
    function paramLines(schema) {
        const props = (schema && schema.properties) || {}, req = (schema && schema.required) || [];
        const ks = Object.keys(props);
        if (!ks.length) return '  （没有参数）';
        return ks.map((k) => {
            const p = props[k];
            let t = p.type || 'object';
            if (p.enum) t += '，可选 ' + p.enum.join(' / ');
            if (p.items && p.items.enum) t += '，元素可选 ' + p.items.enum.join(' / ');
            let line = '  - `' + k + '`（' + t + (req.indexOf(k) >= 0 ? '，必填' : '') + '）' + (p.description ? '：' + p.description : '');
            if (p.properties) line += '\n' + Object.keys(p.properties).map((kk) => '      - `' + kk + '`：' + (p.properties[kk].description || p.properties[kk].type || '')).join('\n');
            return line;
        }).join('\n');
    }
    function agentGuide(port) {
        const base = 'http://127.0.0.1:' + port;
        return [
            '# 封面制作器 · 给 AI 的使用说明',
            '',
            '你可以直接操作用户电脑上开着的「封面制作器」（给抖音 / 小红书 / B站等平台做视频封面的桌面软件）。',
            '用户在软件窗口里能实时看到你做的每一步，也能按 Ctrl+Z 撤回。',
            '',
            '## 怎么调用',
            '',
            '每个工具一个地址，POST JSON 参数，返回 JSON（`ok` = 成功与否，失败时看 `error`，有 `warning` 要照着改）：',
            '',
            '```',
            'POST ' + base + '/call/<工具名>',
            'Authorization: Bearer ' + token,
            'Content-Type: application/json',
            '',
            '{ ...参数 }',
            '```',
            '',
            '例子（curl）：',
            '',
            '```bash',
            'curl -s -X POST ' + base + '/call/get_canvas -H "Authorization: Bearer ' + token + '" -H "Content-Type: application/json" -d "{}"',
            'curl -s -X POST ' + base + '/call/add_text -H "Authorization: Bearer ' + token + '" -H "Content-Type: application/json" -d "{\\"text\\":\\"周末去哪玩\\",\\"frame\\":1,\\"y\\":0.2,\\"size\\":34}"',
            '```',
            '',
            '（Windows 命令行里 JSON 的双引号要像上面那样写成 `\\"`；PowerShell 里用 `Invoke-RestMethod -Method Post -Uri ... -Headers @{Authorization=\'Bearer ' + token + '\'} -ContentType \'application/json\' -Body \'{...}\'` 更省事。参数里有中文时，用脚本（Python / Node）发请求最稳。）',
            '',
            '支持 MCP 的客户端也可以直接连标准 MCP 端点：`' + base + '/mcp`（Streamable HTTP，请求头带同样的 Authorization）。',
            '',
            '## 最省事：一次做完',
            '',
            '**用户给了参考图（想照着某张图的风格做）**：先把参考图拆成独立层：背景、主体、标题、副标题、贴纸 / 装饰，并明确谁在谁上面、谁遮住谁。然后**仍然先用 `create_cover`**，把配色和版式填进 `custom_style` 出第一版；再 `get_canvas` 读取每个元素的 `role / layer_rank / z_index`，用 `set_layer_order` 一次性写清层序，最后 `screenshot` 对比参考图。不要靠创建顺序或反复 `to_front` 猜图层。',
            '',
            '**参考图存在主体遮挡（人物 / 商品与文字或贴纸重叠）**：必须自动调用 `extract_subject`，不要等用户再说“抠图”。原图固定在最底层并完整保留；主体透明层通常在上。随后必须逐个判断每个重叠文字 / 贴纸：被主体遮挡的放在主体下方，覆盖主体的放在主体上方。纯粹不重叠的画面不用抠主体。`create_cover` 可先加 `subject_front: true` 完成“主体压住全部文字”的常见情况；若参考图同时有贴纸压住主体，再 `get_canvas` 并用 `set_layer_order` 按“原图 → 主体下元素 → 主体 → 主体上元素”整批校正。参考图人物有一圈白边时填 `custom_style.subject_outline_color / subject_outline_width`。抠主体只在 Mac（macOS 14+）上能用，失败会在 warnings 里说明。',
            '',
            '**字体**：参考图上有文字时，**必须先判断参考图用的字体**（认得出就写字体名，认不出就写风格最接近的常见字体名，比如 Montserrat ExtraBold、思源黑体 Heavy），调用 `check_fonts` 查这台电脑上有没有（**这一步要在动手做封面之前**）；不要只在 `list_fonts` 里自己挑一个替代就完事。`check_fonts` 返回 `tell_user` 时：**必须先停下来**，把那句话告诉用户，**等用户选**好再继续（用户去下载安装 / 导入这个字体，或者选一个相近字体）。`check_fonts`（以及 add_text / create_cover 用到电脑上没有的字体时）返回里带 `font_missing` 和 `tell_user` —— **必须把 `tell_user` 那句话告诉用户**（没有这个字体，可以下载安装或在封面制作器里导入后让你换回来，或者就用相近的）。',
            '',
            '`create_cover`：给标题（必填）、平台（platforms，默认小红书）、风格（style，比如「简洁高级」「科技」「干货」「醒目」「温暖」「商务」）、可选本地图片（image_paths，绝对路径）、导出文件夹（output_dir，绝对路径），软件自动排版、截图并导出，返回 PNG 的绝对路径。默认保留画布原有内容（新背景垫在最底下）；用户明确说清空 / 重做才传 `replace_canvas: true`。整次制作只占一步撤销；失败会自动恢复原画布。',
            '',
            '## 想自己一步步做',
            '',
            '1. `get_canvas` 看现状：每个独立元素都有 `id / role / layer_rank / z_index`；`layer_rank = 0` 表示该框最上层',
            '2. `set_platforms` 选平台（出对应比例的框，框按编号 1、2、3… 指代）',
            '3. `add_image` 放背景图（铺满整块框）',
            '4. `add_text` / `add_shape` / `add_sticker` 加标题、形状、贴纸',
            '5. 参考图里主体与文字/贴纸重叠时，必须自动 `extract_subject`；再重新 `get_canvas`，按“原图 → 被主体遮挡的元素 → 主体 → 覆盖主体的元素”把该框全部 id 交给 `set_layer_order`',
            '6. `screenshot` 看效果（参数 `save_to` = 存成 PNG 文件的绝对路径，方便你打开图片看；不写就在返回里给 base64）',
            '7. 不满意就 `update_element` / `delete_element` / `undo` 改',
            '8. `export_images` 导出成品',
            '',
            '要点：位置都按「第几块框 + 框里的比例（0~1）」给；字号 / 粗细是画布像素，框在画布上只有两三百像素宽（`get_canvas` 的 `frames[].canvas_size`），标题一般是框宽的 1/6~1/10；返回里有 `warning` 说超出框了就调小或挪位置。',
            '',
            '## 全部工具',
            '',
            TOOLS.map((t) => '### ' + t.name + '\n\n' + t.description + '\n\n参数：\n' + paramLines(t.inputSchema)).join('\n\n'),
            '',
            '---',
            '令牌只在这台电脑上有效；令牌失效时重新打开 ' + base + ' 拿新的。',
            ''
        ].join('\n');
    }
    // 说明书顺手写一份到 userData/AI说明.md（能读文件、不方便发请求的 agent 用；端口 / 令牌变了就跟着更新）
    function guideFile() { return path.join(app.getPath('userData'), 'AI说明.md'); }
    function writeGuideFile() {
        if (!listening) return;
        try { fs.writeFileSync(guideFile(), agentGuide(listening.port)); } catch (e) { console.warn('[cover-maker] 写 AI说明.md 失败:', e.message); }
    }
    function readBody(req) {
        return new Promise((resolve) => {
            let raw = '';
            req.setEncoding('utf8');
            req.on('data', (c) => { raw += c; if (raw.length > 20 * 1024 * 1024) req.destroy(); });
            req.on('end', () => resolve(raw));
        });
    }
    function start() {
        if (server) return Promise.resolve(listening);
        const cfg = ensureToken(readCfg());
        writeCfg(cfg);
        token = cfg.token;
        return new Promise((resolve) => {
            const s = http.createServer(async (req, res) => {
                const send = (code, body, type) => {
                    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                    res.end(body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body)));
                };
                if (!hostOk(req)) return send(403, { error: 'host not allowed' });
                if (!originOk(req)) return send(403, { error: 'origin not allowed' });
                const u = String(req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
                // 说明书：不要令牌（令牌就写在里面）
                if (req.method === 'GET' && (u === '/' || u === '/help' || u === '/guide')) return send(200, agentGuide(listening.port), 'text/markdown; charset=utf-8');
                if (u !== '/mcp' && u.indexOf('/call/') !== 0) return send(404, { error: 'not found：打开 http://127.0.0.1:' + listening.port + '/ 看说明' });
                if (String(req.headers.authorization || '') !== 'Bearer ' + token) return send(401, { error: 'unauthorized：令牌不对，打开 http://127.0.0.1:' + listening.port + '/ 拿最新的令牌' });
                if (u.indexOf('/call/') === 0) {                               // 简单调用：POST /call/<工具名>，body = 参数
                    if (req.method !== 'POST') return send(405, { error: '用 POST' });
                    const raw = await readBody(req);
                    let args = {};
                    if (raw.trim()) { try { args = JSON.parse(raw); } catch (e) { return send(400, { ok: false, error: '参数不是合法 JSON：' + e.message }); } }
                    const name = decodeURIComponent(u.slice(6));
                    if (!hasTool(name)) return send(404, { ok: false, error: '没有这个工具：' + name + '（打开 http://127.0.0.1:' + listening.port + '/ 看全部工具）' });
                    return send(200, await runToolPlain(name, args));
                }
                if (req.method === 'GET') return send(405, { error: 'SSE not supported' });
                if (req.method === 'DELETE') return send(200, {});
                if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
                const raw = await readBody(req);
                let msg;
                try { msg = JSON.parse(raw); } catch (e) { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
                if (Array.isArray(msg)) {
                    const out = (await Promise.all(msg.map(handleRpc))).filter(Boolean);
                    return out.length ? send(200, out) : send(202, null);
                }
                const r = await handleRpc(msg);
                return r ? send(200, r) : send(202, null);
            });
            const want = Number(cfg.port) >= DEFAULT_PORT && Number(cfg.port) < DEFAULT_PORT + PORT_SPAN ? Number(cfg.port) : DEFAULT_PORT;
            const order = [want].concat(Array.from({ length: PORT_SPAN }, (_, i) => DEFAULT_PORT + i).filter((p) => p !== want));
            const tryListen = (i) => {
                if (i >= order.length) { console.warn('[cover-maker] MCP 服务起不来：' + DEFAULT_PORT + '~' + (DEFAULT_PORT + PORT_SPAN - 1) + ' 都被占了'); resolve(null); return; }
                s.once('error', (e) => {
                    if (e.code === 'EADDRINUSE') { tryListen(i + 1); return; }      // 被占 → 试下一个（固定范围，不随机）
                    console.warn('[cover-maker] MCP 服务起不来:', e.message);
                    resolve(null);
                });
                s.listen(order[i], '127.0.0.1', () => {
                    server = s;
                    listening = { port: s.address().port };
                    if (cfg.port !== listening.port) { cfg.port = listening.port; writeCfg(cfg); }
                    writeGuideFile();
                    console.log('[cover-maker] AI 调用服务已开：http://127.0.0.1:' + listening.port + '/（说明书） /mcp（MCP） /call/<工具>');
                    resolve(listening);
                });
            };
            tryListen(0);
        });
    }
    function stop() {
        if (server) { try { server.close(); } catch (e) { /* 已关 */ } }
        server = null; listening = null;
    }
    function enabled() { return readCfg().enabled !== false; }          // 默认开：只有用户明确关过才是关
    function setEnabled(on) {
        const c = ensureToken(readCfg());
        c.enabled = !!on;
        writeCfg(c);
        // 服务已经开着、文件里的令牌却换了（agent.json 被删 / 改过）→ 跟文件对齐，否则拿文件里令牌的都 401
        if (on && server && token !== c.token) { token = c.token; writeGuideFile(); }
        return on ? start() : (stop(), Promise.resolve(null));
    }
    function startIfEnabled() { if (enabled()) start(); }
    // 重置令牌：旧令牌立刻失效（开着的服务当场换），说明书 / 说明文件跟着更新
    function resetToken() {
        const c = readCfg();
        c.token = crypto.randomBytes(24).toString('hex');
        writeCfg(ensureToken(c));
        token = c.token;
        writeGuideFile();
        return c.token;
    }
    function guideUrl() { return 'http://127.0.0.1:' + (listening ? listening.port : (readCfg().port || DEFAULT_PORT)); }
    function sayToAgent() { return '用封面制作器帮我做封面，它在 ' + guideUrl() + ' ，先打开这个地址看使用说明。'; }

    // ---------- 给用户的配置 ----------
    function launchCommand() {
        // 打包后：可执行文件本身；开发时（npx electron .）：electron + 工程目录
        return app.isPackaged ? { command: process.execPath, args: ['--mcp-stdio'] }
            : { command: process.execPath, args: [app.getAppPath(), '--mcp-stdio'] };
    }
    function desktopConfig() {
        const l = launchCommand();
        return JSON.stringify({ mcpServers: { 'cover-maker': { command: l.command, args: l.args } } }, null, 2);
    }
    function codeCommand() {
        const c = ensureToken(readCfg());
        return 'claude mcp add --transport http cover-maker http://127.0.0.1:' + (listening ? listening.port : c.port) + '/mcp --header "Authorization: Bearer ' + c.token + '"';
    }
    async function showDialog(win) {
        for (;;) {
            const on = enabled();
            const r = await dialog.showMessageBox(win, {
                type: 'info', title: 'AI 调用',
                message: on ? 'AI 调用：已打开' : 'AI 调用：已关闭',
                detail: (on ? [
                    'Claude、Cursor 等 AI 助手可以直接操作封面制作器：勾平台、放图片、加文字 / 形状 / 贴纸、套模板、截图检查、导出封面。',
                    '',
                    '不用设置，直接对 AI 说（能上网 / 能运行命令的 AI 都行）：',
                    '「' + sayToAgent() + '」',
                    '',
                    '· 只在这台电脑上能连，外网连不进来；软件要开着、已激活。',
                    '· Claude Desktop 这类只认 MCP 配置的 AI：点「复制 Claude Desktop 配置」，粘进它的配置文件后重启一次。',
                    '· 说明也存了一份文件：' + guideFile(),
                    '· 「重置令牌」：之前连过的 AI 都会断开，要再对它说一遍上面那句话。'
                ] : [
                    '打开后，Claude、Cursor 等 AI 助手可以直接操作封面制作器（只在这台电脑上能连）。'
                ]).join('\n'),
                buttons: on ? ['关闭 AI 调用', '重置令牌', '复制 Claude Desktop 配置', '完成'] : ['打开 AI 调用', '完成'],
                defaultId: on ? 3 : 1, cancelId: on ? 3 : 1, noLink: true
            });
            if (!on) { if (r.response === 0) { await setEnabled(true); continue; } return; }
            if (r.response === 0) { await setEnabled(false); continue; }
            if (r.response === 1) {
                resetToken();
                await dialog.showMessageBox(win, { type: 'info', title: 'AI 调用', message: '令牌已重置', detail: '之前连过的 AI 都断开了。要继续用，再对它说一遍：\n「' + sayToAgent() + '」\n（Claude Desktop 这类走配置的不受影响，它每次自己读最新的令牌。）', buttons: ['好'] });
                continue;
            }
            if (r.response === 2) {
                clipboard.writeText(desktopConfig());
                await dialog.showMessageBox(win, { type: 'info', title: 'AI 调用', message: '已复制 Claude Desktop 配置', detail: '粘到 claude_desktop_config.json 的最外层（已经有 mcpServers 的话，只把 "cover-maker" 那一项放进去），保存后重启 Claude Desktop。', buttons: ['好'] });
                continue;
            }
            return;
        }
    }

    // ---------- --mcp-stdio：转发进程（不开窗口）----------
    function bridge() {
        if (process.platform === 'darwin' && app.dock) { try { app.dock.hide(); } catch (e) { /* 老系统 */ } }
        // ⚠ Windows 上 Electron 主进程的 process.stdin 一启动就 'end'（实测：转发进程秒退）→ 读 / 写都直接走文件描述符 0 / 1
        const out = (obj) => { try { fs.writeSync(1, JSON.stringify(obj) + '\n'); } catch (e) { /* 对方关了 */ } };
        const errOf = (id, message) => ({ jsonrpc: '2.0', id: id == null ? null : id, error: { code: -32000, message: message } });
        let launching = null;
        const post = (body) => new Promise((resolve, reject) => {
            const c = readCfg();
            if (c.enabled === false) { reject(new Error('disabled')); return; }
            if (!c.token) { reject(new Error('no-config')); return; }        // 软件还没开过（没生成令牌）→ 当成没开，下面会把它拉起来
            const data = JSON.stringify(body);
            const req = http.request({ host: '127.0.0.1', port: c.port || DEFAULT_PORT, path: '/mcp', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': 'Bearer ' + c.token, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (x) => { raw += x; });
                res.on('end', () => resolve({ status: res.statusCode, body: raw }));
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
        // 软件没开 → 把它打开，等服务起来
        const ensureApp = () => {
            if (launching) return launching;
            launching = (async () => {
                const l = launchCommand();
                const args = l.args.filter((a) => a !== '--mcp-stdio')
                    .concat(process.argv.filter((a) => a.startsWith('--user-data-dir')))    // 用的是哪个数据目录，拉起来的软件也用同一个（自检 / 多份数据时）
                    .concat(['--agent-launch']);                                             // M249：拉起来后窗口放到最前面
                try { cp.spawn(l.command, args, { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* 起不来就等超时 */ }
                for (let i = 0; i < 80; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    try { const r = await post({ jsonrpc: '2.0', id: '__probe', method: 'ping' }); if (r.status === 200) return true; } catch (e) { /* 还没起来 */ }
                }
                return false;
            })().finally(() => { setTimeout(() => { launching = null; }, 0); });
            return launching;
        };
        const forward = async (msg) => {
            const id = msg && msg.id;
            let r;
            try { r = await post(msg); }
            catch (e) {
                if (e.message === 'disabled') { if (id != null) out(errOf(id, '封面制作器里的 AI 调用被关掉了')); return; }
                const up = await ensureApp();
                if (!up) { if (id != null) out(errOf(id, '封面制作器没能打开。请手动打开软件后再试')); return; }
                try { r = await post(msg); } catch (e2) { if (id != null) out(errOf(id, '连不上封面制作器：' + e2.message)); return; }
            }
            if (r.status === 202 || !r.body) return;
            if (r.status !== 200) { if (id != null) out(errOf(id, '封面制作器返回 ' + r.status + '：' + r.body.slice(0, 200))); return; }
            try { out(JSON.parse(r.body)); } catch (e) { if (id != null) out(errOf(id, '回复看不懂')); }
        };
        let buf = '';
        let pending = Promise.resolve();
        const input = fs.createReadStream(null, { fd: 0, encoding: 'utf8' });
        input.on('error', () => { pending.then(() => app.exit(0)); });
        input.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
                pending = pending.then(() => forward(msg));                     // 按顺序转发（initialize 一定先到）
            }
        });
        input.on('end', () => { pending.then(() => app.exit(0)); });
    }

    return { start, stop, enabled, setEnabled, startIfEnabled, showDialog, bridge, handleRpc, desktopConfig, codeCommand, TOOLS,
             resetToken, sayToAgent, guideUrl, agentGuide, guideFile,
             status: () => ({ enabled: enabled(), listening: listening }) };
};
