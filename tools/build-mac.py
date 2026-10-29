#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在 Windows 上打 macOS 包（封面制作器）。一条命令重跑，改完代码直接出包：

    python tools/build-mac.py --arch arm64        # Apple 芯片
    python tools/build-mac.py --arch x64          # Intel 芯片
    python tools/build-mac.py --arch arm64 x64    # 两个都出

为什么要自己写这套（不用 electron-builder / @electron/packager）：
  ① @electron/packager 在 Windows 上打 darwin 包会直接拒绝 —— mac 的 .app 里 framework 版本目录是**符号链接**，
     Windows 建符号链接要管理员权限（提示 "Cannot create symlinks ... skipping darwin platform"）。
  ② mac 的 arm64 程序**必须有有效签名**才跑得起来，而官方 Electron 包里的签名会因为我们改了 Info.plist 失效，
     又必须在 mac 上才能用 codesign 重签 —— 于是用 rcodesign（Rust 写的跨平台签名工具，Windows 上能跑）做 ad-hoc 签名。
本脚本把这两件事绕过去：
  解压时把符号链接**解引用成实体**（给签名用）→ 改包 → rcodesign ad-hoc 签名 → 打 zip 时再把符号链接**还原成链接**
（这样 zip 体积不翻倍，签名也仍然对得上 —— 签名只看文件内容，链接换成实体不影响）。

