'use strict';

// create_cover 编排：参数整理 → 排队 → 事务 → 勾平台 → 读框 → 排版计划 → 落地 → 截图 → 导出 → 提交。
// 任一步失败 / 被取消 → 回滚事务（画布回到开始前），返回结构化错误。
// 这里不碰 Electron / 窗口：渲染层调用、导出、文件检查都由 mcp.js 注入（测试里用假的）。

const path = require('path');
const { CODES, makeError } = require('./errors');
const { TOOLS } = require('./tool-definitions');
const { buildCoverPlan, checkCustomStyle } = require('./layout-engine');

const PLATFORMS = TOOLS.find((t) => t.name === 'create_cover').inputSchema.properties.platforms.items.enum;
const DEFAULTS = Object.freeze({ platforms: ['xiaohongshu'], style: '简洁高级' });

function normalizeCreateCoverArgs(input) {
  const a = input && typeof input === 'object' ? input : {};
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  if (!title) return makeError(CODES.INVALID_ARGUMENT, '标题是空的', '给 title 写上封面标题');

  let platforms = Array.isArray(a.platforms) ? a.platforms.map((p) => String(p).trim()).filter(Boolean) : [];
  platforms = platforms.filter((p, i) => platforms.indexOf(p) === i);
  const bad = platforms.filter((p) => PLATFORMS.indexOf(p) < 0);
  if (bad.length) {
    return makeError(CODES.UNSUPPORTED_PLATFORM, '不支持这些平台：' + bad.join('、'), '可选：' + PLATFORMS.join(', '));
  }
  if (!platforms.length) platforms = DEFAULTS.platforms.slice();

  const outputDir = typeof a.output_dir === 'string' ? a.output_dir.trim() : '';
  if (a.custom_style != null) {                       // 填错了在动画布之前就报（不然要走一遍回滚）
    const cs = checkCustomStyle(a.custom_style, []);
    if (!cs.ok) return cs;
  }
  if (outputDir && !path.isAbsolute(outputDir)) {
    return makeError(CODES.INVALID_ARGUMENT, 'output_dir 要写绝对路径：' + outputDir, '比如 D:\\covers 或 /Users/me/covers；不写 = 图片/封面制作器导出');
  }

  return {
    ok: true,
    args: {
      title,
      platforms,
      subtitle: typeof a.subtitle === 'string' ? a.subtitle.trim() : '',
      style: typeof a.style === 'string' && a.style.trim() ? a.style.trim() : DEFAULTS.style,
      image_paths: (Array.isArray(a.image_paths) ? a.image_paths : [])
        .filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()),
      output_dir: outputDir,
      auto_export: a.auto_export !== false,
      replace_canvas: a.replace_canvas === true,         // 用户 2026-10-21：默认保留原内容，明确要求才清空
      custom_style: a.custom_style == null ? null : a.custom_style,
      subject_front: a.subject_front === true
    }
  };
}

class StepError extends Error {
  constructor(code, message, suggestion, retryable) {
    super(message);
    this.code = code;
    this.suggestion = suggestion || '';
    this.retryable = !!retryable;
  }
}

function framesForPlan(canvas) {
  return (canvas.frames || []).map((f) => {
    const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(String(f.canvas_size || ''));
    return { no: f.no, ratio: f.ratio, width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0, platforms: f.platforms || [] };
  });
}

