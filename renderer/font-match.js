// 字体不在电脑上时：找相近的先顶上，并给出一句要转告用户的话（用户 2026-10-21：
//   「如果没有某个字体，agent 要去提示用户没有这种字体，需要去下载安装后才能使用，或者用相似字体替换」）。
// 渲染层（window.CoverMakerFontMatch）和 Node 测试（require）共用这一份；纯函数，不碰 DOM。
(function (root) {
    'use strict';

    function norm(s) { return String(s || '').toLowerCase().replace(/[\s\-_]+/g, ''); }

    const WEIGHTS = [
        ['heavy', /heavy|black|bold|特粗|超粗|粗|重/],
        ['light', /light|thin|细|纤/]
    ];
    // 精确字重词（同一档里 Heavy ≠ Bold；2026-10-22 真实 agent：要「思源黑体 Heavy」首选成了 CN Bold）
    const WEIGHT_WORDS = ['extrabold', 'semibold', 'extralight', 'ultralight', 'heavy', 'black', 'bold', 'medium', 'light', 'thin', '特粗', '超粗', '粗', '细', '纤'];
    function weightWordOf(s) { const n = norm(s); return WEIGHT_WORDS.find((w) => n.indexOf(w) >= 0) || ''; }
    // 顺序有讲究：仿宋在宋前、楷在书法前（「华文行楷」算楷体）
    const CATEGORIES = [
        ['fangsong', /仿宋|fangsong/],
        ['kai', /楷|kai/],
        ['song', /宋|song|明朝|ming|serif|mincho/],
        ['yuan', /圆|yuan|round/],
        ['brush', /书法|行书|草书|手书|毛笔|brush|calligraph/],     // 「汉仪尚巍手书」这类毛笔手写（10-21 真实 agent 撞上：只按品牌配到了楷体）
        ['hand', /手写|手迹|hand|可爱|卡通|童/],
        ['hei', /黑|hei|yahei|sans|gothic|苹方|pingfang/],
        ['art', /站酷|综艺|标题|庞门|优设|快乐|艺术|zcool|display|创意/]
    ];
    const FAMILY_NOISE = /(cn|sc|tc|jp|kr|std|pro|heavy|black|bold|semibold|medium|regular|normal|light|thin|extralight|特粗|超粗|粗|细|纤|常规|中)/g;

    function weightOf(s) { const n = norm(s); const w = WEIGHTS.find(([, re]) => re.test(n)); return w ? w[0] : 'regular'; }
    function categoryOf(s) { const n = norm(s); const c = CATEGORIES.find(([, re]) => re.test(n)); return c ? c[0] : null; }
    function familyOf(s) { return norm(s).replace(FAMILY_NOISE, ''); }
    function brandOf(s) { const m = /^[一-鿿]{2}/.exec(norm(s)); return m ? m[0] : null; }

    // → { found: true, font }（有这个字体，font = 电脑上的准确写法）
    //   { found: false, requested, used, similar: [最多 5 个] }（没有：used = 拿来顶上的那个；一个像的都没有 = 默认字体）
    function matchFont(requested, available, defaultFont) {
        const req = String(requested || '').trim();
        if (!req) return { found: true, font: '' };
        const list = (available || []).filter(Boolean);
        const exact = list.find((f) => norm(f) === norm(req));
        if (exact) return { found: true, font: exact };
        const fam = familyOf(req), cat = categoryOf(req), wt = weightOf(req), brand = brandOf(req), ww = weightWordOf(req);
        const scored = list.map((f, i) => {
            let s = 0;
            if (fam && familyOf(f) === fam) s += 10;
            if (cat && categoryOf(f) === cat) s += 5;
            if (brand && brandOf(f) === brand) s += 3;
            if (s > 0 && weightOf(f) === wt) s += 2;       // 粗细只在已经沾边时用来排先后，单靠粗细一样不算像
            if (s > 0 && ww && weightWordOf(f) === ww) s += 1;   // 同一档里字重词也一样（Heavy 对 Heavy）再往前排
            return { f, s, i };
        }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
        const similar = scored.slice(0, 5).map((x) => x.f);
        return { found: false, requested: req, used: similar[0] || defaultFont || '', similar };
    }

    // agent 必须原样（或意思不变地）转告用户的那句话
    // opts.plan = true：只是查了一下（check_fonts），还没开始做 → 让用户选（用户 2026-10-22「不存在的话需要去告诉用户，然后由用户做选择后再继续」）
    function missingFontNotice(m, opts) {
        if (!m || m.found) return '';
        if (opts && opts.plan) {
            const near = m.similar.length ? '用相近的「' + m.used + '」' + (m.similar.length > 1 ? '（或从这几个里挑：' + m.similar.map((x) => '「' + x + '」').join('、') + '）' : '')
                                           : '用默认字体「' + m.used + '」';
            return '电脑上没有「' + m.requested + '」这个字体。请选择：① 先下载安装「' + m.requested + '」（或在封面制作器里用「导入字体」导入字体文件），装好后告诉我；② ' + near + '。你选好我再继续做。';
        }
        const head = '电脑上没有「' + m.requested + '」这个字体，';
        const verb = opts && opts.plan ? '可以先用' : '已先用';
        const now = m.similar.length ? verb + '相近的「' + m.used + '」代替' : verb + '默认字体「' + m.used + '」代替';
        return head + now + '。想用原字体的话，请先下载安装「' + m.requested + '」（或在封面制作器里用「导入字体」导入字体文件），然后告诉我，我再换回来'
            + (m.similar.length > 1 ? '；也可以从这几个相近的里挑一个：' + m.similar.map((x) => '「' + x + '」').join('、') : '') + '。';
    }

    const api = { matchFont, missingFontNotice };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CoverMakerFontMatch = api;
})(typeof window !== 'undefined' ? window : this);
