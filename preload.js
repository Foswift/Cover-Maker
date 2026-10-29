// 能力桥：渲染层能拿到的能力。
// - 基础信息：版本 / 平台 / 离线标记
// - 素材库（§0.12/§0.15）：导入（原生选择框）、按路径导入（拖拽用）、列出、删除；
//   kind = 'material'（我的素材）| 'sticker'（贴纸库），同一个存储两个视图
// - getPathForFile：Electron 32+ 起 File.path 被移除，拖拽文件必须用 webUtils 取路径
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('coverApp', {
    version: process.versions.electron,
    platform: process.platform,
    offline: true,

    // 界面语言（2026-10-29）：开页面时同步取一次（renderer/i18n.js 要在画界面前就知道），切换时存到主进程并重建菜单
    i18n: {
        getLang: () => ipcRenderer.sendSync('settings:get-lang'),
        setLang: (lang) => ipcRenderer.invoke('settings:set-lang', lang)
    },

    library: {
        list: () => ipcRenderer.invoke('library:list'),
        import: (kind) => ipcRenderer.invoke('library:import', kind || 'material'),
        importPaths: (paths, kind) => ipcRenderer.invoke('library:import-paths', paths, kind || 'material'),
        remove: (id) => ipcRenderer.invoke('library:remove', id)
    },

    // 字体库（§0.17）：剪映字幕模板，只存解析出来的样式，不拷原文件
    templates: {
        list: () => ipcRenderer.invoke('templates:list'),
        import: () => ipcRenderer.invoke('templates:import'),
        importDirs: (dirs) => ipcRenderer.invoke('templates:import-dirs', dirs),
        remove: (id) => ipcRenderer.invoke('templates:remove', id),
        add: (entry) => ipcRenderer.invoke('templates:add', entry),
        rename: (id, name) => ipcRenderer.invoke('templates:rename', id, name)   // §0.99.9：双击卡片名字条就地改名
    },

    // 写系统剪贴板（纯文本）：颜色板块右键复制色值用
    copyText: (text) => ipcRenderer.invoke('clipboard:write-text', String(text || '')),

    // 导入图片到画布（§0.22）：只返回路径，**不拷贝、不进素材库**
    pickImages: () => ipcRenderer.invoke('images:pick'),

    // 导出（§0.24）：把若干张图（{name, dataURL}）交给主进程选目录并写盘
    exportPng: (files) => ipcRenderer.invoke('export:png', files),

    // 抠主体（2026-10-11）：交一张 PNG（dataURL），拿回同尺寸的灰度蒙版**每个主体一张**（白=主体）；引擎由主进程按平台挑
    subject: {
        extract: (png) => ipcRenderer.invoke('subject:extract', { png: png }),
        log: (tag, data) => ipcRenderer.invoke('subject:log', tag, data)        // §3.97c 诊断日志（userData/logs/subject.log）
    },

    // 系统字体库（§0.27）：读本机装了哪些字体（渲染层不知道系统字体，只能问主进程）
    // §0.99.18（用户 2026-10-10「可以直接读取系统字体，也可以手动导入字体库」）：
    //   · imported / import / remove = 手动导入那条线（清单存 userData/fonts-imported.json + userData/fonts/）
    //   · readFile(family) = 按族名取**字体文件字节**（导入的优先，再系统字体）→ 渲染层用 FontFace 注册真字体
    fonts: {
        list: (force) => ipcRenderer.invoke('fonts:list', !!force),
        imported: () => ipcRenderer.invoke('fonts:imported'),
        import: () => ipcRenderer.invoke('fonts:import'),
        remove: (id) => ipcRenderer.invoke('fonts:remove', id),
        readFile: (family) => ipcRenderer.invoke('fonts:readFile', family),
        faces: (family) => ipcRenderer.invoke('fonts:faces', family),          // 2026-10-22 字体样式下拉
        readFace: (q) => ipcRenderer.invoke('fonts:readFace', q)
    },

    // 我的模板（§0.25）：存/列/改名/删（缩略图由渲染层截图后交主进程落盘）
    myTemplates: {
        list: () => ipcRenderer.invoke('mytpl:list'),
        save: (tpl) => ipcRenderer.invoke('mytpl:save', tpl),
        rename: (id, name) => ipcRenderer.invoke('mytpl:rename', id, name),
        remove: (id) => ipcRenderer.invoke('mytpl:remove', id)
    },

    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch (err) {
            return '';
        }
    }
});
