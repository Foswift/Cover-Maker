'use strict';

const FRAME = { type: 'integer', minimum: 1, description: '放进第几块框（同画布左上角的框编号，1 起；不写 = 1）。先用 get_canvas 看有哪些框' };
const POS = {
  x: { type: 'number', minimum: 0, maximum: 1, description: '中心点横坐标，占框宽的比例（0 = 左边，0.5 = 正中，1 = 右边；不写 = 0.5）' },
  y: { type: 'number', minimum: 0, maximum: 1, description: '中心点纵坐标，占框高的比例（0 = 顶，1 = 底；不写 = 0.5）' }
};
const COLOR = (description) => ({ type: 'string', description: description + '（#RRGGBB）' });
const SHADOW = {
  type: 'object', description: '阴影（不写 = 不加）',
  properties: {
    color: COLOR('阴影颜色'),
    distance: { type: 'number', description: '距离（像素）' },
    angle: { type: 'number', description: '方向（度，0 = 右，90 = 下）' },
    blur: { type: 'number', description: '模糊（像素）' },
    opacity: { type: 'number', description: '不透明度 0~100' }
  }
};

const PLATFORMS = ['douyin', 'xiaohongshu', 'kuaishou', 'bilibili', 'shipinhao', 'toutiao', 'gongzhonghao', 'dianshang'];   // gongzhonghao = 公众号（2026-10-22，1:1 + 2.35:1）；dianshang = 电商主图（2026-10-24，1:1 800×800）

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const WRITE_IDEMPOTENT = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
const DESTRUCTIVE_IDEMPOTENT = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
const HEX = { type: 'string', pattern: '^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' };
// 透明度（用户 2026-10-21 测参考图：上下两行「FRIDAY」半透明透出天空，原来没法做）
const TEXT_OPACITY = { type: 'number', minimum: 0, maximum: 1, description: '文字不透明度（0~1，1 = 不透明；0.5 = 半透明能透出背景。只淡字本身，描边 / 阴影不跟着淡，同右栏「字透明度」）' };
const OPACITY = { type: 'number', minimum: 0, maximum: 1, description: '不透明度（0~1，1 = 不透明）' };
// 斜切（用户 2026-11-02「用 agent 控制说文字的斜切没有接口」）：跟画布上「右键 → 斜切」拖四边中点同一套变换，单位**度**，0 = 不斜
const SKEW = {
  skew_x: { type: 'number', minimum: -75, maximum: 75, description: '水平斜切（度）：正 = 顶边右移（斜排标题 / 仿斜体），0 = 不斜。建议 ±5~25，超过 45 会明显变形' },
  skew_y: { type: 'number', minimum: -75, maximum: 75, description: '垂直斜切（度）：正 = 左边下移，0 = 不斜' }
};
// 文字渐变（同日第三轮实测：参考图中间那行 FRIDAY 是青 → 浅青渐变，只能纯色）
const GRADIENT = {
  type: 'object',
  description: '文字渐变填充（比如 {"colors":["#45E3EE","#BFF8FF"],"angle":90} = 从上到下青到浅青）。colors 传空数组 = 取消渐变；之后再单独改 color 也会变回纯色',
  properties: {
    colors: { type: 'array', minItems: 0, maxItems: 4, items: Object.assign({ description: '颜色（#RRGGBB），按顺序均匀分布' }, HEX) },
    angle: { type: 'number', description: '方向（度）：0 = 从左到右，90 = 从上到下（默认），45 = 左上到右下' }
  }
};

const LETTER_SPACING = { type: 'number', minimum: -20, maximum: 100, description: '字间距（像素，负数收紧、正数拉开）' };
const STROKE_MODE = { type: 'string', enum: ['outer', 'inner'], description: '描边位置：outer 外描边，inner 内描边' };
const CORNER_RADIUS = {
  anyOf: [
    { type: 'number', minimum: 0 },
    { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0 } }
  ],
  description: '圆角半径：一个数字统一设置；或按左上、右上、右下、左下传固定四项数组'
};
const LINE_POINTS = {
  type: 'object',
  description: '线条三个点（坐标是形状自身 0~1 的比例）：start / end = 两头端点，bend = 曲线经过的弯曲点（直线就放在两头中点）',
  properties: {
    start: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'] },
    bend: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'] },
    end: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'] }
  },
  required: ['start', 'bend', 'end']
};
const BUBBLE_TAIL = {
  type: 'object',
  description: '气泡尾巴：tip_x / tip_y = 尖端位置（相对气泡的比例，可超出 0~1 指到外面）；width = 尾巴根部宽度（0~100 同尖端坐标系）',
  properties: {
    tip_x: { type: 'number', minimum: -1, maximum: 2 },
    tip_y: { type: 'number', minimum: -1, maximum: 2 },
    width: { type: 'number', minimum: 2, maximum: 100 }
  },
  required: ['tip_x', 'tip_y']
};
const WARP_QUAD = {
  anyOf: [
    {
      type: 'object',
      description: '四角透视变形：每个角落在元素**自身盒子**里的位置（0,0 = 左上角，1,1 = 右下角；不变形就是 0,0 / 1,0 / 1,1 / 0,1）。只能用在文字 / 贴纸 / 照片上',
      properties: {
        top_left: { type: 'object', properties: POS, required: ['x', 'y'] },
        top_right: { type: 'object', properties: POS, required: ['x', 'y'] },
        bottom_right: { type: 'object', properties: POS, required: ['x', 'y'] },
        bottom_left: { type: 'object', properties: POS, required: ['x', 'y'] }
      },
      required: ['top_left', 'top_right', 'bottom_right', 'bottom_left']
    },
    { type: 'null' }
  ],
  description: '设置四角透视变形；传 null 清除变形'
};

