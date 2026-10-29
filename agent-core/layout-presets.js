'use strict';

// Declarative style tokens only. The layout engine that consumes these presets
// is deliberately kept outside this module.
const PRESETS = {
  'minimal-premium': {
    id: 'minimal-premium',
    label: '简洁高级',
    palette: {
      background: '#F7F5F0',
      surface: '#FFFFFF',
      primary: '#171717',
      secondary: '#68645D',
      accent: '#B08D57'
    },
    title: { fontScale: 0.112, maxLines: 2, align: 'left' },
    subtitle: { fontScale: 0.040, maxLines: 2 },
    decorations: ['fine-line', 'soft-shadow'],
    imageLayout: { mode: 'split', imagePosition: 'right', imageRatio: 0.46, overlayOpacity: 0.06 },
    noImageLayout: { mode: 'open-space', textWidth: 0.72, focalPoint: 'upper-left' }
  },
  tech: {
    id: 'tech',
    label: '科技感',
    palette: {
      background: '#071426',
      surface: '#102A43',
      primary: '#EAF7FF',
      secondary: '#8FB8D8',
      accent: '#20D9FF'
    },
    title: { fontScale: 0.108, maxLines: 2, align: 'left' },
    subtitle: { fontScale: 0.038, maxLines: 2 },
    decorations: ['grid', 'glow-line', 'data-dots'],
    imageLayout: { mode: 'layered', imagePosition: 'right', imageRatio: 0.52, overlayOpacity: 0.28 },
    noImageLayout: { mode: 'tech-grid', textWidth: 0.70, focalPoint: 'center-left' }
  },
  knowledge: {
    id: 'knowledge',
    label: '知识干货',
    palette: {
      background: '#FFF9E8',
      surface: '#FFFFFF',
      primary: '#172B4D',
      secondary: '#52616B',
      accent: '#FFB000'
    },
    title: { fontScale: 0.104, maxLines: 3, align: 'left' },
    subtitle: { fontScale: 0.037, maxLines: 2 },
    decorations: ['label-chip', 'underline', 'check-marks'],
    imageLayout: { mode: 'card', imagePosition: 'right', imageRatio: 0.40, overlayOpacity: 0.02 },
    noImageLayout: { mode: 'info-card', textWidth: 0.78, focalPoint: 'upper-left' }
  },
  energetic: {
    id: 'energetic',
    label: '活力醒目',
    palette: {
      background: '#FF4D2E',
      surface: '#FFE600',
      primary: '#FFFFFF',
      secondary: '#2B1647',
      accent: '#00E5A8'
    },
    title: { fontScale: 0.126, maxLines: 2, align: 'center' },
    subtitle: { fontScale: 0.043, maxLines: 2 },
    decorations: ['burst', 'bold-stroke', 'confetti'],
    imageLayout: { mode: 'cutout', imagePosition: 'center-right', imageRatio: 0.54, overlayOpacity: 0.10 },
    noImageLayout: { mode: 'poster', textWidth: 0.86, focalPoint: 'center' }
  },
  'warm-life': {
    id: 'warm-life',
    label: '温暖生活',
    palette: {
      background: '#F8E8DA',
      surface: '#FFF8F1',
      primary: '#51372D',
      secondary: '#8A6758',
      accent: '#E8846B'
    },
    title: { fontScale: 0.098, maxLines: 3, align: 'left' },
    subtitle: { fontScale: 0.039, maxLines: 2 },
    decorations: ['organic-blob', 'soft-grain', 'leaf-line'],
    imageLayout: { mode: 'soft-frame', imagePosition: 'right', imageRatio: 0.48, overlayOpacity: 0.08 },
    noImageLayout: { mode: 'organic', textWidth: 0.74, focalPoint: 'center-left' }
  },
  business: {
    id: 'business',
    label: '商务专业',
    palette: {
      background: '#F2F5F8',
      surface: '#FFFFFF',
      primary: '#102A43',
      secondary: '#5C6B7A',
      accent: '#1D63B7'
    },
    title: { fontScale: 0.102, maxLines: 2, align: 'left' },
    subtitle: { fontScale: 0.037, maxLines: 2 },
    decorations: ['rule', 'corner-block', 'subtle-grid'],
    imageLayout: { mode: 'corporate-split', imagePosition: 'right', imageRatio: 0.44, overlayOpacity: 0.12 },
    noImageLayout: { mode: 'corporate-panel', textWidth: 0.72, focalPoint: 'center-left' }
  }
};

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

deepFreeze(PRESETS);

