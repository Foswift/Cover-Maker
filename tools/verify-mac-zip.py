#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
封面制作器：mac 包验收（把 Progress §0.80 固化的那份清单做成一条命令）

    python tools/verify-mac-zip.py                       # 默认验 dist/封面制作器-mac-Apple芯片.zip
    python tools/verify-mac-zip.py --zip dist/xxx.zip --arch x64

验的是这些（§0.80 的历史口径，逐项打 PASS/FAIL）：
  ① 条目数 / 重名 / 符号链接数 / zip 体积 / **CRC 全部能过**（zipfile.testzip）
  ② 顶层只有三样：封面制作器.app + 首次打开.command + 使用说明.txt
  ③ 权限位：Contents/MacOS/封面制作器 0755、首次打开.command 0755、Contents/Info.plist 0644
  ④ Info.plist：CFBundleName / CFBundleIdentifier=com.foswift.covermaker / CFBundleShortVersionString / CFBundleExecutable
  ⑤ 主二进制：Mach-O magic 0xfeedfacf、cputype arm64(0x100000c) / x64(0x1000007)；
     LC_CODE_SIGNATURE 的 linkedata_command 顺序是 (dataoff, datasize) 别解反（§0.80 踩过）；
     SuperBlob 0xfade0cc0 + CodeDirectory 0xfade0c02、flags 0x2 = ad-hoc、identifier
  ⑥ **最关键的一条**：包内 main.js / preload.js / renderer/index.html / renderer/konva.min.js 的
     sha256 与**当前工作区**逐一相同 —— 证明「这个包就是这版代码」
     （2026-10-19 起代码在 Contents/Resources/app.asar 里；10-29 激活码撤掉 → 包里不许再有 license.js / activate.html）
  ⑦ Info.plist ElectronAsarIntegrity = app.asar 头的 sha256；⑧ Electron Framework 的 fuses 已翻；⑨ Electron Framework 是 ad-hoc 重签

