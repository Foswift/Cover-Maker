'use strict';

// Pure layout planner for create_cover: frames + title + style in, element plan out.
// No DOM / Konva / fs / Electron here — renderer/agent-auto-layout.js turns the plan into canvas nodes.
//
// Units in the plan (same as the add_text / add_shape tools):
//   x, y   = element centre, ratio of frame width / height (0..1)
//   box    = { x, y, w, h } top-left + size, ratio of frame width / height
//   size   = font size in canvas pixels (frame.width / frame.height are canvas pixels too)
//   width / height on shapes = ratio of the frame's short side

const { CODES, makeError } = require('./errors');
const { resolvePreset } = require('./layout-presets');

const MAX_TITLE_LINES = 3;
const LINE_HEIGHT = 1.25;
const MIN_FONT_MULT = 0.6;
const BREAK_AFTER = new Set('，,。.！!？?；;：:、）)】」』》'.split(''));
const NO_LINE_START = BREAK_AFTER;

function round(v) {
  return Math.round(v * 10000) / 10000;
}

// Visual width of one character in em: CJK / full-width = 1, ASCII-ish = 0.5.
function charWidth(ch) {
  return /[\u0000-ɏ -⁯]/u.test(ch) && !/[—…]/u.test(ch) ? 0.5 : 1;
}

