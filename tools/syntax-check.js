#!/usr/bin/env node
// 封面制作器：改动后的一键语法检查（**启动前先跑这个**）
//
// 为什么需要它（2026-10-07 踩过）：
//   主进程 main.js 有语法错误时，命令行**一个字都不报**，而是在屏幕上弹一个原生错误框
//   「A JavaScript error occurred in the main process / SyntaxError …」—— 看着像「应用起不来」。
//   renderer/index.html 里的两个大内联 <script> 同样没人校验，改坏了也一样只有白屏。
//
// 用法：  npm run check        （= node tools/syntax-check.js）
//   全部通过 → 打印 OK 并 exit 0；任一处有问题 → 打印「文件:行 + 原因 + 出错那几行」并 exit 1。
//
// 覆盖：main.js / preload.js + renderer/index.html 里的每个内联 script（外链 <script src> 跳过）。

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let bad = 0;
let checked = 0;

// vm.Script 抛的 SyntaxError：stack 首行形如 `/abs/path/main.js:5176`，紧接着是出错源码 + 插入符
function errLine(e) {
    const first = String(e.stack || '').split('\n')[0];
    const m = first.match(/:(\d+)(?::(\d+))?\s*$/);
    return m ? { line: Number(m[1]), col: m[2] ? Number(m[2]) : null } : null;
}

// 打印出错位置 + 上下几行源码（行号 = 源文件里的真实行号）

function checkSource(label, src, offset) {
    checked++;
    try {
        new vm.Script(src, { filename: label });
        console.log(`OK    ${label}  (${src.length} 字符)`);
        return true;
    } catch (e) {
        bad++;
        const at = errLine(e);
        const line = at ? at.line + (offset || 0) : null;
        console.log(`FAIL  ${label}${line ? ' → ' + label.split('（')[0] + ' 第 ' + line + ' 行' : ''}  ${e.message}`);
        if (at) {
            const lines = src.split(/\r?\n/);
            const from = Math.max(0, at.line - 3);
            const to = Math.min(lines.length, at.line + 2);
            for (let i = from; i < to; i++) {
                const mark = i === at.line - 1 ? ' <<< 这里' : '';
                console.log(`      ${String(i + 1 + (offset || 0)).padStart(6)} | ${lines[i]}${mark}`);
            }
        } else {
            // 拿不到行号时，把 Node 自己那段「源码 + 插入符」原样打出来
            console.log('      ' + String(e.stack || '').split('\n').slice(0, 4).join('\n      '));
        }
        return false;
    }
}

function checkFile(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { bad++; console.log(`FAIL  ${rel}  文件不存在`); return; }
    checkSource(rel, fs.readFileSync(abs, 'utf8'), 0);
}

function checkInlineScripts(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { bad++; console.log(`FAIL  ${rel}  文件不存在`); return; }
    const html = fs.readFileSync(abs, 'utf8');
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m, i = 0;
    while ((m = re.exec(html))) {
        const attrs = m[1] || '';
        if (/\bsrc\s*=/i.test(attrs)) continue;                                     // 外链（konva.min.js）
        if (/\btype\s*=/i.test(attrs) && !/javascript|module/i.test(attrs)) continue; // json/ld+json 之类
        i++;
        const startLine = html.slice(0, m.index).split('\n').length;
        checkSource(`${rel} 内联 script#${i}（html 第 ${startLine} 行起）`, m[2], startLine - 1);
    }
    if (i === 0) console.log(`      （${rel} 里没有内联 script？确认一下是不是被整体挪走了）`);
}

console.log('=== 封面制作器 语法检查（启动前先跑）===');
checkFile('main.js');
checkFile('preload.js');
checkFile('mcp.js');        // 2026-10-20 AI 调用（MCP）
checkInlineScripts('renderer/index.html');
console.log('---');
console.log(bad === 0
    ? `全部通过（${checked} 处）→ 可以 npm start`
    : `${bad} 处有问题（共检查 ${checked} 处）→ 先修掉再启动`);
process.exit(bad === 0 ? 0 : 1);
