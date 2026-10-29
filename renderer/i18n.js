// 界面中英切换（用户 2026-10-29「加一个设置，里面可以选择语言，中英文两种，当用户选择中文界面就是中文，选择英文界面就是英文」）
//
// 做法：原有代码里的中文一个都不改。界面上**显示出来**的字 —— 文本节点、title / placeholder / alt / aria-label、alert / confirm —
//   在英文模式下按 i18n-en.js 的字典换成英文；MutationObserver 盯着之后新出现 / 被改掉的字。切回中文 = 把记下的原文放回去。
//   · 先整句查字典；查不到再按「片段」换（代码里是 '已导入 ' + n + ' 张到画布' 这样拼的，字典里存的是拼句用的片段）。
//   · 「」里的东西多半是用户自己的内容（文字、模板名、字体名）：整段在字典里才换，否则原样保留，只把括号换成英文引号。
//   · 不碰：Konva 画布（不是 DOM）、输入框里的值、[contenteditable]、带 data-no-i18n 的元素。
//   · 语言存在主进程（userData/settings.json，菜单要用）；浏览器打开（没有 coverApp）时退回 localStorage。
(function () {
    const DICT = window.CM_I18N_EN || {};
    const CJK = /[一-鿿]/;
    const ATTRS = ['title', 'placeholder', 'alt', 'aria-label'];
    const SKIP_SEL = '[data-no-i18n], script, style, textarea, svg, [contenteditable="true"], [contenteditable=""]';   // svg：图标里画的字（顶栏「文字」图标的「字」）不换
    const LS_KEY = 'cm_lang_v1';
    // 数字后面的量词（片段换完还剩下的）
    const UNITS = { 张: 'image(s)', 个: '', 块: '', 层: '', 步: 'step(s)', 条: '', 段: '', 种: '', 秒: 's' };
    const PUNCT = { '（': ' (', '）': ') ', '：': ': ', '；': '; ', '，': ', ', '、': ', ', '。': '. ', '！': '! ', '？': '? ', '「': '"', '」': '"', '　': ' ', '·': '·' };
    const MARK = '\u0001';

    let lang = 'zh';
    try {
        const bridge = window.coverApp && window.coverApp.i18n;
        lang = (bridge && bridge.getLang()) || localStorage.getItem(LS_KEY) || 'zh';
    } catch (e) { /* 读不到就中文 */ }
    if (lang !== 'en') lang = 'zh';

    // 字典里带「　·　」的条目：界面上的字是按「　·　」切开分段翻的 → 把这种条目也拆成一段一段补进字典
    //   （如 '°　·　按住 Shift = 15° 一档' 补出 '按住 Shift = 15° 一档'；'·　还可撤销' 补出 '还可撤销'）
    Object.keys(DICT).forEach((k) => {
        if (k.indexOf('·') < 0) return;
        const ks = k.split(/\s*·\s*/), vs = String(DICT[k]).split(/\s*·\s*/);
        if (ks.length !== vs.length) return;
        ks.forEach((p, i) => { p = p.trim(); if (p && CJK.test(p) && !(p in DICT)) DICT[p] = vs[i].trim(); });
    });

    // 片段正则：长的在前（同一位置先匹配最长的）；单字不进（太容易误伤用户自己的字）
    const fragKeys = Object.keys(DICT).filter((k) => k.length >= 2 && CJK.test(k)).sort((a, b) => b.length - a.length);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const FRAG_RE = fragKeys.length ? new RegExp(fragKeys.map(esc).join('|'), 'g') : null;

    const wrap = (v) => (v.charAt(0) === '"' ? '' : MARK) + v + (v.charAt(v.length - 1) === '"' ? '' : MARK);
    const exact = (s) => (Object.prototype.hasOwnProperty.call(DICT, s) ? DICT[s] : undefined);

    function translateFragments(t) {
        // 「…」区间：片段完全落在括号里面就不换（用户的内容），带着括号一起的片段（如「已把框分成「」）照换
        const spans = [];
        t.replace(/「[^「」]*」/g, (m, off) => { spans.push([off, off + m.length]); return m; });
        const inside = (a, b) => spans.some((s) => a > s[0] && b < s[1]);
        let out = FRAG_RE ? t.replace(FRAG_RE, (m, off) => (inside(off, off + m.length) ? m : wrap(DICT[m]))) : t;
        out = out.replace(/「([^「」]*)」/g, (m, x) => { const v = exact(x.trim()); return '"' + (v !== undefined ? v : x) + '"'; });
        out = out.replace(/(\d)\s*([张个块层步条段种秒])(?![一-鿿])/g, (m, d, u) => d + (UNITS[u] ? ' ' + UNITS[u] : ''));
        out = out.replace(/[一-鿿][一-鿿0-9A-Za-z]*/g, (m) => { const v = exact(m); return v !== undefined ? wrap(v) : m; });
        out = out.replace(/[（）：；，、。！？「」　]/g, (c) => PUNCT[c]);
        out = out.replace(/[ \t]*\u0001[ \t\u0001]*/g, ' ')
            .replace(/ {2,}/g, ' ')
            .replace(/ ([,.;:!?)%°])/g, '$1')
            .replace(/\( /g, '(')
            .replace(/""/g, '"');
        // 引号里侧不留空格：「抖音 3:4」→ "Douyin 3:4"（不是 " Douyin 3:4 "）
        let open = false;
        out = out.replace(/\s*"\s*/g, (m) => {
            open = !open;
            const before = /^\s/.test(m) && open ? ' ' : '', after = /\s$/.test(m) && !open ? ' ' : '';
            return before + '"' + after;
        });
        return out.trim();
    }

    function translateSeg(seg) {
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(seg);
        const t = m[2];
        if (!CJK.test(t)) return seg;
        const v = exact(t);
        return m[1] + (v !== undefined ? v : translateFragments(t)) + m[3];
    }

    const cache = new Map();
    function translate(str) {
        if (lang !== 'en' || !str || !CJK.test(str)) return str;
        const hit = cache.get(str);
        if (hit !== undefined) return hit;
        const whole = exact(str.trim());
        const out = whole !== undefined
            ? str.replace(str.trim(), () => whole)
            : str.split('\n').map((line) => line.split('　·　').map(translateSeg).join(' · ')).join('\n');
        if (cache.size > 5000) cache.clear();
        cache.set(str, out);
        return out;
    }

    // —— DOM：记原文，按当前语言写回 ——
    const textRec = new WeakMap();     // 文本节点 → { orig, shown }
    const attrRec = new WeakMap();     // 元素 → { 属性名: { orig, shown } }
    const skipped = (el) => !!(el && el.closest && el.closest(SKIP_SEL));

    function doText(n) {
        if (skipped(n.parentElement)) return;
        const rec = textRec.get(n);
        const orig = (rec && n.data === rec.shown) ? rec.orig : n.data;
        if (!CJK.test(orig)) { if (rec) textRec.delete(n); return; }
        const shown = translate(orig);
        textRec.set(n, { orig: orig, shown: shown });
        if (n.data !== shown) n.data = shown;
    }
    function doAttr(el, a) {
        if (!el.hasAttribute(a) || skipped(el)) return;
        let recs = attrRec.get(el);
        const cur = el.getAttribute(a);
        const rec = recs && recs[a];
        const orig = (rec && cur === rec.shown) ? rec.orig : cur;
        if (!CJK.test(orig)) { if (rec) delete recs[a]; return; }
        const shown = translate(orig);
        if (!recs) { recs = {}; attrRec.set(el, recs); }
        recs[a] = { orig: orig, shown: shown };
        if (cur !== shown) el.setAttribute(a, shown);
    }
    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { doText(root); return; }
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        if (root.nodeType === 1 && skipped(root)) return;
        const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) doText(n);
        if (root.nodeType === 1) ATTRS.forEach((a) => doAttr(root, a));
        root.querySelectorAll('[title],[placeholder],[alt],[aria-label]').forEach((el) => ATTRS.forEach((a) => doAttr(el, a)));
    }

    const mo = new MutationObserver((list) => {
        for (const m of list) {
            if (m.type === 'characterData') doText(m.target);
            else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
            else m.addedNodes.forEach(walk);
        }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => walk(document.documentElement));
    else walk(document.documentElement);

    // 原生弹框（代码里还有一些 alert / confirm）
    const nativeAlert = window.alert.bind(window), nativeConfirm = window.confirm.bind(window);
    window.alert = (msg) => nativeAlert(translate(String(msg)));
    window.confirm = (msg) => nativeConfirm(translate(String(msg)));

    function apply() {
        document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
        document.documentElement.setAttribute('data-lang', lang);
        cache.clear();
        walk(document.documentElement);
    }
    apply();

    window.CMI18N = {
        get lang() { return lang; },
        t: translate,
        // 元素里的字「翻译前」是什么（代码要读回界面上的字再拼时用，见 index.html hintStatus）
        origText(el) {
            let out = '';
            const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let n = tw.nextNode(); n; n = tw.nextNode()) {
                const rec = textRec.get(n);
                out += (rec && n.data === rec.shown) ? rec.orig : n.data;
            }
            return out;
        },
        // 切语言：界面立刻换。平时由菜单「设置 → 语言」从主进程叫过来（fromMain，主进程已经存好了）；
        //   页面自己调（自检 / 浏览器打开）时再经 coverApp.i18n.setLang 让主进程记住
        setLang(next, opts) {
            next = next === 'en' ? 'en' : 'zh';
            if (next === lang) return Promise.resolve(lang);
            lang = next;
            try { localStorage.setItem(LS_KEY, lang); } catch (e) { /* 存不了就只管这一次 */ }
            apply();
            window.dispatchEvent(new CustomEvent('cm-lang-change', { detail: { lang: lang } }));
            const bridge = !(opts && opts.fromMain) && window.coverApp && window.coverApp.i18n;
            return bridge ? Promise.resolve(bridge.setLang(lang)).then(() => lang, () => lang) : Promise.resolve(lang);
        }
    };
})();
