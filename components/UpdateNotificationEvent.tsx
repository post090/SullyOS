/**
 * 全局版本更新提醒。
 *
 * 每个版本使用独立的 localStorage key；用户明确选择「立刻体验」或「先逛逛」后
 * 才会记为已读，避免仅仅渲染过一次就把通知吞掉。
 */

import React from 'react';
import { ArrowRight, Database, MagicWand, UsersThree } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
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

export const shouldShowUpdateNotification = (): boolean => {
    try {
        return !localStorage.getItem(UPDATE_NOTIFICATION_KEY_2026_08_02);
    } catch {
        return false;
    }
};

const markCurrentUpdateSeen = (): void => {
    try {
        localStorage.setItem(UPDATE_NOTIFICATION_KEY_2026_08_02, Date.now().toString());
    } catch { /* storage 不可用时不阻断按钮行为 */ }
};

interface UpdateNotificationPopupProps {
    onClose: () => void;
}

const FEATURES = [
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

export const UpdateNotificationPopup: React.FC<UpdateNotificationPopupProps> = ({ onClose }) => {
    const { openApp } = useOS();

    const handleExperience = () => {
        markCurrentUpdateSeen();
        dateLaunch.request({ surface: 'story' });
        openApp(AppID.Date);
        onClose();
    };

    const handleDismiss = () => {
        markCurrentUpdateSeen();
        onClose();
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
                        {FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
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

interface UpdateNotificationControllerProps {
    onClose: () => void;
}

export const UpdateNotificationController: React.FC<UpdateNotificationControllerProps> = ({ onClose }) => {
    return <UpdateNotificationPopup onClose={onClose} />;
};