// create_cover 的自定义风格（用户 2026-10-21「先做第 1 条」）：agent 看完参考图，把看到的配色 / 版式填进来；没填的用 style 选中的预设
const CUSTOM_STYLE = {
  type: 'object',
  description: '照参考图做封面时用：先看参考图，把它的配色和版式填进来（都可选，没填的用 style 的预设）。',
  properties: {
    background_color: Object.assign({ description: '背景色（没有照片时铺满整框）' }, HEX),
    title_color: Object.assign({ description: '标题文字颜色' }, HEX),
    subtitle_color: Object.assign({ description: '副标题文字颜色' }, HEX),
    accent_color: Object.assign({ description: '强调色：短横条 / 色带 / 标题底色块的颜色' }, HEX),
    title_position: { type: 'string', enum: ['top', 'center', 'bottom'], description: '文字块在框里的位置：上 / 中 / 下' },
    title_align: { type: 'string', enum: ['left', 'center', 'right'], description: '文字对齐' },
    title_size: { type: 'number', minimum: 0.04, maximum: 0.25, description: '标题字号占框短边的比例（0.08 ≈ 普通，0.15 ≈ 很大）' },
    title_max_lines: { type: 'integer', minimum: 1, maximum: 3, description: '标题最多几行（放不下先缩字，再不行用「…」截断）' },
    title_stroke_color: Object.assign({ description: '标题描边颜色' }, HEX),
    title_stroke_width: { type: 'number', minimum: 0, maximum: 30, description: '标题描边粗细，占字号的百分比（0 = 不描边，10 ≈ 明显）' },
    title_shadow: { type: 'boolean', description: '标题要不要阴影（默认不要）' },
    title_font: { type: 'string', description: '字体名（照参考图时先用 check_fonts 查参考图的字体在不在、缺了告诉用户；用 list_fonts 查本机有的；标题和副标题都用它）（电脑上没有这个字体时会先用相近的代替，返回里带 font_missing 和 tell_user —— 必须把 tell_user 告诉用户：需要下载安装原字体，或接受相近字体）' },
    subtitle_size: { type: 'number', minimum: 0.02, maximum: 0.1, description: '副标题字号占框短边的比例' },
    decoration: { type: 'string', enum: ['bar', 'band', 'box', 'none'], description: 'bar = 标题上方一条短横线；band = 文字后面一整条通栏色带；box = 标题后面一块底色；none = 不要装饰' },
    overlay_color: Object.assign({ description: '有照片时，文字下面那块遮罩的颜色' }, HEX),
    overlay_opacity: { type: 'number', minimum: 0, maximum: 1, description: '遮罩不透明度（0 = 不加遮罩，直接把字压在照片上）' },
    subject_outline_color: Object.assign({ description: '配合 subject_front：抠出来的主体外描边颜色（参考图里人物有一圈白边 / 彩边时用）' }, HEX),
    subject_outline_width: { type: 'number', minimum: 0, maximum: 40, description: '主体外描边粗细（画布像素，0 = 不描边）' },
    title_gradient_to: Object.assign({ description: '标题渐变：从 title_color 从上到下渐变到这个颜色（参考图标题是渐变色时用）' }, HEX)
  }
};

const DESTRUCTIVE_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

