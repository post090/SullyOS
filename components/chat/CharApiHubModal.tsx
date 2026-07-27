/**
 * CharApiHubModal — 角色级 API 配置聚合面板（聊天加号菜单「API 配置」入口）。
 *
 * 三块内容：
 *  1. 聊天主 API：该角色独立的主模型（chatApiOverride）。不同角色适合不同模型，
 *     这里选了就覆盖全局默认；选「跟随全局默认」= 清掉覆盖。
 *  2. 热点阅读：READ_NEWS 全文阅读时是否把网页配图喂给 AI（hotNewsImagesToAI），
 *     模型不识图就关着，防止 image 段直接报错。
 *  3. 副 API 便捷聚合：主动消息副 API（proactiveConfig.secondaryApi）与情绪评估
 *     API（emotionConfig.api）。原有各自的配置面板全部保留，这里只是同一处快捷改。
 *
 * 站点/模型的增删改（模板管理）仍只在 系统设置 → API 配置。
 */
import React, { useState, useEffect } from 'react';
import Modal from '../os/Modal';
import ApiConnectionPicker, { ApiTriple } from '../os/ApiConnectionPicker';
import { CharacterProfile, APIConfig } from '../../types';

interface CharApiHubModalProps {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    /** 全局主 API（「跟随全局默认」的小字展示用） */
    apiConfig: APIConfig;
    onSave: (patch: Partial<CharacterProfile>) => void;
}

const hostOf = (u?: string): string => {
    try { return u ? new URL(u).hostname : ''; } catch { return u || ''; }
};

const SectionTitle: React.FC<{ label: string; sub?: string }> = ({ label, sub }) => (
    <div className="pt-1">
        <p className="text-xs font-black text-slate-700">{label}</p>
        {sub && <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{sub}</p>}
    </div>
);

