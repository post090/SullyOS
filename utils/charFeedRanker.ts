/**
 * 角色热点订阅 AI 自动排档
 *
 * 根据角色的核心提示词 + 被激活的世界书条目，让 LLM 判断这个角色对全局池子里
 * 每个源的兴趣程度，返回 4 档（浏览/关注/偏爱/必看）或不订阅。
 *
 * 设计原则：
 * 1. 只排全局已选的源，AI 不能凭空造源。
 * 2. 允许不订阅——AI 觉得这个角色不关心某个源就不选，而不是硬塞进最低档。
 * 3. 失败就抛错，不静默兜底——避免给出一套假数据让用户以为角色真的喜欢。
 */

import { APIConfig, CharacterProfile } from '../types';
import { ContextBuilder } from './context';

/** AI 排档结果：origin → tier（0=不订阅, 1=浏览, 2=关注, 3=偏爱, 4=必看） */
export type FeedRanking = Record<string, number>;

export interface FeedSourceInput {
    origin: string;   // platform key 或 RSS URL
    label: string;    // 显示名
    kind: 'platform' | 'rss';
}

const callLlm = async (api: APIConfig, sys: string, user: string): Promise<string> => {
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: sys },
                { role: 'user', content: user },
            ],
            temperature: 0.6,
            max_tokens: 4000,
            stream: false,
        }),
        __sullyMeta: { appName: '神经链接', purpose: '热点订阅排档' },
    } as RequestInit);
    if (!resp.ok) throw new Error(`LLM ${resp.status}`);
    const j = await resp.json();
    return j?.choices?.[0]?.message?.content || '';
};

/** 鲁棒 JSON 提取（复用 charMusicPersona 的同款逻辑） */
const extractJson = <T = any>(text: string): T | null => {
    if (!text || typeof text !== 'string') return null;
    const raw = text.trim().replace(/^\uFEFF/, '');
    const tryParse = (s: string): any | null => {
        try { return JSON.parse(s); } catch { return null; }
    };
    let hit = tryParse(raw);
    if (hit) return hit;

    const fencedMatch = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fencedMatch) {
        hit = tryParse(fencedMatch[1].trim());
        if (hit) return hit;
    }

    const braceSlice = (() => {
        const s = fencedMatch ? fencedMatch[1] : raw;
        const start = s.indexOf('{');
        if (start < 0) return null;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return s.slice(start, i + 1);
            }
        }
        return null;
    })();
    if (braceSlice) {
        hit = tryParse(braceSlice);
        if (hit) return hit;
        const repaired = braceSlice
            .replace(/[：]/g, ':')
            .replace(/[，]/g, ',')
            .replace(/[“”„]/g, '"')
            .replace(/[‘’‚]/g, "'")
            .replace(/'([^'\n\r]*?)'/g, '"$1"')
            .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
            .replace(/,(\s*[}\]])/g, '$1');
        hit = tryParse(repaired);
        if (hit) return hit;
    }
    return null;
};

/**
 * 让 AI 根据角色设定给源列表排档。
 * @returns FeedRanking — origin → tier(0-4)，未出现在结果里的源默认 tier=0（不订阅）
 */
export const rankFeedsForChar = async (
    char: CharacterProfile,
    api: APIConfig,
    sources: FeedSourceInput[],
): Promise<FeedRanking> => {
    if (sources.length === 0) return {};

    // 构建角色上下文：核心提示词 + 世界书（不带记忆/情绪等易变部分）
    const roleContext = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });

    const sourceList = sources.map((s, i) => `${i + 1}. [${s.kind}] ${s.label} (origin: ${s.origin})`).join('\n');

    const sys = `你是一个角色设定分析师。根据角色的核心设定和世界书，判断这个角色对各类新闻/资讯源的兴趣程度。

你需要对每个源给出一个档位：
- 4 (必看)：角色核心设定里强烈关注的内容（如科技博主→Hacker News，金融从业者→财经源）
- 3 (偏爱)：角色明显会喜欢但不是核心的源
- 2 (关注)：角色偶尔会感兴趣的源
- 1 (浏览)：角色可能顺便看看的源
- 0 (不订阅)：角色完全不关心的源——不要硬塞，不关心就不选

只返回 JSON，格式：{"origin字符串": 档位数字, ...}
每个源都必须出现在结果里，包括档位为 0 的。`;

    const user = `## 角色设定
${roleContext}

## 待排档的源列表
${sourceList}

请根据角色设定，对每个源给出 0-4 的档位。只返回 JSON。`;

    const raw = await callLlm(api, sys, user);
    const parsed = extractJson<Record<string, number>>(raw);

    if (!parsed) {
        // 退化：逐行正则抠 "origin": 数字
        const out: FeedRanking = {};
        const re = /["']([^"']+)["']\s*[:：]\s*(\d)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
            const origin = m[1];
            const tier = parseInt(m[2], 10);
            if (sources.some(s => s.origin === origin) && tier >= 0 && tier <= 4) {
                out[origin] = tier;
            }
        }
        if (Object.keys(out).length === 0) {
            throw new Error('AI 返回的内容无法解析为排档结果');
        }
        return out;
    }

    // 清洗：只保留已知 origin + 合法档位
    const validOrigins = new Set(sources.map(s => s.origin));
    const cleaned: FeedRanking = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (validOrigins.has(k) && typeof v === 'number' && v >= 0 && v <= 4) {
            cleaned[k] = Math.round(v);
        }
    }
    if (Object.keys(cleaned).length === 0) {
        throw new Error('AI 排档结果里没有有效条目');
    }
    return cleaned;
};