// deps: { queue, call(name, args), exportTo({dir}), fileExists(path), makeTaskId() }
function createCoverRunner(deps) {
  const { queue, call, exportTo, fileExists, makeTaskId } = deps;

  async function run(args, taskId, signal) {
    const checkCancel = () => {
      if (signal.aborted) throw new StepError(CODES.TASK_CANCELLED, '任务 ' + taskId + ' 已取消');
    };
    const step = async (name, params, code, what) => {
      checkCancel();
      const r = await call(name, params);
      if (!r || !r.ok) throw new StepError(code, what + '失败：' + ((r && r.error) || '没有返回'));
      return r;
    };

    const begin = await call('begin_transaction', { label: '自动制作封面' });
    if (!begin || !begin.ok) {
      return makeError(CODES.MCP_NOT_READY, (begin && begin.error) || '画布没准备好', '确认封面制作器已打开', true);
    }
    try {
      await step('set_platforms', { platforms: args.platforms }, CODES.UNSUPPORTED_PLATFORM, '勾平台');
      const canvas = await step('get_canvas', {}, CODES.MCP_NOT_READY, '读画布');
      const plan = buildCoverPlan({ frames: framesForPlan(canvas), title: args.title, subtitle: args.subtitle,
                                    style: args.style, imagePaths: args.image_paths, customStyle: args.custom_style,
                                    subjectFront: args.subject_front });
      if (!plan.ok) throw new StepError(plan.code || CODES.LAYOUT_FAILED, plan.error, plan.suggestion);
      const applied = await step('apply_cover_plan', { plan, clear: args.replace_canvas }, CODES.LAYOUT_FAILED, '自动排版');
      const shot = await step('screenshot', { frame: (plan.frames[0] || {}).frame || 1 }, CODES.SCREENSHOT_FAILED, '截图');

      let files = [];
      let dir = null;
      if (args.auto_export) {
        checkCancel();
        const ex = await exportTo({ dir: args.output_dir });
        if (!ex || !ex.ok) throw new StepError(CODES.EXPORT_FAILED, '导出失败：' + ((ex && ex.error) || '没有返回'));
        const missing = (ex.files || []).filter((f) => !fileExists(f.path));
        if (!ex.files || !ex.files.length || missing.length) {
          throw new StepError(CODES.EXPORT_FAILED, '导出的文件没找到：' + missing.map((f) => f.path).join('、'));
        }
        files = ex.files;
        dir = ex.dir;
      }
      checkCancel();
      const done = await call('commit_transaction', { token: begin.token });
      if (!done || !done.ok) throw new StepError(CODES.LAYOUT_FAILED, '提交失败：' + ((done && done.error) || '没有返回'));
      return {
        ok: true,
        task_id: taskId,
        preset: plan.preset,
        platforms: args.platforms,
        frames: (canvas.frames || []).map((f) => ({ frame: f.no, ratio: f.ratio, export_size: f.export_size, platforms: f.platforms })),
        dir,
        files,
        warnings: plan.warnings.concat(applied.warnings || []),
        preview: { frame: shot.frame, dataURL: shot.dataURL },
        // 用了电脑上没有的字体：已用相近的顶上；tell_user 是必须转告用户的话（下载安装原字体 / 或用相近的）
        ...(applied.font_missing && applied.font_missing.length ? { font_missing: applied.font_missing, tell_user: applied.tell_user } : {}),
        note: '整次制作在软件里只占一步撤销（Ctrl+Z 一下回到制作前）；要细调用 get_canvas / update_element，改完再 export_images'
      };
    } catch (e) {
      const rb = await call('rollback_transaction', { token: begin.token }).catch((err) => ({ ok: false, error: String(err) }));
      if (!rb || !rb.ok) {
        return makeError(CODES.ROLLBACK_FAILED, String(e && e.message || e) + '；而且回滚也失败了：' + ((rb && rb.error) || ''), '在软件里按 Ctrl+Z 检查画布');
      }
      if (e instanceof StepError) return makeError(e.code, e.message, e.suggestion, e.retryable);
      return makeError(CODES.LAYOUT_FAILED, e, '');
    }
  }

  function createCover(input) {
    const n = normalizeCreateCoverArgs(input);
    if (!n.ok) return Promise.resolve(n);
    const taskId = makeTaskId();
    return queue.enqueue(taskId, ({ signal }) => run(n.args, taskId, signal))
      .catch((e) => (e && e.code === CODES.TASK_CANCELLED
        ? makeError(CODES.TASK_CANCELLED, '任务 ' + taskId + ' 已取消')
        : makeError(CODES.LAYOUT_FAILED, e)));
  }

  return {
    createCover,
    status: () => queue.status(),
    cancel(taskId) {
      return queue.cancel(String(taskId || ''))
        ? { ok: true, task_id: taskId }
        : makeError(CODES.INVALID_ARGUMENT, '没有这个进行中 / 排队中的任务：' + taskId, '用 get_agent_status 看任务列表');
    }
  };
}

module.exports = { normalizeCreateCoverArgs, createCoverRunner, PLATFORMS };
