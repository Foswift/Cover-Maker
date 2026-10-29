/* 封面制作器 · 颜色板块（§4.0，用户 2026-10-12「接下来做颜色板块，固定放到属性框上面，样式参考桌面上的颜色前端样式 + 颜色模块-独立模块版这个排版，只需要rgb和图片两个功能」）
   来源：桌面《颜色模块-独立模块版》Colors.js 原样搬过来，只改了「宿主接口」这一处（见 applyColor / init 里标 ★ 的地方）：
     · 原模块写的是另一个工程的 Project / History / Canvas → 这里换成 window.__cmColorApply(hex)（index.html 里实现：
       选中文字 → 改文字色；选中抠出来的主体 → 改描边色；会进撤销）；
     · 「应用到哪」的下拉（color-target）宿主没放 → syncTargetOptions / Project.on 那两行去掉；
     · 图片页（用户同日「选一张图→提主色、挑色槽、清空槽位这三个部分去掉」+ 选了「用画布上选中的照片」）：
       宿主不放按钮 / 槽位 → 提色板色块点一下直接应用；切到图片页时调 window.__cmColorsOnImageTab()，由宿主从选中照片提色。
   引擎部分（配色方案 / 换算 / 图片提色）一行没动。 */

/* Colors.js — 颜色引擎 + 薄 UI 层（T5 · 对标 Color Gear X）
   ─────────────────────────────────────────────────────────────
   【文件结构】上半 = 引擎（纯函数，与 DOM 无关，换 UI 时这一半一行都不用动）
             下半 = UI 层（只负责把状态画到 DOM 上，换皮只改这一段）
   【实测来源】13 个方案的角度/色数是用 13 张 Color Gear X 截图逐点量出来的
             （圆心 587,1245 / R513，色点角度误差 <1.5°），不是猜的
   【对外接口】Colors.init()           初始化
             Colors.paletteFor(...)  纯函数，取任意方案配色
             Colors.extractPalette(img, n)  纯函数，从图提 n 个主色
   ───────────────────────────────────────────────────────────── */

