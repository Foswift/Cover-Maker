'use strict';

// 安全改别人家的配置文件（Claude / Cursor / VS Code …）：
//   读不懂（带注释 / 写坏了）一律拒绝，不覆盖；写之前在同目录备份 <名>.cover-maker.bak-<时间>（只留最新 3 份）；
//   先写同目录临时文件再 rename 换上（断电 / 崩溃不会留下写了一半的配置）；换上后回读校验，不对就恢复原文件。

const fs = require('fs');
const path = require('path');

const KEEP_BACKUPS = 3;

function fail(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

function readJson(file) {
  if (!fs.existsSync(file)) return { exists: false, value: null };
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return { exists: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('顶层不是对象');
    return { exists: true, value };
  } catch (e) {
    throw fail('CONFIG_PARSE_FAILED', '配置文件读不懂，没有改它：' + file + '（' + e.message + '）', e);
  }
}

function pruneBackups(file) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + '.cover-maker.bak-';
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 删不掉就留着 */ }
  }
}

// Windows 上目标被别的程序占着时 rename 可能失败：先把旧文件挪成保护文件，再换上新文件；任一步失败都挪回去
function replaceFile(tmp, file, stamp) {
  try {
    fs.renameSync(tmp, file);
    return;
  } catch (first) {
    if (!fs.existsSync(file)) throw first;
    const guard = file + '.cover-maker.old-' + stamp;
    fs.renameSync(file, guard);
    try {
      fs.renameSync(tmp, file);
    } catch (second) {
      fs.renameSync(guard, file);
      throw second;
    }
    try { fs.unlinkSync(guard); } catch (e) { /* 留一个旧文件不碍事 */ }
  }
}

function restoreBackup(file, backupPath) {
  fs.copyFileSync(backupPath, file);
}

// validate(读回来的值) → true 才算写成功；opts.now() 只给测试固定时间戳
function writeJsonAtomic(file, nextValue, validate, opts) {
  return writeTextAtomic(file, JSON.stringify(nextValue, null, 2) + '\n',
    validate ? () => validate(readJson(file).value) : null, opts);
}

// 同上，写纯文本（YAML 之类自己拼好的内容）；validate() 不带参数，自己去读文件判断
function writeTextAtomic(file, text, validate, opts) {
  const now = (opts && opts.now) || Date.now;
  const stamp = String(now());
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(file);
  let backupPath = null;
  if (existed) {
    backupPath = file + '.cover-maker.bak-' + stamp;
    fs.copyFileSync(file, backupPath);
  }
  const tmp = path.join(dir, path.basename(file) + '.cover-maker.tmp-' + process.pid + '-' + stamp);
  const undo = () => {
    try {
      if (backupPath) restoreBackup(file, backupPath);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) { /* 尽力了 */ }
  };
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8' });
    replaceFile(tmp, file, stamp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 没写出来 */ }
    undo();
    throw fail('AGENT_CONFIG_WRITE_FAILED', '写配置失败：' + file + '（' + e.message + '）', e);
  }
  let ok = false;
  try { ok = !validate || !!validate(); } catch (e) { ok = false; }
  if (!ok) {
    undo();
    throw fail('AGENT_CONFIG_WRITE_FAILED', '写完回读校验没通过，已恢复原文件：' + file);
  }
  if (backupPath) pruneBackups(file);
  return { path: file, backupPath, created: !existed };
}

module.exports = { readJson, writeJsonAtomic, writeTextAtomic, restoreBackup };
