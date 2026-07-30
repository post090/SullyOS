/**
 * 上岸计划 · 简历解析 + 竞争力分析（第七节）
 *
 * 两块职责：
 *  1. parseResumeIntoProfile：把导入的脱敏简历丢给 LLM，解析成竞争力档案
 *     （方向 / 结构化摘要 / 竞争点 / 改进点），合并进用户级单份 JobProfile。
 *     合并铁律：AI 解析只替换自己产出的 source:'ai' 条目，绝不覆盖用户手改(user)
 *     或角色指令(char)沉淀的条目。
 *  2. buildInterviewCallContext：给语音/文字面试拼场景上下文——面试官(strict)/
 *     陪练(coach)两档人设 + JD 或综合档案 + 出题规则 + 用户附加提示词。
 *
 * 隐私铁律：入模型前 rawText 已在导入时本地脱敏；这里再过 codifyCompanies 把真实
 * 公司名换成代号。companyNameLocal / hrName / 真名永不进任何 prompt。
 */

import { APIConfig, CharacterProfile, JobProfile, JobResume, JobPosition } from '../types';
import { safeResponseJson } from './safeApi';
import { resilientFetch } from './resilientFetch';
import { codifyCompanies } from './privacyRedact';
import { DB } from './db';

// ---------- 通用 ----------

const genId = (prefix: string, i: number) => `${prefix}-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;

/** 从模型输出里抠出 JSON（容忍 ```json 围栏 / 前后废话 / 尾逗号） */
function extractJson(raw: string): any {
    let text = String(raw || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('简历解析：模型没返回 JSON');
    const slice = text.slice(start, end + 1);
    try { return JSON.parse(slice); }
    catch { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); }
}

async function callJsonLLM(apiConfig: APIConfig, system: string, user: string): Promise<any> {
    const resp = await resilientFetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            temperature: 0.4, // 结构化解析求稳，不要发挥
            max_tokens: 2000,
        }),
    }, { timeoutMs: 120_000, retries: 1 });
    if (!resp.ok) throw new Error(`简历解析 LLM ${resp.status}`);
    const data = await safeResponseJson(resp);
    const content = data?.choices?.[0]?.message?.content || '';
    return extractJson(content);
}

// ---------- 简历解析 ----------

const RESUME_PARSE_SYSTEM = `你是资深求职顾问兼简历分析师。用户会给你一份【已脱敏】的简历文本：
- 公司名已被替换成代号（如 A厂、Z2），手机号/邮箱/身份证/真实姓名等已打码。
- 不要试图还原任何真实身份，也不要在输出里编造具体公司真名，代号原样保留即可。

请只输出一个 JSON 对象，不要任何解释文字或代码围栏，结构如下：
{
  "direction": "一句话概括这个人最适合的求职方向（岗位类型+层级），30字以内",
  "digest": "结构化 markdown 摘要，用 ### 教育 / ### 经历 / ### 项目 / ### 技能 四个小标题分段，每段精炼，总长 600 字以内",
  "strengths": ["竞争点，写清楚硬实力/亮点，3~6 条，每条一句话"],
  "gaps": {
    "strategy": ["求职策略层的改进建议，如方向聚焦/投递节奏/目标公司选择，1~4 条"],
    "resume": ["简历写法层的改进建议，如量化成果/技能排序/措辞，1~4 条"]
  }
}
只谈这份简历本身，基于事实分析，不要空泛套话。`;

/** AI 解析出来的原始草稿（清洗后） */
export interface ParsedProfileDraft {
    direction: string;
    digest: string;
    strengths: string[];
    gaps: { strategy: string[]; resume: string[] };
}

function normalizeDraft(raw: any): ParsedProfileDraft {
    const arr = (v: any): string[] =>
        Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 12) : [];
    return {
        direction: String(raw?.direction ?? '').trim().slice(0, 120),
        digest: String(raw?.digest ?? '').trim().slice(0, 4000),
        strengths: arr(raw?.strengths),
        gaps: {
            strategy: arr(raw?.gaps?.strategy),
            resume: arr(raw?.gaps?.resume),
        },
    };
}

