// M249 Task 7：把 agent-core/layout-engine.js 算出来的「布局计划」落到画布上。
// 只调注入进来的现成能力（AI 工具那一套 add_image / add_text / add_shape …），不自己碰 Konva ——
// 这样落地效果和 agent 一个个工具手调完全一致，撤销 / 图层 / 导出也都走原来的路。
// 出错就 throw：调用方（create_cover）负责回滚事务。图片放不进去不算错 → 记 warning、改铺纯色。
(function () {
    'use strict';

    function must(r, what) {
        if (!r || !r.ok) throw new Error(what + '失败：' + ((r && r.error) || '没有返回'));
        return r;
    }

    function frameSize(frames, no) {
        const f = (frames || []).find((x) => x.no === no);
        if (!f) throw new Error('画布上没有第 ' + no + ' 块框');
        const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(String(f.canvas_size || ''));
        if (!m) throw new Error('第 ' + no + ' 块框的尺寸读不到');
        return { w: Number(m[1]), h: Number(m[2]) };
    }

    // 纯色背景 = 一块铺满整框的矩形（略放大一点，免得边上露出一像素白线；框外部分本来就不显示）
    async function addSolid(h, frameNo, color, size) {
        const short = Math.min(size.w, size.h);
        const r = must(await h.addShape({ shape: 'rect', frame: frameNo, x: 0.5, y: 0.5,
                                          width: size.w / short * 1.02, height: size.h / short * 1.02, fill: color }), '铺背景色');
        return r.element.id;
    }
    // 保留原内容时（默认，用户 2026-10-21）：新背景垫到最底层，原来的东西不被盖住
    async function sendToBottom(h, id) {
        must(await h.setAttrs({ id: id, z: 'bottom' }), '背景放到最底层');
    }

    async function addText(h, frameNo, el) {
        const args = { text: el.text, frame: frameNo, x: el.x, y: el.y, size: el.size, color: el.color, shadow: !!el.shadow };
        if (el.stroke_color || el.stroke_width) { args.stroke_color = el.stroke_color; args.stroke_width = el.stroke_width; }   // custom_style 的描边
        if (el.font) args.font = el.font;
        if (el.gradient) args.gradient = el.gradient;                          // custom_style.title_gradient_to
        const r = must(await h.addText(args),
                       '加「' + el.role + '」文字');
        const id = r.element.id;
        let info = must(await h.setAttrs({ id: id, align: el.align || 'center', lineHeight: 1.25,
                                           role: el.role, ref_id: el.ref_id }), '设文字语义和对齐').element;
        // 左 / 右对齐：文字节点宽 = 最长那行，要把它的左边 / 右边贴到计划里文本框的边上
        if (el.box && (el.align === 'left' || el.align === 'right')) {
            const x = el.align === 'left' ? el.box.x + info.w / 2 : el.box.x + el.box.w - info.w / 2;
            info = must(await h.update({ id: id, frame: frameNo, x: x, y: el.box.y + info.h / 2 }), '摆文字').element;
        }
        return id;
    }

    async function tagElement(h, id, el, extra) {
        const attrs = Object.assign({ id: id, role: el.role, ref_id: el.ref_id }, extra || {});
        must(await h.setAttrs(attrs), '标记「' + el.role + '」图层');
        return id;
    }

    function byLayer(a, b) {
        const al = Number.isFinite(Number(a.layer)) ? Number(a.layer) : 0;
        const bl = Number.isFinite(Number(b.layer)) ? Number(b.layer) : 0;
        return al - bl || a.seq - b.seq;
    }

    async function applyPlan(plan, h, opts) {
        if (!plan || !plan.ok || !Array.isArray(plan.frames)) throw new Error('布局计划不对');
        const warnings = [];
        const created = [];
        if (opts && opts.clear) must(await h.clearCanvas(), '清空画布');
        const frames = h.getFrames();
        const before = h.getCanvas ? h.getCanvas().elements : [];
        for (const f of plan.frames) {
            const size = frameSize(frames, f.frame);
            const bg = f.background || {};
            const order = [];
            let seq = 0;
            let photoId = null;
            if (bg.type === 'image') {
                const r = await h.addImage({ path: bg.path, frame: f.frame });
                if (r && r.ok && r.element) { photoId = r.element.id; created.push(photoId); }
                else {
                    warnings.push('第 ' + f.frame + ' 块框：图片「' + bg.path + '」放不进去（' + ((r && r.error) || '未知原因') + '），改用纯色背景');
                    created.push(await addSolid(h, f.frame, bg.fallbackColor || '#FFFFFF', size));
                }
            } else {
                created.push(await addSolid(h, f.frame, bg.color || '#FFFFFF', size));
            }
            const backgroundId = created[created.length - 1];
            await tagElement(h, backgroundId, Object.assign({ role: 'background', ref_id: 'background' }, bg));
            order.push({ id: backgroundId, layer: Number(bg.layer) || 0, seq: seq++ });
            if (!(opts && opts.clear) && !h.setLayerOrder) await sendToBottom(h, backgroundId);
            for (const el of f.elements || []) {
                if (el.type === 'shape') {
                    const r = must(await h.addShape({ shape: el.shape, frame: f.frame, x: el.x, y: el.y, width: el.width, height: el.height, fill: el.fill }),
                                   '加「' + el.role + '」形状');
                    await tagElement(h, r.element.id, el, el.opacity != null ? { opacity: el.opacity } : null);
                    created.push(r.element.id);
                    order.push({ id: r.element.id, layer: el.layer, seq: seq++ });
                } else if (el.type === 'text') {
                    const id = await addText(h, f.frame, el);
                    created.push(id);
                    order.push({ id: id, layer: el.layer, seq: seq++ });
                } else if (el.type === 'subject') {
                    // 抠主体放最上层（人挡字）：抠不出来（Windows / 图里没认出主体）不算失败，记 warning、封面照常
                    if (!photoId) continue;
                    const r = h.extractSubject ? await h.extractSubject({ id: photoId, outline: el.outline }) : { ok: false, error: '不支持' };
                    if (r && r.ok && r.element) {
                        await tagElement(h, r.element.id, el);
                        created.push(r.element.id);
                        order.push({ id: r.element.id, layer: el.layer, seq: seq++ });
                    } else warnings.push('第 ' + f.frame + ' 块框：没能把主体抠出来放到文字上面（' + ((r && r.error) || '未知原因') + '），字照常在照片上');
                } else {
                    warnings.push('不认识的元素类型：' + el.type);
                }
            }
            if (h.setLayerOrder) {
                const planned = order.sort(byLayer).map((x) => x.id);
                // 默认保留用户原内容：新生成的整套图层放在原内容下面，原内容仍在最上面。
                const preserved = before.filter((e) => e.frame === f.frame).slice().reverse().map((e) => e.id);
                must(await h.setLayerOrder({ frame: f.frame, bottom_to_top: planned.concat(preserved) }), '按计划设置图层');
            }
        }
        if (h.setStatus) h.setStatus('AI：自动排版完成（' + plan.frames.length + ' 块框）');
        return { ok: true, elements: created, warnings: warnings };
    }

    window.CoverMakerAutoLayout = { applyPlan: applyPlan };
})();