退出码 0 = 全过；1 = 有 FAIL。条目数/体积等「会随版本变」的量只打印出来做对照，不硬判（硬判见 §0.80 的历史值）。
"""
import argparse
import hashlib
import io
import os
import plistlib
import struct
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ZIP = os.path.join(ROOT, 'dist', '封面制作器-mac-Apple芯片.zip')
APP = '封面制作器.app'
# ⚠ zip 里的路径分隔符恒为 '/'，这里**不能用 os.path.join**（Windows 上会拼成反斜杠 → 查不到条目）
PAYLOAD = APP + '/Contents/Resources/app'

fails = []
info_lines = []


def ok(name, cond, extra=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  — ' + extra) if extra else ''))
    if not cond:
        fails.append(name)
    return cond


def sha256_of(data):
    return hashlib.sha256(data).hexdigest()[:12]


def parse_macho(buf):
    magic = struct.unpack('<I', buf[:4])[0]
    out = {'magic': magic}
    if magic != 0xFEEDFACF:
        return out
    cputype, _cpusub, _ft, ncmds, _sizecmds, _flags, _res = struct.unpack('<iiIIIII', buf[4:32])
    out['cputype'] = cputype
    off = 32
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack('<II', buf[off:off + 8])
        if cmd == 0x1D:            # LC_CODE_SIGNATURE = linkedit_data_command{dataoff, datasize}
            dataoff, datasize = struct.unpack('<II', buf[off + 8:off + 16])
            out['sig'] = (dataoff, datasize)
        off += cmdsize
    return out


def parse_superblob(buf, dataoff, datasize):
    """返回 (magic, codeDirectory 信息 dict)"""
    blob = buf[dataoff:dataoff + datasize]
    sb_magic = struct.unpack('>I', blob[:4])[0]
    if sb_magic != 0xFADE0CC0:
        return sb_magic, None
    count = struct.unpack('>I', blob[8:12])[0]
    cd = None
    for i in range(count):
        rel = struct.unpack('>I', blob[12 + 4 * i:16 + 4 * i])[0]
        m = struct.unpack('>I', blob[rel:rel + 4])[0]
        if m == 0xFADE0C02:                       # CodeDirectory
            flags = struct.unpack('>I', blob[rel + 12:rel + 16])[0]
            ident_off = struct.unpack('>I', blob[rel + 20:rel + 24])[0]
            ident = blob[rel + ident_off:rel + ident_off + 64].split(b'\0')[0].decode('utf-8', 'replace')
            cd = {'flags': flags, 'identifier': ident, 'blobs': count}
    return sb_magic, cd


def parse_asar(buf):
    """asar 格式：[u32=4][u32 头 pickle 长度 n] + 头 pickle{[u32 负载长][u32 串长 L][JSON 串]} + 文件区（从 8+n 开始）。
    返回 (头 JSON 串, read_file(相对路径) -> bytes|None)。"""
    import json
    n = struct.unpack_from('<I', buf, 4)[0]
    slen = struct.unpack_from('<I', buf, 12)[0]
    header_str = buf[16:16 + slen].decode('utf-8')
    header = json.loads(header_str)
    base = 8 + n

    def read_file(rel):
        node = header
        for part in rel.split('/'):
            node = (node.get('files') or {}).get(part)
            if node is None:
                return None
        if 'offset' not in node or node.get('unpacked'):
            return None
        off = base + int(node['offset'])
        return buf[off:off + int(node['size'])]
    return header_str, read_file


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', default=DEFAULT_ZIP)
    ap.add_argument('--arch', default='arm64', choices=['arm64', 'x64'])
    a = ap.parse_args()

    want_cpu = 0x100000C if a.arch == 'arm64' else 0x1000007
    print('=== 封面制作器 mac 包验收 ===')
    print('包: %s' % a.zip)
    ok('包文件存在', os.path.isfile(a.zip), a.zip)
    if fails:
        sys.exit(1)
    size = os.path.getsize(a.zip)
    print('      体积: %.1f MB (%d 字节)' % (size / 1024.0 / 1024.0, size))

    z = zipfile.ZipFile(a.zip)
    names = z.namelist()
    print('      条目: %d' % len(names))

    # ① CRC
    bad = z.testzip()
    ok('CRC 全部通过（testzip）', bad is None, '坏条目=%s' % bad)
    dupe = len(names) - len(set(names))
    ok('无重名条目', dupe == 0, '重名 %d' % dupe)

    # 符号链接：external_attr 高 16 位里的 S_IFLNK
    links = [n for n in names if (z.getinfo(n).external_attr >> 16) & 0xF000 == 0xA000]
    print('      符号链接: %d 个' % len(links))
    ok('符号链接数 = 14（Electron framework 那批）', len(links) == 14, '实测 %d' % len(links))

    # ② 顶层三样
    top = sorted({n.split('/')[0] for n in names if n and not n.startswith('/')})
    ok('顶层只有 app + .command + 说明.txt 三样',
       top == sorted([APP, '首次打开.command', '使用说明.txt']), str(top))

    # ②b 使用说明：要写激活码（2026-10-19 软件改成使用要激活码，说明一度漏写）；芯片那句跟包的芯片一致
    readme = z.read('使用说明.txt').decode('utf-8') if '使用说明.txt' in names else ''
    ok('使用说明写了激活 / 买码方式', '【激活】' in readme and '激活码' in readme and 'foswift.com/download' in readme)
    chip_ok = ('这是 Intel 芯片版' in readme) if a.arch == 'x64' else ('只支持 Apple 芯片' in readme)
    ok('使用说明的芯片那句 = %s' % a.arch, chip_ok)

    # ③ 权限位
    perms = {n: (z.getinfo(n).external_attr >> 16) & 0o777 for n in names}
    binp = APP + '/Contents/MacOS/封面制作器'
    ok('主二进制权限 0755', perms.get(binp) == 0o755, oct(perms.get(binp, -1)))
    ok('首次打开.command 权限 0755', perms.get('首次打开.command') == 0o755, oct(perms.get('首次打开.command', -1)))
    ok('Info.plist 权限 0644', perms.get(APP + '/Contents/Info.plist') == 0o644, oct(perms.get(APP + '/Contents/Info.plist', -1)))

    # ④ plist
    pl = plistlib.loads(z.read(APP + '/Contents/Info.plist'))
    ok('plist CFBundleName=封面制作器', pl.get('CFBundleName') == '封面制作器', str(pl.get('CFBundleName')))
    ok('plist CFBundleIdentifier=com.foswift.covermaker',
       pl.get('CFBundleIdentifier') == 'com.foswift.covermaker', str(pl.get('CFBundleIdentifier')))
    ok('plist CFBundleExecutable=封面制作器', pl.get('CFBundleExecutable') == '封面制作器', str(pl.get('CFBundleExecutable')))
    print('      版本: %s' % pl.get('CFBundleShortVersionString'))

    # ⑤ 主二进制 + 签名
    buf = z.read(binp)
    m = parse_macho(buf)
    ok('Mach-O magic 0xfeedfacf', m.get('magic') == 0xFEEDFACF, hex(m.get('magic', 0)))
    ok('cputype = %s (%s)' % (a.arch, hex(want_cpu)), m.get('cputype') == want_cpu, hex(m.get('cputype', 0)))
    if 'sig' in m:
        dataoff, datasize = m['sig']
        print('      LC_CODE_SIGNATURE @%d 长 %d' % (dataoff, datasize))
        sb, cd = parse_superblob(buf, dataoff, datasize)
        ok('SuperBlob magic 0xfade0cc0', sb == 0xFADE0CC0, hex(sb))
        ok('CodeDirectory 里有签名目录', cd is not None)
        if cd:
            ok('CodeDirectory flags = 0x2（ad-hoc）', cd['flags'] == 0x2, hex(cd['flags']))
            ok('签名 identifier = com.foswift.covermaker', cd['identifier'] == 'com.foswift.covermaker', cd['identifier'])
            print('      签名子块 %d 个' % cd['blobs'])
    else:
        ok('找到 LC_CODE_SIGNATURE', False)

    # ⑥ 包内代码 == 工作区（最关键）—— 2026-10-19 起代码在 app.asar 里（加固 ①②③，见 tools/harden-pack.js）
    print('--- 包内代码（app.asar）vs 工作区（sha256 前 12 位）---')
    asar_path = APP + '/Contents/Resources/app.asar'
    ok('包内有 app.asar', asar_path in names)
    ok('没有明文 app 目录（只认 asar）', not any(n.startswith(PAYLOAD + '/') for n in names))
    if asar_path not in names:
        sys.exit(1)
    asar_buf = z.read(asar_path)
    header_str, read_file = parse_asar(asar_buf)
    pairs = ['main.js', 'preload.js', 'renderer/index.html', 'renderer/service-wechat.jpg', 'renderer/konva.min.js', 'renderer/colors.js',
             'renderer/fonts/SourceHanSansCN-Medium.otf', 'renderer/fonts/SourceHanSans-LICENSE.txt']
    for rel in pairs:
        data = read_file(rel)
        if data is None:
            ok('asar 里有 %s' % rel, False)
            continue
        h_zip = sha256_of(data)
        with open(os.path.join(ROOT, rel), 'rb') as f:
            h_local = sha256_of(f.read())
        print('      %-22s 包内 %s | 工作区 %s' % (rel, h_zip, h_local))
        ok('%s 与工作区一致' % rel, h_zip == h_local)
    ok('asar 里没有激活码模块（license.js / activate.html，10-29 撤掉）', read_file('license.js') is None and read_file('renderer/activate.html') is None)

    # ⑦ Info.plist 的 asar 完整性哈希 = 包里 app.asar 头的 sha256
    integ = (pl.get('ElectronAsarIntegrity') or {}).get('Resources/app.asar') or {}
    h_header = hashlib.sha256(header_str.encode('utf-8')).hexdigest()
    ok('Info.plist ElectronAsarIntegrity 与 app.asar 一致', integ.get('algorithm') == 'SHA256' and integ.get('hash') == h_header,
       'plist %s | 实际 %s' % (str(integ.get('hash'))[:16], h_header[:16]))

    # ⑧ fuses（在 Electron Framework 真文件里）：RunAsNode / NODE_OPTIONS / --inspect 关，asar 完整性 / 只认 asar 开
    fw_path = APP + '/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
    fw = z.read(fw_path)
    sentinel = b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
    si = fw.find(sentinel)
    wire = b''
    if si >= 0:
        p = si + len(sentinel)
        wire = fw[p + 2:p + 2 + fw[p + 1]]
    print('      fuse wire: %s' % wire.decode('ascii', 'replace'))
    want = {0: b'0', 2: b'0', 3: b'0', 4: b'1', 5: b'1'}
    ok('fuses：RunAsNode/NODE_OPTIONS/inspect 关，asar 完整性/只认 asar 开',
       len(wire) >= 6 and all(wire[i:i + 1] == v for i, v in want.items()), wire.decode('ascii', 'replace'))

    # ⑨ 翻过 fuse 的 Electron Framework 必须是我们重签的 ad-hoc（还挂官方签名 = 内容对不上，Apple 芯片拒绝加载）
    fm = parse_macho(fw)
    if 'sig' in fm:
        _sb, fcd = parse_superblob(fw, fm['sig'][0], fm['sig'][1])
        ok('Electron Framework 是 ad-hoc 重签（flags 0x2）', bool(fcd) and fcd['flags'] == 0x2, hex(fcd['flags']) if fcd else '无 CodeDirectory')
    else:
        ok('Electron Framework 有 LC_CODE_SIGNATURE', False)

    print('---')
    if fails:
        print('%d 项 FAIL：' % len(fails))
        for f in fails:
            print('  · ' + f)
        sys.exit(1)
    print('全部通过 → 这个包就是当前工作区这版代码')


if __name__ == '__main__':
    main()
