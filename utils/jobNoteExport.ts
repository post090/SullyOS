// 上岸计划「笔记本」导出：单篇 txt / 全部打包 zip。
// APK(native) 走 Capacitor Filesystem 写文件 + Share 弹系统分享面板（方便在别的设备看）；
// 纯 Web 兜底走 Blob + a[download]。刻意把这层单独抽出来，UI 只管调 export* 函数。

import { Capacitor } from '@capacitor/core';
import type { JobNote, JobNoteKind } from '../types';

const KIND_LABEL: Record<JobNoteKind, string> = {
    eval: '面试评价', resume_advice: '简历建议', analysis: '岗位分析', note: '随手记',
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** 文件名/压缩包名用的时间戳：20260731-113059。 */
export const exportStamp = (d: Date = new Date()): string =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** 笔记标题 → 安全文件名：去掉 Windows/Android 非法字符与控制符，压掉多余空白并限长。 */
export const safeFileName = (name: string, fallback = '笔记'): string => {
    const cleaned = (name || '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || fallback).slice(0, 60);
};

/** 一篇笔记 → 纯文本（带标题/类型/标签/时间抬头 + 正文）。 */
export const noteToTxt = (note: JobNote): string => {
    const created = new Date(note.createdAt).toLocaleString('zh-CN');
    const updated = note.updatedAt ? new Date(note.updatedAt).toLocaleString('zh-CN') : '';
    const head = [
        note.title || '（无标题）',
        `【类型】${KIND_LABEL[note.kind] || '笔记'}`,
        (note.tags && note.tags.length) ? `【标签】${note.tags.join('、')}` : '',
        `【创建】${created}`,
        (updated && updated !== created) ? `【更新】${updated}` : '',
        '────────────────────',
        '',
    ].filter(Boolean).join('\n');
    return `${head}${note.content || ''}\n`;
};

const isNative = (): boolean => {
    try { return Capacitor.isNativePlatform(); } catch { return false; }
};

/** Blob → base64（去掉 dataURL 前缀），给 native 写二进制文件用。 */
const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result || ''); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsDataURL(blob);
});

export type ExportResult = 'shared' | 'downloaded';

/**
 * 统一导出：native 写进 Documents/SullyOS/notes 再弹系统分享；web 触发下载。
 * text 与 blob 二选一（txt 传 text，zip 传 blob）。分享被用户取消不算失败（文件已落盘）。
 */
const shareOrDownload = async (opts: {
    fileName: string;
    mime: string;
    text?: string;
    blob?: Blob;
    shareTitle?: string;
}): Promise<ExportResult> => {
    const { fileName, mime, text, blob, shareTitle } = opts;
    if (isNative()) {
        const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
        const { Share } = await import('@capacitor/share');
        const path = `SullyOS/notes/${fileName}`;
        if (typeof text === 'string') {
            await Filesystem.writeFile({ path, data: text, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
        } else if (blob) {
            await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: Directory.Documents, recursive: true });
        } else {
            throw new Error('没有可导出的内容');
        }
        const { uri } = await Filesystem.getUri({ directory: Directory.Documents, path });
        try {
            await Share.share({ title: shareTitle || fileName, files: [uri] });
        } catch (e: any) {
            // 用户在系统分享面板点了取消不算失败——文件已经存在 Documents/SullyOS/notes 了。
            if (!/cancel/i.test(String(e?.message || e))) throw e;
        }
        return 'shared';
    }
    // Web：Blob + a[download]
    const outBlob = blob || new Blob([text || ''], { type: mime });
    const url = URL.createObjectURL(outBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* noop */ } }, 4000);
    return 'downloaded';
};

/** 导出单篇笔记为 txt。 */
export const exportSingleNote = async (note: JobNote): Promise<ExportResult> =>
    shareOrDownload({
        fileName: `${safeFileName(note.title)}.txt`,
        mime: 'text/plain;charset=utf-8',
        text: noteToTxt(note),
        shareTitle: note.title || '笔记',
    });

/** 导出全部笔记为 zip（每篇一个 txt，文件名去重；zip 名带时间戳）。 */
export const exportAllNotes = async (notes: JobNote[]): Promise<ExportResult> => {
    if (!notes.length) throw new Error('还没有笔记可导出');
    const mod: any = await import('jszip');
    const JSZip = mod.default || mod;
    const zip = new JSZip();
    const used = new Set<string>();
    notes.forEach((n, idx) => {
        const base = safeFileName(n.title, `笔记${idx + 1}`);
        let name = `${base}.txt`;
        let k = 2;
        while (used.has(name)) { name = `${base}(${k++}).txt`; }
        used.add(name);
        zip.file(name, noteToTxt(n));
    });
    const blob: Blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return shareOrDownload({
        fileName: `上岸计划笔记_${exportStamp()}.zip`,
        mime: 'application/zip',
        blob,
        shareTitle: '上岸计划笔记',
    });
};

/**
 * 导出一组预格式化的文本条目为 zip（岗位库等复用；每条一个 txt，文件名去重，zip 名带时间戳）。
 * 文本由调用方（掌握各自的标签/字段含义）拼好后传入，本层只管打包 + 分享/下载。
 */
export const exportTextEntries = async (
    entries: { name: string; text: string }[],
    opts: { zipBaseName: string; shareTitle: string },
): Promise<ExportResult> => {
    if (!entries.length) throw new Error('没有可导出的内容');
    const mod: any = await import('jszip');
    const JSZip = mod.default || mod;
    const zip = new JSZip();
    const used = new Set<string>();
    entries.forEach((e, idx) => {
        const base = safeFileName(e.name, `条目${idx + 1}`);
        let name = `${base}.txt`;
        let k = 2;
        while (used.has(name)) { name = `${base}(${k++}).txt`; }
        used.add(name);
        zip.file(name, e.text);
    });
    const blob: Blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return shareOrDownload({
        fileName: `${opts.zipBaseName}_${exportStamp()}.zip`,
        mime: 'application/zip',
        blob,
        shareTitle: opts.shareTitle,
    });
};
