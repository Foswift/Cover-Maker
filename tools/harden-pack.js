// 打包加固（2026-10-19，用户选「①②③」）—— 由 tools/build-mac.py 在组装 .app、签名之前调用：
//   node tools/harden-pack.js --appdir <Resources/app> --asar <Resources/app.asar> --binary <Frameworks/Electron Framework.framework/Versions/A/Electron Framework>
//
//   （原来的 ② 混淆 license.js 已随激活码一起撤掉：2026-10-29 用户「不需要激活码锁机器了」）
//   ① app 目录 → app.asar（之后删掉 app 目录），算 asar 头的 sha256 打印出来 → build-mac.py 写进 Info.plist 的 ElectronAsarIntegrity；
//      再翻 Electron Framework 里的 fuses：只从 asar 加载 + 校验 asar 完整性 + 禁 RunAsNode / NODE_OPTIONS / --inspect。
//      必须在签名之前做（翻 fuse 改了二进制）。
//
// 输出（stdout 最后一行）：JSON { asarHash, fuses }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : null;
}
const appdir = arg('appdir');
const asarOut = arg('asar');
const binary = arg('binary');
if (!appdir || !asarOut || !binary) {
    console.error("用法：node tools/harden-pack.js --appdir <dir> --asar <out.asar> --binary <Versions/A/Electron Framework>");
    process.exit(2);
}

async function main() {
    const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cm-harden-src-'));

    // ---------- ① asar + 完整性哈希 ----------
    const asar = require('@electron/asar');
    if (fs.existsSync(asarOut)) fs.unlinkSync(asarOut);
    await asar.createPackage(appdir, asarOut);
    const { headerString } = asar.getRawHeader(asarOut);
    const asarHash = crypto.createHash('sha256').update(headerString).digest('hex');
    // 包里文件齐不齐
    const listed = asar.listPackage(asarOut, { isPack: false }).map((p) => p.replace(/\\/g, '/'));
    for (const need of ['/main.js', '/preload.js', '/mcp.js', '/agent-core/tool-definitions.js', '/agent-core/errors.js', '/agent-core/task-queue.js', '/agent-core/create-cover.js', '/agent-core/layout-engine.js', '/agent-core/layout-presets.js', '/renderer/agent-auto-layout.js', '/renderer/font-match.js', '/agent-integration/registry.js', '/agent-integration/config-io.js', '/agent-integration/manifest.js', '/agent-integration/detect.js', '/agent-integration/clients/json-client.js', '/agent-integration/register-worker.js', '/agent-integration/mac-env.js', '/agent-integration/clients/cli-client.js', '/agent-integration/clients/claude-code.js', '/agent-integration/clients/codex.js', '/agent-integration/clients/hermes.js', '/agent-integration/clients/trae.js', '/agent-integration/clients/cherry-studio.js', '/agent-integration/clients/dsh.js', '/agent-integration/clients/openclaw.js', '/package.json', '/renderer/index.html']) {
        if (!listed.includes(need)) throw new Error('app.asar 里缺 ' + need);
    }
    fs.rmSync(appdir, { recursive: true, force: true });
    console.log('[harden] app.asar：%d 个条目，头哈希 %s', listed.length, asarHash.slice(0, 16));

    // ---------- ① fuses ----------
    // Mac 上 fuse 在 Electron Framework 里，--binary 要给**真文件** Versions/A/Electron Framework：
    //   framework 顶层那个同名文件在官方包里是符号链接，build-mac.py 解压时拷成了实体副本、打 zip 时又还原成链接 → 翻在副本上等于白翻。
    // 先拷到不带「.app」的临时路径再翻：@electron/fuses 看到路径里有 .app 会自作主张去拼 ../../Frameworks/...
    const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = require('@electron/fuses');
    const tmpBin = path.join(work, 'fuse-target.bin');
    fs.copyFileSync(binary, tmpBin);
    await flipFuses(tmpBin, {
        version: FuseVersion.V1,
        resetAdHocDarwinSignature: false,                               // 签名由 build-mac.py 之后统一做
        [FuseV1Options.RunAsNode]: false,                               // 禁 ELECTRON_RUN_AS_NODE：不能把程序当普通 node 跑
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,    // 禁 NODE_OPTIONS 注入
        [FuseV1Options.EnableNodeCliInspectArguments]: false,           // 禁 --inspect 调试
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,    // 按 Info.plist 的 ElectronAsarIntegrity 校验 app.asar
        [FuseV1Options.OnlyLoadAppFromAsar]: true                       // 只认 app.asar，不认旁边的 app 目录
    });
    const wire = await getCurrentFuseWire(tmpBin);
    fs.copyFileSync(tmpBin, binary);
    fs.rmSync(work, { recursive: true, force: true });
    const fuses = {};
    for (const [name, idx] of Object.entries(FuseV1Options)) {
        if (typeof idx === 'number' && wire[idx] !== undefined) fuses[name] = String.fromCharCode(wire[idx]) === '1' ? 'on' : String.fromCharCode(wire[idx]) === '0' ? 'off' : 'removed';
    }
    console.log('[harden] fuses：%s', JSON.stringify(fuses));
    console.log(JSON.stringify({ asarHash, fuses }));
}

main().catch((e) => { console.error('[harden] 失败：', e && e.stack || e); process.exit(1); });