产物：dist/封面制作器-mac-<芯片>.zip（里面是 封面制作器.app + 首次打开.command + 使用说明.txt）
"""
import argparse
import json
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
APP_NAME = "封面制作器"          # .app 名字（也是 CFBundleName / 主二进制名字）
BUNDLE_ID = "com.foswift.covermaker"
VERSION = __import__("json").load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "package.json"), encoding="utf-8"))["version"]   # 2026-10-17：跟 package.json 走（原来写死 0.1.0，两处容易对不上）
ELECTRON_VERSION = "43.1.0"
RCODESIGN_VER = "0.29.0"
RCODESIGN_URL = ("https://github.com/indygreg/apple-platform-rs/releases/download/"
                 "apple-codesign/%s/apple-codesign-%s-x86_64-pc-windows-msvc.zip") % (RCODESIGN_VER, RCODESIGN_VER)

# Electron 必须的授权（V8 要 JIT 和可写可执行内存）。
# 我们**不开 hardened runtime**（没苹果证书、不做公证），所以严格说这些授权不是必需；
# 但写上无害，将来要公证也用得上。
ENTITLEMENTS = {
    "com.apple.security.cs.allow-jit": True,
    "com.apple.security.cs.allow-unsigned-executable-memory": True,
    "com.apple.security.cs.allow-dyld-environment-variables": True,
    "com.apple.security.cs.disable-library-validation": True,
}

CHIP = {"arm64": "Apple芯片", "x64": "Intel芯片", "universal": "通用"}


def log(*a):
    print("[build-mac]", *a, flush=True)


# ---------- 1. 找 / 下 Electron 的 darwin 包 ----------
def electron_zip(arch):
    name = "electron-v%s-darwin-%s.zip" % (ELECTRON_VERSION, arch)
    mine = os.path.join(DIST, "_cache", name)          # 自己下过的先找
    if os.path.exists(mine):
        log("用 dist/_cache 里的 Electron:", "%.0fMB" % (os.path.getsize(mine) / 1048576))
        return mine
    cache = os.path.expanduser("~/AppData/Local/electron/Cache")
    for r, _d, fs in os.walk(cache):
        if name in fs:
            p = os.path.join(r, name)
            log("用缓存里的 Electron:", p, "%.0fMB" % (os.path.getsize(p) / 1048576))
            return p
    # 缓存里没有就自己下（官方 release，约 100MB）
    url = "https://github.com/electron/electron/releases/download/v%s/%s" % (ELECTRON_VERSION, name)
    dst = os.path.join(DIST, "_cache", name)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    log("下载 Electron:", url)
    urllib.request.urlretrieve(url, dst)
    return dst


def rcodesign_exe():
    ex = os.path.join(DIST, "_tools", "rcodesign")
    for r, _d, fs in os.walk(ex):
        for f in fs:
            if f.lower() == "rcodesign.exe":
                return os.path.join(r, f)
    os.makedirs(ex, exist_ok=True)
    z = os.path.join(ex, "rcodesign.zip")
    log("下载 rcodesign（跨平台签名工具）…")
    urllib.request.urlretrieve(RCODESIGN_URL, z)
    zipfile.ZipFile(z).extractall(ex)
    for r, _d, fs in os.walk(ex):
        for f in fs:
            if f.lower() == "rcodesign.exe":
                return os.path.join(r, f)
    raise RuntimeError("rcodesign 没解出来")


# ---------- 2. 解压（符号链接解引用成实体） ----------
def read_links(z):
    links = {}
    for i in z.infolist():
        if ((i.external_attr >> 16) & 0o170000) == 0o120000:
            links[i.filename.replace("\\", "/")] = z.read(i).decode("utf-8", "replace")
    return links


def expand(rel, linkmap):
    """把路径里所有符号链接前缀展开成真实路径（A/Versions/Current/X → A/Versions/A/X）。
    每换一次就从头再走一遍 —— 链式链接（Current → A）不这样处理会漏。"""
    cur = rel.replace("\\", "/")
    for _ in range(40):
        parts = cur.split("/")
        hit = None
        for i in range(len(parts)):
            prefix = "/".join(parts[:i + 1])
            if prefix in linkmap:
                base = "/".join(parts[:i])
                tgt = os.path.normpath(os.path.join(base, linkmap[prefix])).replace("\\", "/")
                hit = "/".join(tgt.split("/") + parts[i + 1:])
                break
        if hit is None:
            return cur
        cur = hit
    return cur


def fresh_work(arch):
    """中间目录用哪个：删得掉就用固定名字；删不掉（Windows 上目录被别的进程占着句柄）就换个名字接着干，
    不要让整个打包因为一个删不掉的旧目录失败。"""
    base = os.path.join(DIST, "_mac_" + arch)
    if not os.path.exists(base):
        os.makedirs(base)
        return base
    try:
        shutil.rmtree(base)
        os.makedirs(base)
        return base
    except OSError as e:
        alt = base + "_" + time.strftime("%H%M%S")
        log("旧中间目录删不掉（%s），改用 %s" % (e.strerror or e, os.path.basename(alt)))
        os.makedirs(alt)
        return alt


def extract(zpath, work):
    if os.path.exists(work):
        shutil.rmtree(work)
    os.makedirs(work, exist_ok=True)
    z = zipfile.ZipFile(zpath)
    members = z.infolist()
    linkmap = read_links(z)
    for i in members:
        name = i.filename.replace("\\", "/")
        if name in linkmap:
            continue
        dest = os.path.join(work, *name.split("/"))
        if i.is_dir():
            os.makedirs(dest, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(i) as s, open(dest, "wb") as o:
                shutil.copyfileobj(s, o)
    for name in linkmap:                       # 解引用：拷实体（Windows 上建不了链接）
        dest = os.path.join(work, *name.split("/"))
        real = os.path.join(work, *expand(name, linkmap).split("/"))
        if not os.path.exists(real):
            raise RuntimeError("符号链接目标找不到: %s -> %s" % (name, expand(name, linkmap)))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.isdir(real):
            shutil.copytree(real, dest)
        else:
            shutil.copy2(real, dest)
    log("解压完成（%d 个符号链接已解引用成实体）" % len(linkmap))
    return linkmap


# ---------- 3. 组装 .app ----------
def assemble(work, icon_icns):
    src = os.path.join(work, "Electron.app")
    app = os.path.join(work, APP_NAME + ".app")
    if os.path.exists(app):
        shutil.rmtree(app)
    os.rename(src, app)
    # 主二进制改名（CFBundleExecutable 必须与文件名一致）
    os.rename(os.path.join(app, "Contents", "MacOS", "Electron"),
              os.path.join(app, "Contents", "MacOS", APP_NAME))
    res = os.path.join(app, "Contents", "Resources")
    # 塞进应用代码，再加固（2026-10-19 用户选 ①②③，原来是不打 asar 的明文 app 目录）：
    #   tools/harden-pack.js：打成 app.asar → 翻 Electron Framework 的 fuses（混淆 license.js 那步 10-29 随激活码撤掉）
    #   （只从 asar 加载 + 校验 asar 完整性 + 禁 RunAsNode / NODE_OPTIONS / --inspect），asar 头哈希写进 Info.plist
    appdir = os.path.join(res, "app")
    if os.path.exists(appdir):
        shutil.rmtree(appdir)
    os.makedirs(appdir)
    for f in ("main.js", "preload.js", "mcp.js"):
        shutil.copy2(os.path.join(ROOT, f), appdir)
    shutil.copytree(os.path.join(ROOT, "renderer"), os.path.join(appdir, "renderer"))
    # mcp.js 依赖 agent-core/（M249）；agent-integration/ 做出来后也要进包，缺了 main.js 一启动 require 就崩
    for d in ("agent-core", "agent-integration"):
        if os.path.isdir(os.path.join(ROOT, d)):
            shutil.copytree(os.path.join(ROOT, d), os.path.join(appdir, d))
    with open(os.path.join(appdir, "package.json"), "w", encoding="utf-8") as f:
        f.write('{\n  "name": "cover-maker",\n  "version": "%s",\n  "description": "%s",\n  "main": "main.js"\n}\n'
                % (VERSION, APP_NAME))
    fw = os.path.join(app, "Contents", "Frameworks", "Electron Framework.framework")
    fw_real = os.path.join(fw, "Versions", "A", "Electron Framework")      # 真文件；顶层同名的和 Versions/Current 在官方包里是链接
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "harden-pack.js"), "--appdir", appdir,
                        "--asar", os.path.join(res, "app.asar"), "--binary", fw_real],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (r.stdout + r.stderr).splitlines():
        if line.startswith("[harden]") or "失败" in line or "中止" in line:
            log("   " + line)
    if r.returncode != 0:
        raise RuntimeError("加固失败（harden-pack.js 退出码 %d）:\n%s" % (r.returncode, (r.stdout + r.stderr)[-3000:]))
    harden = json.loads(r.stdout.strip().splitlines()[-1])
    # 解压时链接被拷成了实体副本 → 把翻过 fuse 的真文件同步过去，三份一致（不然签名工具签到哪份是没准的）
    for copy in (os.path.join(fw, "Electron Framework"), os.path.join(fw, "Versions", "Current", "Electron Framework")):
        if os.path.isfile(copy):
            shutil.copy2(fw_real, copy)
    d = os.path.join(res, "default_app.asar")           # 没 app 时的兜底，用不上
    if os.path.exists(d):
        os.remove(d)
    shutil.copy2(icon_icns, os.path.join(res, "electron.icns"))   # plist 里指的就是这个名字，直接覆盖最省事
    # Info.plist
    pl = os.path.join(app, "Contents", "Info.plist")
    info = plistlib.load(open(pl, "rb"))
    info.update({
        "CFBundleName": APP_NAME, "CFBundleDisplayName": APP_NAME, "CFBundleExecutable": APP_NAME,
        "CFBundleIdentifier": BUNDLE_ID, "CFBundleShortVersionString": VERSION, "CFBundleVersion": VERSION,
        "CFBundleIconFile": "electron.icns",
        "LSApplicationCategoryType": "public.app-category.graphics-design",
        "NSHumanReadableCopyright": "© 2026 cover-maker",
        # fuse EnableEmbeddedAsarIntegrityValidation 按这个校验 app.asar（改了 asar 而哈希对不上 → 程序直接退出）
        "ElectronAsarIntegrity": {"Resources/app.asar": {"algorithm": "SHA256", "hash": harden["asarHash"]}},
    })
    plistlib.dump(info, open(pl, "wb"))
    # Helper：官方包里没有 CFBundleExecutable（靠 CFBundleName 兜底），
    # 但签名工具找不到主程序就不给签 → 补上；顺手把重复的 bundle id 改成自己的
    roles = {"Electron Helper.app": "helper", "Electron Helper (Renderer).app": "helper.Renderer",
             "Electron Helper (GPU).app": "helper.GPU", "Electron Helper (Plugin).app": "helper.Plugin"}
    for hn, role in roles.items():
        hp = os.path.join(app, "Contents", "Frameworks", hn, "Contents", "Info.plist")
        hi = plistlib.load(open(hp, "rb"))
        hi["CFBundleExecutable"] = hi.get("CFBundleName") or hn.replace(".app", "")
        hi["CFBundleIdentifier"] = BUNDLE_ID + "." + role
        plistlib.dump(hi, open(hp, "wb"))
    log("组装完成：%s.app（bundle id %s，版本 %s）" % (APP_NAME, BUNDLE_ID, VERSION))
    return app


# ---------- 4. ad-hoc 签名 ----------
def sign_binaries_only(work, app, ent):
    """回退路径：整包签名失败时，逐个 Mach-O 单独签（Intel 版会遇到）。
    为什么 Intel 版要回退：x64 的官方 Electron 二进制**本身没签名**，而我们的解引用副本
    （符号链接在 Windows 上只能拷成实体）在整包签名算 CodeResources 时需要 cdhash，算不出来就报
    "binary does not have code signature data"。arm64 版没这问题（官方已经签过，副本自带签名）。
    逐个签一样能让 Intel Mac 上跑起来（每个二进制都有 ad-hoc 签名），只是没有包级 CodeResources。"""
    rc = rcodesign_exe()
    n = 0
    machos = []
    for root, _d, fs in os.walk(app):
        for fn in fs:
            fp = os.path.join(root, fn)
            if is_macho(fp):
                machos.append(fp)
    for fp in machos:
        r = subprocess.run([rc, "sign", "--entitlements-xml-file=" + ent, fp], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise RuntimeError("单文件签名失败 %s:\n%s" % (fp, (r.stdout + r.stderr)[-1500:]))
        n += 1
    # 清掉可能残留的包级 CodeResources（半成品状态比没有更糟：macOS 会说「已损坏」）
    for root, dirs, _fs in list(os.walk(app)):
        if os.path.basename(root) == "_CodeSignature":
            shutil.rmtree(root, ignore_errors=True)
    log("整包签名不支持这条路径 → 已改为逐个二进制签名（%d 个 Mach-O）" % n)


def sign(work, app):
    rc = rcodesign_exe()
    ent = os.path.join(work, "entitlements.plist")
    plistlib.dump(ENTITLEMENTS, open(ent, "wb"))
    r = subprocess.run([rc, "sign", "--entitlements-xml-file=entitlements.plist", APP_NAME + ".app"],
                       cwd=work, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        err = r.stdout + r.stderr
        if "does not have code signature data" in err:
            sign_binaries_only(work, app, ent)          # x64 走这条（整包签不了，但每个二进制都签上）
            globals()["BINARIES_ONLY"] = True           # 后面校验据此调整预期
        else:
            raise RuntimeError("签名失败:\n" + err[-3000:])
    warn = [l for l in (r.stdout + r.stderr).splitlines() if "could not" in l or "error" in l.lower()]
    log("ad-hoc 签名完成" + ("（警告：%s）" % warn if warn else "，无警告"))
    # 验一下主程序和 Renderer Helper：标识符 + ADHOC 标志
    if globals().get("BINARIES_ONLY"):
        log("（这个包没有包级签名，只有各二进制自己的签名 —— Intel 版正常情况，见 build-mac.py 注释）")
    # ⚠ 路径必须带上「封面制作器.app/」前缀：只给 "Contents/MacOS/xxx" 时 rcodesign 会说
    #   "specified path is not of a recognized type"（它要靠路径判断实体类型）
    # 2026-10-19：Electron Framework 翻过 fuse 内容变了 → 必须是我们重签的 ad-hoc（还挂着官方签名 = 内容对不上，Apple 芯片拒绝加载）
    for label, p in [("主程序", APP_NAME + ".app/Contents/MacOS/" + APP_NAME),
                     ("Renderer Helper", APP_NAME + ".app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)"),
                     ("Electron Framework（翻过 fuse）", APP_NAME + ".app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework")]:
        out = subprocess.run([rc, "print-signature-info", p], cwd=work, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        ident = next((l.strip() for l in out.splitlines() if "identifier:" in l), "?")
        adhoc = any("ADHOC" in l for l in out.splitlines())
        log("   %s → %s | ADHOC=%s" % (label, ident, adhoc))
        if not adhoc:
            raise RuntimeError("签名不是 ad-hoc（Apple 芯片上会拒绝运行）")


# ---------- 5. 打 zip（符号链接还原 + 权限位保住） ----------
def is_macho(p):
    with open(p, "rb") as f:
        return f.read(4) in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xce\xfa\xed\xfe")


def build_zip(work, app, ozip, out_zip, linkmap):
    oz = zipfile.ZipFile(ozip)
    orig_modes = {}
    for i in oz.infolist():
        orig_modes[i.filename.replace("\\", "/").replace("Electron.app/", "", 1)] = (i.external_attr >> 16) & 0o7777
    link_rel = {k.split("Electron.app/", 1)[1]: v for k, v in linkmap.items() if "Electron.app/" in k}
    src = os.path.join(work, APP_NAME + ".app")
    if os.path.exists(out_zip):
        os.remove(out_zip)
    t0, files, nlink = time.time(), 0, 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for root, dirs, fs in os.walk(src):
            rel_dir = os.path.relpath(root, src).replace("\\", "/")
            rel_dir = "" if rel_dir == "." else rel_dir
            if rel_dir in link_rel:            # 符号链接位置：跳过实体，下面写回链接
                dirs[:] = []
                continue
            if rel_dir:
                zi = zipfile.ZipInfo("%s.app/%s/" % (APP_NAME, rel_dir), date_time=time.localtime()[:6])
                zi.create_system = 3
                zi.external_attr = (0o040000 | 0o755) << 16
                z.writestr(zi, b"")
            for fn in sorted(fs):
                p = os.path.join(root, fn)
                rel = (rel_dir + "/" + fn) if rel_dir else fn
                if rel in link_rel:        # 文件型符号链接（framework 同名二进制）也要跳过，否则 zip 里出现重名条目
                    continue
                mode = orig_modes.get(rel)
                if mode is None:
                    mode = 0o755 if (rel.startswith("Contents/MacOS/") or rel.endswith((".dylib", ".command")) or is_macho(p)) else 0o644
                elif rel.startswith("Contents/MacOS/") or rel.endswith((".dylib", ".command")) or is_macho(p):
                    mode |= 0o111
                zi = zipfile.ZipInfo("%s.app/%s" % (APP_NAME, rel), date_time=time.localtime(os.path.getmtime(p))[:6])
                zi.create_system = 3
                zi.external_attr = (0o100000 | mode) << 16
                zi.compress_type = zipfile.ZIP_DEFLATED
                with open(p, "rb") as f:
                    z.writestr(zi, f.read())
                files += 1
        for rel, target in link_rel.items():   # 符号链接写回（体积不翻倍，签名不受影响）
            zi = zipfile.ZipInfo("%s.app/%s" % (APP_NAME, rel))
            zi.create_system = 3
            zi.external_attr = (0o120777 << 16)
            zi.compress_type = zipfile.ZIP_STORED
            z.writestr(zi, target.encode())
            nlink += 1
        # 说明文件（放在 .app 外面，不污染 app 包）
        # 芯片那句按包分（原来两个包共用一句「只支持 Apple 芯片」，Intel 包里也这么写 —— 2026-10-19 修）
        chip = (CHIP_LINE_X64 if "Intel" in os.path.basename(out_zip) else CHIP_LINE_ARM64)
        for name, text in (("使用说明.txt", README_TXT % {"app": APP_NAME, "chip": chip}),
                           ("首次打开.command", FIRST_OPEN_SH % APP_NAME)):
            zi = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
            zi.create_system = 3
            zi.external_attr = (0o100755 if name.endswith(".command") else 0o100644) << 16
            z.writestr(zi, text.encode("utf-8"))
    log("打包完成 %.1fs | 文件 %d | 符号链接 %d | zip %.0fMB" % (time.time() - t0, files, nlink, os.path.getsize(out_zip) / 1048576))
    return out_zip


# 2026-10-19：加【激活】一段（软件改成下载免费、使用要激活码，一码一机）；芯片那句按包分
CHIP_LINE_ARM64 = "· 只支持 Apple 芯片（M1/M2/M3/M4…）。Intel 芯片的 Mac 请用 Intel芯片 那个包"
CHIP_LINE_X64 = "· 这是 Intel 芯片版。Apple 芯片（M1/M2/M3/M4…）的 Mac 请用 Apple芯片 那个包"

README_TXT = """封面制作器 · macOS 版
============================