const RULES = [
  { id: 'minimal-premium', chinese: ['简洁', '高级', '留白'], english: ['minimal', 'premium'] },
  { id: 'tech', chinese: ['科技', '未来'], english: ['tech', 'ai', 'future'] },
  { id: 'knowledge', chinese: ['知识', '干货', '教程', '清单'], english: ['knowledge', 'tutorial', 'checklist'] },
  { id: 'energetic', chinese: ['活力', '醒目', '热闹', '促销'], english: ['energetic', 'bold', 'promotion'] },
  { id: 'warm-life', chinese: ['温暖', '生活', '治愈'], english: ['warm', 'life', 'healing'] },
  { id: 'business', chinese: ['商务', '企业', '专业'], english: ['business', 'corporate', 'professional'] }
];
deepFreeze(RULES);

const ALL_CHINESE_KEYWORDS = RULES.flatMap((rule) => rule.chinese);
const NEGATIONS = ['不要', '避免', '拒绝', '去掉', '不', '非', '无'];
const STYLE_SUFFIXES = ['风格', '设计', '视觉', '主题', '主义', '风', '感', '型', '系'];
const CLAUSE_SEPARATOR = /[，,。.!！？；;、/\\]+/u;
const SHORT_NEGATION_BRIDGES = new Set(['', '太', '够', '要', '想要', '需要', '喜欢', '采用', '使用', '这种', '那种', '任何', '带有', '有']);

function compactText(value) {
  return value.replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeStyle(style) {
  if (typeof style !== 'string') return null;
  const folded = style.normalize('NFKC').toLowerCase().trim();
  if (!folded) return null;
  return {
    compact: compactText(folded),
    clauses: folded.split(CLAUSE_SEPARATOR).map(compactText).filter(Boolean)
  };
}

function hasChineseBoundary(clause, keyword, start) {
  const following = clause.slice(start + keyword.length);
  if (!following || !/^\p{Script=Han}/u.test(following)) return true;
  return STYLE_SUFFIXES.some((suffix) => following.startsWith(suffix)) ||
    ALL_CHINESE_KEYWORDS.some((otherKeyword) => following.startsWith(otherKeyword));
}

function isNegated(clause, keywordStart, keywordLength) {
  const keywordEnd = keywordStart + keywordLength;
  for (const negation of NEGATIONS) {
    let negationStart = clause.indexOf(negation);
    while (negationStart !== -1) {
      const negationEnd = negationStart + negation.length;
      if (negationEnd <= keywordStart) {
        const bridge = clause.slice(negationEnd, keywordStart);
        const hasNegationWindow = negation.length > 1
          ? bridge.length <= 2
          : SHORT_NEGATION_BRIDGES.has(bridge);
        if (hasNegationWindow) return true;
      } else if (keywordEnd <= negationStart) {
        const bridge = clause.slice(keywordEnd, negationStart);
        if (/^(?:风格|[风感])?$/u.test(bridge)) return true;
      }
      negationStart = clause.indexOf(negation, negationStart + negation.length);
    }
  }
  return false;
}

function hasPositiveChineseKeyword(clauses, keyword) {
  return clauses.some((clause) => {
    let start = clause.indexOf(keyword);
    while (start !== -1) {
      if (hasChineseBoundary(clause, keyword, start) && !isNegated(clause, start, keyword.length)) return true;
      start = clause.indexOf(keyword, start + keyword.length);
    }
    return false;
  });
}

function hasPositiveEnglishKeyword(clauses, keyword) {
  return clauses.some((clause) => {
    let start = clause.indexOf(keyword);
    while (start !== -1) {
      const before = clause[start - 1] || '';
      const after = clause[start + keyword.length] || '';
      const hasWordBoundary = !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
      if (hasWordBoundary && !isNegated(clause, start, keyword.length)) return true;
      start = clause.indexOf(keyword, start + keyword.length);
    }
    return false;
  });
}

function resolvePreset(style) {
  const normalized = normalizeStyle(style);
  if (!normalized) return PRESETS['minimal-premium'];

  // Canonical IDs and labels win before fuzzy keyword matching.
  for (const preset of Object.values(PRESETS)) {
    const normalizedId = preset.id.replace(/[^a-z0-9]+/g, '');
    if (normalized.compact === normalizedId || normalized.compact === preset.label) return preset;
  }

  for (const rule of RULES) {
    const hasChineseKeyword = rule.chinese.some((keyword) =>
      hasPositiveChineseKeyword(normalized.clauses, keyword));
    const hasEnglishKeyword = rule.english.some((keyword) =>
      hasPositiveEnglishKeyword(normalized.clauses, keyword));
    if (hasChineseKeyword || hasEnglishKeyword) return PRESETS[rule.id];
  }
  return PRESETS['minimal-premium'];
}

module.exports = { resolvePreset, PRESETS, RULES };