const Colors = (() => {
  /* ============================================================
     一、引擎层（纯函数，零 DOM 依赖）
     ============================================================ */

  // ---------- 1. 13 种配色和谐（角度=色相偏移，实测自 Color Gear X）----------
  // angles 长度 = 该方案输出的颜色数（原软件每个方案色数不同：2/3/4/6）
  const SCHEMES = [
    { key: 'complement', name: '互补',     angles: [0, 180] },
    { key: 'near2',      name: '邻近双色', angles: [0, 30] },
    { key: 'near3',      name: '邻近三色', angles: [0, 30, 60] },
    { key: 'near4',      name: '邻近四色', angles: [0, 30, 60, 90] },
    { key: 'near210',    name: '邻近+对位', angles: [0, 150, 180, 210] },   // 原 [0, 30, 60, 210] → 顶点 210（对着那一簇的中心 30）
    // 分裂互补 / 三角邻近 / 邻近+对位：取样点（空心圆 = angles[0]）必须是形状的**顶点**（单独对着那一簇的那个尖），不是底角
    //   （用户 2026-10-13 对着截图：「空心圆应该是左上角 / 右上角的实心圆」）。形状不变，只换哪个点是取样点：
    //   分裂互补 原 [0, 60, 210] → 顶点 210 → [0, 150, 210]（= 取样色 + 补色两侧各 30°，标准分裂互补）
    //   三角邻近 原 [0, 60, 120, 240] → 对称轴 60↔240、顶点 240 → [0, 120, 180, 240]
    { key: 'split',      name: '分裂互补', angles: [0, 150, 210] },
    { key: 'triad',      name: '三角',     angles: [0, 120, 240] },
    { key: 'triadNear',  name: '三角邻近', angles: [0, 120, 180, 240] },
    { key: 'square',     name: '四角',     angles: [0, 90, 180, 270] },
    { key: 'rect',       name: '矩形',     angles: [0, 60, 180, 240] },
    { key: 'doubleComp', name: '双重互补', angles: [0, 30, 60, 180, 210, 240] },
    { key: 'hexad',      name: '六色均分', angles: [0, 60, 120, 180, 240, 300] },
    { key: 'mono',       name: '单色',     angles: [0, 0, 0, 0, 0, 0], tone: 'shade' },
  ];

  // ---------- 2. 颜色换算 ----------
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, max ? d / max : 0, max];
  }

  const toHex = (r, g, b) =>
    '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
  const hsvHex = (h, s, v) => toHex(...hsvToRgb(h, s, v));

  function hexToHsv(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }

  // ---------- 3. 和谐配色（纯函数：给方案+主色 → 一组颜色）----------
  function paletteFor(schemeKey, h, s, v) {
    const sc = SCHEMES.find(x => x.key === schemeKey) || SCHEMES[0];
    return sc.angles.map((a, i) => {
      if (sc.tone === 'shade' && i > 0) {
        // 单色方案：同色相，只沿色轮半径方向降饱和 → 越往里越浅（跟色轮上取样位置一致）
        // 注意不要动明度：色轮不体现明度，动了就会"点在里面、色块却是黑的"
        const ss = Math.max(0.10, s * (1 - i * 0.17));
        return hsvHex(h + a, ss, v);
      }
      return hsvHex(h + a, s, v);
    });
  }

  // ---------- 4. 明度色阶（同色相，饱和递减+明度递增）----------
  function scaleFor(h, s, v, n = 6) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      out.push(hsvHex(h, s * (1 - 0.88 * t), v * (1 - 0.09 * t)));
    }
    return out;
  }

  // ---------- 5. 图片提色：中位切分（纯函数，提一整板色给用户挑）----------
  function medianCut(pixels, count) {
    let boxes = [pixels];
    while (boxes.length < count) {
      boxes.sort((a, b) => b.length - a.length);
      const box = boxes.shift();
      if (!box || box.length < 2) { boxes.push(box); break; }
      let channel = 0, range = -1;
      for (let ch = 0; ch < 3; ch++) {
        let mn = 255, mx = 0;
        for (const p of box) { if (p[ch] < mn) mn = p[ch]; if (p[ch] > mx) mx = p[ch]; }
        if (mx - mn > range) { range = mx - mn; channel = ch; }
      }
      box.sort((a, b) => a[channel] - b[channel]);
      const mid = Math.floor(box.length / 2);
      boxes.push(box.slice(0, mid), box.slice(mid));
    }
    return boxes.filter(b => b.length).map(box => {
      let r = 0, g = 0, bl = 0;
      for (const p of box) { r += p[0]; g += p[1]; bl += p[2]; }
      const n = box.length;
      return toHex(Math.round(r / n), Math.round(g / n), Math.round(bl / n));
    });
  }

  // ★ 提色改版（用户 2026-10-13「但是有些颜色没有提取出来」）：
  //   中位切分按**像素多少**分盒子 → 面积大的颜色占好几格（重复）、面积小但很显眼的颜色（红 logo、黄字）被平均掉。
  //   新做法：① 缩图**不插值**（最近邻取样），细节保持原色，不被糊成中间色；
  //          ② 按 5 位/通道分桶计数 → 换到 Lab（人眼感知距离）→ 看起来一样的（ΔE < MERGE_DE）并成一种色，带上面积占比；
  //             占比 < MIN_SHARE 的当成边缘杂色丢掉；
  //          ③ 挑色：先拿面积最大的，之后每次挑「和已挑的最不像 × 面积权重」最高的 → 小而显眼的颜色能进来、不出重复；
  //          ④ 结果按面积从大到小排；图里不同的颜色不够 count 个就只给这么多（不拿重复色凑数）。
  //   老算法留着（medianCut）：负对照 window.__cmOldExtract = true → 走老路。
  const MERGE_DE = 12, MIN_SHARE = 0.003, PICK_MIN_DE = 10;
  function rgbToLab(r, g, b) {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  const deLab = (p, q) => Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);

  function extractPalette(img, count = 32) {
    const old = (typeof window !== 'undefined' && window.__cmOldExtract);
    const max = old ? 140 : 200;
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!old) ctx.imageSmoothingEnabled = false;          // 最近邻：小细节保持原色
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    if (old) {
      const pixels = [];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        pixels.push([data[i], data[i + 1], data[i + 2]]);
      }
      if (!pixels.length) return [];
      return medianCut(pixels, count);
    }

    // ② 分桶计数（5 位/通道 = 32768 桶），每桶记像素数和 RGB 累加（桶内取平均 = 真实颜色，不是桶中心）
    const bins = new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;                   // 抠图的透明部分不算
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let e = bins.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, e); }
      e.n++; e.r += r; e.g += g; e.b += b;
      total++;
    }
    if (!total) return [];
    // 大桶先落座，后面的桶并进最近的、看起来一样的那一簇（ΔE < MERGE_DE），否则自成一簇
    const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
    const clusters = [];
    for (const e of sorted) {
      const rgb = [e.r / e.n, e.g / e.n, e.b / e.n];
      const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
      let best = null, bestD = MERGE_DE;
      for (const c of clusters) { const d = deLab(c.lab, lab); if (d < bestD) { bestD = d; best = c; } }
      if (best) {
        best.r += e.r; best.g += e.g; best.b += e.b; best.n += e.n;   // 簇心不动（= 最大那桶的颜色），只累计面积和颜色
      } else {
        clusters.push({ lab: lab, n: e.n, r: e.r, g: e.g, b: e.b });
      }
    }
    // 丢掉边缘杂色
    const cand = clusters.filter((c) => c.n / total >= MIN_SHARE);
    if (!cand.length) cand.push(clusters[0]);
    cand.forEach((c) => { c.share = c.n / total; c.rgb = [c.r / c.n, c.g / c.n, c.b / c.n]; c.lab = rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]); });
    // ★ 用户 2026-10-15「为什么识别不到绿色」（桌搭照片里那块发光的 RELAXED 绿灯牌）：
    //   发光 / 渐变的颜色一种色深浅跨度很大（亮黄绿 → 深绿），ΔE < MERGE_DE 并不到一起 → 碎成十几个小簇，
    //   每个都 < MIN_SHARE，被当杂色**全部丢掉**（实测：绿像素占 0.61%，碎成 19 簇，最大一簇 0.10%）。
    //   补救：被丢的小簇里**够鲜艳的**（Lab 彩度 ≥ HUE_MIN_C）按色相归类（±HUE_TOL°），一类合计够 MIN_SHARE
    //   → 作为一种色留下，代表色 = 这一类里面积最大的那簇。灰 / 黑 / 白这些不鲜艳的碎色照旧丢。
    //   负对照 window.__cmNoHueGroup = true → 退回只按单簇面积丢。
    if (!(typeof window !== 'undefined' && window.__cmNoHueGroup)) {
      const HUE_TOL = 20, HUE_MIN_C = 25;
      const groups = [];
      clusters.filter((c) => c.n / total < MIN_SHARE).map((c) => {
        const rgb = [c.r / c.n, c.g / c.n, c.b / c.n];
        const L = rgbToLab(rgb[0], rgb[1], rgb[2]);
        return { n: c.n, rgb: rgb, lab: L, C: Math.hypot(L[1], L[2]), H: (Math.atan2(L[2], L[1]) * 180 / Math.PI + 360) % 360 };
      }).filter((c) => c.C >= HUE_MIN_C).sort((a, b) => b.n - a.n).forEach((c) => {
        const g = groups.find((x) => { const d = Math.abs(x.H - c.H); return Math.min(d, 360 - d) <= HUE_TOL; });
        if (g) g.n += c.n; else groups.push({ H: c.H, n: c.n, seed: c });
      });
      groups.forEach((g) => {
        if (g.n / total >= MIN_SHARE) cand.push({ n: g.n, share: g.n / total, rgb: g.seed.rgb, lab: g.seed.lab });
      });
    }
    // ③ 挑色：面积最大的先进；之后挑「离已挑最近那个的 ΔE × 面积^0.25」最大的；都太像（< PICK_MIN_DE）就停
    cand.sort((a, b) => b.n - a.n);
    const picked = [cand[0]];
    while (picked.length < count) {
      let best = null, bestScore = -1;
      for (const c of cand) {
        if (picked.indexOf(c) >= 0) continue;
        let dmin = Infinity;
        for (const p of picked) { const d = deLab(p.lab, c.lab); if (d < dmin) dmin = d; }
        if (dmin < PICK_MIN_DE) continue;
        const score = dmin * Math.pow(c.share, 0.25);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (!best) break;
      picked.push(best);
    }
    // ④ 按面积从大到小
    picked.sort((a, b) => b.n - a.n);
    return picked.map((c) => toHex(Math.round(c.rgb[0]), Math.round(c.rgb[1]), Math.round(c.rgb[2])));
  }

  /* ============================================================
     二、状态
     ============================================================ */
  const FAV_KEY = 'coverforge.colorFavorites';
  const SLOTS = 6;                      // 挑色槽位数（与原软件一致）

  let state = {
    h: 48, s: 1, v: 1,                  // 主色 HSV（默认品牌黄 #FFCC00）
    scheme: 'complement',
    palette: [],                        // 当前方案配色
    scale: [],                          // 明度色阶
    board: [],                          // 从图提出的一板色（30+）
    slots: new Array(SLOTS).fill(null), // 挑色槽
    activeSlot: 0,
    favorites: [],
    target: 'fill',                     // fill | stroke | shadow | background
  };

  /* ============================================================
     三、UI 层（换皮只改这一段）
     ============================================================ */
  const F = id => document.getElementById(id);
  const WHEEL = 200;
  // 圆球不许出圆盘（用户 2026-10-13「颜色盘上的圆球不能超出圆盘」）：饱和度 100% 落在离边缘 WHEEL_INSET 的那一圈上，
  //   最大的那个圆球（取样点：半径 6.8 + 描边 1.4 = 8.2）整个留在盘里；最外面这一圈就是纯色（s = 1）。
  //   着色（drawWheel）/ 圆球位置（wheelPoint）/ 鼠标取色（bindWheel）三处用同一个半径 → 圆球底下的颜色 = 选中的颜色。
  const WHEEL_INSET = 9;
  function wheelSatR(r) { return Math.max(1, r - WHEEL_INSET * (2 * r / WHEEL)); }

  function wheelPoint(h, s) {
    const r = WHEEL / 2, rs = wheelSatR(r), rad = h * Math.PI / 180;
    return [r + Math.cos(rad) * s * rs, r + Math.sin(rad) * s * rs];
  }

  function drawWheel() {
    const c = F('color-wheel');
    if (!c) return;
    const ctx = c.getContext('2d');
    const r = c.width / 2;
    const rs = wheelSatR(r);
    const img = ctx.createImageData(c.width, c.height);
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const dx = x - r + 0.5, dy = y - r + 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * c.width + x) * 4;
        if (dist > r) { img.data[i + 3] = 0; continue; }
        let ang = Math.atan2(dy, dx) * 180 / Math.PI;
        if (ang < 0) ang += 360;
        const [rr, gg, bb] = hsvToRgb(ang, Math.min(1, dist / rs), state.v);
        img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // 联动色点（对齐原软件）：取样点 = 空心圆（永远就是鼠标选的那个）；派生色 = 实心深色圆
    const sc = SCHEMES.find(x => x.key === state.scheme);
    const dots = sc.angles.map((a, i) => {
      const hsv = hexToHsv(state.palette[i] || '');
      const h = hsv ? hsv[0] : state.h + a;
      const s = hsv ? hsv[1] : state.s;
      const [px, py] = wheelPoint(h, s);
      return { px, py, h, s, main: i === 0 };
    });

    // ① 先画派生点（实心，填该色的暗色版 → 在任何色相区都是实心深圆）
    dots.filter(d => !d.main).forEach(d => {
      ctx.beginPath();
      ctx.arc(d.px, d.py, 5.8, 0, Math.PI * 2);
      ctx.fillStyle = hsvHex(d.h, Math.min(1, d.s * 0.95), 0.32);
      ctx.fill();
    });

    // ② 取样点最后画 → 永远压在最上层，不会被派生点盖住
    const mp = dots.find(d => d.main);
    if (mp) {
      ctx.beginPath();
      ctx.arc(mp.px, mp.py, 6.8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 2.8; ctx.stroke();
      ctx.beginPath();
      ctx.arc(mp.px, mp.py, 5.2, 0, Math.PI * 2);
      ctx.strokeStyle = '#2E2E2E'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // 色块条：一个「色块 + 下方 HEX」的单元（对齐 Color Gear X：色块下方标 HEX）
  function strip(elId, colors, onClick, opts = {}) {
    const el = F(elId);
    if (!el) return;
    el.innerHTML = '';
    colors.forEach(hex => {
      const wrap = document.createElement('div');
      wrap.className = 'swatch';
      const d = document.createElement('div');
      d.className = 'color-chip' + (opts.small ? ' sm' : '');
      d.style.background = hex;
      d.dataset.hex = hex;
      d.title = hex + ' · 右键复制色值';
      if (onClick) d.addEventListener('click', () => onClick(hex));
      wrap.appendChild(d);
      if (opts.hex !== false) {
        const s = document.createElement('span');
        s.className = 'swatch-hex';
        s.textContent = hex;
        wrap.appendChild(s);
      }
      el.appendChild(wrap);
    });
  }

  // 方案图标（照原软件）：分段刻度圆环 + 每色一个「扇形块」贴在环上 + 细线连接
  //    同角度的多点沿半径向内错开（单色方案 6 色）；选中态在外围套一圈高亮环
  function schemeIcon(sc, isActive) {
    const s = 34, dpr = 2, cv = document.createElement('canvas');
    cv.width = cv.height = s * dpr;            // 2 倍内部分辨率 → 线条不糊
    cv.style.width = cv.style.height = s + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const c = s / 2;
    const R = c - 4.6;                        // 环半径

    // 1) 背景刻度圈：30 段短弧，段间留缝
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#DEDEE3';
    for (let i = 0; i < 30; i++) {
      const a0 = i / 30 * Math.PI * 2 + 0.03;
      const a1 = (i + 1) / 30 * Math.PI * 2 - 0.03;
      ctx.beginPath(); ctx.arc(c, c, R, a0, a1); ctx.stroke();
    }

    // 2) 色点位置
    const seen = {}, pts = [];
    sc.angles.forEach(a => {
      const n = (seen[a] = (seen[a] || 0) + 1) - 1;
      const rad = a * Math.PI / 180;
      const rr = Math.max(2.6, R * (1 - n * 0.2));
      pts.push([c + Math.cos(rad) * rr, c + Math.sin(rad) * rr, rad, rr]);
    });

    // 3) 连线
    if (pts.length > 1) {
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      if (pts.length > 2) ctx.closePath();
      ctx.strokeStyle = '#ADADB5'; ctx.lineWidth = 1.1; ctx.stroke();
    }

    // 4) 扇形块（径向小梯形，贴在环上）
    pts.forEach(([x, y, rad, rr], i) => {
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(rad);
      const w = 3.6, h = 3.4;                 // 切向宽 / 径向高
      ctx.beginPath();
      ctx.moveTo(rr - h / 2, -w / 2);
      ctx.lineTo(rr + h / 2, -w / 2 + 0.7);
      ctx.lineTo(rr + h / 2, w / 2 - 0.7);
      ctx.lineTo(rr - h / 2, w / 2);
      ctx.closePath();
      ctx.fillStyle = i === 0 ? '#6A6A73' : '#93939B';
      ctx.fill();
      ctx.restore();
    });

    // 5) 选中：外围高亮环
    if (isActive) {
      ctx.beginPath();
      ctx.arc(c, c, R + 1.6, 0, Math.PI * 2);
      ctx.strokeStyle = '#F0CD56'; ctx.lineWidth = 1.6; ctx.stroke();
    }
    return cv;
  }

  // ★ 宿主改版（用户 2026-10-12「rgb的13种默认显示一排，用下拉显示剩下的，按使用次数进行排序，使用最多放在最前面」）：
  //   第一排 = 用得最多的 SCHEME_ROW 个 + 最后一格「▾」；点「▾」→ 下面弹出浮层放其余的；
  //   每点一个方案，它的使用次数 +1（存 localStorage，重开还在），按次数从多到少排，次数一样按原顺序（Array.sort 是稳定的）。
  const USE_KEY = 'coverforge.schemeUse';
  const SCHEME_ROW = 4;
  let schemeUse = {};
  try { schemeUse = JSON.parse(localStorage.getItem(USE_KEY) || '{}') || {}; } catch (e) { schemeUse = {}; }
  let schemePopOpen = false;
  function schemesByUse() {
    return SCHEMES.slice().sort((a, b) => (schemeUse[b.key] || 0) - (schemeUse[a.key] || 0));
  }
  function useScheme(key) {
    schemeUse[key] = (schemeUse[key] || 0) + 1;
    try { localStorage.setItem(USE_KEY, JSON.stringify(schemeUse)); } catch (e) {}
    state.scheme = key;
    schemePopOpen = false;
    refresh();
  }
  function schemeButton(sc) {
    const b = document.createElement('button');
    b.className = 'scheme-btn' + (sc.key === state.scheme ? ' active' : '');
    b.title = sc.name + '（' + sc.angles.length + ' 色）';
    b.dataset.key = sc.key;
    b.appendChild(schemeIcon(sc, sc.key === state.scheme));
    b.addEventListener('click', (e) => { e.stopPropagation(); useScheme(sc.key); });
    return b;
  }
  function renderSchemeBar() {
    const bar = F('color-schemes');
    if (!bar) return;
    bar.innerHTML = '';
    const order = schemesByUse();
    order.slice(0, SCHEME_ROW).forEach(sc => bar.appendChild(schemeButton(sc)));
    const rest = order.slice(SCHEME_ROW);
    const more = document.createElement('button');
    more.className = 'scheme-btn scheme-more' + (schemePopOpen ? ' open' : '') + (rest.some(sc => sc.key === state.scheme) ? ' has-active' : '');
    more.title = '更多配色方案（' + rest.length + ' 个）';
    more.textContent = schemePopOpen ? '▲' : '▼';
    more.addEventListener('click', (e) => { e.stopPropagation(); schemePopOpen = !schemePopOpen; renderSchemeBar(); });
    bar.appendChild(more);
    if (schemePopOpen) {
      const pop = document.createElement('div');
      pop.className = 'scheme-pop';
      pop.addEventListener('click', (e) => e.stopPropagation());
      rest.forEach(sc => pop.appendChild(schemeButton(sc)));
      bar.appendChild(pop);
    }
  }
  // 点浮层外面 / Esc → 收起
  document.addEventListener('click', () => { if (schemePopOpen) { schemePopOpen = false; renderSchemeBar(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && schemePopOpen) { schemePopOpen = false; renderSchemeBar(); } });

  // 提色板：固定 24 格（四排 × 6），有色的点一下填进当前槽，空着的显示虚线格
  //   用户 2026-10-15「颜色图片中再加一排框，因为如果图片中颜色太多了显示不完」→ 12 格（两排）加到 18 格（三排）；同日「再加一排」→ 24 格（四排）
  const BOARD_N = 24;
  function renderBoard() {
    const el = F('color-board');
    if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < BOARD_N; i++) {
      const hex = state.board[i];
      const d = document.createElement('div');
      if (hex) {
        d.className = 'board-chip';
        d.style.background = hex;
        d.dataset.hex = hex;
        d.title = hex + '（点一下应用 · 右键复制色值）';
        // ★ 宿主把挑色槽去掉了（用户 2026-10-12）→ 没有槽位时点色块 = 直接应用
        d.addEventListener('click', () => (F('color-slots') ? fillSlot(hex) : applyColor(hex)));
      } else {
        d.className = 'board-chip empty';
      }
      el.appendChild(d);
    }
  }

  function renderSlots() {
    const el = F('color-slots');
    if (!el) return;
    el.innerHTML = '';
    state.slots.forEach((hex, i) => {
      const d = document.createElement('div');
      d.className = 'slot-chip' + (hex ? '' : ' empty') + (i === state.activeSlot ? ' active' : '');
      if (hex) {
        d.style.background = hex;
        d.dataset.hex = hex;
        d.title = hex + '（点一下喂进色轮，双击应用到目标）';
        d.addEventListener('click', () => {
          state.activeSlot = i;
          const hsv = hexToHsv(hex);
          if (hsv) { state.h = hsv[0]; state.s = hsv[1]; state.v = hsv[2]; }
          refresh();
        });
        d.addEventListener('dblclick', () => applyColor(hex));
      } else {
        d.title = '空槽';
        d.addEventListener('click', () => { state.activeSlot = i; renderSlots(); });
      }
      el.appendChild(d);
    });
  }

  function fillSlot(hex) {
    let i = state.slots.indexOf(null);
    if (i < 0) i = state.activeSlot;
    state.slots[i] = hex;
    state.activeSlot = Math.min(i + 1, SLOTS - 1);
    const hsv = hexToHsv(hex);
    if (hsv) { state.h = hsv[0]; state.s = hsv[1]; state.v = hsv[2]; }
    renderSlots();
    refresh();
  }

  // 右键色块 = 复制色值（用户 2026-10-15「右键可以复制色框的色值」）：颜色板块里凡是带 data-hex 的色块都算
  //   （RGB 页方案色 / 色阶、图片页提色板、收藏、槽位）；剪贴板优先走宿主桥（主进程 clipboard），没有再用 navigator.clipboard
  function copyHex(hex) {
    const h = String(hex || '').toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(h)) return Promise.resolve(false);
    const app = (typeof window !== 'undefined') && window.coverApp;
    const p = (app && app.copyText) ? app.copyText(h)
      : (navigator.clipboard ? navigator.clipboard.writeText(h) : Promise.reject(new Error('没有剪贴板')));
    return Promise.resolve(p).then(() => { flash('已复制 ' + h); return true; }, () => { flash('复制失败：' + h); return false; });
  }
  document.addEventListener('contextmenu', (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('[data-hex]') : null;
    if (!chip || !chip.closest('#color-panel')) return;
    e.preventDefault();
    e.stopPropagation();
    copyHex(chip.dataset.hex);
  });

  // ---------- 常驻颜色（用户 2026-10-15「在颜色框 rgb 中，原本的色值框下面再加一排空白色值框，样式参考图片的色值框，
  //   用户可以从上面色值框中拖入到空白色值框中，变为常驻颜色」）----------
  //   · RGB 页配色块下面一排 PIN_N 格（样式 = 图片页提色板的格子：空格虚线、有色实心）；存 localStorage，重开还在；
  //   · 从上面任何色块（配色块 / 黑白框 / 常驻格自己）**按住拖**到格子上松手 = 放进去（格子有色就换掉）；
  //     常驻格之间拖 = 互换位置；把常驻色**拖出这一排**松手 = 移除；
  //   · 拖动用 pointer 事件自己做（不走 HTML5 拖放：会被画布「拖文件进来」那套提示截走，自检也没法真鼠标测）；
  //     按下后移动 > 4px 才算拖，没拖就是原来的单击（上色）；拖完松手那下 click 吃掉，不会顺手上色；
  //   · 常驻色单击 = 上色、右键 = 复制色值（和别的色块一样）。
  const PIN_KEY = 'coverforge.colorPins';
  const PIN_N = 6;
  let pins = new Array(PIN_N).fill(null);
  try {
    const saved = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    if (Array.isArray(saved)) for (let i = 0; i < PIN_N; i++) pins[i] = /^#[0-9A-F]{6}$/i.test(saved[i] || '') ? String(saved[i]).toUpperCase() : null;
  } catch (e) { /* 读不到就从空的开始 */ }
  function savePins() { try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch (e) {} }
  function renderPins() {
    const el = F('color-pins');
    if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < PIN_N; i++) {
      const hex = pins[i];
      const d = document.createElement('div');
      d.dataset.pin = String(i);
      if (hex) {
        d.className = 'board-chip pin-chip';
        d.style.background = hex;
        d.dataset.hex = hex;
        d.title = hex + '（常驻色：点一下应用 · 右键复制色值 · 拖出这一排 = 移除）';
        d.addEventListener('click', () => applyColor(hex));
      } else {
        d.className = 'board-chip pin-chip empty';
        d.title = '空的常驻色：从上面的色块按住拖到这里';
      }
      el.appendChild(d);
    }
  }
  let pinDrag = null, eatClickUntil = 0;
  function pinSlotAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    return hit && hit.closest ? hit.closest('#color-pins .pin-chip') : null;
  }
  // 2026-10-21 用户「也可以将色框中的色块直接拖入到渐变块中」：右栏文字属性里的渐变色块（.tp-grad-sw）也接色块
  function gradSlotAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    return hit && hit.closest ? hit.closest('#textProps .tp-grad-sw') : null;
  }
  function pinDragEnd() {
    if (!pinDrag) return;
    if (pinDrag.ghost) pinDrag.ghost.remove();
    document.querySelectorAll('#color-pins .pin-chip.drop, #textProps .tp-grad-sw.drop').forEach(x => x.classList.remove('drop'));
    pinDrag = null;
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || window.__cmNoColorPins) return;
    const chip = e.target && e.target.closest ? e.target.closest('#color-pane-rgb [data-hex]') : null;
    if (!chip || !F('color-pins')) return;
    const hex = String(chip.dataset.hex || '').toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex)) return;
    const from = chip.closest('#color-pins') ? Number(chip.dataset.pin) : null;
    pinDrag = { hex: hex, from: from, x0: e.clientX, y0: e.clientY, ghost: null };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!pinDrag) return;
    if (!pinDrag.ghost) {
      if (Math.hypot(e.clientX - pinDrag.x0, e.clientY - pinDrag.y0) < 4) return;
      const g = document.createElement('div');
      g.className = 'pin-ghost';
      g.style.background = pinDrag.hex;
      document.body.appendChild(g);
      pinDrag.ghost = g;
    }
    pinDrag.ghost.style.left = (e.clientX - 13) + 'px';
    pinDrag.ghost.style.top = (e.clientY - 10) + 'px';
    const slot = pinSlotAt(e.clientX, e.clientY);
    document.querySelectorAll('#color-pins .pin-chip').forEach(x => x.classList.toggle('drop', x === slot));
    const gs = gradSlotAt(e.clientX, e.clientY);
    document.querySelectorAll('#textProps .tp-grad-sw').forEach(x => x.classList.toggle('drop', x === gs));
  }, true);
  document.addEventListener('pointerup', (e) => {
    if (!pinDrag) return;
    const d = pinDrag;
    if (!d.ghost) { pinDragEnd(); return; }                 // 没拖动 = 普通单击，照旧
    eatClickUntil = Date.now() + 300;                        // 拖完松手带出来的那下 click 不算（不然顺手给选中的文字上了色）
    const gs = gradSlotAt(e.clientX, e.clientY);
    if (gs) {                                                // 拖进渐变色块：交给渲染层（它决定改起点还是终点）
      gs.dispatchEvent(new CustomEvent('cm-color-drop', { detail: { hex: d.hex } }));
      pinDragEnd();
      return;
    }
    const slot = pinSlotAt(e.clientX, e.clientY);
    const inRow = (() => { const r = F('color-pins').getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4; })();
    if (slot) {
      const to = Number(slot.dataset.pin);
      if (d.from != null && d.from !== to) { const t = pins[to]; pins[to] = d.hex; pins[d.from] = t; }   // 常驻格之间 = 互换
      else pins[to] = d.hex;
      savePins(); renderPins();
      flash('常驻色 ' + d.hex);
    } else if (d.from != null && !inRow) {                  // 常驻色拖出这一排 = 移除
      pins[d.from] = null;
      savePins(); renderPins();
      flash('已移除常驻色 ' + d.hex);
    }
    pinDragEnd();
  }, true);
  document.addEventListener('pointercancel', pinDragEnd, true);
  document.addEventListener('click', (e) => {
    if (Date.now() < eatClickUntil && e.target && e.target.closest && e.target.closest('#color-panel')) { e.stopPropagation(); e.preventDefault(); eatClickUntil = 0; }
  }, true);

  function flash(msg) {
    const el = F('color-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { el.style.opacity = '0'; }, 1600);
  }

  // 滑条进度底：已填充部分 --accent、其余 --slider-track（对齐宿主面板的滑条外观）
  function sliderBg(pct) {
    const p = Math.max(0, Math.min(100, pct));
    return 'linear-gradient(90deg, var(--accent) 0%, var(--accent) ' + p +
           '%, var(--slider-track) ' + p + '%, var(--slider-track) 100%)';
  }

  function refresh() {
    state.palette = paletteFor(state.scheme, state.h, state.s, state.v);
    state.scale = scaleFor(state.h, state.s, state.v, 6);
    drawWheel();
    renderSchemeBar();
    strip('color-palette', state.palette, applyColor, { hex: false });  // 主配色：只留色块（色号走 hover 提示）
    strip('color-scale', state.scale, applyColor, { hex: false, small: true });  // 明度色阶：只要色块
    // 明度/饱和滑条：进度式（已填充用 --accent、其余用 --slider-track，对齐宿主面板滑条外观）
    const vSl = F('color-v');
    if (vSl) vSl.style.background = sliderBg(state.v * 100);
    const sSl = F('color-s');
    if (sSl) sSl.style.background = sliderBg(state.s * 100);
    const hexEl = F('color-hex');
    const hex = hsvHex(state.h, state.s, state.v);
    if (hexEl && document.activeElement !== hexEl) hexEl.value = hex;
    const ch = F('color-current');
    if (ch) ch.style.background = hex;
    renderSlots();
  }

  /* ---------- 黑白两色框（用户 2026-10-13）：默认不选中；点一下选中 + 应用，再点一下取消；点别的颜色也取消 ---------- */
  let bwSel = null;                     // null | '#FFFFFF' | '#000000'
  function renderBw() {
    document.querySelectorAll('#color-bw .bw-chip').forEach(d => d.classList.toggle('selected', d.dataset.hex === bwSel));
  }
  function clearBw() { if (bwSel) { bwSel = null; renderBw(); } }
  // ★ 宿主钩子（§4.0f/g）：没选中时点的颜色 = 「上色刷」（一直上色直到取消）；
  //   取消 = 黑白框再点一下 / 点色盘 / Esc（宿主调 Colors.cancelPick）→ 黑白框高亮和上色刷一起清
  function cancelPick() {
    clearBw();
    if (typeof window.__cmColorCancel === 'function') window.__cmColorCancel();
  }
  function bindBw() {
    document.querySelectorAll('#color-bw .bw-chip').forEach(d => d.addEventListener('click', (e) => {
      e.stopPropagation();
      // 2026-10-22（用户「为什么有时候我点黑白颜色需要点击两次」）：以前是开关，点过黑色后再点黑色 = 「取消」不上色；
      //   上色刷和高亮框都撤了，开关没意义 → 每点一下都直接上色，不记选中
      applyColor(d.dataset.hex);
    }));
  }

  /* ---------- 应用颜色（唯一写数据的出口）---------- */
  function applyColor(hex) {
    clearBw();                          // ★ 点了别的颜色 → 黑白框取消选中
    // ★ 宿主接口：封面制作器在 index.html 里提供 window.__cmColorApply(hex) → 返回给用户看的一句话
    let msg = '';
    try { msg = (typeof window.__cmColorApply === 'function') ? window.__cmColorApply(hex) : '宿主没接颜色出口'; }
    catch (e) { msg = '应用颜色出错：' + (e && e.message ? e.message : e); }
    flash(msg || ('已应用 ' + hex));
  }

  // ★ 宿主用（吸管，用户 2026-10-13「颜色盘右下角加一个吸管，参考 PS」）：取到的颜色 = 色盘主色跳过去 + 像点了色块一样应用
  function useColor(hex) {
    const hsv = hexToHsv(hex);
    if (!hsv) return;
    state.h = hsv[0]; state.s = hsv[1]; state.v = hsv[2];
    refresh();
    applyColor(String(hex).toUpperCase());
  }

  function syncTargetOptions() {
    const sel = F('color-target');
    if (!sel) return;
    const layer = Project.getSelected();
    const opts = [
      { v: 'fill', label: '文字填充色', need: 'text' },
      { v: 'stroke', label: '文字描边色', need: 'text' },
      { v: 'shadow', label: '文字阴影色', need: 'text' },
      { v: 'background', label: '画布背景色', need: 'any' },
    ];
    sel.innerHTML = '';
    opts.forEach(o => {
      if (o.need === 'text' && (!layer || layer.type !== 'text')) return;
      const op = document.createElement('option');
      op.value = o.v; op.textContent = o.label;
      sel.appendChild(op);
    });
    if (![...sel.options].some(o => o.value === state.target)) {
      state.target = sel.options.length ? sel.options[0].value : 'background';
    }
    sel.value = state.target;
  }

  /* ---------- 收藏 ---------- */
  function loadFavorites() {
    try { state.favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]') || []; }
    catch (e) { state.favorites = []; }
  }

  function saveFavorite() {
    state.favorites.unshift({ colors: state.palette.slice() });
    state.favorites = state.favorites.slice(0, 24);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites)); } catch (e) {}
    renderFavorites();
    flash('已收藏当前配色');
  }

  function renderFavorites() {
    const el = F('color-favorites');
    if (!el) return;
    el.innerHTML = '';
    if (!state.favorites.length) { el.innerHTML = '<div class="color-tip">还没有收藏</div>'; return; }
    state.favorites.forEach((fav, i) => {
      const row = document.createElement('div');
      row.className = 'fav-row';
      fav.colors.forEach(hex => {
        const d = document.createElement('div');
        d.className = 'color-chip sm';
        d.style.background = hex;
        d.dataset.hex = hex;
        d.title = hex + ' · 右键复制色值';
        d.addEventListener('click', () => applyColor(hex));
        row.appendChild(d);
      });
      const del = document.createElement('button');
      del.className = 'fav-del';
      del.textContent = '×';
      del.addEventListener('click', () => {
        state.favorites.splice(i, 1);
        try { localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites)); } catch (e) {}
        renderFavorites();
      });
      row.appendChild(del);
      el.appendChild(row);
    });
  }

  /* ---------- 交互绑定 ---------- */
  function bindWheel() {
    const c = F('color-wheel');
    if (!c) return;
    let dragging = false;
    const pick = e => {
      const rect = c.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (c.width / rect.width) - c.width / 2;
      const y = (e.clientY - rect.top) * (c.height / rect.height) - c.height / 2;
      let ang = Math.atan2(y, x) * 180 / Math.PI;
      if (ang < 0) ang += 360;
      state.h = ang;
      state.s = Math.min(1, Math.sqrt(x * x + y * y) / wheelSatR(c.width / 2));
      cancelPick();
      refresh();
    };
    c.addEventListener('mousedown', e => { dragging = true; pick(e); });
    window.addEventListener('mousemove', e => { if (dragging) pick(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // 顶部模式切换：RGB / 图片（版式对齐 111.png）
  // 注意：直接操作 style.display，不依赖宿主的 .hidden 类（换宿主也能用）
  function setPane(isRgb) {
    const rgb = F('color-pane-rgb'), img = F('color-pane-image');
    if (rgb) rgb.style.display = isRgb ? '' : 'none';
    if (img) img.style.display = isRgb ? 'none' : '';
  }

  function bindTabs() {
    const tabs = [...document.querySelectorAll('#color-panel .color-tab')];
    if (!tabs.length) return;
    setPane(true);
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.toggle('active', x === t));
      const isRgb = t.dataset.tab === 'rgb';
      setPane(isRgb);
      if (isRgb) refresh();
      // ★ 宿主钩子：切到图片页 → 让宿主从画布上选中的照片提色
      else if (typeof window.__cmColorsOnImageTab === 'function') window.__cmColorsOnImageTab();
    }));
  }

  function onPickFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        state.board = extractPalette(img, BOARD_N);
        state.activeSlot = 0;
        renderBoard();
        const tip = F('color-extract-tip');
        if (tip) tip.textContent = '提出 ' + state.board.length + ' 色，点色块填槽';
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function init() {
    if (!F('color-wheel')) return;
    loadFavorites();

    const start = hexToHsv('#FFCC00');
    if (start) { state.h = start[0]; state.s = start[1]; state.v = start[2]; }

    bindWheel();
    bindBw();
    bindTabs();

    F('color-v').addEventListener('input', e => { state.v = +e.target.value / 100; refresh(); });
    // 下面两个是「可选元素」：宿主保留饱和度滑条 / HEX 输入框时才生效（默认版式里没有）
    const sEl = F('color-s');
    if (sEl) sEl.addEventListener('input', e => { state.s = +e.target.value / 100; refresh(); });
    const hexEl = F('color-hex');
    if (hexEl) hexEl.addEventListener('change', e => {
      const hsv = hexToHsv(e.target.value);
      if (hsv) { state.h = hsv[0]; state.s = hsv[1]; state.v = hsv[2]; refresh(); }
      else e.target.value = hsvHex(state.h, state.s, state.v);
    });
    // 以下元素都可能被宿主裁掉，全部按「可选」处理
    const tgt = F('color-target');
    if (tgt) tgt.addEventListener('change', e => { state.target = e.target.value; });

    const ex = F('btn-color-extract');
    if (ex) ex.addEventListener('click', () => F('color-image-file').click());
    const fileEl = F('color-image-file');
    if (fileEl) fileEl.addEventListener('change', onPickFile);

    const fav = F('btn-color-fav');
    if (fav) fav.addEventListener('click', saveFavorite);

    const clr = F('btn-color-clearslots');
    if (clr) clr.addEventListener('click', () => {
      state.slots = new Array(SLOTS).fill(null);
      state.activeSlot = 0;
      renderSlots();
    });

    // ★ 宿主没有「应用到哪」下拉，不订阅 Project（封面制作器没有这个对象）
    renderFavorites();
    renderBoard();
    renderPins();
    refresh();
  }

  return {
    init,
    // 引擎直出（给别的工程/UI 复用）
    SCHEMES,
    paletteFor,
    scaleFor,
    extractPalette,
    hsvHex,
    hexToHsv,
    getState: () => state,
    getSchemeUse: () => Object.assign({}, schemeUse),   // ★ 自检用：各方案使用次数
    _resetSchemeUse: () => { schemeUse = {}; try { localStorage.removeItem(USE_KEY); } catch (e) {} schemePopOpen = false; renderSchemeBar(); },   // ★ 自检用
    applyColor,          // ★ 自检用：等同点一下色块
    useColor,            // ★ 宿主用：吸管取到的颜色（色盘跳过去 + 应用）
    getBwSelected: () => bwSel,
    cancelPick,          // ★ 宿主用：Esc 取消上色刷
    flash,               // ★ 宿主用：「先点颜色再点文字」用上时出一句提示   // ★ 自检用：黑白框当前选中（null = 都没选）
    _setHsv: (h, s, v) => { state.h = h; state.s = s; state.v = v; refresh(); },   // ★ 自检用
    _board: (arr) => { state.board = arr.slice(); renderBoard(); },              // ★ 自检用
    getPins: () => pins.slice(),                                                  // ★ 自检用
    _setPins: (arr) => { pins = new Array(PIN_N).fill(null).map((_, i) => (arr && arr[i]) || null); savePins(); renderPins(); },   // ★ 自检用
  };
})();
