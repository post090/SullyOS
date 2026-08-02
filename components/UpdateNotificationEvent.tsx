/**
 * 全局版本更新提醒。
 *
 * 每个版本使用独立的 localStorage key；用户明确选择「立刻体验」或「先逛逛」后
 * 才会记为已读，避免仅仅渲染过一次就把通知吞掉。
 */

import React from 'react';
import {
    ArrowRight, BellRinging, ChatTeardropDots, Database, MagicWand, PaperPlaneTilt, UsersThree,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { trackEvent } from '../utils/analytics';
import { dateLaunch } from '../utils/dateLaunch';

// 历史 key —— 保留给备份兼容与旧版本日志使用。
export const UPDATE_NOTIFICATION_KEY = 'sullyos_update_2026_04_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05 = 'sullyos_update_2026_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_10 = 'sullyos_update_2026_05_10_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_17 = 'sullyos_update_2026_05_17_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_25 = 'sullyos_update_2026_05_25_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_05 = 'sullyos_update_2026_06_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_14 = 'sullyos_update_2026_06_14_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_21 = 'sullyos_update_2026_06_21_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_26 = 'sullyos_update_2026_06_26_seen';
export const UPDATE_NOTIFICATION_KEY_2026_07_10 = 'sullyos_update_2026_07_10_seen';
// 本次更新：见面 · 剧情首映。
export const UPDATE_NOTIFICATION_KEY_2026_08_02 = 'sullyos_update_2026_08_02_story_seen';
// 本次更新：主动消息 2.0。
export const UPDATE_NOTIFICATION_KEY_2026_08_03 = 'sullyos_update_2026_08_03_amsg2_seen';

export const FAQ_TARGET_SECTION_KEY = 'sullyos_faq_target_section';
export const CHANGELOG_2026_04 = 'changelog-2026-04';
export const CHANGELOG_2026_05 = 'changelog-2026-05';
export const CHANGELOG_2026_05_10 = 'changelog-2026-05-10';
export const CHANGELOG_2026_05_17 = 'changelog-2026-05-17';
export const CHANGELOG_2026_05_27 = 'changelog-2026-05-27';
export const CHANGELOG_2026_06_05 = 'changelog-2026-06-05';
export const CHANGELOG_2026_06_14 = 'changelog-2026-06-14';
export const CHANGELOG_2026_06_21 = 'changelog-2026-06-21';
export const CHANGELOG_2026_06_26 = 'changelog-2026-06-26';
export const CHANGELOG_2026_07_10 = 'changelog-2026-07-10';
// 本次更新的版本标识。这一版的弹窗直接跳见面 App，FAQ 里暂时没有对应的更新说明页，
// 所以这个常量目前只用来给埋点标注「用户看到/点掉的是哪一版提醒」。
export const CHANGELOG_2026_08_02 = 'changelog-2026-08-02';
export const CHANGELOG_2026_08_03 = 'changelog-2026-08-03';

/** storage 读不出来时当成看过：宁可少弹一次，也别每次开机都糊用户一脸。 */
const isUpdateSeen = (key: string): boolean => {
    try {
        return !!localStorage.getItem(key);
    } catch {
        return true;
    }
};

const markUpdateSeen = (key: string): void => {
    try {
        localStorage.setItem(key, Date.now().toString());
    } catch { /* storage 不可用时不阻断按钮行为 */ }
};

interface UpdatePopupProps {
    /** 这条用户自己关掉了 —— 接着弹队列里的下一条。 */
    onDone: () => void;
    /**
     * 用户点了「立刻体验」这类按钮、已经被带去别的 App 了 —— 整串提醒收起来。
     * 后面那几条不标已读，下次启动照弹，免得刚跳过去就被新弹窗盖住。
     */
    onExit: () => void;
}

const STORY_FEATURES = [
    {
        icon: UsersThree,
        eyebrow: '多人同场',
        text: '一次邀请多位角色，进入同一幕。',
    },
    {
        icon: MagicWand,
        eyebrow: '你的剧本',
        text: '原生预设、制作器与面具箱都已就位。',
    },
    {
        icon: Database,
        eyebrow: '记得刚好',
        text: '事件盒或独立向量分区，剧情彼此不串线。',
    },
] as const;

const StoryPremierePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    // 弹窗真正露面时记一次。版本取文件顶部写死的 changelog 常量，不含任何用户数据。
    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_02 });
    }, []);

    const handleExperience = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_02);
        dateLaunch.request({ surface: 'story' });
        openApp(AppID.Date);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_02 });
    };

    const handleDismiss = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_02);
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_02 });
    };

    return (
        <div
            className="story-premiere-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#17131f]/75 px-4 backdrop-blur-sm"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="story-premiere-title"
        >
            <style>{`
                @keyframes storyPremiereOverlayIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes storyPremiereTicketIn {
                    from { opacity: 0; transform: translateY(24px) scale(.975); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes storyPremiereReveal {
                    from { opacity: 0; transform: translateY(9px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .story-premiere-overlay { animation: storyPremiereOverlayIn 220ms ease-out both; }
                .story-premiere-ticket { animation: storyPremiereTicketIn 460ms cubic-bezier(.2,.8,.2,1) both; }
                .story-premiere-reveal { animation: storyPremiereReveal 420ms ease-out both; }
                @media (prefers-reduced-motion: reduce) {
                    .story-premiere-overlay,
                    .story-premiere-ticket,
                    .story-premiere-reveal { animation: none !important; }
                    .story-premiere-action { transition: none !important; }
                }
            `}</style>

            <section className="story-premiere-ticket relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#fbf7ef] text-[#292334] shadow-[0_28px_80px_rgba(13,9,20,0.45)] ring-1 ring-white/20">
                <div className="relative overflow-hidden bg-[#292334] px-6 pb-7 pt-6 text-[#fbf7ef]">
                    <div className="absolute inset-x-0 top-0 flex justify-around px-4 pt-2 opacity-35" aria-hidden="true">
                        {Array.from({ length: 9 }).map((_, index) => (
                            <span key={index} className="h-1.5 w-3 rounded-[2px] bg-[#fbf7ef]" />
                        ))}
                    </div>

                    <div className="story-premiere-reveal flex items-center justify-between pt-2" style={{ animationDelay: '90ms' }}>
                        <p className="text-[9px] font-bold tracking-[0.32em] text-[#cdbdff]">NIGHT SCREENING</p>
                        <span className="rounded-full border border-[#cdbdff]/45 px-2.5 py-1 text-[9px] font-bold tracking-[0.16em] text-[#ddcffd]">NEW · 剧情</span>
                    </div>

                    <div className="story-premiere-reveal mt-8" style={{ animationDelay: '150ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[0.24em] text-[#a993ee]">见面模式 · 新功能首映</p>
                        <h2 id="story-premiere-title" className="max-w-[18rem] text-[27px] font-black leading-[1.25] tracking-[-0.035em]">
                            见面，现在可以<br />一起写一场故事。
                        </h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#d7d0df]">
                            多角色、原生预设与独立剧情记忆，已经抵达放映室。
                        </p>
                    </div>

                    <div className="absolute -bottom-3 -left-3 h-6 w-6 rounded-full bg-[#fbf7ef]" aria-hidden="true" />
                    <div className="absolute -bottom-3 -right-3 h-6 w-6 rounded-full bg-[#fbf7ef]" aria-hidden="true" />
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#ded7ca]">
                        {STORY_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div
                                key={eyebrow}
                                className="story-premiere-reveal flex items-start gap-3 py-3 first:pt-0"
                                style={{ animationDelay: `${230 + index * 70}ms` }}
                            >
                                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eee7ff] text-[#6f43da]">
                                    <Icon size={18} weight="duotone" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[12px] font-extrabold tracking-[0.08em] text-[#4c3b70]">{eyebrow}</p>
                                    <p className="mt-1 text-[12px] leading-5 text-[#6f6876]">{text}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <p className="story-premiere-reveal mt-2 border-l-2 border-[#b99cf8] pl-3 text-[10px] leading-[1.7] text-[#8b8291]" style={{ animationDelay: '470ms' }}>
                        楼层与剧情记忆支持长按编辑；完整备份也会把它们一起带走。
                    </p>

                    <div className="story-premiere-reveal mt-5" style={{ animationDelay: '530ms' }}>
                        <button
                            type="button"
                            onClick={handleExperience}
                            className="story-premiere-action flex w-full items-center justify-center gap-2 rounded-2xl bg-[#7547e8] px-5 py-3.5 text-[13px] font-extrabold tracking-[0.05em] text-white shadow-[0_10px_24px_rgba(117,71,232,0.28)] transition-transform duration-200 active:scale-[0.975]"
                        >
                            立刻体验
                            <ArrowRight size={16} weight="bold" />
                        </button>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="story-premiere-action mt-1.5 w-full py-2.5 text-[11px] font-semibold text-[#918998] transition-colors active:text-[#4f4755]"
                        >
                            先逛逛
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
};

const AMSG2_FEATURES = [
    {
        icon: BellRinging,
        eyebrow: '到点就响',
        text: 'App 关着、手机锁着，消息一样送得到。',
    },
    {
        icon: ChatTeardropDots,
        eyebrow: '说一声就行',
        text: '「明早八点叫我」，ta 自己把任务排上。',
    },
    {
        icon: PaperPlaneTilt,
        eyebrow: '话没说完',
        text: '后台顺手排下一条，事办完了回来报备。',
    },
] as const;

const Amsg2UpdatePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_03 });
    }, []);

    const handleGuide = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_03);
        // 直接展开这一版的更新说明：怎么部署、有哪些边界都写在那页里。
        try {
            sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_08_03);
        } catch { /* storage 不可用就退回 FAQ 首页，别拦着跳转 */ }
        openApp(AppID.FAQ);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_03 });
    };

    const handleDismiss = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_03);
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_03 });
    };

    return (
        <div
            className="amsg-brief-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#0c1020]/78 px-4 backdrop-blur-sm"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="amsg-brief-title"
        >
            <style>{`
                @keyframes amsgBriefOverlayIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes amsgBriefCardIn {
                    from { opacity: 0; transform: translateY(24px) scale(.975); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes amsgBriefReveal {
                    from { opacity: 0; transform: translateY(9px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .amsg-brief-overlay { animation: amsgBriefOverlayIn 220ms ease-out both; }
                .amsg-brief-card { animation: amsgBriefCardIn 460ms cubic-bezier(.2,.8,.2,1) both; }
                .amsg-brief-reveal { animation: amsgBriefReveal 420ms ease-out both; }
                @media (prefers-reduced-motion: reduce) {
                    .amsg-brief-overlay,
                    .amsg-brief-card,
                    .amsg-brief-reveal { animation: none !important; }
                    .amsg-brief-action { transition: none !important; }
                }
            `}</style>

            <section className="amsg-brief-card relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#f7f8fd] text-[#232838] shadow-[0_28px_80px_rgba(8,11,26,0.5)] ring-1 ring-white/20">
                {/* 上半截是一块深夜里的锁屏：功能本身长什么样，比讲一遍更省事 */}
                <div className="relative overflow-hidden bg-[#171d33] px-6 pb-7 pt-6 text-[#f3f5ff]">
                    <div className="pointer-events-none absolute -right-12 -top-14 h-44 w-44 rounded-full bg-[#5b7cfa]/25 blur-2xl" aria-hidden="true" />

                    <div className="amsg-brief-reveal relative flex items-center justify-between" style={{ animationDelay: '90ms' }}>
                        <p className="text-[9px] font-bold tracking-[0.32em] text-[#93a9ff]">LOCK SCREEN · 02:47</p>
                        <span className="rounded-full border border-[#93a9ff]/45 px-2.5 py-1 text-[9px] font-bold tracking-[0.16em] text-[#b9c6ff]">NEW · 主动消息</span>
                    </div>

                    <div className="amsg-brief-reveal relative mt-7" style={{ animationDelay: '150ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[0.24em] text-[#8fa4f5]">主动消息 2.0</p>
                        <h2 id="amsg-brief-title" className="max-w-[18rem] text-[27px] font-black leading-[1.25] tracking-[-0.035em]">
                            这回换 ta<br />自己挑时间找你。
                        </h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#c6cce6]">
                            消息在后台生成、直接推到手机，你不用一直开着 App。
                        </p>
                    </div>

                    <div
                        className="amsg-brief-reveal relative mt-5 flex items-start gap-3 rounded-2xl bg-white/[0.12] px-3.5 py-3 ring-1 ring-white/15"
                        style={{ animationDelay: '210ms' }}
                    >
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#5b7cfa]/85 text-white">
                            <BellRinging size={15} weight="fill" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                                <p className="truncate text-[11px] font-bold text-white">Sully</p>
                                <span className="shrink-0 text-[9px] text-[#aab4d8]">02:47</span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-4 text-[#dfe4f7]">汤炖好了，说好要叫你的——起来喝一口再睡。</p>
                        </div>
                    </div>

                    <div className="absolute -bottom-3 -left-3 h-6 w-6 rounded-full bg-[#f7f8fd]" aria-hidden="true" />
                    <div className="absolute -bottom-3 -right-3 h-6 w-6 rounded-full bg-[#f7f8fd]" aria-hidden="true" />
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#dde1ef]">
                        {AMSG2_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div
                                key={eyebrow}
                                className="amsg-brief-reveal flex items-start gap-3 py-3 first:pt-0"
                                style={{ animationDelay: `${260 + index * 70}ms` }}
                            >
                                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e6ebff] text-[#3f5fd4]">
                                    <Icon size={18} weight="duotone" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[12px] font-extrabold tracking-[0.08em] text-[#39456e]">{eyebrow}</p>
                                    <p className="mt-1 text-[12px] leading-5 text-[#6c7186]">{text}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <p className="amsg-brief-reveal mt-2 border-l-2 border-[#8fa4f5] pl-3 text-[10px] leading-[1.7] text-[#848a9d]" style={{ animationDelay: '500ms' }}>
                        要用得先自己搭一个小后端，全程在网页上点，大约 15 分钟；步骤和边界都写在说明里。
                    </p>

                    <div className="amsg-brief-reveal mt-5" style={{ animationDelay: '560ms' }}>
                        <button
                            type="button"
                            onClick={handleGuide}
                            className="amsg-brief-action flex w-full items-center justify-center gap-2 rounded-2xl bg-[#3f5fd4] px-5 py-3.5 text-[13px] font-extrabold tracking-[0.05em] text-white shadow-[0_10px_24px_rgba(63,95,212,0.28)] transition-transform duration-200 active:scale-[0.975]"
                        >
                            看看怎么开
                            <ArrowRight size={16} weight="bold" />
                        </button>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="amsg-brief-action mt-1.5 w-full py-2.5 text-[11px] font-semibold text-[#8b90a2] transition-colors active:text-[#4a4f60]"
                        >
                            先不折腾
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
};

/**
 * 这一批要弹的更新提醒，新的排前面。
 *
 * 同时上线好几个功能时，各自值得单独说一次，所以排成队列：关掉一条接着弹下一条，
 * 已读各记各的 key——点掉其中一条不影响另一条还会不会露面。
 */
const UPDATE_QUEUE: { key: string; render: (props: UpdatePopupProps) => React.ReactNode }[] = [
    { key: UPDATE_NOTIFICATION_KEY_2026_08_03, render: (props) => <Amsg2UpdatePopup {...props} /> },
    { key: UPDATE_NOTIFICATION_KEY_2026_08_02, render: (props) => <StoryPremierePopup {...props} /> },
];

export const shouldShowUpdateNotification = (): boolean => UPDATE_QUEUE.some((entry) => !isUpdateSeen(entry.key));

interface UpdateNotificationControllerProps {
    onClose: () => void;
}

export const UpdateNotificationController: React.FC<UpdateNotificationControllerProps> = ({ onClose }) => {
    // 进场时把没看过的挑出来定住。每次渲染重算的话，当前这条一被标记已读就会自己从队列里
    // 消失、直接跳到下一条，用户还没来得及点——推进队列的只能是下面 onDone 那一下。
    const [pending, setPending] = React.useState(() => UPDATE_QUEUE.filter((entry) => !isUpdateSeen(entry.key)));
    const current = pending[0];

    React.useEffect(() => {
        if (!current) onClose();
    }, [current, onClose]);

    if (!current) return null;

    return (
        <React.Fragment key={current.key}>
            {current.render({
                onDone: () => setPending((rest) => rest.slice(1)),
                onExit: onClose,
            })}
        </React.Fragment>
    );
};