function textWidth(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

// Latin words and digit runs stay whole; everything else is one token per character.
function tokenize(text) {
  return text.match(/[A-Za-z0-9][A-Za-z0-9'’\-_.%+#&]*|\s+|[\s\S]/gu) || [];
}

function splitLongToken(token, maxWidth) {
  const parts = [];
  let cur = '';
  for (const ch of token) {
    if (cur && textWidth(cur + ch) > maxWidth) { parts.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function wrapParagraph(paragraph, maxWidth) {
  const tokens = [];
  for (const t of tokenize(paragraph)) {
    if (!/^\s+$/u.test(t) && textWidth(t) > maxWidth) tokens.push(...splitLongToken(t, maxWidth));
    else tokens.push(t);
  }
  const lines = [];
  let line = [];
  const lineText = () => line.join('').trim();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!line.length && /^\s+$/u.test(t)) continue;
    const candidate = line.concat(t).join('').trimEnd();
    // Closing punctuation may hang onto the line rather than start the next one.
    if (textWidth(candidate) <= maxWidth || (NO_LINE_START.has(t) && line.length)) {
      line.push(t);
      continue;
    }
    // Prefer breaking just after punctuation within the last few tokens.
    let cutAt = -1;
    for (let j = line.length - 1; j >= Math.max(1, line.length - 3); j -= 1) {
      if (BREAK_AFTER.has(line[j])) { cutAt = j + 1; break; }
    }
    if (cutAt > 0 && cutAt < line.length) {
      const rest = line.slice(cutAt);
      line = line.slice(0, cutAt);
      lines.push(lineText());
      line = rest;
      while (line.length && /^\s+$/u.test(line[0])) line.shift();
      i -= 1;
      continue;
    }
    lines.push(lineText());
    line = /^\s+$/u.test(t) ? [] : [t];
  }
  if (lineText()) lines.push(lineText());
  return lines;
}

// 均衡断行：行数不变，把每行宽度摊平 —— 不会出现「三招拍出高级 / 感」这种最后一行只剩一个字
// （2026-10-21 真实 agent 照参考图做横版时撞上，只能自己 update_element 改）
function balancedWrap(paragraph, maxWidth) {
  const greedy = wrapParagraph(paragraph, maxWidth);
  if (greedy.length < 2) return greedy;
  for (let w = Math.ceil(textWidth(paragraph) / greedy.length * 2) / 2; w < maxWidth; w += 0.5) {
    const lines = wrapParagraph(paragraph, w);
    if (lines.length === greedy.length) return lines;
  }
  return greedy;
}

function splitTitle(text, maxCharsPerLine, maxLines) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (!source) return { lines: [], truncated: false };
  const maxWidth = Math.max(1, maxCharsPerLine);
  const all = [];
  for (const paragraph of source.split(/\r?\n/u)) {
    if (paragraph.trim()) all.push(...balancedWrap(paragraph.trim(), maxWidth));
  }
  if (all.length <= maxLines) return { lines: all, truncated: false };
  const lines = all.slice(0, maxLines);
  let last = lines[maxLines - 1];
  while (last && textWidth(last + '…') > maxWidth) last = Array.from(last).slice(0, -1).join('');
  lines[maxLines - 1] = last.trimEnd() + '…';
  return { lines, truncated: true };
}

// Area text must stay in, as frame ratios. Tall frames (9:16) keep clear of the
// platform's bottom UI (caption, buttons) and the top status area.
function safeArea(frame) {
  const w = frame.width;
  const h = frame.height;
  const margin = 0.07 * Math.min(w, h);
  const mx = margin / w;
  let top = margin / h;
  let bottom = margin / h;
  if (w / h < 0.6) {
    top = Math.max(top, 0.10);
    bottom = Math.max(bottom, 0.20);
  }
  return { x: round(mx), y: round(top), w: round(1 - 2 * mx), h: round(1 - top - bottom) };
}

function validFrame(f) {
  return f && Number.isInteger(f.no) && f.no >= 1 &&
    Number.isFinite(f.width) && f.width > 0 && Number.isFinite(f.height) && f.height > 0;
}

// 先按 preferredLines 缩字找能放下的字号；缩到最小还放不下 → 按 maxLines 截断
function fitTitle(title, maxWidthPx, baseSize, preferredLines, maxLines) {
  for (let mult = 1; mult >= MIN_FONT_MULT - 1e-9; mult -= 0.05) {
    const size = baseSize * mult;
    const res = splitTitle(title, Math.floor(maxWidthPx / size), preferredLines);
    if (!res.truncated) return { size, lines: res.lines, truncated: false };
  }
  const size = baseSize * MIN_FONT_MULT;
  return Object.assign({ size }, splitTitle(title, Math.floor(maxWidthPx / size), maxLines || MAX_TITLE_LINES));
}

// ---------- custom_style（照参考图：agent 看完参考图填进来的配色 / 版式）----------
const CS_COLORS = ['background_color', 'title_color', 'subtitle_color', 'accent_color', 'title_stroke_color', 'overlay_color', 'subject_outline_color', 'title_gradient_to'];
const CS_ENUMS = {
  title_position: ['top', 'center', 'bottom'],
  title_align: ['left', 'center', 'right'],
  decoration: ['bar', 'band', 'box', 'none']
};
const CS_NUMBERS = {
  title_size: [0.04, 0.25], title_max_lines: [1, 3], title_stroke_width: [0, 30],
  subtitle_size: [0.02, 0.1], overlay_opacity: [0, 1], subject_outline_width: [0, 40]
};

function hex6(v) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v).trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return '#' + h.toUpperCase();
}

// → { ok, value } 或结构化错误；数字超范围夹到范围内并记 warning，不认识的键忽略并记 warning
function checkCustomStyle(cs, warnings) {
  if (cs == null) return { ok: true, value: {} };
  if (typeof cs !== 'object' || Array.isArray(cs)) {
    return makeError(CODES.INVALID_ARGUMENT, 'custom_style 要是一个对象', '比如 {"title_color":"#FFFFFF","title_position":"bottom"}');
  }
  const out = {};
  for (const [k, v] of Object.entries(cs)) {
    if (v == null) continue;
    if (CS_COLORS.includes(k)) {
      const c = hex6(v);
      if (!c) return makeError(CODES.INVALID_ARGUMENT, 'custom_style.' + k + ' 不是颜色：' + v, '用 #RRGGBB，比如 #FF3B30');
      out[k] = c;
    } else if (CS_ENUMS[k]) {
      if (!CS_ENUMS[k].includes(v)) return makeError(CODES.INVALID_ARGUMENT, 'custom_style.' + k + ' 不认识：' + v, '可选：' + CS_ENUMS[k].join(' / '));
      out[k] = v;
    } else if (CS_NUMBERS[k]) {
      const n = Number(v);
      if (!Number.isFinite(n)) return makeError(CODES.INVALID_ARGUMENT, 'custom_style.' + k + ' 不是数字：' + v, '');
      const [lo, hi] = CS_NUMBERS[k];
      const c = Math.min(hi, Math.max(lo, k === 'title_max_lines' ? Math.round(n) : n));
      if (c !== n) warnings.push('custom_style.' + k + ' = ' + v + ' 超出范围，按 ' + c + ' 处理（范围 ' + lo + '~' + hi + '）');
      out[k] = c;
    } else if (k === 'title_shadow') {
      out[k] = !!v;
    } else if (k === 'title_font') {
      if (String(v).trim()) out[k] = String(v).trim();
    } else {
      warnings.push('custom_style.' + k + ' 不认识，忽略了');
    }
  }
  return { ok: true, value: out };
}

function layoutFrame(frame, opts) {
  const { preset, title, subtitle, imagePath, warnings } = opts;
  const cs = opts.custom || {};
  const W = frame.width;
  const H = frame.height;
  const short = Math.min(W, H);
  const safe = safeArea(frame);
  const pal = {
    background: cs.background_color || preset.palette.background,
    primary: cs.title_color || preset.palette.primary,
    secondary: cs.subtitle_color || preset.palette.secondary,
    accent: cs.accent_color || preset.palette.accent
  };
  const hasImage = !!imagePath;
  const layout = hasImage ? preset.imageLayout : preset.noImageLayout;
  const align = cs.title_align || preset.title.align;
  const decoration = cs.decoration || 'bar';
  const titleScale = cs.title_size || preset.title.fontScale;
  const subScale = cs.subtitle_size || preset.subtitle.fontScale;

  const widthRatio = Math.min(safe.w, hasImage ? Math.max(layout.imageRatio || 0, 0.86) : layout.textWidth);
  // 装饰块（色带 / 底色块）要包住文字，留出内边距：文字区左右各收一点
  const inset = decoration === 'box' || decoration === 'band' ? 0.035 * short / W : 0;
  const textW = widthRatio - 2 * inset;
  const textWpx = textW * W;

  // 标题：给了 title_max_lines 就是硬上限；否则先按预设行数，放不下再放宽到 3 行
  let t;
  if (cs.title_max_lines) {
    t = fitTitle(title, textWpx, titleScale * short, cs.title_max_lines, cs.title_max_lines);
  } else {
    t = fitTitle(title, textWpx, titleScale * short, preset.title.maxLines, MAX_TITLE_LINES);
    if (t.truncated) t = fitTitle(title, textWpx, titleScale * short, MAX_TITLE_LINES, MAX_TITLE_LINES);
  }
  if (t.truncated) warnings.push(`第 ${frame.no} 块框：标题太长，放不下的部分用「…」省略了`);

  let subSize = subScale * short;
  const s = subtitle ? splitTitle(subtitle, Math.floor(textWpx / subSize), preset.subtitle.maxLines) : { lines: [], truncated: false };
  if (s.truncated) warnings.push(`第 ${frame.no} 块框：副标题太长，超过 ${preset.subtitle.maxLines} 行的部分用「…」省略了`);

  const accentH = Math.max(2, 0.012 * short);
  const accentW = 0.14 * short;
  const padY = decoration === 'box' || decoration === 'band' ? 0.035 * short : 0;
  let titleSize = t.size;
  let gap;
  let barH;
  let blockH;
  // 整块（装饰 + 标题 + 副标题）放不进安全区的高度就一起缩
  for (let k = 1; ; k -= 0.05) {
    titleSize = t.size * k;
    subSize = subScale * short * k;
    gap = 0.5 * titleSize;
    barH = decoration === 'bar' ? accentH + gap : 0;
    blockH = barH + padY * 2 + t.lines.length * titleSize * LINE_HEIGHT +
      (s.lines.length ? gap + s.lines.length * subSize * LINE_HEIGHT : 0);
    if (blockH <= safe.h * H || k <= MIN_FONT_MULT) break;
  }

  const boxX = align === 'center' ? 0.5 - widthRatio / 2 : align === 'right' ? safe.x + safe.w - widthRatio : safe.x;
  const textX = boxX + inset;
  const position = cs.title_position || (hasImage ? 'bottom' : layout.focalPoint === 'upper-left' ? 'upper' : 'center');
  let topPx;
  if (position === 'bottom') topPx = (safe.y + safe.h) * H - blockH;
  else if (position === 'top') topPx = safe.y * H;
  else if (position === 'upper') topPx = safe.y * H + 0.08 * safe.h * H;
  else topPx = safe.y * H + (safe.h * H - blockH) / 2;
  topPx = Math.min(Math.max(topPx, safe.y * H), (safe.y + safe.h) * H - blockH);
  const bottomPx = topPx + blockH;

  const rect = (role, x0, y0, x1, y1, fill, extra) => Object.assign({
    type: 'shape', ref_id: role, role, layer: 10, shape: 'rect', frame: frame.no,
    x: round((x0 + x1) / 2), y: round((y0 + y1) / 2 / H),
    width: round((x1 - x0) * W / short), height: round((y1 - y0) / short),
    box: { x: round(x0), y: round(y0 / H), w: round(x1 - x0), h: round((y1 - y0) / H) },
    fill
  }, extra || {});

  const elements = [];
  // 有照片：文字下面垫一块遮罩（贴着文字所在的那条边铺满）；overlay_opacity = 0 → 不垫
  const overlayOpacity = cs.overlay_opacity != null ? cs.overlay_opacity : 0.82;
  if (hasImage && overlayOpacity > 0 && decoration !== 'band') {
    const pad = 0.05 * short;
    let y0 = Math.max(0, topPx - pad);
    let y1 = Math.min(H, bottomPx + pad);
    if (position === 'bottom') y1 = H;
    if (position === 'top' || position === 'upper') y0 = 0;
    elements.push(rect('scrim', 0, y0, 1, y1, cs.overlay_color || pal.background, { opacity: overlayOpacity }));
  }
  if (decoration === 'band') {
    // 贴着文字所在的那条边铺满（文字在下 → 色带到底边；在上 → 到顶边），不留一条底色缝
    elements.push(rect('band', 0, position === 'top' ? 0 : topPx, 1, position === 'bottom' ? H : bottomPx, pal.accent));
  }
  if (decoration === 'bar') {
    const ax = align === 'center' ? 0.5 - accentW / W / 2 : align === 'right' ? textX + textW - accentW / W : textX;
    elements.push(rect('accent', ax, topPx, ax + accentW / W, topPx + accentH, pal.accent));
  }

  let cursor = topPx + barH + padY;
  const textEl = (role, lines, size, color, extra) => {
    const h = lines.length * size * LINE_HEIGHT;
    const el = Object.assign({
      type: 'text', ref_id: role, role, layer: role === 'title' ? 20 : 21, frame: frame.no, text: lines.join('\n'),
      x: round(textX + textW / 2), y: round((cursor + h / 2) / H),
      size: Math.round(size * 10) / 10, color, align,
      box: { x: round(textX), y: round(cursor / H), w: round(textW), h: round(h / H) }
    }, extra);
    cursor += h;
    return el;
  };
  const font = cs.title_font ? { font: cs.title_font } : {};
  const titleEl = textEl('title', t.lines, titleSize, pal.primary, Object.assign({
    shadow: !!cs.title_shadow
  }, cs.title_gradient_to ? { gradient: { colors: [pal.primary, cs.title_gradient_to], angle: 90 } } : {}, cs.title_stroke_color || cs.title_stroke_width ? {
    stroke_color: cs.title_stroke_color || '#000000',
    stroke_width: cs.title_stroke_width != null ? cs.title_stroke_width : 8
  } : {}, font));
  if (decoration === 'box') {
    const b = titleEl.box;
    const px = 0.035 * short / W;
    elements.push(rect('box', Math.max(0, b.x - px), Math.max(0, b.y * H - padY), Math.min(1, b.x + b.w + px), Math.min(H, (b.y + b.h) * H + padY), pal.accent));
  }
  elements.push(titleEl);
  if (s.lines.length) {
    cursor += gap;
    elements.push(textEl('subtitle', s.lines, subSize, pal.secondary, Object.assign({ shadow: false }, font)));
  }

  // subject_front：把照片里的主体抠出来放到最上层（字在它后面）—— 放在最后一步，抠出来自然在最上面
  if (hasImage && opts.subjectFront) {
    const subj = { type: 'subject', ref_id: 'subject', role: 'subject', layer: 30, frame: frame.no };
    if (cs.subject_outline_color || cs.subject_outline_width) {
      subj.outline = { color: cs.subject_outline_color || '#FFFFFF', width: cs.subject_outline_width != null ? cs.subject_outline_width : 6 };
      if (!(subj.outline.width > 0)) delete subj.outline;
    }
    elements.push(subj);
  }

  return {
    frame: frame.no,
    // fallbackColor：图片放不进去时改铺的纯色（适配器负责降级）
    background: hasImage
      ? { type: 'image', ref_id: 'background', role: 'background', layer: 0, path: imagePath, fit: 'cover', fallbackColor: pal.background }
      : { type: 'solid', ref_id: 'background', role: 'background', layer: 0, color: pal.background },
    elements
  };
}

function buildCoverPlan(input) {
  const args = input && typeof input === 'object' ? input : {};
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return makeError(CODES.LAYOUT_FAILED, '标题是空的', '给 title 写上封面标题');
  const frames = Array.isArray(args.frames) ? args.frames : [];
  if (!frames.length) return makeError(CODES.LAYOUT_FAILED, '没有可排版的框', '先 set_platforms 勾上平台');
  const bad = frames.find((f) => !validFrame(f));
  if (bad) return makeError(CODES.LAYOUT_FAILED, '框的数据不对：' + JSON.stringify(bad), '框要有 no（从 1 起）和大于 0 的 width / height');

  const warnings = [];
  const images = [];
  for (const p of Array.isArray(args.imagePaths) ? args.imagePaths : []) {
    if (typeof p === 'string' && p.trim()) images.push(p.trim());
    else warnings.push('忽略了一个不是路径的图片参数');
  }
  const unused = images.slice(frames.length);
  if (unused.length) warnings.push('框不够，这些图片没用上：' + unused.join('、'));

  const custom = checkCustomStyle(args.customStyle, warnings);
  if (!custom.ok) return custom;
  const preset = resolvePreset(args.style);
  const subtitle = typeof args.subtitle === 'string' ? args.subtitle.trim() : '';
  const planFrames = frames.map((frame, i) => layoutFrame(frame, {
    preset, title, subtitle, warnings, custom: custom.value, subjectFront: !!args.subjectFront,
    imagePath: images.length ? images[i % images.length] : null
  }));
  return { ok: true, preset: preset.id, frames: planFrames, warnings };
}

module.exports = { buildCoverPlan, splitTitle, safeArea, textWidth, checkCustomStyle };