const TOOLS = [
  {
    name: 'get_canvas',
    description: '看画布现在是什么样：可选平台、框和每个独立元素。elements 按最上层到最下层返回，并明确给出 role（主体/标题/贴纸等语义）、layer_rank（每块框内 0 = 最上层）和 z_index（Konva 实际层号）。动手之前先调它；调整前后关系用 set_layer_order，不要靠逐个 to_front 猜顺序。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_platforms',
    description: '设置要做封面的平台（会出对应比例的框）。平台：douyin 抖音、xiaohongshu 小红书、kuaishou 快手、bilibili 哔哩哔哩、shipinhao 视频号、toutiao 头条、gongzhonghao 公众号（1:1 + 2.35:1）、dianshang 电商主图（1:1）。同比例的平台共用一块框。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: '要勾上的平台（其余取消）：内置 ' + PLATFORMS.join(' / ') + '；自定义目标写 list_custom_ratios 给的 key（custom_ratio_xxx）'
        }
      },
      required: ['platforms']
    }
  },
  {
    name: 'add_image',
    description: '把本机的一张图片放进框里（自动铺满整块框，做背景 / 主图）。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '图片的绝对路径（png / jpg / webp / gif）' }, frame: FRAME },
      required: ['path']
    }
  },
  {
    name: 'add_text',
    description: '加一段文字（标题 / 副标题等）。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: Object.assign({ text: { type: 'string', description: '文字内容，\\n 换行' }, frame: FRAME }, POS, {
        size: { type: 'number', description: '字号（画布像素，不写 = 33）。框在画布上只有两三百像素宽（见 get_canvas 的 frames[].canvas_size），标题一般是框宽的 1/6~1/10' },
        font: { type: 'string', description: '字体名（用 list_fonts 查；不写 = 默认字体）（电脑上没有这个字体时会先用相近的代替，返回里带 font_missing 和 tell_user —— 必须把 tell_user 告诉用户：需要下载安装原字体，或接受相近字体）' },
        color: COLOR('文字颜色'),
        stroke_color: COLOR('描边颜色'),
        stroke_width: { type: 'number', description: '描边粗细，占字号的百分比（0~30，0 = 不描边）' },
        shadow: { type: 'boolean', description: '要不要阴影（默认带一点阴影；false = 去掉）' },
        align: { type: 'string', enum: ['left', 'center', 'right'], description: '多行文字的对齐（默认左对齐；居中排的标题用 center）' },
        opacity: TEXT_OPACITY,
        gradient: GRADIENT,
        letter_spacing: LETTER_SPACING,
        stroke_mode: STROKE_MODE,
        stroke_gradient: GRADIENT,
        ...SKEW
      }),
      required: ['text']
    }
  },
  {
    name: 'add_shape',
    description: '加一个形状（可以在里面写字）。形状 id 用 list_shapes 查，常用：rect 正方形、roundrect 圆角矩形、circle 圆、triangle 三角、arrowR 箭头、star5 星形、burst 爆炸贴、bubbleRound 对话气泡（椭圆）、chatRect 方框气泡（两种气泡的尾巴默认在左下，用户可以在画布上把尾巴拖到任意方向）、ribbon 横幅、tag 价签、line 直线、arrowLine 箭头线、curve 曲线、brush 笔刷线（两头尖的手刷线）、brushLines 笔刷三连（三条错开的手刷线，常放在标题下面做装饰）。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: Object.assign({ shape: { type: 'string', description: '形状 id' }, frame: FRAME }, POS, {
        width: { type: 'number', minimum: 0.02, maximum: 1.5, description: '长边占框短边的比例（不写 = 0.45）' },
        height: { type: 'number', minimum: 0.01, maximum: 1.5, description: '高度占框短边的比例（可选；给了就宽高分开算，比如 rect 配 width 1.3 + height 0.12 = 一条横色带）' },
        fill: COLOR('形状颜色（线条 = 线色）'),
        text: { type: 'string', description: '形状里的字（线条不能写字）' },
        text_color: COLOR('形状里的字的颜色（不写 = 按形状颜色自动黑/白）'),
        text_size: { type: 'number', description: '形状里的字号（画布像素）' },
        font: { type: 'string', description: '形状里的字体（电脑上没有这个字体时会先用相近的代替，返回里带 font_missing 和 tell_user —— 必须把 tell_user 告诉用户：需要下载安装原字体，或接受相近字体）' },
        stroke: {
          type: 'object', description: '形状描边（不写 = 不描边）',
          properties: { color: COLOR('描边颜色'), width: { type: 'number', description: '粗细（像素）' }, dashed: { type: 'boolean', description: 'true = 虚线' } }
        },
        shadow: SHADOW,
        opacity: OPACITY,
        corner_radius: CORNER_RADIUS,
        line_points: LINE_POINTS,
        bubble_tail: BUBBLE_TAIL,
        ...SKEW
      }),
      required: ['shape']
    }
  },
  {
    name: 'add_sticker',
    description: '贴一个表情贴纸（emoji，比如 🔥 ⭐ ❤️ 👍 🎉）。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: Object.assign({ emoji: { type: 'string' }, frame: FRAME }, POS, { size: { type: 'number', description: '大小（画布像素，不写 = 60）' }, opacity: OPACITY }),
      required: ['emoji']
    }
  },
  {
    name: 'update_element',
    description: '改一个已有元素（id 从 get_canvas 拿）：位置、大小、旋转、文字、颜色等。只写要改的字段。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: Object.assign({ id: { type: 'string' }, frame: FRAME }, POS, {
        width: { type: 'number', description: '形状 / 贴纸 / 图片：长边占框**短边**的比例（形状同时给了 height 就是宽度）。⚠ 不是占框宽/框高；读回请看 w_side / h_side' },
        height: { type: 'number', description: '只对形状：高度占框**短边**的比例（同上，读回看 h_side）' },
        rotation: { type: 'number', description: '旋转角度（度）' },
        text: { type: 'string', description: '文字 / 形状里的字' },
        color: COLOR('文字颜色 / 形状颜色'),
        size: { type: 'number', description: '字号' },
        font: { type: 'string', description: '字体名（电脑上没有这个字体时会先用相近的代替，返回里带 font_missing 和 tell_user —— 必须把 tell_user 告诉用户：需要下载安装原字体，或接受相近字体）' },
        text_color: COLOR('形状里的字的颜色'),
        stroke: { type: 'object', properties: { color: COLOR('描边颜色'), width: { type: 'number' }, dashed: { type: 'boolean' } } },
        shadow: SHADOW,
        to_front: { type: 'boolean', description: 'true = 移到最上层' },
        to_back: { type: 'boolean', description: 'true = 移到最下层（比如把新加的背景色块垫到底）' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: '不透明度（0~1）。文字 = 只淡字本身（同右栏「字透明度」）；形状 / 贴纸 / 照片 = 整个元素' },
        gradient: GRADIENT,
        letter_spacing: LETTER_SPACING,
        stroke_mode: STROKE_MODE,
        stroke_gradient: GRADIENT,
        tint: Object.assign({ description: '图片贴纸的纯色色调；单独修改会取消色调渐变' }, HEX),
        tint_gradient: GRADIENT,
        corner_radius: CORNER_RADIUS,
        line_points: LINE_POINTS,
        bubble_tail: BUBBLE_TAIL,
        warp_quad: WARP_QUAD,
        ...SKEW
      }),
      required: ['id']
    }
  },
  {
    name: 'set_layer_order',
    description: '一次性确定某块框内全部元素的前后关系。bottom_to_top 必须列出该框内所有元素 id：第一个在最底层，最后一个在最上层。参考图有主体遮挡时，要逐个判断文字、贴纸与主体的关系：覆盖主体的元素放在主体上方，被主体遮挡的元素放在主体下方；原图放最底。先用 get_canvas 读取 id / role / layer_rank；整批校验通过才修改，且一次撤销可完整恢复。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        frame: FRAME,
        bottom_to_top: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
          description: '该框内全部元素 id，按最底层 → 最上层排列'
        }
      },
      required: ['frame', 'bottom_to_top']
    }
  },
  {
    name: 'delete_element',
    description: '删掉元素。给 id 删一个；all = true 删掉画布上全部内容（照片、文字、形状、贴纸）。',
    annotations: DESTRUCTIVE,
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' } } }
  },
  {
    name: 'list_shapes',
    description: '列出能用的形状 id 和名字（按分组）。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_fonts',
    description: '列出本机能用的字体（含用户导入的）。字体很多，可以用 query 筛。照参考图做时别只在这里挑替代字体 —— 先用 check_fonts 查参考图的字体在不在，缺了要告诉用户。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '名字里包含的字，比如「黑」「宋」「Arial」' },
        limit: { type: 'integer', description: '最多返回几个（默认 50）' }
      }
    }
  },
  {
    name: 'check_fonts',
    description: '查几个字体在这台电脑上有没有（用户 2026-10-22：参考图里的字体本机没有时要告诉用户）。照参考图做封面、参考图上有文字时，必须先判断参考图用的字体（认得出就写字体名，认不出就写风格最接近的常见字体名，比如 Montserrat ExtraBold、思源黑体 Heavy、站酷快乐体），用本工具查；返回里有 tell_user 时必须先停下来，把这句话原样告诉用户，等用户选好（下载安装 / 导入这个字体后继续，或者选一个列出的相近字体）再继续做封面；不要先做完再说，也不要自己悄悄换成别的字体。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        fonts: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' }, description: '要查的字体名（参考图上每种字体一个）' }
      },
      required: ['fonts']
    }
  },
  {
    name: 'list_templates',
    description: '列出用户存过的模板（名字、比例）。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'apply_template',
    description: '把一个模板套到画布上同比例的框里（换掉框里原有的文字 / 贴纸 / 形状，照片不动）。',
    annotations: DESTRUCTIVE,
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '模板名字（list_templates 里的）' }, id: { type: 'string' } } }
  },
  {
    name: 'undo',
    description: '撤销（同 Ctrl+Z）。',
    annotations: WRITE,
    inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1, description: '撤几步（默认 1）' } } }
  },
  {
    name: 'redo',
    description: '重做。',
    annotations: WRITE,
    inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1 } } }
  },
  {
    name: 'screenshot',
    description: '看一眼做出来的效果：返回某块框（或整块画布）的图片。改完之后用它检查。',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'integer', minimum: 1, description: '第几块框（不写 = 整块画布）' },
        save_to: { type: 'string', description: '存成 PNG 文件的绝对路径（可选；能打开图片文件的 AI 用这个看图最方便）' }
      }
    }
  },
  {
    name: 'export_images',
    description: '导出封面图片：每块框按平台标准尺寸各导一张 PNG（白底），写到指定文件夹，返回文件路径。给了 frames 就只导那几块框；给了 width/height 就按这个像素导出（自定义规格，铺满整块框）。',
    annotations: DESTRUCTIVE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '导出到哪个文件夹（绝对路径；不写 = 图片/封面制作器导出）' },
        frames: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 20, description: '只导这几块框（框编号，get_canvas 的 frames[].no）；不写 = 每块框都导' },
        width: { type: 'number', minimum: 64, maximum: 8000, description: '自定义导出宽度（像素）；和 height 一起给才算自定义规格，不写 = 用平台标准像素' },
        height: { type: 'number', minimum: 64, maximum: 8000, description: '自定义导出高度（像素）' }
      }
    }
  },
  {
    name: 'add_sticker_image',
    description: '从本机导入一张图片作为可缩放、可着色的图片贴纸；与 add_sticker 的 emoji 贴纸不同。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: Object.assign({
        path: { type: 'string', minLength: 1, description: '图片文件的绝对路径（png / jpg / webp / gif）' },
        frame: FRAME
      }, POS, {
        width: { type: 'number', minimum: 0.01, maximum: 2, description: '贴纸宽度占框短边的比例' },
        tint: Object.assign({ description: '纯色色调；不写则保留原图颜色' }, HEX),
        tint_gradient: GRADIENT,
        opacity: OPACITY
      }),
      required: ['path']
    }
  },
  {
    name: 'set_element_state',
    description: '设置元素可见或锁定状态。锁定的元素不能通过本工具或其他 Agent 工具强制绕过；要修改前先明确解锁。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' }
      },
      required: ['id']
    }
  },
  {
    name: 'duplicate_elements',
    description: '把一个或多个未锁定元素复制到指定框，保留样式和相对位置。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        target_frame: FRAME,
        offset_x: { type: 'number', minimum: -1, maximum: 1, description: '横向偏移，占目标框宽的比例' },
        offset_y: { type: 'number', minimum: -1, maximum: 1, description: '纵向偏移，占目标框高的比例' }
      },
      required: ['ids', 'target_frame']
    }
  },
  {
    name: 'fit_image_to_frame',
    description: '把已有图片在框或网格单元中以 cover 方式非破坏性重新取景；只改裁剪窗口、焦点与缩放，不删除或改写原图。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['cover'], default: 'cover' },
        focal_x: { type: 'number', minimum: 0, maximum: 1 },
        focal_y: { type: 'number', minimum: 0, maximum: 1 },
        zoom: { type: 'number', minimum: 1, maximum: 20 },
        cell: {
          type: 'object',
          description: '可选网格单元，行列从 1 开始',
          properties: {
            row: { type: 'integer', minimum: 1 },
            column: { type: 'integer', minimum: 1 }
          },
          required: ['row', 'column']
        }
      },
      required: ['id']
    }
  },
  {
    name: 'erase_element',
    description: '给图片元素追加非破坏性擦除笔画；原始图片数据不变，可用 clear_erase 清除蒙版。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        strokes: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object',
            properties: {
              points: {
                type: 'array', minItems: 1, maxItems: 500,
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number', minimum: 0, maximum: 1 },
                    y: { type: 'number', minimum: 0, maximum: 1 }
                  },
                  required: ['x', 'y']
                }
              },
              size: { type: 'number', minimum: 1, maximum: 500, description: '画笔直径（像素）' }
            },
            required: ['points', 'size']
          }
        }
      },
      required: ['id', 'strokes']
    }
  },
  {
    name: 'clear_erase',
    description: '清除图片元素的非破坏性擦除蒙版，恢复完整原图。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id']
    }
  },
  {
    name: 'get_template',
    description: '按 id 或名字读取一个已保存模板的完整定义，不修改模板或画布。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' }
      },
      anyOf: [{ required: ['id'] }, { required: ['name'] }]
    }
  },
  {
    name: 'save_template',
    description: '把指定框保存为新模板；同名模板默认不覆盖。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        frame: FRAME,
        overwrite: { type: 'boolean', default: false, description: '只有用户明确要求时才设 true' }
      },
      required: ['name', 'frame']
    }
  },
  {
    name: 'rename_template',
    description: '重命名模板；若目标名字已存在则默认不覆盖。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 100 }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'delete_template',
    description: '永久删除一个模板；必须由调用方明确确认。',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        confirm: { type: 'boolean', const: true }
      },
      required: ['id', 'confirm']
    }
  },
  {
    name: 'import_templates',
    description: '从绝对路径导入模板包；遇到同 id 或同名模板时默认跳过，不覆盖现有模板。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: '模板包文件的绝对路径' },
        conflict: { type: 'string', enum: ['skip', 'rename', 'overwrite'], default: 'skip' }
      },
      required: ['path']
    }
  },
  {
    name: 'export_template',
    description: '把一个模板写到指定绝对路径；文件已存在时默认不覆盖。写文件属于破坏性外部操作。',
    annotations: DESTRUCTIVE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1, description: '导出文件的绝对路径' },
        overwrite: { type: 'boolean', default: false }
      },
      required: ['id', 'path']
    }
  },
  {
    name: 'export_templates',
    description: '把多个模板写成一个模板包到指定绝对路径；文件已存在时默认不覆盖。写文件属于破坏性外部操作。',
    annotations: DESTRUCTIVE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        path: { type: 'string', minLength: 1, description: '导出文件的绝对路径' },
        overwrite: { type: 'boolean', default: false }
      },
      required: ['ids', 'path']
    }
  },
  {
    name: 'get_guides',
    description: '读取参考线、显示/吸附/锁定偏好和各框中的相对位置。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_guide_preferences',
    description: '设置参考线的显示、吸附和锁定偏好，以及标尺 / 智能参考线开关（同「视图」菜单与顶栏参考线菜单）。锁定后不能强制绕过；移动或删除前应先解锁。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        show: { type: 'boolean', description: '显示 / 隐藏参考线' },
        snap: { type: 'boolean', description: '对齐到参考线' },
        lock: { type: 'boolean', description: '锁定参考线（锁定后不能增删）' },
        rulers: { type: 'boolean', description: '标尺（同上排标尺条）' },
        smart: { type: 'boolean', description: '智能参考线（拖动时出现的粉色对齐提示）' }
      }
    }
  },
  {
    name: 'add_guide',
    description: '添加水平或垂直参考线。位置二选一：整张画布像素位置，或框编号加框内比例。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        orientation: { type: 'string', enum: ['horizontal', 'vertical'] },
        canvas_px: { type: 'number', minimum: 0, description: '相对整张画布左边或顶边的像素位置' },
        frame: FRAME,
        frame_ratio: { type: 'number', minimum: 0, maximum: 1, description: '相对指定框宽或高的位置比例' }
      },
      required: ['orientation'],
      anyOf: [
        { required: ['canvas_px'] },
        { required: ['frame', 'frame_ratio'] }
      ]
    }
  },
  {
    name: 'remove_guide',
    description: '删除一条未锁定的参考线；锁定时不提供 force 绕过。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id']
    }
  },
  {
    name: 'clear_guides',
    description: '清空全部未锁定参考线；必须明确确认，且不会用 force 绕过锁定。',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', const: true } },
      required: ['confirm']
    }
  },
  {
    name: 'get_app_settings',
    description: '读取应用当前主题与语言设置。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_theme',
    description: '切换应用主题。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: { theme: { type: 'string', enum: ['cream', 'classic'] } },
      required: ['theme']
    }
  },
  {
    name: 'set_language',
    description: '切换应用界面语言；保存设置后需要 reload（重新加载）应用才能让所有界面生效。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: { language: { type: 'string', enum: ['zh', 'en'] } },
      required: ['language']
    }
  },
  {
    name: 'create_cover',
    description: '根据标题、平台、风格和可选本地图片自动完成一版封面；默认导出并返回真实绝对路径。用户给了参考图：先看参考图，把配色 / 版式填进 custom_style。',
    annotations: DESTRUCTIVE_WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS } },
        title: { type: 'string', minLength: 1 },
        subtitle: { type: 'string' },
        style: { type: 'string' },
        image_paths: { type: 'array', items: { type: 'string' } },
        output_dir: { type: 'string' },
        auto_export: { type: 'boolean', default: true },
        replace_canvas: { type: 'boolean', default: false, description: '默认 false = 保留画布原有内容（新背景垫在最底下）；只有用户明确要求清空 / 重做时才传 true' },
        custom_style: CUSTOM_STYLE,
        subject_front: { type: 'boolean', description: '有照片时把人物 / 主体抠出来放到文字上面（杂志封面那种「人挡字」）。只在 Mac（macOS 14+）上能抠；抠不出来会给提示，封面照常做' }
      },
      required: ['title']
    }
  },
  {
    name: 'get_agent_status',
    description: '查看封面制作器、画布、任务队列和可用能力状态。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'cancel_cover_task',
    description: '取消指定的自动制作任务；正在运行的任务会停止并回滚。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id']
    }
  },
  {
    name: 'extract_subject',
    description: '把照片里的人物 / 主体抠出来，变成一个新透明图层，原照片不动。多模态 Agent 看到参考图中的主体与文字或贴纸重叠时，必须自动调用本工具，不要等用户再说“抠图”。原图保留并固定在最底层；抠完后再逐个判断重叠元素：被主体遮挡的放到主体下方，覆盖主体的放到主体上方。只在 Mac（macOS 14+）上能用。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要抠的照片 id（get_canvas 里 type = image 的）；不写 = 第 frame 块框里最大的那张照片' },
        frame: FRAME,
        outline: { type: 'object', description: '主体外描边（不写 = 不描边）', properties: {
          color: Object.assign({ description: '描边颜色' }, HEX), width: { type: 'number', minimum: 1, maximum: 40, description: '粗细（画布像素）' } } },
        shadow: { type: 'object', description: '主体阴影（不写 = 不加）', properties: {
          color: Object.assign({ description: '阴影颜色' }, HEX), distance: { type: 'number', description: '距离（画布像素）' },
          blur: { type: 'number', description: '大小 / 模糊（画布像素）' }, angle: { type: 'number', description: '方向（度，0 = 右，90 = 下）' },
          opacity: { type: 'number', minimum: 0, maximum: 1 } } }
      }
    }
  },
  // ==================== 2026-11-11：路径文字 / 颜色 / 画布辅助（三组，补「AI 能操作全部功能」缺口）====================
  {
    name: 'add_text_path',
    description: '沿一条曲线排文字（同画布右键「文字路径」拖出来的那种）。曲线用若干点给出（按框的比例 0~1，左上 = 0,0），文字顺着这条线排；建好后 update_element 改字 / 字体 / 字号 / 颜色，或再调一次本工具换一条曲线。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: Object.assign({
        text: { type: 'string', description: '路径上的文字（不能为空；换行会变成空格）' },
        points: {
          type: 'array', minItems: 2, maxItems: 64,
          description: '曲线经过的点（按框宽 / 框高的比例，0~1，按顺序连起来）。给 2 点 = 直线，3 点以上会自动平滑成曲线',
          items: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'] }
        },
        size: { type: 'number', description: '字号（画布像素，不写 = 默认字号）' },
        color: COLOR('文字颜色'),
        font: { type: 'string', description: '字体名（电脑上没有会用相近字体代替，返回里带 font_missing / tell_user）' },
        stroke_width: { type: 'number', description: '描边粗细（按字号百分比，0 = 不描边）' },
        stroke_color: COLOR('描边颜色'),
        align: { type: 'string', enum: ['left', 'center', 'right'], description: '沿曲线的对齐方式（默认 left = 从曲线起点开始排）' }
      }, { frame: FRAME, x: POS.x, y: POS.y })
    }
  },
  {
    name: 'sample_color',
    description: '从画布取样颜色（同色盘右下角那只吸管，取的就是眼睛看到的成品颜色）。给了 frame 就按那块框内的比例取，不给 frame 就按整块画布的比例取。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: Object.assign({ frame: { type: 'integer', minimum: 1, description: '在哪块框里取（不写 = 整块画布）' } }, {
        x: { type: 'number', minimum: 0, maximum: 1, description: '横向位置（占框宽 / 画布宽的比例，0 = 左，1 = 右）' },
        y: { type: 'number', minimum: 0, maximum: 1, description: '纵向位置（占框高 / 画布高的比例，0 = 顶，1 = 底）' }
      }),
      required: ['x', 'y']
    }
  },
  {
    name: 'extract_palette',
    description: '从一张照片 / 图片贴纸里提主色（同「颜色」板块的提色板）。不写 id 就取第 frame 块框里最大的那张照片。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '照片 / 图片贴纸的 id；不写 = 第 frame 块框里最大的那张照片' },
        frame: FRAME,
        count: { type: 'number', minimum: 2, maximum: 32, description: '要几个颜色（默认 24，同提色板）' },
        apply_to_board: { type: 'boolean', description: 'true = 同时把这组颜色铺到右栏提色板上（用户在界面上看得见）' }
      }
    }
  },
  {
    name: 'get_color_pins',
    description: '读常驻颜色格子（右栏颜色的那 6 个空格，存本机、重开还在）。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_color_pins',
    description: '写常驻颜色格子（最多 6 个，null / 空字符串 = 这一格留空）。整组替换，不写就保持原样。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        colors: { type: 'array', maxItems: 6, items: { anyOf: [Object.assign({ type: 'string' }, HEX), { type: 'null' }] }, description: '6 个颜色（#RRGGBB），不够 6 个后面留空' }
      },
      required: ['colors']
    }
  },
  {
    name: 'get_color_scheme',
    description: '按配色方案算一组和谐色（同「颜色」板块的配色方案：互补 / 三分 / 四分 / 类似 / 单色等）。不给 color 就列出所有方案名。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        scheme: { type: 'string', description: '方案 key（先从本工具不带 color 调一次拿到列表）' },
        color: COLOR('主色（#RRGGBB）'),
        count: { type: 'number', minimum: 2, maximum: 8, description: '要几个颜色（不写 = 该方案原生的色数）' }
      }
    }
  },
  {
    name: 'new_guide_layout',
    description: '按版式批量加参考线（同「视图 → 新建参考线版面」）：列数 / 行数 / 装订线 / 四边距，单位都是导出像素。列或行填 0 = 那个方向不分。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'integer', minimum: 1, description: '只按第几块框的规格排版（不写 = 每块框各排一套）' },
        cols: { type: 'integer', minimum: 0, maximum: 100, description: '列数（默认 2）' },
        rows: { type: 'integer', minimum: 0, maximum: 100, description: '行数（默认 0）' },
        col_gutter: { type: 'number', minimum: 0, description: '列装订线（导出像素）' },
        row_gutter: { type: 'number', minimum: 0, description: '行装订线（导出像素）' },
        margin_top: { type: 'number', minimum: 0 },
        margin_left: { type: 'number', minimum: 0 },
        margin_bottom: { type: 'number', minimum: 0 },
        margin_right: { type: 'number', minimum: 0 },
        clear: { type: 'boolean', description: 'true = 先清掉现有参考线再加' }
      }
    }
  },
  {
    name: 'align_elements',
    description: '把选中的几个元素对齐 / 分布（同顶栏那排对齐按钮）：只给 1 个 id 时对齐到它所在的那块框；给 2 个以上时对齐到这些元素的外接范围；分布（hdist / vdist）要至少 3 个，间距相等。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' }, description: '要一起对齐的元素 id（get_canvas 拿）' },
        mode: { type: 'string', enum: ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom', 'hdist', 'vdist'],
                description: 'left 左对齐 / hcenter 水平居中 / right 右对齐 / top 顶对齐 / vcenter 垂直居中 / bottom 底对齐 / hdist 水平分布 / vdist 垂直分布' }
      },
      required: ['ids', 'mode']
    }
  },
  {
    name: 'set_frame_transform',
    description: '手动缩放 / 挪动参考框本身（同画布上抓框的角点缩放、按住框边拖）。框里的照片 / 文字 / 贴纸会跟着一起变换。只影响界面排布，不影响导出像素。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'integer', minimum: 1, description: '第几块框（1 起；不写 = 1）' },
        scale: { type: 'number', minimum: 0.1, maximum: 4, description: '缩放倍数（1 = 原始大小，绕框中心缩）' },
        offset_x: { type: 'number', minimum: -4000, maximum: 4000, description: '横向位移（画布像素，正 = 右）' },
        offset_y: { type: 'number', minimum: -4000, maximum: 4000, description: '纵向位移（画布像素，正 = 下）' }
      }
    }
  },
  // ==================== 2026-11-11 第四批：字体库 / 贴纸库 / 自定义目标比例（剩下的三组）====================
  {
    name: 'import_fonts',
    description: '把本机的 .ttf / .otf / .ttc 字体文件导入软件的「导入字体」库（不用装进系统，导完立刻能用；同顶栏「文字 → ＋ 导入字体」）。返回导入了哪些族名、跳过了哪些及原因。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: '字体文件的绝对路径（.ttf / .otf / .ttc / .otc）' }
      },
      required: ['paths']
    }
  },
  {
    name: 'remove_font',
    description: '删掉一个**导入的**字体（连字体文件一起删；同「文字」弹出框里字体的 ×）。系统字体删不了。已经用它的文字会退回同类字体。',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: '字体族名（list_fonts 返回的 imported 里那些）' },
        confirm: { type: 'boolean', description: '必须传 true 才会删（防误删）' }
      },
      required: ['family', 'confirm']
    }
  },
  {
    name: 'save_to_font_library',
    description: '把画布上选中文字的样式存进「字体库」（同右栏「存入字体库」/ 文字菜单那条）。不给 id 就用当前选中的文字。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要存的文字元素 id（不写 = 用当前选中的）' },
        name: { type: 'string', description: '存进去的名字（不写 = 「框选文字 · N 段」）' }
      }
    }
  },
  {
    name: 'list_stickers',
    description: '看贴纸库里有什么：内置表情（含被藏起来的）、导入的贴纸（带 id，可以删）。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'import_stickers',
    description: '把本机图片导入贴纸库（同「贴纸」弹出框右上角＋导入贴纸）。PNG/JPG/WEBP/GIF，建议透明背景 PNG。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' }, description: '图片文件的绝对路径' }
      },
      required: ['paths']
    }
  },
  {
    name: 'remove_sticker',
    description: '从贴纸库删掉一个**导入的**贴纸（同贴纸格子悬停的 ×，库里那份副本一起删、删了不能恢复）。内置表情不能这样删，见 hide_builtin_sticker。',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '导入贴纸的 id（list_stickers 的 imported[].id）' },
        confirm: { type: 'boolean', description: '必须传 true 才会删' }
      },
      required: ['id', 'confirm']
    }
  },
  {
    name: 'hide_builtin_sticker',
    description: '从贴纸库里藏掉一个内置表情（同贴纸格子的 × / 右键删除）。可以 restore_builtin_stickers 全部恢复。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: { emoji: { type: 'string', description: '内置表情（list_stickers 的 builtin 里那些）' } },
      required: ['emoji']
    }
  },
  {
    name: 'restore_builtin_stickers',
    description: '恢复全部被藏掉的内置表情（同「↺ 恢复删除的表情」/ 文件 → 恢复内置贴纸）。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: { type: 'object', properties: {} }
  },
  // ==================== 2026-11-11 第五批：复刻参考图（参考图层 + 量测 + 比对，Phase 1）====================
  {
    name: 'set_reference_image',
    description: '把一张图设成「参考图」：半透明叠在画布上（overlay，默认）方便对位，或者贴在窗口右侧单独对照（side）。参考图**不进导出的成品**，也不是画布元素（不会被选中 / 删除 / 存进模板），重启就没了。它只给 AI 和人对照用。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '参考图的绝对路径（png / jpg / webp / gif）' },
        opacity: { type: 'number', minimum: 0.05, maximum: 1, description: '叠在画布上时的不透明度（默认 0.5；side 模式无关）' },
        mode: { type: 'string', enum: ['overlay', 'side'], description: 'overlay = 叠在画布上；side = 窗口右侧单独面板' }
      },
      required: ['path']
    }
  },
  {
    name: 'clear_reference_image',
    description: '关掉参考图（画布上那层 / 右侧面板一起收）。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'measure_reference',
    description: '把当前参考图读成数据（复刻的第一步）：背景色、显著色块（bbox + 纯色/渐变 + 颜色）、文字区（bbox + 估算字号）、主色。坐标全是占参考图宽/高的比例 0~1，可以直接当框的 x/y/w/h 用。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        max_width: { type: 'number', minimum: 120, maximum: 480, description: '分析用的采样宽度（默认 360，越大越准越慢）' },
        max_regions: { type: 'number', minimum: 1, maximum: 24, description: '最多返回几个色块（默认 12，按面积从大到小）' },
        palette: { type: 'number', minimum: 2, maximum: 8, description: '主色要几个（默认 6）' }
      }
    }
  },
  {
    name: 'compare_with_reference',
    description: '把当前画布和参考图对比（复刻的收尾/迭代用）：返回相似度 similarity（0~1）、平均色差 mean_delta，以及偏差最大的 5 块（bbox + delta_e + kind：color 颜色不对 / position 位置偏了 / missing 少了东西）。先设参考图再调它；没设参考图会报错。',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        grid: { type: 'number', minimum: 4, maximum: 24, description: '把图切成 grid×grid 格来比（默认 8；要更细看位置偏差就用 12）' }
      }
    }
  },
  {
    name: 'list_custom_ratios',
    description: '看自定义目标比例（左栏平台列表最下面自己加的那些）都有哪些，返回 key / 名称 / 宽高 / 是否已勾选。',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_custom_ratio',
    description: '新增一个自定义目标比例（同左栏「＋ 新增比例」）：宽高是**最终导出像素**（64–10000 的整数），比例由宽高自动算。新增后默认成为当前目标（勾上）。',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 64, maximum: 10000, description: '导出宽度（像素）' },
        height: { type: 'integer', minimum: 64, maximum: 10000, description: '导出高度（像素）' },
        name: { type: 'string', description: '显示名（不写 = 「宽:高」）' }
      },
      required: ['width', 'height']
    }
  },
  {
    name: 'rename_custom_ratio',
    description: '给自定义目标比例改个显示名。',
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '自定义比例的 id 或 key（custom_ratio_xxx，list_custom_ratios 给的）' },
        name: { type: 'string', description: '新名字（≤30 字，不能含 \\ / * ? " < > |）' }
      },
      required: ['id', 'name']
    }
  },
  {
    name: 'remove_custom_ratio',
    description: '删掉一个自定义目标比例（同那一行的 ×）：连带取消勾选、清掉这块框的手动位移 / 缩放。',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '自定义比例的 id 或 key' },
        confirm: { type: 'boolean', description: '必须传 true 才会删' }
      },
      required: ['id', 'confirm']
    }
  }
];

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

deepFreeze(TOOLS);

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function hasTool(name) {
  return TOOL_NAMES.has(name);
}

module.exports = { TOOLS, hasTool, deepFreeze, CUSTOM_STYLE };