【怎么装】
1. 双击 zip 解压 → 得到「%(app)s.app」和「首次打开.command」
2. 双击「%(app)s.app」
   · 如果提示"无法打开，因为 Apple 无法检查其是否包含恶意软件"：
     右键点它 → 选「打开」→ 再点「打开」（这一步只需做一次）
   · 如果还是打不开（提示"已损坏"或签名问题）：
     双击「首次打开.command」——它会自动清掉隔离标记并本机重签一次，跑完就能双击打开了
3. 第一次打开会显示「激活页」，输入激活码激活后即可使用（见下面【激活】）

【激活】
· 软件下载免费，使用需要激活码（4 组共 16 位，例如 ABCD-EFGH-JKLM-NPQR）
· 一个激活码绑定一台电脑；联网激活一次，之后断网也能一直用
· 激活页上方的「本机机器码」不用填 —— 换电脑找客服时把它发给客服即可
· 换电脑或重装系统：请联系客服重置激活码，再在新电脑上输入同一个码
· 购买激活码：打开 https://foswift.com/download ，微信扫页面上的二维码添加客服
  （激活页右边也有客服二维码，直接扫就行）

【这个包是什么情况】
· 在 Windows 上跨平台打的，签名是 ad-hoc（本机签名），没有苹果开发者证书，所以第一次要手动放行一次
%(chip)s
· 你的作品/素材/模板存在 ~/Library/Application Support/cover-maker/ 里
· 首次启动如果提示要不要允许"访问文件"，选允许（要读写你自己导入的图片）