const CharApiHubModal: React.FC<CharApiHubModalProps> = ({ isOpen, onClose, char, apiConfig, onSave }) => {
    // 主 API 覆盖（null = 跟随全局）
    const [mainApi, setMainApi] = useState<ApiTriple | null>(char.chatApiOverride?.baseUrl ? char.chatApiOverride : null);
    // 热点图片喂 AI
    const [newsImgToAI, setNewsImgToAI] = useState(!!char.hotNewsImagesToAI);
    // 主动消息副 API
    const [proUseSec, setProUseSec] = useState(!!char.proactiveConfig?.useSecondaryApi);
    const [proSecApi, setProSecApi] = useState<ApiTriple | null>(char.proactiveConfig?.secondaryApi ?? null);
    // 情绪评估 API（null = 跟随主 API）
    const [emoApi, setEmoApi] = useState<ApiTriple | null>(char.emotionConfig?.api?.baseUrl ? char.emotionConfig.api : null);

    useEffect(() => {
        if (!isOpen) return;
        setMainApi(char.chatApiOverride?.baseUrl ? char.chatApiOverride : null);
        setNewsImgToAI(!!char.hotNewsImagesToAI);
        setProUseSec(!!char.proactiveConfig?.useSecondaryApi);
        setProSecApi(char.proactiveConfig?.secondaryApi ?? null);
        setEmoApi(char.emotionConfig?.api?.baseUrl ? char.emotionConfig.api : null);
    }, [isOpen, char.id]);

    const followSub = apiConfig.model ? `${apiConfig.model} · ${hostOf(apiConfig.baseUrl)}` : hostOf(apiConfig.baseUrl);
    const mainSub = mainApi?.baseUrl ? `${mainApi.model} · ${hostOf(mainApi.baseUrl)}` : followSub;

    const handleSave = () => {
        const patch: Partial<CharacterProfile> = {
            chatApiOverride: mainApi?.baseUrl ? { ...mainApi } : undefined,
            hotNewsImagesToAI: newsImgToAI,
        };
        // 主动消息副 API：不动 proactiveConfig 的其余字段；从未配置过主动消息时给最小骨架
        const pc = char.proactiveConfig;
        patch.proactiveConfig = {
            ...(pc || { enabled: false, intervalMinutes: 60 }),
            useSecondaryApi: proUseSec && !!proSecApi?.baseUrl,
            secondaryApi: proSecApi?.baseUrl ? { ...proSecApi } : undefined,
        };
        // 情绪评估 API：只改 api 字段，enabled 等保持原样
        patch.emotionConfig = {
            ...(char.emotionConfig || { enabled: false }),
            api: emoApi?.baseUrl ? { ...emoApi } : undefined,
        };
        onSave(patch);
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            title="API 配置"
            onClose={onClose}
            footer={
                <>
                    <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                    <button onClick={handleSave} className="flex-1 py-3 bg-blue-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">保存</button>
                </>
            }
        >
            <div className="space-y-4">
                <p className="text-[10px] text-slate-400 leading-relaxed -mt-1">
                    只对「{char.name}」生效。站点/模型的添加与编辑在 系统设置 → API 配置。
                </p>

                {/* 1. 聊天主 API */}
                <div className="space-y-2">
                    <SectionTitle label="聊天主 API" sub="该角色回复用的主模型；选「跟随全局默认」即用系统设置里的主 API。" />
                    <ApiConnectionPicker
                        value={mainApi}
                        onChange={setMainApi}
                        followLabel="跟随全局默认"
                        followSub={followSub}
                        compact
                        hint={null}
                    />
                </div>

                {/* 2. 热点阅读 */}
                <div className="space-y-2 pt-1 border-t border-slate-100">
                    <SectionTitle label="热点全文阅读" />
                    <button
                        onClick={() => setNewsImgToAI(v => !v)}
                        className="w-full flex items-center justify-between bg-slate-50 rounded-2xl px-4 py-3 active:scale-[0.98] transition-transform"
                    >
                        <div className="text-left">
                            <p className="text-xs font-bold text-slate-700">把热点配图喂给 AI</p>
                            <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">TA 读热点全文时连配图一起看。模型不识图请保持关闭，否则会报错。</p>
                        </div>
                        <div className={`w-11 h-6 rounded-full p-0.5 transition-colors flex-shrink-0 ml-3 ${newsImgToAI ? 'bg-blue-500' : 'bg-slate-300'}`}>
                            <div className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${newsImgToAI ? 'translate-x-5' : ''}`} />
                        </div>
                    </button>
                </div>

                {/* 3. 副 API 聚合（便捷入口） */}
                <div className="space-y-3 pt-1 border-t border-slate-100">
                    <SectionTitle label="副 API 便捷聚合" sub="这些配置和原来各自的面板是同一份数据，改哪边都一样。" />

                    <div className="space-y-2">
                        <button
                            onClick={() => setProUseSec(v => !v)}
                            className="w-full flex items-center justify-between bg-slate-50 rounded-2xl px-4 py-2.5 active:scale-[0.98] transition-transform"
                        >
                            <p className="text-xs font-bold text-slate-700">主动消息用副 API</p>
                            <div className={`w-11 h-6 rounded-full p-0.5 transition-colors flex-shrink-0 ml-3 ${proUseSec ? 'bg-violet-500' : 'bg-slate-300'}`}>
                                <div className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${proUseSec ? 'translate-x-5' : ''}`} />
                            </div>
                        </button>
                        {proUseSec && (
                            <ApiConnectionPicker value={proSecApi} onChange={setProSecApi} compact hint={null} />
                        )}
                    </div>

                    <div className="space-y-2">
                        <p className="text-[11px] font-bold text-slate-600 pl-1">情绪评估 API</p>
                        <ApiConnectionPicker
                            value={emoApi}
                            onChange={setEmoApi}
                            followLabel="跟随主 API"
                            followSub={mainSub}
                            compact
                            hint={null}
                        />
                    </div>
                </div>
            </div>
        </Modal>
    );
};

export default CharApiHubModal;