/** 把 AI 草稿合并进现有档案：保留 user/char 条目，只替换 ai 条目 */
function mergeAiDraft(existing: JobProfile | null, draft: ParsedProfileDraft): JobProfile {
    const now = Date.now();
    const base: JobProfile = existing || { id: 'main', direction: '', strengths: [], gaps: [], resumeDigest: '', updatedAt: now };

    // 保留用户手改 / 角色指令沉淀的条目，AI 重新解析不覆盖
    const keptStrengths = base.strengths.filter(s => s.source !== 'ai');
    const keptGaps = base.gaps.filter(g => g.source !== 'ai');

    const aiStrengths = draft.strengths.map((text, i) => ({ id: genId('str', i), text, source: 'ai' as const }));
    const aiGaps = [
        ...draft.gaps.strategy.map((text, i) => ({ id: genId('gap-s', i), text, kind: 'strategy' as const, source: 'ai' as const })),
        ...draft.gaps.resume.map((text, i) => ({ id: genId('gap-r', i), text, kind: 'resume' as const, source: 'ai' as const })),
    ];

    return {
        id: 'main',
        // 方向：用户已手写过就尊重，别被重解析冲掉；否则采用 AI 的
        direction: base.direction.trim() || draft.direction,
        strengths: [...keptStrengths, ...aiStrengths],
        gaps: [...keptGaps, ...aiGaps],
        resumeDigest: draft.digest || base.resumeDigest,
        updatedAt: now,
    };
}

/**
 * 解析一份简历进竞争力档案。落库并返回合并后的 JobProfile。
 * 入模型前：rawText（导入时已本地脱敏）→ codifyCompanies 代号化 → 截断。
 */
export async function parseResumeIntoProfile(resume: JobResume, apiConfig: APIConfig): Promise<JobProfile> {
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
        throw new Error('还没配置可用的 API');
    }
    const positions = await DB.getJobPositions();
    const safeText = codifyCompanies(resume.rawText || '', positions).slice(0, 12000);
    if (safeText.replace(/\s/g, '').length < 20) throw new Error('这份简历内容太短，解析不出东西');

    const raw = await callJsonLLM(apiConfig, RESUME_PARSE_SYSTEM, `简历文本（已脱敏）：\n\n${safeText}`);
    const draft = normalizeDraft(raw);
    const existing = await DB.getJobProfile();
    const merged = mergeAiDraft(existing, draft);
    await DB.saveJobProfile(merged);
    return merged;
}

// ---------- 面试场景上下文 ----------

export type InterviewMode = 'strict' | 'coach';
export type InterviewTarget =
    | { kind: 'position'; position: JobPosition }
    | { kind: 'comprehensive' };

const MODE_PERSONA: Record<InterviewMode, string> = {
    strict: `【面试官人设】你现在是一位严肃、专业的面试官。语气正式、有压迫感但不失礼貌，会追问细节、质疑含糊回答，像真实的一面/二面。每次只抛出一个问题，等对方回答后再基于回答深入或转向下一题。`,
    coach: `【陪练人设】你现在是一位耐心的面试陪练。语气轻松鼓励，问题循序渐进，回答后会给一句简短点评和改进方向，帮对方建立信心。每次只问一个问题。`,
};

/** 拼面试场景上下文段（作为 sceneContext 塞进通话/文字面试的 coreContext 前） */
export function buildInterviewCallContext(
    target: InterviewTarget,
    mode: InterviewMode,
    profile: JobProfile | null,
    char: CharacterProfile,
    extraPrompt?: string,
): string {
    const parts: string[] = [MODE_PERSONA[mode]];

    if (target.kind === 'position') {
        const p = target.position;
        // JD 进 prompt 前代号化（把可能出现的真实公司名换成本卡代号），只暴露代号/岗位名/JD
        const jd = p.jd ? codifyCompanies(p.jd, [p]).slice(0, 1500) : '';
        const posLines = [`【面试岗位】代号 ${p.code} · ${p.title}`];
        if (p.projectName) posLines.push(`项目方向：${p.projectName}`);
        if (jd) posLines.push(`岗位 JD（已脱敏）：\n${jd}`);
        parts.push(posLines.join('\n'));
    } else {
        parts.push('【面试目标】综合面试，不针对具体岗位，围绕候选人整体背景与求职方向提问。');
    }

    // 候选人竞争力档案（永远不含真名/真实公司）
    if (profile) {
        const pf: string[] = [];
        if (profile.direction) pf.push(`求职方向：${profile.direction}`);
        if (profile.strengths.length) pf.push(`竞争点：${profile.strengths.map(s => s.text).join('；')}`);
        if (profile.gaps.length) pf.push(`可深挖的弱项：${profile.gaps.map(g => g.text).join('；')}`);
        if (profile.resumeDigest) pf.push(`简历摘要：\n${profile.resumeDigest.slice(0, 800)}`);
        if (pf.length) parts.push(`【候选人档案（据此设计针对性问题，但不要直接念出来）】\n${pf.join('\n')}`);
    }

    parts.push(`【出题规则】\n- 一次只问一个问题，问完停下等回答。\n- 围绕岗位要求与候选人背景，由浅入深。\n- 不要一次列出多个问题，不要自问自答。\n- 保持你(${char.name})的说话风格。`);

    const extra = (extraPrompt || '').trim();
    if (extra) parts.push(`【本场额外要求（用户指定，优先遵守）】\n${extra.slice(0, 800)}`);

    return parts.join('\n\n');
}