【功能】
平台引导框（抖音/小红书/快手/哔站/视频号/头条）· 贴纸 · 字体库（剪映字幕模板）· 图片拖进画布 ·
撤销重做（不设步数上限）· 图层面板 · 我的模板（缩略图/预览/应用）· 导出（每个框各导一张，白底）
"""

FIRST_OPEN_SH = """#!/bin/bash
# 封面制作器 · 首次打开修复（双击运行即可）
# 干两件事：① 去掉"来自网络"的隔离标记 ② 本机做一次 ad-hoc 签名（万一跨平台签名校验不过）
cd "$(dirname "$0")" || exit 1
APP="%s.app"
if [ ! -d "$APP" ]; then
  echo "❌ 没找到「$APP」。请把这个文件和它放在同一个文件夹里再双击。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi
echo "① 清除隔离标记…"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null && echo "   已清除" || echo "   （没有隔离标记，跳过）"
echo "② 本机重新签名（ad-hoc）…"
codesign --force --deep --sign - "$APP" && echo "   已签名" || echo "   ⚠ 签名失败，可以先把上面的报错发给我"
echo "③ 验证签名…"
codesign --verify --verbose=2 "$APP" 2>&1 | tail -3
echo
echo "✅ 完成。现在可以直接双击「$APP」打开了。"
read -n 1 -s -r -p "按任意键关闭…"
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", nargs="+", default=["arm64"], choices=["arm64", "x64"])
    ap.add_argument("--keep-work", action="store_true", help="保留中间产物（排查用）")
    args = ap.parse_args()
    os.makedirs(DIST, exist_ok=True)
    icns = os.path.join(ROOT, "build", "icon.icns")
    if not os.path.exists(icns):
        raise SystemExit("少了 build/icon.icns（图标签名用），先生成图标")
    outs = []
    for arch in args.arch:
        log("=" * 60)
        log("开始打 %s（%s）" % (arch, CHIP.get(arch, arch)))
        zpath = electron_zip(arch)
        work = fresh_work(arch)
        linkmap = extract(zpath, work)
        app = assemble(work, icns)
        sign(work, app)
        out = os.path.join(DIST, "封面制作器-mac-%s.zip" % CHIP.get(arch, arch))
        build_zip(work, app, zpath, out, linkmap)
        outs.append(out)
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)
    log("=" * 60)
    for o in outs:
        log("产物:", o, "(%.0f MB)" % (os.path.getsize(o) / 1048576))


if __name__ == "__main__":
    main()
