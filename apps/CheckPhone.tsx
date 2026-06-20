import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneEvidence, PhoneCustomApp } from '../types';
import { ContextBuilder } from '../utils/context';
import Modal from '../components/os/Modal';
import { safeResponseJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import PersonaSim, { LifeLog, generatePersonaScript } from './PersonaSim';
import { usePersonaSim, personaSimStore } from '../utils/personaSimStore';
import { getLastInnerState } from '../utils/emotionApply';
import {
    User, Phone, ChatCircleDots, ChatCircle, ShoppingBag, Hamburger, Compass, GearSix,
    Plus, SignOut, CaretLeft, CaretRight, Cloud, ImagesSquare, LockSimple, Package,
    Storefront, Heart, ArrowsClockwise, Tray, DotsThree, ClockCounterClockwise, Sparkle
} from '@phosphor-icons/react';

type LayoutId = NonNullable<PhoneCustomApp['layout']>;

const APP_LAYOUTS: { id: LayoutId; name: string; desc: string; icon: string }[] = [
    { id: 'generic', name: '通用卡片', desc: '标题 + 内容信息流', icon: '🗂️' },
    { id: 'shop', name: '购物风格', desc: '商品 / 价格 / 状态', icon: '🛍️' },
    { id: 'feed', name: '社交动态', desc: '头像 / 正文 / 点赞', icon: '💬' },
    { id: 'forum', name: '论坛风格', desc: '帖子 / 楼层 / 回复', icon: '📋' },
    { id: 'novel', name: '小说风格', desc: '章节 / 正文阅读', icon: '📖' },
];

// ============================================================
//  SHARED PREMIUM UI PIECES
//  (module-scope: defining these inside CheckPhone gave them a new identity
//   on every render, which remounted whole sub-app subtrees → list items kept
//   re-playing their entrance animation (闪烁) and chat scroll snapped back.)
// ============================================================
const StatusStrip: React.FC = () => {
    const clock = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return (
        <div className="h-9 flex justify-between px-6 items-center z-30 relative pt-2 text-white/70 shrink-0">
            <span className="text-[12px] font-semibold tracking-tight tabular-nums">{clock}</span>
            <div className="flex gap-1.5 items-center">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M2 22h3V10H2v12zm6 0h3V6H8v16zm6 0h3V2h-3v20zm6 0h3v-8h-3v8z" /></svg>
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M1.371 8.143c5.858-5.857 15.356-5.857 21.213 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.06 0c-4.98-4.979-13.053-4.979-18.032 0a.75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182c4.1-4.1 10.749-4.1 14.85 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.062 0 8.25 8.25 0 0 0-11.667 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.204 3.182a6 6 0 0 1 8.486 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0 3.75 3.75 0 0 0-5.304 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182a1.5 1.5 0 0 1 2.122 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0l-.53-.53a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                <div className="w-5 h-2.5 border border-current rounded-[3px] relative px-px flex items-center"><div className="h-1.5 bg-current w-3/4 rounded-[1px]" /></div>
            </div>
        </div>
    );
};

const TermHeader: React.FC<{ title: string; sub?: string; accent: string; onBack: () => void; right?: React.ReactNode }> =
    ({ title, sub, accent, onBack, right }) => (
        <div className="shrink-0 z-20">
            <StatusStrip />
            <div className="h-14 flex items-center justify-between px-4">
                <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                    <CaretLeft size={18} weight="bold" />
                </button>
                <div className="flex-1 text-center px-2">
                    <div className="text-[15px] font-semibold text-white tracking-wide truncate">{title}</div>
                    {sub && <div className="text-[10px] tracking-[0.2em] uppercase mt-0.5" style={{ color: accent }}>{sub}</div>}
                </div>
                <div className="w-9 flex justify-end">{right}</div>
            </div>
        </div>
    );

const RefreshFab: React.FC<{ onClick: () => void; label: string; accent: string; loading?: boolean }> =
    ({ onClick, label, accent, loading }) => (
        <div className="absolute bottom-7 w-full flex justify-center pointer-events-none z-30">
            <button
                disabled={loading}
                onClick={onClick}
                className="pointer-events-auto px-6 py-3 rounded-full font-semibold text-[12px] flex items-center gap-2 active:scale-95 transition shadow-[0_8px_30px_rgba(0,0,0,0.5)] text-white border border-white/10"
                style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}
            >
                {loading
                    ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    : <ArrowsClockwise size={15} weight="bold" />}
                {loading ? '同步中…' : label}
            </button>
        </div>
    );

const SubAppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden text-white"
        style={{ background: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)' }}>
        {children}
    </div>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
        <Tray size={44} weight="light" />
        <span className="text-xs tracking-wide">{text}</span>
    </div>
);

const DelBtn: React.FC<{ onDelete: () => void }> = ({ onDelete }) => (
    <button onClick={onDelete} className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition z-10">×</button>
);

const HomeCard: React.FC<{
    icon: React.ReactNode; label: string; sub: string; accent: string;
    badge?: number; onClick: () => void; spanFull?: boolean;
}> = ({ icon, label, sub, accent, badge, onClick, spanFull }) => (
    <button onClick={onClick}
        className={`relative ${spanFull ? 'col-span-2' : ''} rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition-transform duration-300 min-h-[140px] flex flex-col justify-between group`}>
        <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full blur-2xl pointer-events-none opacity-50"
            style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
        <div className="flex items-start justify-between relative z-10">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center border border-white/[0.08]"
                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, color: accent, boxShadow: `inset 0 0 16px ${accent}22` }}>
                {icon}
            </div>
            {badge ? (
                <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shadow-[0_0_12px_rgba(244,63,94,0.6)]">{badge}</span>
            ) : null}
        </div>
        <div className="relative z-10">
            <div className="text-[15px] font-semibold tracking-[0.18em] text-white uppercase">{label}</div>
            <div className="text-[11px] text-white/45 mt-1">{sub}</div>
            <div className="h-[3px] w-9 rounded-full mt-2.5" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
        </div>
    </button>
);

