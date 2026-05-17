/**
 * UpdateNotificationEvent.tsx
 * 版本更新强制提醒弹窗 (2026.5.17 小更新)
 *
 * 所有尚未确认过本次弹窗的用户，打开后都会被强制接到一次，
 * 点击"查看更新"后会跳转到使用帮助 App 的对应更新日志页。
 */

import React from 'react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';

// 历史 key —— 保留, 让老用户的"已看过"状态延续到本月新弹窗判断里
export const UPDATE_NOTIFICATION_KEY = 'sullyos_update_2026_04_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05 = 'sullyos_update_2026_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_10 = 'sullyos_update_2026_05_10_seen';
// 本次小更新 key —— 5.17 Instant Push 上线
export const UPDATE_NOTIFICATION_KEY_2026_05_17 = 'sullyos_update_2026_05_17_seen';

export const FAQ_TARGET_SECTION_KEY = 'sullyos_faq_target_section';
export const CHANGELOG_2026_04 = 'changelog-2026-04';
export const CHANGELOG_2026_05 = 'changelog-2026-05';
export const CHANGELOG_2026_05_10 = 'changelog-2026-05-10';
export const CHANGELOG_2026_05_17 = 'changelog-2026-05-17';

export const shouldShowUpdateNotification = (): boolean => {
    try {
        return !localStorage.getItem(UPDATE_NOTIFICATION_KEY_2026_05_17);
    } catch {
        return false;
    }
};

interface UpdateNotificationPopupProps {
    onClose: () => void;
}

export const UpdateNotificationPopup: React.FC<UpdateNotificationPopupProps> = ({ onClose }) => {
    const { openApp } = useOS();

    const handleView = () => {
        try {
            localStorage.setItem(UPDATE_NOTIFICATION_KEY_2026_05_17, Date.now().toString());
            sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_05_17);
        } catch { /* ignore */ }
        openApp(AppID.FAQ);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
                <div className="pt-7 pb-3 px-6 text-center">
                    <img
                        src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ec.png"
                        alt="update"
                        className="w-10 h-10 mx-auto mb-2"
                    />
                    <h2 className="text-lg font-extrabold text-slate-800">小更新提醒</h2>
                    <p className="text-[11px] text-slate-400 mt-1">2026 年 5 月 17 日 · Instant Push 上线</p>
                </div>

                <div className="px-6 pb-4 space-y-3">
                    <div className="bg-gradient-to-br from-teal-50 to-sky-50 border border-teal-100 rounded-2xl p-4">
                        <p className="text-[13px] text-slate-700 leading-relaxed">
                            新增<strong className="text-teal-700">「Instant Push」</strong>发送模式 —— 给角色发完一条文本就可以<strong className="text-sky-700">锁屏走人</strong>，AI 的回复会自己以系统推送通知的形式回来。<strong className="text-teal-700">不用一直留在前台</strong>，也<strong className="text-cyan-700">不怕被系统杀后台</strong>。
                        </p>
                        <p className="text-[12px] text-slate-500 leading-relaxed mt-2">
                            <strong>目前只有主聊天框的普通文本消息</strong>会触发；图片、小红书卡片、麦当劳点餐、约会（见面模式）等其它路径暂不支持，会自动走老路径，不受影响。
                        </p>
                        <p className="text-[12px] text-slate-500 leading-relaxed mt-2">
                            需要先配 VAPID 公私钥 + 部署一次 Cloudflare Worker；开启位置：<strong>设置 → Instant Push</strong>，里面有逐步指引。
                        </p>
                    </div>
                    <div className="bg-teal-50 border border-teal-200 rounded-2xl p-3">
                        <p className="text-[12px] font-bold text-teal-700 text-center">
                            点击下方按钮查看本次更新说明
                        </p>
                    </div>
                </div>

                <div className="px-6 pb-7 pt-2">
                    <button
                        onClick={handleView}
                        className="w-full py-3.5 bg-gradient-to-r from-teal-500 to-sky-500 text-white font-bold rounded-2xl shadow-lg shadow-teal-200 active:scale-95 transition-transform text-sm"
                    >
                        查看 5 月 17 日小更新
                    </button>
                </div>
            </div>
        </div>
    );
};

interface UpdateNotificationControllerProps {
    onClose: () => void;
}

export const UpdateNotificationController: React.FC<UpdateNotificationControllerProps> = ({ onClose }) => {
    return <UpdateNotificationPopup onClose={onClose} />;
};
