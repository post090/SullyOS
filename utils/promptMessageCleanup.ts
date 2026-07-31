/**
 * 剥离历史里旧的双语标签：`%%BILINGUAL%%` 形态整条在标记处截断（只留原文侧），
 * `<翻译>` XML 形态只留 <原文>。
 */
export function cleanApiMessages(
    apiMessages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
    return apiMessages.map((msg: any) => {
        if (typeof msg.content !== 'string') return msg;
        let c: string = msg.content;
        if (c.toLowerCase().includes('%%bilingual%%')) {
            const idx = c.toLowerCase().indexOf('%%bilingual%%');
            c = c.substring(0, idx).trim();
        }
        if (c.includes('<翻译>')) {
            c = c.replace(/<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g, '$1').trim();
        }
        return { ...msg, content: c };
    });
}

/**
 * 把多模态图片消息压平成纯文本：保留 text 部分，丢弃 image_url/base64。
 */
export function flattenImageContentParts(
    apiMessages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
    return apiMessages.map((msg) => {
        if (!Array.isArray(msg.content)) return msg;
        const text = msg.content
            .filter((part: any) => part?.type === 'text')
            .map((part: any) => part.text || '')
            .join('\n')
            .trim();
        return { ...msg, content: text || '[图片]' };
    });
}
