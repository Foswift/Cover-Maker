'use strict';

const assert = require('node:assert/strict');

async function run() {
  const { makeError, CODES } = require('../agent-core/errors');
  const { TOOLS, hasTool, deepFreeze, CUSTOM_STYLE } = require('../agent-core/tool-definitions');
  const { TaskQueue } = require('../agent-core/task-queue');
  const { PRESETS, RULES, resolvePreset } = require('../agent-core/layout-presets');
  const { buildCoverPlan, splitTitle, safeArea } = require('../agent-core/layout-engine');
  const { normalizeCreateCoverArgs, createCoverRunner } = require('../agent-core/create-cover');

  const expectedCodes = [
    'APP_START_FAILED',
    'APP_START_TIMEOUT',
    'MCP_NOT_READY',
    'AGENT_CONFIG_WRITE_FAILED',
    'AGENT_RESTART_REQUIRED',
    'TASK_BUSY',
    'TASK_CANCELLED',
    'IMAGE_NOT_FOUND',
    'UNSUPPORTED_IMAGE',
    'UNSUPPORTED_PLATFORM',
    'LAYOUT_FAILED',
    'SCREENSHOT_FAILED',
    'EXPORT_FAILED',
    'ROLLBACK_FAILED',
    'INVALID_ARGUMENT'
  ];
  assert.deepEqual(Object.keys(CODES), expectedCodes);
  assert.equal(Object.isFrozen(CODES), true);
  assert.deepEqual(makeError(CODES.IMAGE_NOT_FOUND, 'x'), {
    ok: false,
    code: 'IMAGE_NOT_FOUND',
    error: 'x',
    suggestion: '',
    retryable: false
  });
  assert.deepEqual(makeError(CODES.TASK_BUSY, 'busy', 'retry later', true), {
    ok: false,
    code: 'TASK_BUSY',
    error: 'busy',
    suggestion: 'retry later',
    retryable: true
  });
  assert.deepEqual(makeError('PLUGIN_ERROR', new Error('plugin failed'), 42), {
    ok: false,
    code: 'PLUGIN_ERROR',
    error: 'plugin failed',
    suggestion: '42',
    retryable: false
  });
  assert.deepEqual(makeError('FUTURE_ERROR', 500, null), {
    ok: false,
    code: 'FUTURE_ERROR',
    error: '500',
    suggestion: '',
    retryable: false
  });

  const legacyNames = [
    'get_canvas', 'set_platforms', 'add_image', 'add_text', 'add_shape', 'add_sticker',
    'update_element', 'set_layer_order', 'delete_element', 'list_shapes', 'list_fonts', 'check_fonts', 'list_templates',
    'apply_template', 'undo', 'redo', 'screenshot', 'export_images'
  ];
  const newNames = ['create_cover', 'get_agent_status', 'cancel_cover_task', 'extract_subject'];
  assert.equal(TOOLS.length, legacyNames.length + newNames.length);
  assert.deepEqual(TOOLS.map((tool) => tool.name), legacyNames.concat(newNames));
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, TOOLS.length);
  assert.equal(hasTool('get_canvas'), true);
  assert.equal(hasTool('create_cover'), true);
  assert.equal(hasTool('not_a_tool'), false);
  assert.equal(hasTool(), false);
  assert.equal(TOOLS.filter((tool) => tool.name === 'create_cover').length, 1);

  const getCanvas = TOOLS.find((tool) => tool.name === 'get_canvas');
  assert.deepEqual(getCanvas.inputSchema, { type: 'object', properties: {} });
  assert.equal(getCanvas.annotations.readOnlyHint, true);
  assert.equal(getCanvas.annotations.idempotentHint, true);
  assert.equal(getCanvas.annotations.openWorldHint, false);

  const setLayerOrder = TOOLS.find((tool) => tool.name === 'set_layer_order');
  assert.deepEqual(setLayerOrder.inputSchema.required, ['frame', 'bottom_to_top']);
  assert.equal(setLayerOrder.inputSchema.properties.bottom_to_top.uniqueItems, true);
  assert.equal(setLayerOrder.annotations.readOnlyHint, false);
  assert.equal(setLayerOrder.annotations.destructiveHint, false);

  const deleteElement = TOOLS.find((tool) => tool.name === 'delete_element');
  assert.equal(deleteElement.annotations.readOnlyHint, false);
  assert.equal(deleteElement.annotations.destructiveHint, true);
  assert.deepEqual(deleteElement.inputSchema.properties, {
    id: { type: 'string' },
    all: { type: 'boolean' }
  });

  const addText = TOOLS.find((tool) => tool.name === 'add_text');
  assert.deepEqual(addText.inputSchema.required, ['text']);
  assert.equal(addText.inputSchema.properties.x.minimum, 0);
  assert.equal(addText.inputSchema.properties.x.maximum, 1);
  assert.equal(addText.inputSchema.properties.frame.minimum, 1);
  // 透明度（参考图半透明文字）：文字 / 形状 / 贴纸 / 改元素都能给
  for (const name of ['add_text', 'add_shape', 'add_sticker', 'update_element']) {
    const op = TOOLS.find((tool) => tool.name === name).inputSchema.properties.opacity;
    assert.equal(op.type, 'number', name + ' has opacity');
    assert.equal(op.minimum, 0);
    assert.equal(op.maximum, 1);
  }
  assert.match(TOOLS.find((tool) => tool.name === 'add_shape').description, /brush 笔刷线/);
  // 文字渐变（参考图中间那行 FRIDAY 青→浅青）
  for (const name of ['add_text', 'update_element']) {
    const g = TOOLS.find((tool) => tool.name === name).inputSchema.properties.gradient;
    assert.equal(g.type, 'object', name + ' has gradient');
    assert.equal(g.properties.colors.type, 'array');
    assert.equal(g.properties.colors.maxItems, 4);
    assert.equal(g.properties.angle.type, 'number');
  }

  const createCover = TOOLS.find((tool) => tool.name === 'create_cover');
  assert.equal(createCover.description, '根据标题、平台、风格和可选本地图片自动完成一版封面；默认导出并返回真实绝对路径。用户给了参考图：先看参考图，把配色 / 版式填进 custom_style。');
  assert.deepEqual(createCover.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  });
  assert.deepEqual(createCover.inputSchema, {
    type: 'object',
    properties: {
      platforms: {
        type: 'array',
        items: { type: 'string', enum: ['douyin', 'xiaohongshu', 'kuaishou', 'bilibili', 'shipinhao', 'toutiao', 'gongzhonghao', 'dianshang'] }
      },
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
  });
  assert.deepEqual(Object.keys(CUSTOM_STYLE.properties), ['background_color', 'title_color', 'subtitle_color', 'accent_color',
    'title_position', 'title_align', 'title_size', 'title_max_lines', 'title_stroke_color', 'title_stroke_width', 'title_shadow',
    'title_font', 'subtitle_size', 'decoration', 'overlay_color', 'overlay_opacity', 'subject_outline_color', 'subject_outline_width', 'title_gradient_to']);
  assert.deepEqual(CUSTOM_STYLE.properties.decoration.enum, ['bar', 'band', 'box', 'none']);
  // 参考图字体（用户 2026-10-22 Mac 实测「为什么参考图没有的字体没有给用户反馈」）：先认字体、check_fonts，缺的必须告诉用户
  const checkFonts = TOOLS.find((tool) => tool.name === 'check_fonts');
  assert.ok(checkFonts, 'check_fonts tool exists');
  assert.deepEqual(checkFonts.inputSchema.required, ['fonts']);
  assert.equal(checkFonts.inputSchema.properties.fonts.type, 'array');
  assert.equal(checkFonts.annotations.readOnlyHint, true);
  assert.match(checkFonts.description, /参考图.*字体.*必须.*tell_user.*告诉用户/, '缺字体必须告诉用户');
  // 用户同日追加「不存在的话需要去告诉用户，然后由用户做选择后再继续」：先停、等用户选，不能先做完再说
  assert.match(checkFonts.description, /先停下来.*等用户.*选.*再继续/, '缺字体要先停下来等用户选择');
  assert.match(CUSTOM_STYLE.properties.title_font.description, /check_fonts/, '照参考图设字体前先 check_fonts');
  assert.match(TOOLS.find((tool) => tool.name === 'list_fonts').description, /check_fonts/);
  const extract = TOOLS.find((tool) => tool.name === 'extract_subject');
  assert.deepEqual(Object.keys(extract.inputSchema.properties), ['id', 'frame', 'outline', 'shadow']);
  assert.equal(extract.annotations.readOnlyHint, false);
  assert.equal(extract.annotations.destructiveHint, false, 'adds a layer, never touches the original photo');
  assert.match(extract.description, /参考图.*主体.*文字.*贴纸.*重叠.*必须自动调用/, '多模态 Agent 发现主体遮挡时必须自动抠主体');
  assert.match(extract.description, /原图.*最底层/, '原始照片必须保留在最底层');
  assert.match(setLayerOrder.description, /逐个.*文字.*贴纸.*主体.*上方.*下方/, '重叠元素必须逐个判断主体前后关系');
  assert.equal(TOOLS.find((tool) => tool.name === 'update_element').inputSchema.properties.to_back.type, 'boolean');
  assert.equal(createCover.inputSchema.properties.subject_front.type, 'boolean');

  const status = TOOLS.find((tool) => tool.name === 'get_agent_status');
  assert.deepEqual(status.inputSchema, { type: 'object', properties: {} });
  assert.equal(status.annotations.readOnlyHint, true);

  const cancel = TOOLS.find((tool) => tool.name === 'cancel_cover_task');
  assert.deepEqual(cancel.inputSchema.required, ['task_id']);
  assert.deepEqual(cancel.inputSchema.properties.task_id, { type: 'string' });
  assert.equal(cancel.annotations.readOnlyHint, false);

  const setPlatforms = TOOLS.find((tool) => tool.name === 'set_platforms');
  assert.deepEqual(
    createCover.inputSchema.properties.platforms.items.enum,
    setPlatforms.inputSchema.properties.platforms.items.enum
  );

  const applyTemplate = TOOLS.find((tool) => tool.name === 'apply_template');
  assert.equal(applyTemplate.annotations.readOnlyHint, false);
  assert.equal(applyTemplate.annotations.destructiveHint, true);

  const screenshot = TOOLS.find((tool) => tool.name === 'screenshot');
  assert.equal(screenshot.annotations.readOnlyHint, false);
  assert.equal(screenshot.annotations.destructiveHint, true);

  const exportImages = TOOLS.find((tool) => tool.name === 'export_images');
  assert.equal(exportImages.annotations.readOnlyHint, false);
  assert.equal(exportImages.annotations.destructiveHint, true);
  assert.equal(exportImages.annotations.idempotentHint, true);

  const mutableChild = { value: 1 };
  const shallowFrozenParent = Object.freeze({ child: mutableChild });
  assert.equal(Object.isFrozen(mutableChild), false);
  assert.equal(deepFreeze(shallowFrozenParent), shallowFrozenParent);
  assert.equal(Object.isFrozen(mutableChild), true);

  function assertDeepFrozen(value, path) {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
    for (const key of Reflect.ownKeys(value)) {
      assertDeepFrozen(value[key], `${path}.${String(key)}`);
    }
  }
  assertDeepFrozen(TOOLS, 'TOOLS');

  assert.throws(() => {
    createCover.inputSchema.properties.title.minLength = 0;
  }, TypeError);
  assert.throws(() => {
    TOOLS.push({ name: 'injected_tool' });
  }, TypeError);
  assert.equal(hasTool('injected_tool'), false);
  assert.equal(hasTool('create_cover'), TOOLS.some((tool) => tool.name === 'create_cover'));

  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs an object schema`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} must stay local`);
  }

  const expectedPresetLabels = {
    'minimal-premium': '简洁高级',
    tech: '科技感',
    knowledge: '知识干货',
    energetic: '活力醒目',
    'warm-life': '温暖生活',
    business: '商务专业'
  };
  assert.deepEqual(Object.keys(PRESETS), Object.keys(expectedPresetLabels));
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.equal(preset.id, id);
    assert.equal(preset.label, expectedPresetLabels[id]);
    assert.equal(typeof preset.palette, 'object');
    assert.equal(Array.isArray(preset.palette), false);
    for (const [name, color] of Object.entries(preset.palette)) {
      assert.match(color, /^#[0-9A-F]{6}$/, `${id}.palette.${name} must be #RRGGBB`);
    }
    for (const [name, textStyle] of Object.entries({ title: preset.title, subtitle: preset.subtitle })) {
      assert.equal(Number.isFinite(textStyle.fontScale), true, `${id}.${name}.fontScale must be finite`);
      assert.equal(textStyle.fontScale > 0 && textStyle.fontScale < 1, true,
        `${id}.${name}.fontScale must be between 0 and 1`);
      assert.equal(Number.isInteger(textStyle.maxLines) && textStyle.maxLines > 0, true,
        `${id}.${name}.maxLines must be a positive integer`);
    }
    assert.match(preset.title.align, /^(left|center|right)$/);
    assert.equal(Array.isArray(preset.decorations), true);
    assert.equal(typeof preset.imageLayout, 'object');
    assert.equal(typeof preset.noImageLayout, 'object');
    for (const [path, value] of [
      ['imageLayout.imageRatio', preset.imageLayout.imageRatio],
      ['imageLayout.overlayOpacity', preset.imageLayout.overlayOpacity],
      ['noImageLayout.textWidth', preset.noImageLayout.textWidth]
    ]) {
      assert.equal(Number.isFinite(value), true, `${id}.${path} must be finite`);
      assert.equal(value >= 0 && value <= 1, true, `${id}.${path} must be between 0 and 1`);
    }
    assert.deepEqual(Object.keys(preset), [
      'id', 'label', 'palette', 'title', 'subtitle', 'decorations', 'imageLayout', 'noImageLayout'
    ]);
    assertDeepFrozen(preset, `PRESETS.${id}`);
  }
  assertDeepFrozen(PRESETS, 'PRESETS');
  assertDeepFrozen(RULES, 'RULES');

  const styleCases = new Map([
    ['简洁', 'minimal-premium'], ['高级', 'minimal-premium'], ['留白', 'minimal-premium'],
    ['科技', 'tech'], ['AI', 'tech'], ['未来', 'tech'],
    ['干货', 'knowledge'], ['教程', 'knowledge'], ['清单', 'knowledge'],
    ['醒目', 'energetic'], ['热闹', 'energetic'], ['促销', 'energetic'],
    ['温暖', 'warm-life'], ['生活', 'warm-life'], ['治愈', 'warm-life'],
    ['商务', 'business'], ['企业', 'business'], ['专业', 'business']
  ]);
  for (const [style, id] of styleCases) {
    assert.equal(resolvePreset(style), PRESETS[id], `${style} should resolve to ${id}`);
  }
  for (const id of Object.keys(expectedPresetLabels)) {
    assert.equal(resolvePreset(id), PRESETS[id], `${id} should resolve by canonical id`);
    assert.equal(resolvePreset(id.toUpperCase()), PRESETS[id], `${id} should ignore case`);
  }
  assert.equal(resolvePreset('  科技， ＡＩ；未来！ '), PRESETS.tech);
  assert.equal(resolvePreset('【温暖】、生活／治愈'), PRESETS['warm-life']);
  assert.equal(resolvePreset('BUSINESS，professional'), PRESETS.business);
  assert.equal(resolvePreset(), PRESETS['minimal-premium']);
  assert.equal(resolvePreset(null), PRESETS['minimal-premium']);
  assert.equal(resolvePreset('  '), PRESETS['minimal-premium']);
  assert.equal(resolvePreset('未知风格'), PRESETS['minimal-premium']);
  assert.equal(resolvePreset({ style: 'tech' }), PRESETS['minimal-premium']);
  assert.equal(resolvePreset('科技'), resolvePreset(' 科 技 ！'));
  assert.equal(resolvePreset('科技，商务'), PRESETS.tech, 'keyword priority must be deterministic');
  for (const style of [
    '不专业', '非科技风', '无商务风', '不要未来感', '不要 tech 风',
    '避免专业风', '拒绝科技风', '去掉未来感', '未来不要科技感'
  ]) {
    assert.equal(resolvePreset(style), PRESETS['minimal-premium'], `${style} must not select a negated style`);
  }
  assert.equal(resolvePreset('高科技风'), PRESETS.tech, 'a valid keyword suffix must retain the Chinese style match');
  assert.equal(resolvePreset('不要科技感，要商务专业'), PRESETS.business,
    'negation must not hide an explicit style in another clause');
  assert.equal(resolvePreset('拒绝商务风，选择温暖治愈'), PRESETS['warm-life'],
    'remaining positive styles still use deterministic priority');
  for (const style of ['科技馆导览', '专业户采访']) {
    assert.equal(resolvePreset(style), PRESETS['minimal-premium'], `${style} contains no style keyword boundary`);
  }
  assert.throws(() => {
    PRESETS.tech.title.fontScale = 99;
  }, TypeError);
  assert.throws(() => {
    PRESETS.tech.decorations.push('injected');
  }, TypeError);

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  function assertIso(value, label) {
    assert.equal(typeof value, 'string', `${label} must be a string`);
    assert.equal(new Date(value).toISOString(), value, `${label} must be ISO time`);
  }

  // Workers receive one stable context object: { signal, taskId }.
  const serialQueue = new TaskQueue();
  const firstGate = deferred();
  const serialEvents = [];
  let activeWorkers = 0;
  let maximumActiveWorkers = 0;
  const firstPromise = serialQueue.enqueue('first', async ({ signal, taskId }) => {
    assert.equal(taskId, 'first');
    assert.equal(signal instanceof AbortSignal, true);
    activeWorkers += 1;
    maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
    serialEvents.push('first:start');
    await firstGate.promise;
    serialEvents.push('first:end');
    activeWorkers -= 1;
    return 'first result';
  });
  const secondPromise = serialQueue.enqueue('second', async ({ signal, taskId }) => {
    assert.equal(taskId, 'second');
    assert.equal(signal instanceof AbortSignal, true);
    activeWorkers += 1;
    maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
    serialEvents.push('second:start');
    activeWorkers -= 1;
    return 'second result';
  });
  await Promise.resolve();
  assert.deepEqual(serialEvents, ['first:start']);
  const busyStatus = serialQueue.status();
  assert.deepEqual(busyStatus, {
    active: {
      task_id: 'first',
      started_at: busyStatus.active.started_at
    },
    queued: [{
      task_id: 'second',
      queued_at: busyStatus.queued[0].queued_at
    }]
  });
  assertIso(busyStatus.active.started_at, 'active.started_at');
  assertIso(busyStatus.queued[0].queued_at, 'queued.queued_at');
  firstGate.resolve();
  assert.equal(await firstPromise, 'first result');
  assert.equal(await secondPromise, 'second result');
  assert.deepEqual(serialEvents, ['first:start', 'first:end', 'second:start']);
  assert.equal(maximumActiveWorkers, 1);
  assert.deepEqual(serialQueue.status(), { active: null, queued: [] });

  const validationQueue = new TaskQueue();
  await assert.rejects(validationQueue.enqueue('', async () => {}), /taskId/i);
  await assert.rejects(validationQueue.enqueue('   ', async () => {}), /taskId/i);
  await assert.rejects(validationQueue.enqueue('valid', null), /worker/i);
  const duplicateGate = deferred();
  const original = validationQueue.enqueue('duplicate', () => duplicateGate.promise);
  await assert.rejects(validationQueue.enqueue('duplicate', async () => {}), /duplicate/i);
  duplicateGate.resolve('done');
  assert.equal(await original, 'done');

  // Cancelling in the same turn as enqueue must prevent even a synchronous
  // worker body from starting, and must not stall the following task.
  const immediateCancelQueue = new TaskQueue();
  let immediateWorkerCalls = 0;
  const immediatePromise = immediateCancelQueue.enqueue('immediate-cancel', () => {
    immediateWorkerCalls += 1;
    return 'must not resolve';
  });
  const immediateCancelled = assert.rejects(immediatePromise, (error) => {
    assert.equal(error.code, CODES.TASK_CANCELLED);
    assert.equal(error.taskId, 'immediate-cancel');
    return true;
  });
  assert.equal(immediateCancelQueue.cancel('immediate-cancel'), true);
  const afterImmediate = immediateCancelQueue.enqueue('after-immediate-cancel', () => 'continued');
  await immediateCancelled;
  assert.equal(immediateWorkerCalls, 0);
  assert.equal(await afterImmediate, 'continued');

  const queuedCancelQueue = new TaskQueue();
  const blocker = deferred();
  const blockerPromise = queuedCancelQueue.enqueue('blocker', () => blocker.promise);
  const neverRunPromise = queuedCancelQueue.enqueue('queued-cancel', async () => {
    assert.fail('a cancelled queued worker must not run');
  });
  const queuedCancelled = assert.rejects(neverRunPromise, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, CODES.TASK_CANCELLED);
    assert.equal(error.taskId, 'queued-cancel');
    return true;
  });
  assert.equal(queuedCancelQueue.cancel('queued-cancel'), true);
  assert.equal(queuedCancelQueue.cancel('queued-cancel'), false);
  await queuedCancelled;
  assert.deepEqual(queuedCancelQueue.status().queued, []);
  blocker.resolve('unblocked');
  assert.equal(await blockerPromise, 'unblocked');
  assert.equal(
    await queuedCancelQueue.enqueue('queued-cancel', () => 'reused after queued cancellation'),
    'reused after queued cancellation'
  );

  const activeCancelQueue = new TaskQueue();
  let observedSignal;
  const activeCancelledPromise = activeCancelQueue.enqueue('active-cancel', ({ signal }) => {
    observedSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('worker noticed abort');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  const activeCancelled = assert.rejects(activeCancelledPromise, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, CODES.TASK_CANCELLED);
    assert.equal(error.taskId, 'active-cancel');
    return true;
  });
  await Promise.resolve();
  assert.equal(activeCancelQueue.cancel('active-cancel'), true);
  assert.equal(observedSignal.aborted, true);
  await activeCancelled;
  assert.deepEqual(activeCancelQueue.status(), { active: null, queued: [] });

  // AbortError is only cancellation when this queue's signal was aborted.
  const abortErrorQueue = new TaskQueue();
  const workerAbortError = new Error('worker-owned AbortError');
  workerAbortError.name = 'AbortError';
  const workerAbortPromise = abortErrorQueue.enqueue('worker-abort-error', () => {
    throw workerAbortError;
  });
  await assert.rejects(workerAbortPromise, (error) => {
    assert.equal(error, workerAbortError);
    assert.equal(error.code, undefined);
    return true;
  });

  // A worker may ignore cancellation and resolve; the public task still cancels.
  const resolveAfterAbortQueue = new TaskQueue();
  let resolveAfterAbortStarted = false;
  const resolveAfterAbortPromise = resolveAfterAbortQueue.enqueue('resolve-after-abort', ({ signal }) => {
    resolveAfterAbortStarted = true;
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve('ignored abort'), { once: true });
    });
  });
  const resolvedWorkerCancelled = assert.rejects(resolveAfterAbortPromise, (error) => {
    assert.equal(error.code, CODES.TASK_CANCELLED);
    assert.equal(error.taskId, 'resolve-after-abort');
    return true;
  });
  await Promise.resolve();
  assert.equal(resolveAfterAbortStarted, true);
  assert.equal(resolveAfterAbortQueue.cancel('resolve-after-abort'), true);
  await resolvedWorkerCancelled;

  // A genuinely synchronous throw must release the queue for the next task.
  const syncThrowQueue = new TaskQueue();
  const syncError = new Error('synchronous worker failure');
  const syncFailed = syncThrowQueue.enqueue('sync-throw', () => {
    throw syncError;
  });
  const afterSyncThrow = syncThrowQueue.enqueue('after-sync-throw', () => 'continued after sync throw');
  await assert.rejects(syncFailed, (error) => error === syncError);
  assert.equal(await afterSyncThrow, 'continued after sync throw');

  // Completed task IDs are reusable.
  const reuseQueue = new TaskQueue();
  assert.equal(await reuseQueue.enqueue('reusable', () => 'first use'), 'first use');
  assert.equal(await reuseQueue.enqueue('reusable', () => 'second use'), 'second use');

  const isolationQueue = new TaskQueue();
  const failed = isolationQueue.enqueue('fails', async () => {
    throw new Error('intentional worker failure');
  });
  const recovered = isolationQueue.enqueue('after-failure', async () => 'still runs');
  await assert.rejects(failed, /intentional worker failure/);
  assert.equal(await recovered, 'still runs');
  assert.deepEqual(isolationQueue.status(), { active: null, queued: [] });

  // ---------- Task 5: layout engine ----------
  assert.deepEqual(splitTitle('普通人如何用AI提升效率', 6, 3), { lines: ['普通人如何用', 'AI提升效率'], truncated: false });
  assert.deepEqual(splitTitle('短标题', 8, 2), { lines: ['短标题'], truncated: false });
  assert.deepEqual(splitTitle('三招拍出高级感', 6, 3).lines, ['三招拍出', '高级感'], 'balanced: no lone last character');
  assert.deepEqual(splitTitle('一二三四五六七八九十十一', 10, 3).lines, ['一二三四五六', '七八九十十一']);
  assert.deepEqual(splitTitle('第一行\n第二行', 8, 3), { lines: ['第一行', '第二行'], truncated: false });
  // English words are not cut in the middle; half-width chars count as half.
  assert.deepEqual(splitTitle('Make covers faster today', 6, 3).lines, ['Make covers', 'faster today']);
  // Prefer breaking right after punctuation near the limit.
  assert.deepEqual(splitTitle('三分钟学会，封面排版技巧', 7, 3).lines, ['三分钟学会，', '封面排版技巧']);
  const cut = splitTitle('这是一个非常非常非常非常非常非常长的标题需要被截断', 5, 3);
  assert.equal(cut.lines.length, 3);
  assert.equal(cut.truncated, true);
  assert.equal(cut.lines[2].endsWith('…'), true);
  assert.deepEqual(splitTitle('', 5, 3), { lines: [], truncated: false });

  const frameXhs = { no: 1, ratio: '3:4', width: 300, height: 400, platforms: ['xiaohongshu'] };
  const frameDouyin = { no: 2, ratio: '9:16', width: 270, height: 480, platforms: ['toutiao'] };
  const frameBili = { no: 3, ratio: '16:9', width: 480, height: 270, platforms: ['bilibili'] };

  const EPS = 2e-4; // plan coordinates are rounded to 4 decimals
  function assertInFrame(el, label) {
    for (const k of ['x', 'y']) {
      assert.equal(typeof el[k], 'number', `${label}.${k}`);
      assert.ok(el[k] >= 0 && el[k] <= 1, `${label}.${k}=${el[k]} must be within 0..1`);
    }
    if (el.box) {
      assert.ok(el.box.x >= 0 && el.box.y >= 0 && el.box.x + el.box.w <= 1 + EPS && el.box.y + el.box.h <= 1 + EPS,
        `${label}.box must stay inside the frame`);
    }
  }
  function assertInSafe(el, safe, label) {
    const b = el.box;
    assert.ok(b.x >= safe.x - EPS && b.y >= safe.y - EPS && b.x + b.w <= safe.x + safe.w + EPS && b.y + b.h <= safe.y + safe.h + EPS,
      `${label} box ${JSON.stringify(b)} must stay in safe area ${JSON.stringify(safe)}`);
  }

  // 1. 小红书 3:4 无图
  const planXhs = buildCoverPlan({ frames: [frameXhs], title: '普通人如何用 AI 提升效率', subtitle: '5 个马上能用的方法', style: '简洁高级', imagePaths: [] });
  assert.equal(planXhs.ok, true);
  assert.equal(planXhs.preset, 'minimal-premium');
  assert.equal(planXhs.frames.length, 1);
  const fx = planXhs.frames[0];
  assert.equal(fx.frame, 1);
  assert.deepEqual(fx.background, { type: 'solid', ref_id: 'background', role: 'background', layer: 0, color: PRESETS['minimal-premium'].palette.background });
  assert.equal(fx.elements.some((e) => e.type === 'image'), false);
  assert.ok(fx.elements.some((e) => e.type === 'shape' && e.role === 'accent'));
  const xTitle = fx.elements.find((e) => e.role === 'title');
  const xSub = fx.elements.find((e) => e.role === 'subtitle');
  assert.ok(fx.elements.every((e) => e.ref_id && Number.isFinite(e.layer)), 'every planned element has explicit identity and layer');
  assert.deepEqual({ title: xTitle.layer, subtitle: xSub.layer }, { title: 20, subtitle: 21 });
  assert.equal(xTitle.type, 'text');
  assert.equal(xSub.type, 'text');
  assert.equal(xTitle.text.replace(/\s+/g, ''), '普通人如何用AI提升效率');
  assert.ok(xTitle.size > xSub.size, 'title is bigger than subtitle');
  assert.ok(xSub.box.y >= xTitle.box.y + xTitle.box.h - EPS, 'subtitle sits under the title');
  assert.deepEqual(planXhs.warnings, []);

  // 2. 抖音 9:16 有图
  const planDy = buildCoverPlan({ frames: [frameDouyin], title: '一分钟看懂', style: '科技', imagePaths: ['D:/a.jpg'] });
  assert.equal(planDy.preset, 'tech');
  const fd = planDy.frames[0];
  assert.equal(fd.background.type, 'image');
  assert.equal(fd.background.path, 'D:/a.jpg');
  assert.equal(fd.background.fallbackColor, PRESETS.tech.palette.background, 'image background carries a solid fallback');
  assert.ok(fd.elements.find((e) => e.role === 'title'));
  assert.equal(fd.elements.some((e) => e.role === 'subtitle'), false, 'no subtitle element when subtitle is empty');
  assert.ok(fd.elements.some((e) => e.role === 'scrim'), 'text over a photo gets a backing panel');

  // 3. B站 16:9 标题+副标题，多框各自出计划，图片多于一张时按框轮流
  const planMulti = buildCoverPlan({ frames: [frameXhs, frameBili], title: '标题', subtitle: '副标题', style: 'business', imagePaths: ['D:/1.jpg', 'D:/2.jpg', 'D:/3.jpg'] });
  assert.deepEqual(planMulti.frames.map((f) => f.frame), [1, 3]);
  assert.deepEqual(planMulti.frames.map((f) => f.background.path), ['D:/1.jpg', 'D:/2.jpg']);
  assert.ok(planMulti.warnings.some((w) => /D:\/3\.jpg/.test(w)), 'unused images are reported');
  const fb = planMulti.frames[1];
  assert.ok(fb.elements.find((e) => e.role === 'subtitle'));

  // 4. 长标题最多三行，超出给 warning
  const planLong = buildCoverPlan({ frames: [frameXhs], title: '这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题', style: '' });
  const lTitle = planLong.frames[0].elements.find((e) => e.role === 'title');
  assert.ok(lTitle.text.split('\n').length <= 3);
  assert.ok(planLong.warnings.length >= 1);

  // 5 + 6. 所有位置在 0..1，文字不出安全区
  for (const plan of [planXhs, planDy, planMulti, planLong]) {
    for (const f of plan.frames) {
      const src = [frameXhs, frameDouyin, frameBili].find((x) => x.no === f.frame);
      const safe = safeArea(src);
      for (const el of f.elements) {
        assertInFrame(el, `frame${f.frame}.${el.role}`);
        if (el.type === 'text') assertInSafe(el, safe, `frame${f.frame}.${el.role}`);
      }
    }
  }
  // 9:16 keeps text away from the bottom platform UI
  assert.ok(safeArea(frameDouyin).y + safeArea(frameDouyin).h <= 0.85);

  // 7. 同输入同输出
  const again = buildCoverPlan({ frames: [frameXhs], title: '普通人如何用 AI 提升效率', subtitle: '5 个马上能用的方法', style: '简洁高级', imagePaths: [] });
  assert.deepEqual(again, planXhs);

  // 错误输入 → 结构化错误
  assert.equal(buildCoverPlan({ frames: [frameXhs], title: '  ' }).code, 'LAYOUT_FAILED');
  assert.equal(buildCoverPlan({ frames: [], title: 'x' }).code, 'LAYOUT_FAILED');
  assert.equal(buildCoverPlan({ frames: [{ no: 1, width: 0, height: 10 }], title: 'x' }).code, 'LAYOUT_FAILED');
  assert.equal(buildCoverPlan().ok, false);

  // ---------- custom_style（照参考图）----------
  {
    const base = { frames: [frameXhs], title: '三分钟学会封面排版', subtitle: '新手也能用', style: '简洁高级' };
    const plan = (cs, extra) => buildCoverPlan(Object.assign({}, base, extra || {}, { customStyle: cs }));
    const els = (p) => p.frames[0].elements;
    const role = (p, r) => els(p).find((e) => e.role === r);

    // colours override the preset everywhere they are used
    const pc = plan({ background_color: '#112233', title_color: 'ff0000', subtitle_color: '#00FF00', accent_color: '#abc' });
    assert.equal(pc.ok, true, JSON.stringify(pc));
    assert.deepEqual(pc.frames[0].background, { type: 'solid', ref_id: 'background', role: 'background', layer: 0, color: '#112233' });
    assert.equal(role(pc, 'title').color, '#FF0000');
    assert.equal(role(pc, 'subtitle').color, '#00FF00');
    assert.equal(role(pc, 'accent').fill, '#AABBCC');

    // position: top < center < bottom
    const yTop = role(plan({ title_position: 'top' }), 'title').y;
    const yMid = role(plan({ title_position: 'center' }), 'title').y;
    const yBot = role(plan({ title_position: 'bottom' }), 'title').y;
    assert.ok(yTop < yMid && yMid < yBot, [yTop, yMid, yBot].join(' '));

    // alignment: right edge sits on the safe area's right edge
    const safe = safeArea(frameXhs);
    const tr = role(plan({ title_align: 'right' }), 'title');
    assert.equal(tr.align, 'right');
    assert.ok(Math.abs(tr.box.x + tr.box.w - (safe.x + safe.w)) < EPS);
    assert.equal(role(plan({ title_align: 'center' }), 'title').x, 0.5);

    // size and line cap
    assert.ok(role(plan({ title_size: 0.16 }), 'title').size > role(plan({ title_size: 0.06 }), 'title').size);
    const one = plan({ title_max_lines: 1 }, { title: '这是一个特别特别特别特别特别特别长的标题文字' });
    assert.equal(role(one, 'title').text.split('\n').length, 1);
    assert.ok(one.warnings.length >= 1);

    // stroke / shadow / font travel with the text
    const st = role(plan({ title_stroke_color: '#000', title_stroke_width: 12, title_shadow: true, title_font: '思源黑体' }), 'title');
    assert.equal(st.stroke_color, '#000000');
    assert.equal(st.stroke_width, 12);
    assert.equal(st.shadow, true);
    assert.equal(st.font, '思源黑体');
    assert.equal(role(plan({ title_font: '思源黑体' }), 'subtitle').font, '思源黑体');
    assert.equal(role(plan({}), 'title').shadow, false, 'no shadow unless asked');

    // decorations
    const none = plan({ decoration: 'none' });
    assert.equal(els(none).some((e) => e.type === 'shape'), false);
    const band = plan({ decoration: 'band', accent_color: '#FFD400' });
    const bandEl = role(band, 'band');
    assert.equal(bandEl.fill, '#FFD400');
    assert.equal(bandEl.box.x, 0);
    assert.equal(bandEl.box.w, 1);
    for (const r of ['title', 'subtitle']) {
      const b = role(band, r).box;
      assert.ok(b.y >= bandEl.box.y - EPS && b.y + b.h <= bandEl.box.y + bandEl.box.h + EPS, r + ' sits inside the band');
    }
    assert.equal(els(band).some((e) => e.role === 'accent'), false);
    const box = plan({ decoration: 'box' });
    const boxEl = role(box, 'box');
    const tb = role(box, 'title').box;
    assert.ok(boxEl.box.x <= tb.x && boxEl.box.y <= tb.y && boxEl.box.x + boxEl.box.w >= tb.x + tb.w && boxEl.box.y + boxEl.box.h >= tb.y + tb.h, 'box wraps the title');
    assert.ok(els(box).indexOf(boxEl) < els(box).indexOf(role(box, 'title')), 'box is drawn before (under) the title');

    // overlay with a photo
    const withImg = { imagePaths: ['D:/a.jpg'] };
    assert.equal(els(plan({ overlay_opacity: 0 }, withImg)).some((e) => e.role === 'scrim'), false, 'opacity 0 = no overlay');
    const sc = role(plan({ overlay_color: '#000000', overlay_opacity: 0.4 }, withImg), 'scrim');
    assert.equal(sc.fill, '#000000');
    assert.equal(sc.opacity, 0.4);
    const topScrim = role(plan({ title_position: 'top' }, withImg), 'scrim');
    assert.equal(topScrim.box.y, 0, 'text at the top → overlay hugs the top edge');

    // everything still inside frame / safe area, deterministic
    for (const cs of [{ title_position: 'top', decoration: 'band' }, { title_position: 'bottom', title_align: 'right', decoration: 'box', title_size: 0.2 },
      { title_position: 'center', title_size: 0.25, title_max_lines: 3 }]) {
      for (const fr of [frameXhs, frameDouyin, frameBili]) {
        const p = buildCoverPlan({ frames: [fr], title: '普通人如何用 AI 提升效率', subtitle: '5 个马上能用的方法', customStyle: cs });
        for (const el of p.frames[0].elements) {
          assertInFrame(el, JSON.stringify(cs) + el.role);
          if (el.type === 'text') assertInSafe(el, safeArea(fr), JSON.stringify(cs) + el.role);
        }
        assert.deepEqual(buildCoverPlan({ frames: [fr], title: '普通人如何用 AI 提升效率', subtitle: '5 个马上能用的方法', customStyle: cs }), p);
      }
    }

    // title gradient: from title_color (or the preset's) to title_gradient_to, top → bottom
    const gr = role(plan({ title_color: '#45e3ee', title_gradient_to: '#bff8ff' }), 'title');
    assert.deepEqual(gr.gradient, { colors: ['#45E3EE', '#BFF8FF'], angle: 90 });
    assert.equal(gr.color, '#45E3EE', 'solid colour stays the first stop (what the panel shows)');
    assert.equal(role(plan({ title_gradient_to: '#ffffff' }), 'title').gradient.colors[0], PRESETS['minimal-premium'].palette.primary);
    assert.equal(role(plan({}), 'title').gradient, undefined);
    assert.equal(role(plan({ title_gradient_to: '#fff' }), 'subtitle').gradient, undefined, 'subtitle stays solid');
    assert.equal(plan({ title_gradient_to: 'blue' }).code, 'INVALID_ARGUMENT');

    // subject in front of the text (photo only), drawn last so it ends up on top
    const sf = buildCoverPlan(Object.assign({}, base, { imagePaths: ['D:/p.jpg'], subjectFront: true,
      customStyle: { subject_outline_color: '#fff', subject_outline_width: 6 } }));
    const subj = els(sf)[els(sf).length - 1];
    assert.equal(subj.type, 'subject');
    assert.deepEqual(subj.outline, { color: '#FFFFFF', width: 6 });
    assert.equal(els(buildCoverPlan(Object.assign({}, base, { imagePaths: ['D:/p.jpg'], subjectFront: true }))).slice(-1)[0].outline, undefined);
    assert.equal(els(buildCoverPlan(Object.assign({}, base, { subjectFront: true }))).some((e) => e.type === 'subject'), false, 'no photo → nothing to cut out');
    assert.equal(els(buildCoverPlan(Object.assign({}, base, { imagePaths: ['D:/p.jpg'] }))).some((e) => e.type === 'subject'), false);

    // bad input → INVALID_ARGUMENT naming the field
    const bad1 = plan({ title_color: 'red' });
    assert.equal(bad1.code, 'INVALID_ARGUMENT');
    assert.match(bad1.error, /title_color/);
    assert.equal(plan({ decoration: 'stars' }).code, 'INVALID_ARGUMENT');
    assert.equal(plan({ title_position: 'left' }).code, 'INVALID_ARGUMENT');
    assert.equal(plan('not an object').code, 'INVALID_ARGUMENT');
    // out-of-range numbers are clamped with a warning, not rejected
    const clamped = plan({ title_size: 9 });
    assert.equal(clamped.ok, true);
    assert.ok(clamped.warnings.some((w) => /title_size/.test(w)));
    // unknown keys are ignored with a warning
    assert.ok(plan({ sparkle: true }).warnings.some((w) => /sparkle/.test(w)));
    // no custom style → identical to before
    assert.deepEqual(buildCoverPlan(base), plan(undefined));
  }

  // ---------- 字体缺失：找相近的 + 告诉用户 ----------
  {
    const { matchFont, missingFontNotice } = require('../renderer/font-match');
    const avail = ['微软雅黑', '思源黑体 Heavy', '思源宋体', '站酷快乐体', '楷体', 'Arial', '思源黑体 Light'];
    // present (case / spaces / dashes don't matter)
    assert.deepEqual(matchFont('思源宋体', avail, '微软雅黑'), { found: true, font: '思源宋体' });
    assert.deepEqual(matchFont('思源黑体heavy', avail, '微软雅黑'), { found: true, font: '思源黑体 Heavy' });
    assert.deepEqual(matchFont('arial', avail, '微软雅黑'), { found: true, font: 'Arial' });
    // same family, other spelling of weight → that family's same weight first
    const m1 = matchFont('思源黑体 CN Heavy', avail, '微软雅黑');
    assert.equal(m1.found, false);
    assert.equal(m1.used, '思源黑体 Heavy');
    assert.ok(m1.similar.length >= 2 && m1.similar.length <= 5);
    assert.equal(m1.similar[0], '思源黑体 Heavy');
    // same category
    assert.ok(['微软雅黑', '思源黑体 Heavy', '思源黑体 Light'].includes(matchFont('方正兰亭黑', avail, '微软雅黑').used));
    assert.equal(matchFont('华文行楷', avail, '微软雅黑').used, '楷体');
    assert.equal(matchFont('汉仪尚巍手书', ['汉仪楷体繁', '方正字迹-书法行书', '微软雅黑'], '微软雅黑').used, '方正字迹-书法行书', 'brush style beats a same-brand regular font');
    assert.equal(matchFont('方正粗宋', avail, '微软雅黑').used, '思源宋体');
    // weight breaks ties inside a category
    assert.equal(matchFont('汉仪粗黑', avail, '微软雅黑').used, '思源黑体 Heavy');
    assert.equal(matchFont('汉仪细黑', avail, '微软雅黑').used, '思源黑体 Light');
    // nothing alike → default font, no candidates
    assert.deepEqual(matchFont('Zapfino', avail, '微软雅黑'), { found: false, requested: 'Zapfino', used: '微软雅黑', similar: [] });
    // empty / missing input → not a request
    assert.deepEqual(matchFont('', avail, '微软雅黑'), { found: true, font: '' });
    // deterministic
    assert.deepEqual(matchFont('方正兰亭黑', avail, '微软雅黑'), matchFont('方正兰亭黑', avail, '微软雅黑'));
    // the sentence the agent has to pass on
    const note = missingFontNotice(m1);
    assert.match(note, /没有「思源黑体 CN Heavy」/);
    assert.match(note, /「思源黑体 Heavy」代替/);
    assert.match(note, /下载安装/);
    assert.match(note, /导入字体/);
    assert.match(missingFontNotice(matchFont('Zapfino', avail, '微软雅黑')), /默认字体「微软雅黑」/);
    const ask = missingFontNotice(m1, { plan: true });
    assert.match(ask, /请选择/, 'check_fonts：让用户做选择');
    assert.match(ask, /下载安装「思源黑体 CN Heavy」/);
    assert.match(ask, /用相近的「思源黑体 Heavy」/);
    assert.match(ask, /选好.*再继续/);
    assert.doesNotMatch(ask, /已先用/);
    // 字重精确：Heavy 对 Heavy 优先于 Heavy 对 Bold（同日真实 agent：要「思源黑体 Heavy」首选成了 CN Bold）
    assert.equal(matchFont('思源黑体 Heavy', ['思源黑体 CN Bold', '思源黑体 CN Heavy', '思源黑体 CN Regular'], '微软雅黑').used, '思源黑体 CN Heavy');
    assert.equal(matchFont('Montserrat Black', ['Arial Bold', 'Arial Black', 'Arial'], 'Arial').found, false);
  }

  // ---------- Task 8/9: create_cover ----------
  assert.deepEqual(normalizeCreateCoverArgs({ title: ' A ' }), {
    ok: true,
    args: {
      title: 'A', platforms: ['xiaohongshu'], subtitle: '', style: '简洁高级',
      image_paths: [], output_dir: '', auto_export: true, replace_canvas: false, custom_style: null, subject_front: false
    }
  });
  assert.equal(normalizeCreateCoverArgs({ title: '  ' }).code, 'INVALID_ARGUMENT');
  assert.equal(normalizeCreateCoverArgs({}).code, 'INVALID_ARGUMENT');
  assert.equal(normalizeCreateCoverArgs({ title: 'x', platforms: ['weibo'] }).code, 'UNSUPPORTED_PLATFORM');
  // 公众号（用户 2026-10-22「平台框中加一个公众号(1:1 2.35:1)」）
  assert.deepEqual(normalizeCreateCoverArgs({ title: 'x', platforms: ['gongzhonghao'] }).args.platforms, ['gongzhonghao']);
  assert.match(TOOLS.find((tool) => tool.name === 'set_platforms').description, /gongzhonghao 公众号/);
  assert.equal(normalizeCreateCoverArgs({ title: 'x', output_dir: 'out/covers' }).code, 'INVALID_ARGUMENT');
  assert.equal(normalizeCreateCoverArgs({ title: 'x', custom_style: { title_color: 'red' } }).code, 'INVALID_ARGUMENT', 'bad custom_style rejected before touching the canvas');
  assert.deepEqual(normalizeCreateCoverArgs({ title: 'x', custom_style: { title_color: '#fff' } }).args.custom_style, { title_color: '#fff' });
  assert.deepEqual(normalizeCreateCoverArgs({ title: 'x', platforms: ['douyin', 'douyin', 'bilibili'] }).args.platforms, ['douyin', 'bilibili']);
  assert.deepEqual(normalizeCreateCoverArgs({ title: 'x', image_paths: ['', 'D:/a.png'] }).args.image_paths, ['D:/a.png']);

  const CANVAS = { ok: true, frames: [{ no: 1, ratio: '3:4', canvas_size: '300x400', export_size: '1080x1440', platforms: ['xiaohongshu'] }] };
  function fakeDeps(over, onCall) {
    const log = [];
    const deps = Object.assign({
      queue: new TaskQueue(),
      makeTaskId: (() => { let i = 0; return () => 'cover-' + (++i); })(),
      fileExists: () => true,
      exportTo: async (a) => { log.push('export:' + (a.dir || '')); return { ok: true, dir: a.dir || 'D:/out', files: [{ path: 'D:/out/a.png', width: 1080, height: 1440 }] }; },
      call: async (name, args) => {
        log.push(name);
        if (onCall) { const r = await onCall(name, args); if (r) return r; }
        if (name === 'begin_transaction') return { ok: true, token: 'T' };
        if (name === 'get_canvas') return CANVAS;
        if (name === 'apply_cover_plan') return { ok: true, elements: ['a', 'b'], warnings: [] };
        if (name === 'screenshot') return { ok: true, frame: 1, dataURL: 'data:image/png;base64,AAAA' };
        return { ok: true };
      }
    }, over || {});
    return { log, runner: createCoverRunner(deps) };
  }

  {
    const { log, runner } = fakeDeps();
    const r = await runner.createCover({ title: '标题', output_dir: 'D:/out' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task_id, 'cover-1');
    assert.equal(r.preset, 'minimal-premium');
    assert.deepEqual(r.files, [{ path: 'D:/out/a.png', width: 1080, height: 1440 }]);
    assert.equal(r.preview.dataURL, 'data:image/png;base64,AAAA');
    assert.deepEqual(log, ['begin_transaction', 'set_platforms', 'get_canvas', 'apply_cover_plan', 'screenshot', 'export:D:/out', 'commit_transaction']);
    assert.equal(r.font_missing, undefined, 'no font notice when every font exists');
  }
  {
    const miss = [{ requested: '方正粗黑宋', used: '思源宋体', similar: ['思源宋体'], tell_user: '电脑上没有「方正粗黑宋」这个字体…' }];
    const { runner } = fakeDeps(null, async (name) => (name === 'apply_cover_plan'
      ? { ok: true, elements: [], warnings: [], font_missing: miss, tell_user: miss[0].tell_user } : null));
    const r = await runner.createCover({ title: '字体', custom_style: { title_font: '方正粗黑宋' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.font_missing, miss);
    assert.equal(r.tell_user, miss[0].tell_user, 'the sentence for the user reaches the agent');
  }
  {
    const { log, runner } = fakeDeps();
    const r = await runner.createCover({ title: '不导出', auto_export: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.files, []);
    assert.equal(log.some((x) => x.startsWith('export')), false);
  }
  {
    const { log, runner } = fakeDeps(null, async (name) => (name === 'apply_cover_plan' ? { ok: false, error: 'boom' } : null));
    const r = await runner.createCover({ title: '失败' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LAYOUT_FAILED');
    assert.ok(log.includes('rollback_transaction'));
    assert.equal(log.includes('commit_transaction'), false);
  }
  {
    const { log, runner } = fakeDeps({ fileExists: () => false });
    const r = await runner.createCover({ title: '文件没写出来' });
    assert.equal(r.code, 'EXPORT_FAILED');
    assert.ok(log.includes('rollback_transaction'));
  }
  {
    const { runner } = fakeDeps(null, async (name) => (name === 'begin_transaction' ? { ok: false, error: '封面制作器的窗口没开' } : null));
    assert.equal((await runner.createCover({ title: 'x' })).code, 'MCP_NOT_READY');
  }
  {
    // cancel: the first task blocks inside apply; the second is queued and cancelled before it starts
    const gate = deferred();
    const { log, runner } = fakeDeps(null, async (name) => {
      if (name === 'apply_cover_plan') { await gate.promise; return { ok: true, elements: [], warnings: [] }; }
      return null;
    });
    const p1 = runner.createCover({ title: '一', auto_export: false });
    const p2 = runner.createCover({ title: '二', auto_export: false });
    for (let i = 0; i < 20 && !log.includes('apply_cover_plan'); i += 1) await new Promise((r) => setImmediate(r));
    const st = runner.status();
    assert.equal(st.active.task_id, 'cover-1');
    assert.deepEqual(st.queued.map((t) => t.task_id), ['cover-2']);
    assert.equal(runner.cancel('cover-2').ok, true);
    assert.equal(runner.cancel('nope').ok, false);
    assert.equal(runner.cancel('cover-1').ok, true);          // running: stops at the next step and rolls back
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r2.code, 'TASK_CANCELLED');
    assert.equal(r1.code, 'TASK_CANCELLED');
    assert.ok(log.includes('rollback_transaction'));
    assert.equal(log.includes('commit_transaction'), false);
  }
}

module.exports = { run };

if (require.main === module) {
  run().then(() => {
    console.log('[agent-core] PASS');
  }).catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