const CheckPhone: React.FC = () => {
    const { closeApp, characters, activeCharacterId, updateCharacter, apiConfig, addToast, userProfile } = useOS();
    const [view, setView] = useState<'select' | 'phone'>('select');
    // activeAppId: 'home' | 'chat_detail' | 'app_id'
    const [activeAppId, setActiveAppId] = useState<string>('home');
    const [targetChar, setTargetChar] = useState<CharacterProfile | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(0); // 0 = home, 1 = custom apps

    // Chat Detail State
    const [selectedChatRecord, setSelectedChatRecord] = useState<PhoneEvidence | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    // Custom App Creation State
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newAppName, setNewAppName] = useState('');
    const [newAppIcon, setNewAppIcon] = useState('✨');
    const [newAppColor, setNewAppColor] = useState('#8b9cff');
    const [newAppPrompt, setNewAppPrompt] = useState('');
    const [newAppLayout, setNewAppLayout] = useState<NonNullable<PhoneCustomApp['layout']>>('generic');

    // 人格模拟：演出脚本在全局 store 后台生成，生成期间用户可离开查手机/切到别的 OS App
    const sim = usePersonaSim();
    const [showInner, setShowInner] = useState(false);

    // Swipe tracking for paging
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);

    // Derived state for evidence records
    const records = targetChar?.phoneState?.records || [];
    const customApps = targetChar?.phoneState?.customApps || [];

    useEffect(() => {
        if (targetChar) {
            const updated = characters.find(c => c.id === targetChar.id);
            if (updated && updated !== targetChar) {
                setTargetChar(updated);
                if (selectedChatRecord) {
                    const freshRecord = updated.phoneState?.records?.find(r => r.id === selectedChatRecord.id);
                    if (freshRecord && freshRecord !== selectedChatRecord) setSelectedChatRecord(freshRecord);
                }
            }
        }
    }, [characters]);

    // Reset page scroll on navigation to prevent mobile layout shift
    useEffect(() => {
        window.scrollTo(0, 0);
    }, [activeAppId, view]);

    // Auto scroll to bottom of chat detail
    useEffect(() => {
        if (activeAppId === 'chat_detail' && chatEndRef.current) {
            const container = chatEndRef.current.parentElement;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [selectedChatRecord?.detail, activeAppId]);

    const handleSelectChar = (c: CharacterProfile) => {
        setTargetChar(c);
        setView('phone');
        setActiveAppId('home');
        setPage(0);
    };

    const handleExitPhone = () => {
        setView('select');
        setTargetChar(null);
        setActiveAppId('home');
        setPage(0);
    };

    // 切换「查手机内容是否同步到私聊」（默认开）
    const toggleSendToChat = () => {
        if (!targetChar) return;
        const next = !(targetChar.phoneState?.sendToChat !== false);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], sendToChat: next },
        });
        addToast(next ? '已开启 · 查手机内容会同步到私聊' : '已关闭 · 查手机内容仅本地可见', 'info');
    };

    // 打开 Messages：把已读时间戳推到现在 → 清掉未读红点
    const openChat = () => {
        if (targetChar) {
            updateCharacter(targetChar.id, {
                phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], chatReadAt: Date.now() },
            });
        }
        setActiveAppId('chat');
    };

    const handleDeleteRecord = async (record: PhoneEvidence) => {
        if (!targetChar) return;

        const newRecords = (targetChar.phoneState?.records || []).filter(r => r.id !== record.id);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: newRecords }
        });

        if (record.systemMessageId) {
            await DB.deleteMessage(record.systemMessageId);
        }

        if (selectedChatRecord?.id === record.id) {
            setActiveAppId('chat');
            setSelectedChatRecord(null);
        }

        addToast('记录已删除', 'success');
    };

    const handleDeleteApp = (appId: string) => {
        if (!targetChar) return;
        const newApps = (targetChar.phoneState?.customApps || []).filter(a => a.id !== appId);
        updateCharacter(targetChar.id, {
            phoneState: { records: targetChar.phoneState?.records || [], ...targetChar.phoneState, customApps: newApps }
        });
        addToast('App 已卸载', 'success');
    };

    const handleCreateCustomApp = () => {
        if (!targetChar || !newAppName || !newAppPrompt) return;

        const newApp: PhoneCustomApp = {
            id: `app-${Date.now()}`,
            name: newAppName,
            icon: newAppIcon,
            color: newAppColor,
            prompt: newAppPrompt,
            layout: newAppLayout
        };

        const currentApps = targetChar.phoneState?.customApps || [];
        updateCharacter(targetChar.id, {
            phoneState: { records: targetChar.phoneState?.records || [], ...targetChar.phoneState, customApps: [...currentApps, newApp] }
        });

        setShowCreateModal(false);
        setNewAppName('');
        setNewAppPrompt('');
        setNewAppLayout('generic');
        setPage(1);
        addToast(`已安装 ${newAppName}`, 'success');
    };

    // Calculate Time Gap
    const getTimeGapHint = (lastMsgTimestamp: number | undefined): string => {
        if (!lastMsgTimestamp) return '这是初次见面。';
        const now = Date.now();
        const diffMs = now - lastMsgTimestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 5) return '你们刚刚还在聊天。';
        if (diffMins < 60) return `距离上次互动只有 ${diffMins} 分钟。`;
        if (diffHours < 24) return `距离上次互动已经过了 ${diffHours} 小时。`;
        return `距离上次互动已经过了 ${diffDays} 天。`;
    };

    // --- Core Generation Logic ---
    const handleGenerate = async (type: string, customPrompt?: string, layout?: LayoutId) => {
        if (!targetChar || !apiConfig.apiKey) {
            addToast('配置错误', 'error');
            return;
        }
        setIsLoading(true);

        try {
            await injectMemoryPalace(targetChar);
            const context = ContextBuilder.buildCoreContext(targetChar, userProfile, true);
            const msgs = await DB.getMessagesByCharId(targetChar.id);

            const lastMsg = msgs[msgs.length - 1];
            const timeGap = getTimeGapHint(lastMsg?.timestamp);

            const recentMsgs = msgs.slice(-50).map(m => {
                const roleName = m.role === 'user' ? userProfile.name : targetChar.name;
                const content = m.type === 'text' ? m.content : `[${m.type}]`;
                return `${roleName}: ${content}`;
            }).join('\n');

            let promptInstruction = "";
            let logPrefix = "";

            if (customPrompt) {
                const layoutHint: Record<LayoutId, string> = {
                    generic: `这是一个【通用信息流】App。格式JSON数组: [{ "title": "标题/项目名", "detail": "详细内容", "value": "可选的数值/状态(如 +100)" }, ...]`,
                    shop: `这是一个【购物】App，请生成商品/订单。title=商品名, detail=规格或物流状态, value=价格(如 ¥129.00)。格式JSON数组: [{ "title": "...", "detail": "...", "value": "¥..." }, ...]`,
                    feed: `这是一个【社交动态】App（类似朋友圈/微博）。title=发布时间或心情, detail=动态正文。格式JSON数组: [{ "title": "...", "detail": "..." }, ...]`,
                    forum: `这是一个【论坛/贴吧】App。title=帖子标题, detail=帖子正文, value=所在板块(如 #日常)。格式JSON数组: [{ "title": "...", "detail": "...", "value": "#..." }, ...]`,
                    novel: `这是一个【小说阅读】App。title=章节标题, detail=该章正文片段(150字左右), value=字数(如 1.2万字)。格式JSON数组: [{ "title": "第N章 ...", "detail": "...", "value": "..." }, ...]`,
                };
                promptInstruction = `用户正在查看你的手机 App: "${type}"。
该 App 的功能/用户想看的内容是: "${customPrompt}"。
请生成 2-4 条符合该 App 功能的记录，必须符合你的人设。
${layoutHint[layout || 'generic']}`;
                const customApp = customApps.find(a => a.id === type);
                logPrefix = customApp ? customApp.name : type;
            } else {
                if (type === 'chat') {
                    promptInstruction = `生成 3 个该角色手机聊天软件(Message/Line)中的**对话片段**。
    要求：
    1. **自动匹配角色**: 根据人设，虚构 3 个合理的联系人（如：如果是学生，联系人可以是“辅导员”、“社团学长”；如果是杀手，联系人可以是“中间人”）。不要使用“User”作为联系人。
    2. **对话感**: 内容必须是有来有回的对话脚本（3-4句），体现他们之间的关系。
    3. **格式**: 必须严格使用 "我:..." 代表主角(你)，"对方:..." 或 "人名:..." 代表联系人。
    格式JSON数组: [{ "title": "联系人名称 (身份)", "detail": "对方: 最近怎么样？\\n我: 还活着。\\n对方: 那就好。" }, ...]`;
                    logPrefix = "聊天软件";
                } else if (type === 'call') {
                    promptInstruction = `生成 3 条该角色的近期**通话记录**。
    格式JSON数组: [{ "title": "联系人名称", "value": "呼入 (5分钟) / 未接 / 呼出 (30秒)", "detail": "关于下周聚会的事..." }, ...]`;
                    logPrefix = "通话记录";
                } else if (type === 'order') {
                    promptInstruction = `生成 3 条该角色最近的购物订单。注意 value 字段请填写商品价格(如 ¥129.00)。
    格式JSON数组: [{ "title": "商品名", "detail": "规格/状态/物流", "value": "¥129.00" }, ...]`;
                    logPrefix = "购物APP";
                } else if (type === 'delivery') {
                    promptInstruction = `生成 3 条该角色最近的外卖记录。value 字段请填写实付金额(如 ¥38.50)。
    格式JSON数组: [{ "title": "店名", "detail": "菜品明细", "value": "¥38.50" }, ...]`;
                    logPrefix = "外卖APP";
                } else if (type === 'social') {
                    promptInstruction = `生成 2 条该角色的朋友圈/社交媒体动态。
    格式JSON数组: [{ "title": "时间/状态", "detail": "正文内容" }, ...]`;
                    logPrefix = "朋友圈";
                }
            }

            const fullPrompt = `${context}\n\n### [Current Status]\n时间距离上次互动: ${timeGap}\n\n### [Recent Chat Context]\n${recentMsgs}\n\n### [Task]\n${promptInstruction}\n请根据[Current Status]和人设调整生成内容的时间戳和情绪。如果很久没聊天，记录可能是近期的独处状态；如果刚聊过，记录可能与聊天内容相关。`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: "user", content: fullPrompt }],
                    temperature: 0.8
                })
            });

            if (!response.ok) throw new Error('API Error');
            const data = await safeResponseJson(response);
            let content = data.choices[0].message.content;
            content = content.replace(/```json/g, '').replace(/```/g, '').trim();
            const firstBracket = content.indexOf('[');
            const lastBracket = content.lastIndexOf(']');
            if (firstBracket > -1 && lastBracket > -1) content = content.substring(firstBracket, lastBracket + 1);

            let json = [];
            try { json = JSON.parse(content); } catch (e) { json = []; }

            const newRecordsToAdd: PhoneEvidence[] = [];

            // 是否把查手机内容同步到私聊（默认开），关闭则只存本地、不进聊天/上下文
            const pushToChat = targetChar.phoneState?.sendToChat !== false;

            if (Array.isArray(json)) {
                for (const item of json) {
                    const recordTitle = item.title || 'Unknown';
                    const recordDetail = item.detail || '...';

                    let savedMsgId: number | undefined;
                    if (pushToChat) {
                        // 包装成上下文可读的漂亮卡片（phone_card），不再是古早的 [系统:...] 纯文本
                        const cardContent = type === 'chat'
                            ? `[在 TA 手机的聊天软件里看到与「${recordTitle}」的对话] ${recordDetail.replace(/\n/g, ' ')}`
                            : `[在 TA 手机的${logPrefix}里看到] ${recordTitle}${item.value ? ` · ${item.value}` : ''} — ${recordDetail}`;
                        await DB.saveMessage({
                            charId: targetChar.id,
                            role: 'assistant',
                            type: 'phone_card',
                            content: cardContent,
                            metadata: { phoneCard: { app: logPrefix, kind: type, title: recordTitle, detail: recordDetail, value: item.value } },
                        } as any);
                        const currentMsgs = await DB.getMessagesByCharId(targetChar.id);
                        savedMsgId = currentMsgs[currentMsgs.length - 1]?.id;
                    }

                    newRecordsToAdd.push({
                        id: `rec-${Date.now()}-${Math.random()}`,
                        type: type,
                        title: recordTitle,
                        detail: recordDetail,
                        value: item.value,
                        timestamp: Date.now(),
                        systemMessageId: savedMsgId
                    });

                    await new Promise(r => setTimeout(r, 50));
                }
            }

            const existingRecords = targetChar.phoneState?.records || [];
            updateCharacter(targetChar.id, {
                phoneState: { ...targetChar.phoneState, records: [...existingRecords, ...newRecordsToAdd] }
            });

            addToast(`已刷新 ${newRecordsToAdd.length} 条数据`, 'success');

        } catch (e: any) {
            console.error(e);
            addToast('解析失败，请重试', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // --- Continue Chat Logic ---
    const handleContinueChat = async () => {
        if (!selectedChatRecord || !targetChar || !apiConfig.apiKey) return;
        setIsLoading(true);

        try {
            await injectMemoryPalace(targetChar);
            const context = ContextBuilder.buildCoreContext(targetChar, userProfile, true);
            const prompt = `${context}

### [Task: Continue Conversation]
Roleplay: You are "${targetChar.name}". You are chatting on your phone with "${selectedChatRecord.title}".
Current History:
"""
${selectedChatRecord.detail}
"""

Task: Please continue this conversation for 3-5 more turns.
Style: Casual, IM style.
Format:
- Use "我: ..." for yourself (${targetChar.name}).
- Use "对方: ..." for the contact (${selectedChatRecord.title}).
- Only output the new dialogue lines. Do NOT repeat history.
`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.85
                })
            });

            if (response.ok) {
                const data = await safeResponseJson(response);
                let newLines = data.choices[0].message.content.trim();
                newLines = newLines.replace(/```/g, '');

                const updatedDetail = `${selectedChatRecord.detail}\n${newLines}`;
                const updatedRecord = { ...selectedChatRecord, detail: updatedDetail };
                setSelectedChatRecord(updatedRecord);

                const allRecords = targetChar.phoneState?.records || [];
                const updatedRecords = allRecords.map(r => r.id === updatedRecord.id ? updatedRecord : r);
                updateCharacter(targetChar.id, {
                    phoneState: { ...targetChar.phoneState, records: updatedRecords }
                });
            }

        } catch (e) {
            console.error(e);
            addToast('续写失败', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // ----- 人格模拟：后台生成（生成期间用户可离开本 App 去别处逛） -----
    const runSim = async (m: 'daily' | 'event', t: string, presence: 'default' | 'light' | 'none' = 'default') => {
        if (!targetChar) return;
        if (!apiConfig.apiKey) { addToast('请先配置 API', 'error'); return; }
        const cid = targetChar.id, cname = targetChar.name;
        personaSimStore.set({ status: 'loading', mode: m, theme: t, charId: cid, charName: cname });
        try {
            const generated = await generatePersonaScript({
                char: targetChar, userProfile, apiConfig: apiConfig as any, mode: m, theme: t, userPresence: presence,
            });
            personaSimStore.set({ status: 'ready', mode: m, theme: t, script: generated, charId: cid, charName: cname });
            addToast('演出已就绪', 'success');
        } catch (e) {
            console.error(e);
            personaSimStore.set({ status: 'error', mode: m, theme: t, charId: cid, charName: cname });
            addToast('演出生成失败，请重试', 'error');
        }
    };

    // 全局指示条点击后请求深链：直接进入对应角色的演出
    useEffect(() => {
        if (sim.deepLink && sim.charId) {
            const c = characters.find(x => x.id === sim.charId);
            if (c) {
                setTargetChar(c);
                setView('phone');
                setActiveAppId('persona');
            }
            personaSimStore.clearDeepLink();
        }
    }, [sim.deepLink, sim.charId, characters]);

    // ============================================================
    //  DERIVED STATS  (drive the "living" home screen)
    // ============================================================
    const charName = targetChar?.name || 'Unknown Device';
    const allSorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
    const chatRecords = records.filter(r => r.type === 'chat');
    const orderRecords = records.filter(r => r.type === 'order');
    const deliveryRecords = records.filter(r => r.type === 'delivery');
    const socialRecords = records.filter(r => r.type === 'social');
    const simLogCount = targetChar?.phoneState?.simLogs?.length || 0;
    const sendToChat = targetChar?.phoneState?.sendToChat !== false; // 默认开
    const lastInner = targetChar ? getLastInnerState(targetChar.id) : '';
    const lastTs = allSorted[0]?.timestamp;

    const appLabel = (type: string): string => {
        switch (type) {
            case 'chat': return '聊天';
            case 'order': return '淘宝';
            case 'delivery': return '外卖';
            case 'social': return '朋友圈';
            case 'call': return '通话';
            default: return customApps.find(a => a.id === type)?.name || 'App';
        }
    };

    const fmtClock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const lastSeenText = (() => {
        if (!lastTs) return 'Awaiting first sync';
        const d = Date.now() - lastTs;
        const days = Math.floor(d / 86400000);
        const hrs = Math.floor(d / 3600000);
        const mins = Math.floor(d / 60000);
        if (days > 0) return `Last seen ${days}d ago`;
        if (hrs > 0) return `Last seen ${hrs}h ago`;
        if (mins > 0) return `Last seen ${mins}m ago`;
        return 'Online now';
    })();

    const foodSub = deliveryRecords.length
        ? (() => {
            const t = Math.max(...deliveryRecords.map(r => r.timestamp));
            const days = Math.floor((Date.now() - t) / 86400000);
            return days <= 0 ? 'ordered today' : `last order ${days}d ago`;
        })()
        : 'no orders yet';

    const momentsSub = socialRecords.length ? `${socialRecords.length} new posts` : 'nothing shared';
    const taobaoSub = orderRecords.length ? `${orderRecords.length} items in cart` : 'cart is empty';
    // 未读 = 上次打开 Messages 之后才生成的聊天记录；打开即清零，不再一直挂红点
    const chatReadAt = targetChar?.phoneState?.chatReadAt || 0;
    const unreadChats = chatRecords.filter(r => r.timestamp > chatReadAt).length;
    const messageSub = chatRecords.length === 0 ? 'no messages' : unreadChats ? `${unreadChats} unread messages` : 'all caught up';

    // pseudo screen-time + weather (decorative, deterministic per char)
    const seed = charName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const temp = 16 + (seed % 14);
    const screenMin = 64 + records.length * 11 + (seed % 40);
    const stH = Math.floor(screenMin / 60);
    const stM = screenMin % 60;
    const ringP = Math.min(0.94, screenMin / 360);
    const RING_C = 2 * Math.PI * 42;

    const activity = (() => {
        const items = allSorted.slice(0, 4).reverse().map(r => ({ t: r.timestamp, label: `打开${appLabel(r.type)}` }));
        if (lastTs) items.push({ t: Date.now(), label: '锁屏' });
        return items;
    })();

    const now = new Date();
    const clockNow = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateNow = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const fallbackQuote = targetChar?.socialProfile?.bio || '“有些话，隔着屏幕，反而更接近真实。”';
    const innerQuote = lastInner.trim();

    // ============================================================
    //  SUB-APPS
    // ============================================================
    const renderChatList = () => {
        const accent = '#8b9cff';
        const list = records.filter(r => r.type === 'chat').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Messages" sub={`${list.length} threads`} accent={accent} onBack={() => setActiveAppId('home')} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 space-y-2.5 no-scrollbar pb-28 overscroll-contain">
                    {list.length === 0 && <EmptyState text="暂无聊天记录" />}
                    {list.map(r => {
                        const last = r.detail.split('\n').pop() || '...';
                        return (
                            <div key={r.id} onClick={() => { setSelectedChatRecord(r); setActiveAppId('chat_detail'); }}
                                className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] active:scale-[0.99] transition cursor-pointer animate-fade-in">
                                <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold text-lg"
                                    style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)`, boxShadow: `inset 0 0 18px ${accent}25` }}>
                                    {r.title[0]}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-baseline gap-2">
                                        <span className="font-semibold text-[13.5px] text-white/95 truncate">{r.title}</span>
                                        <span className="text-[10px] text-white/35 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                    </div>
                                    <div className="text-[11.5px] text-white/45 truncate mt-0.5">{last.replace(/^(我|对方|Me|Them)[:：]\s*/, '')}</div>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); handleDeleteRecord(r); }}
                                    className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </div>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerate('chat')} label="刷新消息" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderChatDetail = () => {
        if (!selectedChatRecord || !targetChar) return null;
        const accent = '#8b9cff';
        const lines = selectedChatRecord.detail.split('\n').filter(l => l.trim());
        const parsedLines = lines.map(line => {
            const isMe = line.startsWith('我') || line.startsWith('Me');
            const content = line.replace(/^(我|Me|对方|Them|[\w一-龥]+)[:：]\s*/, '');
            return { isMe, content };
        });

        return (
            <SubAppShell>
                <TermHeader title={selectedChatRecord.title} accent={accent} onBack={() => setActiveAppId('chat')} />
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {parsedLines.map((msg, idx) => (
                        <div key={idx} className={`flex items-end gap-2 ${msg.isMe ? 'justify-end' : 'justify-start'}`}>
                            {!msg.isMe && (
                                <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs text-white shrink-0"
                                    style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>
                                    {selectedChatRecord.title[0]}
                                </div>
                            )}
                            <div className={`px-3.5 py-2.5 rounded-2xl max-w-[74%] text-[13px] leading-relaxed break-words ${
                                msg.isMe
                                    ? 'text-white rounded-br-md'
                                    : 'bg-white/[0.07] text-white/90 border border-white/[0.06] rounded-bl-md'
                                }`}
                                style={msg.isMe ? { background: `linear-gradient(135deg, ${accent}, ${accent}bb)` } : undefined}>
                                {msg.content}
                            </div>
                            {msg.isMe && <img src={targetChar.avatar} className="w-8 h-8 rounded-xl object-cover shrink-0" />}
                        </div>
                    ))}
                    {isLoading && (
                        <div className="flex justify-center py-4">
                            <div className="flex gap-1.5">
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.2s' }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.4s' }} />
                            </div>
                        </div>
                    )}
                    <div ref={chatEndRef} />
                </div>
                <div className="shrink-0 w-full p-4 pb-6">
                    <button onClick={handleContinueChat} disabled={isLoading}
                        className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                        {isLoading ? '对方正在输入…' : '偷看后续 / 拱火 🔥'}
                    </button>
                </div>
            </SubAppShell>
        );
    };

    const renderCallList = () => {
        const accent = '#4ade80';
        const list = records.filter(r => r.type === 'call').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Recents" sub="call log" accent={accent} onBack={() => setActiveAppId('home')} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-2">
                    {list.length === 0 && <EmptyState text="暂无通话记录" />}
                    {list.map(r => {
                        const isMissed = r.value?.includes('未接') || r.value?.includes('Missed');
                        const isOutgoing = r.value?.includes('呼出') || r.value?.includes('Outgoing');
                        const c = isMissed ? '#fb7185' : accent;
                        return (
                            <div key={r.id} className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] animate-fade-in">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `${c}1f`, color: c }}>
                                    <Phone size={19} weight="fill" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="font-semibold text-[13.5px] truncate" style={{ color: isMissed ? '#fb7185' : 'rgba(255,255,255,0.95)' }}>{r.title}</div>
                                    <div className="text-[10.5px] text-white/40 flex items-center gap-1.5 mt-0.5">
                                        <span>{isMissed ? '未接来电' : (isOutgoing ? '呼出' : '呼入')}</span>
                                        {r.value && !isMissed && <span>· {r.value.replace(/.*?\((.*?)\).*/, '$1')}</span>}
                                    </div>
                                    {r.detail && <div className="text-[10.5px] text-white/30 mt-1 italic truncate">“{r.detail}”</div>}
                                </div>
                                <span className="text-[10px] text-white/30 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                <button onClick={() => handleDeleteRecord(r)} className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </div>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerate('call')} label="刷新通话" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderShop = () => {
        const accent = '#ff7a45';
        const list = records.filter(r => r.type === 'order').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="淘宝" sub="my orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ShoppingBag size={20} weight="fill" style={{ color: accent }} />} />
                {/* banner */}
                <div className="px-4 pb-2 shrink-0">
                    <div className="rounded-2xl p-3.5 flex items-center gap-3 border border-white/[0.06] overflow-hidden relative"
                        style={{ background: `linear-gradient(120deg, ${accent}26, ${accent}08)` }}>
                        <Storefront size={26} weight="fill" style={{ color: accent }} />
                        <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-white">{charName} 的购物车</div>
                            <div className="text-[10.5px] text-white/50">{list.length} 件商品 · 待付款 / 待收货</div>
                        </div>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="还没有订单" />}
                    {list.map(r => (
                        <div key={r.id} className="group relative flex gap-3 rounded-2xl p-3 bg-white/[0.035] border border-white/[0.06] animate-slide-up">
                            <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center"
                                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                <Package size={26} weight="light" style={{ color: accent }} />
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col">
                                <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                                <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                                <div className="mt-auto flex items-center justify-between pt-1.5">
                                    <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '¥ --'}</span>
                                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider">已下单</span>
                                </div>
                            </div>
                            <button onClick={() => handleDeleteRecord(r)} className="absolute top-1.5 right-1.5 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('order')} label="刷新订单" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderFood = () => {
        const accent = '#fbbf24';
        const list = records.filter(r => r.type === 'delivery').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="外卖" sub="recent orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<Hamburger size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="还没有外卖记录" />}
                    {list.map(r => (
                        <div key={r.id} className="group relative rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] animate-slide-up">
                            <div className="flex items-center gap-3">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                    <Storefront size={20} weight="fill" style={{ color: accent }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13.5px] font-semibold text-white/95 truncate">{r.title}</div>
                                    <div className="text-[10px] text-white/35 mt-0.5">{fmtClock(r.timestamp)} · 已送达</div>
                                </div>
                                {r.value && <span className="text-[14px] font-bold shrink-0" style={{ color: accent }}>{r.value}</span>}
                            </div>
                            <div className="text-[11.5px] text-white/50 mt-2.5 leading-relaxed pl-1 border-l-2" style={{ borderColor: `${accent}55` }}>
                                <span className="pl-2">{r.detail}</span>
                            </div>
                            <button onClick={() => handleDeleteRecord(r)} className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('delivery')} label="刷新外卖" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderMoments = () => {
        const accent = '#c084fc';
        const list = records.filter(r => r.type === 'social').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Moments" sub="朋友圈" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ImagesSquare size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="还没有动态" />}
                    {list.map(r => (
                        <div key={r.id} className="group relative rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up">
                            <div className="flex items-center gap-3 mb-2.5">
                                {targetChar?.avatar
                                    ? <img src={targetChar.avatar} className="w-9 h-9 rounded-full object-cover" />
                                    : <div className="w-9 h-9 rounded-full" style={{ background: accent }} />}
                                <div className="min-w-0">
                                    <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                    <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                                </div>
                            </div>
                            <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                            <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                                <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                                <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                            </div>
                            <button onClick={() => handleDeleteRecord(r)} className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('social')} label="刷新动态" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderCustomItem = (r: PhoneEvidence, idx: number, total: number, accent: string, layout: LayoutId, app: PhoneCustomApp) => {
        switch (layout) {
            case 'shop':
                return (
                    <div key={r.id} className="group relative flex gap-3 rounded-2xl p-3 bg-white/[0.035] border border-white/[0.06] animate-slide-up">
                        <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl" style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>{app.icon}</div>
                        <div className="flex-1 min-w-0 flex flex-col">
                            <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                            <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                            <div className="mt-auto flex items-center justify-between pt-1.5">
                                <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '¥ --'}</span>
                                <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider">已下单</span>
                            </div>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'feed':
                return (
                    <div key={r.id} className="group relative rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up">
                        <div className="flex items-center gap-3 mb-2.5">
                            <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ background: `linear-gradient(135deg, ${accent}55, ${accent}15)` }}>{app.icon}</div>
                            <div className="min-w-0">
                                <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                            </div>
                        </div>
                        <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                            <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                            <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'forum':
                return (
                    <div key={r.id} className="group relative rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up">
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                            <span className="text-[14px] font-semibold text-white/95 leading-snug line-clamp-2 flex-1">{r.title}</span>
                            {r.value && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed line-clamp-3 whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-3 mt-2.5 text-[10px] text-white/35">
                            <span className="flex items-center gap-1">{app.icon} {charName}</span>
                            <span>· {1 + (r.id.length % 200)} 回复</span>
                            <span>· {fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'novel':
                return (
                    <div key={r.id} className="group relative rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up" style={{ boxShadow: `inset 0 0 30px ${accent}10` }}>
                        <div className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: accent }}>Chapter {total - idx}</div>
                        <div className="text-[15px] font-semibold text-white/95 mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.title}</div>
                        <div className="text-[12.5px] text-white/60 leading-loose line-clamp-4 whitespace-pre-wrap" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.detail}</div>
                        <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/[0.06] text-[10px] text-white/30">
                            <span>{r.value || '连载中'}</span>
                            <span className="tabular-nums">{fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            default:
                return (
                    <div key={r.id} className="group relative rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up" style={{ boxShadow: `inset 0 0 24px ${accent}14` }}>
                        <div className="flex justify-between items-start gap-2 mb-1.5">
                            <span className="text-[13.5px] font-semibold text-white/95 line-clamp-1">{r.title}</span>
                            {r.value && <span className="text-[12px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="text-[9.5px] text-white/25 mt-2 text-right tabular-nums">{fmtClock(r.timestamp)}</div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
        }
    };

    const renderCustomApp = (app: PhoneCustomApp) => {
        const accent = app.color || '#8b9cff';
        const layout = app.layout || 'generic';
        const layoutMeta = APP_LAYOUTS.find(l => l.id === layout);
        const list = records.filter(r => r.type === app.id).sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title={app.name} sub={layoutMeta?.name || 'custom app'} accent={accent} onBack={() => setActiveAppId('home')}
                    right={<span className="text-lg">{app.icon}</span>} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="暂无数据" />}
                    {list.map((r, idx) => renderCustomItem(r, idx, list.length, accent, layout, app))}
                </div>
                <RefreshFab onClick={() => handleGenerate(app.id, app.prompt, layout)} label="刷新数据" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    // ============================================================
    //  HOME DESKTOP (mirrors the reference design)
    // ============================================================
    const renderHomePage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-2 pb-32">
            {/* Header */}
            <div className="flex items-start justify-between mb-5">
                <div className="min-w-0">
                    <h1 className="text-[34px] leading-none text-white font-light tracking-wide truncate" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{charName}</h1>
                    <p className="text-[11px] tracking-[0.35em] uppercase text-white/40 mt-2">The Space Between</p>
                    <div className="h-px w-28 bg-gradient-to-r from-white/30 to-transparent mt-3" />
                </div>
                <div className="flex flex-col items-end shrink-0 pt-1 text-white/70">
                    <Cloud size={26} weight="light" />
                    <span className="text-[15px] font-light mt-1 tabular-nums">{temp}°C</span>
                </div>
            </div>

            {/* Time */}
            <div className="mb-4">
                <div className="text-[30px] font-extralight text-white tracking-[0.08em] tabular-nums">{clockNow}</div>
                <div className="text-[12px] text-white/45 mt-0.5">{dateNow}</div>
            </div>

            {/* Quote：有最近的内心独白(InnerState)就显示它（一行截断，点按看全文），否则兜底诗句 */}
            {innerQuote ? (
                <button onClick={() => setShowInner(true)} className="block w-full text-left mb-5 group">
                    <p className="text-[13px] text-white/65 italic leading-relaxed line-clamp-1">「{innerQuote}」</p>
                    <span className="text-[9px] tracking-wider text-white/30 group-active:text-white/55">有些话没说出口 · 轻触</span>
                </button>
            ) : (
                <p className="text-[13px] text-white/55 italic mb-5 leading-relaxed">{fallbackQuote}</p>
            )}

            {/* Persona simulation hero */}
            <button onClick={() => setActiveAppId('persona')}
                className="relative w-full rounded-[24px] p-5 mb-3.5 text-left overflow-hidden border border-white/[0.09] active:scale-[0.98] transition-transform"
                style={{ background: 'linear-gradient(115deg, rgba(184,155,255,0.22), rgba(120,90,214,0.08) 55%, rgba(20,18,30,0.4))' }}>
                <div className="absolute -top-10 -right-6 w-40 h-40 rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(184,155,255,0.55), transparent 70%)' }} />
                <div className="relative z-10">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/55">Persona Simulation</div>
                    <div className="text-[18px] font-light text-white mt-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>成为 TA 的一段人生</div>
                    <div className="text-[11px] text-white/55 mt-1.5">不是查看 TA 的手机 · 是用 TA 的手机活一次</div>
                    <div className="flex items-center justify-between mt-4">
                        <span className="text-[11px] text-white/45 flex items-center gap-1.5">
                            <ClockCounterClockwise size={13} /> 生活记录 · {simLogCount}
                        </span>
                        <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: '#c9b6ff' }}>进入演出 <CaretRight size={11} weight="bold" /></span>
                    </div>
                </div>
            </button>

            {/* App cards */}
            <div className="grid grid-cols-2 gap-3.5 mb-3.5">
                <HomeCard icon={<ChatCircleDots size={24} weight="light" />} label="Message" sub={messageSub} accent="#8b9cff"
                    badge={unreadChats || undefined} onClick={openChat} />
                <HomeCard icon={<ImagesSquare size={24} weight="light" />} label="Moments" sub={momentsSub} accent="#c084fc"
                    onClick={() => setActiveAppId('social')} />
                <HomeCard icon={<Hamburger size={24} weight="light" />} label="Food" sub={foodSub} accent="#fbbf24"
                    onClick={() => setActiveAppId('waimai')} />
                <HomeCard icon={<ShoppingBag size={24} weight="light" />} label="Taobao" sub={taobaoSub} accent="#ff7a45"
                    onClick={() => setActiveAppId('taobao')} />
            </div>

            {/* Add app + my apps row */}
            <div className="grid grid-cols-2 gap-3.5 mb-7">
                <button onClick={() => setShowCreateModal(true)}
                    className={`${customApps.length ? '' : 'col-span-2'} rounded-[20px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]`}>
                    <Plus size={22} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">Add App</span>
                </button>
                {customApps.length > 0 && (
                    <button onClick={() => setPage(1)}
                        className="rounded-[20px] p-4 border border-white/[0.07] bg-white/[0.03] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]">
                        <DotsThree size={26} weight="bold" className="text-white/60" />
                        <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">My Apps · {customApps.length}</span>
                    </button>
                )}
            </div>

            {/* Today's activity */}
            <div className="rounded-[22px] p-4 border border-white/[0.07] bg-white/[0.025] backdrop-blur-xl mb-6">
                <div className="flex items-center justify-between mb-3.5">
                    <span className="text-[10px] tracking-[0.25em] uppercase text-white/45">Today's Activity</span>
                    <span className="text-[10px] text-white/35 flex items-center gap-0.5">More <CaretRight size={10} weight="bold" /></span>
                </div>
                <div className="flex gap-4">
                    <div className="flex-1 min-w-0 space-y-2.5">
                        {activity.length === 0 && <div className="text-[11px] text-white/30">尚无活动记录</div>}
                        {activity.map((a, i) => (
                            <div key={i} className="flex items-center gap-3">
                                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i === activity.length - 1 ? '#c084fc' : 'rgba(255,255,255,0.3)' }} />
                                <span className="text-[11px] text-white/45 tabular-nums w-[58px] shrink-0">{fmtClock(a.t)}</span>
                                <span className="text-[12px] text-white/75 truncate">{a.label}</span>
                            </div>
                        ))}
                    </div>
                    <div className="relative w-24 h-24 shrink-0 flex items-center justify-center">
                        <svg viewBox="0 0 100 100" className="w-24 h-24 -rotate-90">
                            <circle cx="50" cy="50" r="42" stroke="rgba(255,255,255,0.08)" strokeWidth="3" fill="none" />
                            <circle cx="50" cy="50" r="42" stroke="url(#stRing)" strokeWidth="3" fill="none" strokeLinecap="round"
                                strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - ringP)} />
                            <defs>
                                <linearGradient id="stRing" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stopColor="#c084fc" />
                                    <stop offset="100%" stopColor="#8b9cff" />
                                </linearGradient>
                            </defs>
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-[8px] tracking-[0.15em] uppercase text-white/40">Screen</span>
                            <span className="text-[14px] font-light text-white tabular-nums">{stH}h {stM}m</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Last seen */}
            <div className="flex items-center justify-center gap-1.5 text-white/35">
                <LockSimple size={12} weight="fill" />
                <span className="text-[11px] tracking-wide">{lastSeenText}</span>
            </div>
        </div>
    );

    const renderAppsPage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-4 pb-32">
            <div className="flex items-center justify-between mb-6">
                <button onClick={() => setPage(0)} className="flex items-center gap-1 text-white/50 text-[12px]">
                    <CaretLeft size={14} weight="bold" /> Home
                </button>
                <span className="text-[11px] tracking-[0.3em] uppercase text-white/45">Installed Apps</span>
                <div className="w-12" />
            </div>
            <div className="grid grid-cols-2 gap-3.5">
                {customApps.map(app => {
                    const accent = app.color || '#8b9cff';
                    const count = records.filter(r => r.type === app.id).length;
                    return (
                        <div key={app.id} className="relative group">
                            <button onClick={() => setActiveAppId(app.id)}
                                className="w-full rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition min-h-[130px] flex flex-col justify-between">
                                <div className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl opacity-50 pointer-events-none"
                                    style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
                                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl border border-white/[0.08] relative z-10"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, boxShadow: `inset 0 0 16px ${accent}22` }}>
                                    {app.icon}
                                </div>
                                <div className="relative z-10">
                                    <div className="text-[14px] font-semibold text-white truncate">{app.name}</div>
                                    <div className="text-[10.5px] text-white/40 mt-0.5">{count} 条记录</div>
                                    <div className="h-[3px] w-8 rounded-full mt-2" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
                                </div>
                            </button>
                            <button onClick={() => handleDeleteApp(app.id)}
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-rose-500 text-white rounded-full flex items-center justify-center text-[12px] leading-none opacity-0 group-hover:opacity-100 transition z-20 shadow-md">×</button>
                        </div>
                    );
                })}
                <button onClick={() => setShowCreateModal(true)}
                    className="rounded-[24px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[130px]">
                    <Plus size={24} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.2em] uppercase text-white/50">Add App</span>
                </button>
            </div>
        </div>
    );

    const renderDesktop = () => {
        const hasBg = !!targetChar?.dateBackground;
        const totalPages = customApps.length > 0 ? 2 : 1;

        const onTouchStart = (e: React.TouchEvent) => {
            touchStartX.current = e.touches[0].clientX;
            touchStartY.current = e.touches[0].clientY;
        };
        const onTouchEnd = (e: React.TouchEvent) => {
            if (touchStartX.current == null || touchStartY.current == null) return;
            const dx = e.changedTouches[0].clientX - touchStartX.current;
            const dy = e.changedTouches[0].clientY - touchStartY.current;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (dx < 0 && page < totalPages - 1) setPage(page + 1);
                if (dx > 0 && page > 0) setPage(page - 1);
            }
            touchStartX.current = null;
            touchStartY.current = null;
        };

        return (
            <div className="absolute inset-0 flex flex-col z-0 overflow-hidden bg-[#070809]">
                {/* Cinematic background */}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'radial-gradient(120% 80% at 50% 0%, #1a1d2b 0%, #0a0c12 55%, #060709 100%)' }} />
                {hasBg && (
                    <div className="absolute inset-0 opacity-25 pointer-events-none"
                        style={{ backgroundImage: `url(${targetChar!.dateBackground})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                )}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'linear-gradient(to bottom, rgba(7,8,9,0.35) 0%, rgba(7,8,9,0.1) 30%, rgba(7,8,9,0.85) 100%)' }} />
                <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/15 to-transparent pointer-events-none z-20" />

                <StatusStrip />

                {/* Pager */}
                <div className="flex-1 relative z-10 overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                    <div className="flex h-full w-[200%] transition-transform duration-500 ease-out"
                        style={{ transform: `translateX(-${page * 50}%)` }}>
                        {renderHomePage()}
                        {renderAppsPage()}
                    </div>
                </div>

                {/* Page dots */}
                {totalPages > 1 && (
                    <div className="absolute bottom-[88px] left-1/2 -translate-x-1/2 flex gap-2 z-40">
                        {Array.from({ length: totalPages }).map((_, i) => (
                            <button key={i} onClick={() => setPage(i)}
                                className="rounded-full transition-all"
                                style={{ width: page === i ? 18 : 6, height: 6, background: page === i ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)' }} />
                        ))}
                    </div>
                )}

                {/* Floating glass nav */}
                <nav className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] z-40">
                    <div className="bg-white/[0.06] backdrop-blur-2xl rounded-[26px] border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)] flex justify-around items-center px-3 py-2.5">
                        <button onClick={() => setActiveAppId('call')} className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Phone size={22} weight="light" />
                        </button>
                        <button onClick={openChat} className="relative flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <ChatCircleDots size={22} weight="light" />
                            {unreadChats > 0 && <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center">{unreadChats}</span>}
                        </button>
                        <button onClick={handleExitPhone} aria-label="断开连接"
                            className="relative flex items-center justify-center w-14 h-14 rounded-full active:scale-90 transition -my-1"
                            style={{ background: 'radial-gradient(circle at 35% 30%, #b89bff, #6d5bd6 55%, #2a2150 100%)', boxShadow: '0 0 24px rgba(157,124,255,0.55), inset 0 0 18px rgba(255,255,255,0.25)' }}>
                            <SignOut size={22} weight="bold" className="text-white" />
                        </button>
                        <button onClick={() => setActiveAppId('social')} className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Compass size={22} weight="light" />
                        </button>
                        <button onClick={toggleSendToChat} aria-label="同步到私聊"
                            className="relative flex items-center justify-center p-2.5 hover:text-white rounded-2xl transition active:scale-90"
                            style={{ color: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.4)' }}>
                            <GearSix size={22} weight={sendToChat ? 'fill' : 'light'} />
                            <span className="absolute bottom-1 right-1.5 w-1.5 h-1.5 rounded-full"
                                style={{ background: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.25)', boxShadow: sendToChat ? '0 0 6px #7dd3fc' : 'none' }} />
                        </button>
                    </div>
                </nav>
            </div>
        );
    };

    // ============================================================
    //  TARGET-SELECT SCREEN
    // ============================================================
    if (view === 'select') {
        return (
            <div className="absolute inset-0 flex flex-col overflow-hidden text-white"
                style={{ background: 'radial-gradient(120% 80% at 50% 0%, #161826 0%, #0a0b10 60%)' }}>
                <StatusStrip />
                <div className="h-14 flex items-center justify-between px-4 shrink-0">
                    <button onClick={closeApp} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                        <CaretLeft size={18} weight="bold" />
                    </button>
                    <span className="font-semibold tracking-[0.25em] uppercase text-[13px] text-white/80">Target Device</span>
                    <div className="w-9" />
                </div>
                <div className="flex-1 min-h-0 px-5 grid grid-cols-2 gap-4 overflow-y-auto pb-20 no-scrollbar overscroll-contain content-start pt-2">
                    {characters.map(c => (
                        <div key={c.id} onClick={() => handleSelectChar(c)}
                            className="aspect-[3/4] rounded-3xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-xl p-4 flex flex-col items-center justify-center gap-4 cursor-pointer active:scale-95 transition group hover:border-violet-400/50 hover:shadow-[0_0_24px_rgba(157,124,255,0.25)] relative overflow-hidden">
                            <div className="absolute -top-10 -right-10 w-28 h-28 rounded-full blur-3xl bg-violet-500/0 group-hover:bg-violet-500/20 transition" />
                            <div className="w-20 h-20 rounded-full p-[2px] border-2 border-white/15 group-hover:border-violet-400/70 transition-colors relative z-10">
                                <img src={c.avatar} className="w-full h-full rounded-full object-cover grayscale group-hover:grayscale-0 transition-all" />
                            </div>
                            <div className="text-center relative z-10">
                                <div className="font-semibold text-white/90 text-sm group-hover:text-violet-300">{c.name}</div>
                                <div className="text-[10px] text-white/35 font-mono mt-1 tracking-widest">CONNECT &gt;</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // ============================================================
    //  PHONE VIEW
    // ============================================================
    const customActive = customApps.find(a => a.id === activeAppId);
    return (
        <div className="absolute inset-0 bg-[#070809] overflow-hidden font-sans overscroll-none">
            {activeAppId === 'home' ? renderDesktop() : (
                <>
                    {activeAppId === 'chat' && renderChatList()}
                    {activeAppId === 'chat_detail' && renderChatDetail()}
                    {activeAppId === 'call' && renderCallList()}
                    {activeAppId === 'taobao' && renderShop()}
                    {activeAppId === 'waimai' && renderFood()}
                    {activeAppId === 'social' && renderMoments()}
                    {activeAppId === 'persona' && targetChar && (
                        <PersonaSim targetChar={targetChar} onExit={() => setActiveAppId('home')} openLifeLog={() => setActiveAppId('lifelog')}
                            sim={sim} onStart={runSim} onConsumed={() => personaSimStore.reset()} />
                    )}
                    {activeAppId === 'lifelog' && targetChar && (
                        <LifeLog targetChar={targetChar} onBack={() => setActiveAppId('home')} />
                    )}
                    {customActive && renderCustomApp(customActive)}
                </>
            )}

            {/* InnerState 全文 —— 「此刻内心」专属卡片 */}
            {showInner && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-fade-in">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowInner(false)} />
                    <div className="relative w-full max-w-sm bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-slide-up">
                        {/* 标题 + 星点 */}
                        <div className="px-6 pt-7 pb-3 flex items-center justify-center gap-2.5">
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current mb-1" /></span>
                            <h3 className="text-lg font-bold text-slate-800">TA 此刻的内心</h3>
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current mb-1" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current" /></span>
                        </div>
                        {/* 引文面板 */}
                        <div className="px-6 pb-2">
                            <div className="relative bg-slate-50 rounded-3xl px-5 pt-7 pb-5 max-h-[52vh] overflow-y-auto no-scrollbar">
                                <span className="absolute top-2 left-4 text-[42px] leading-none font-black select-none pointer-events-none" style={{ color: '#5f82ef' }}>“</span>
                                <p className="relative text-[14.5px] leading-[2] text-slate-600 whitespace-pre-wrap px-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                    {innerQuote}
                                </p>
                                <span className="block text-right text-[42px] leading-none font-black select-none pointer-events-none pr-2" style={{ color: '#5f82ef' }}>”</span>
                            </div>
                        </div>
                        {/* 关闭 */}
                        <div className="px-6 pb-6 pt-3">
                            <button onClick={() => setShowInner(false)}
                                className="w-full py-3.5 rounded-2xl text-white font-bold active:scale-[0.99] transition"
                                style={{ background: '#5f82ef' }}>关闭</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Create App Modal */}
            <Modal isOpen={showCreateModal} title="安装自定义 App" onClose={() => setShowCreateModal(false)}
                footer={<button onClick={handleCreateCustomApp} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">安装到桌面</button>}>
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl shadow-md border border-white/10 shrink-0"
                            style={{ background: `linear-gradient(135deg, ${newAppColor}55, ${newAppColor}15)` }}>
                            {newAppIcon}
                        </div>
                        <div className="flex-1 space-y-2">
                            <input value={newAppName} onChange={e => setNewAppName(e.target.value)} placeholder="App 名称 (如: 银行)" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                            <div className="flex gap-2">
                                <input value={newAppIcon} onChange={e => setNewAppIcon(e.target.value)} placeholder="Emoji" className="w-16 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-center" />
                                <input type="color" value={newAppColor} onChange={e => setNewAppColor(e.target.value)} className="h-9 flex-1 cursor-pointer rounded-lg bg-transparent" />
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">功能指令 (AI Prompt)</label>
                        <textarea
                            value={newAppPrompt}
                            onChange={e => setNewAppPrompt(e.target.value)}
                            placeholder="例如: 显示该用户的存款余额、近期的转账记录以及理财收益。"
                            className="w-full h-24 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none"
                        />
                        <p className="text-[9px] text-slate-400 mt-1">AI 将根据此指令生成该 App 内部的数据。</p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">界面样板 (UI Style)</label>
                        <div className="grid grid-cols-2 gap-2">
                            {APP_LAYOUTS.map(l => {
                                const active = newAppLayout === l.id;
                                return (
                                    <button key={l.id} type="button" onClick={() => setNewAppLayout(l.id)}
                                        className={`text-left rounded-xl p-2.5 border transition flex items-center gap-2.5 ${active ? 'border-transparent text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
                                        style={active ? { background: newAppColor } : undefined}>
                                        <span className="text-lg leading-none shrink-0">{l.icon}</span>
                                        <div className="min-w-0">
                                            <div className="text-[12px] font-bold leading-tight">{l.name}</div>
                                            <div className={`text-[9px] leading-tight truncate ${active ? 'text-white/80' : 'text-slate-400'}`}>{l.desc}</div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default CheckPhone;
