/**
 * 副 API 连接选择器 —— 全站各处"副 API / 独立 API"面板的统一选择组件。
 *
 * 背景：主动消息/情绪评估/记忆宫殿/家园/彼方等模块原先各自摆三个裸 input
 * 让用户手抄 baseUrl/apiKey/model，与系统设置的「站点+模型」新管理模式脱节。
 * 这里复用站点派生逻辑（utils/apiStations）+ GlassSelect 玻璃下拉，让副 API
 * 也用"选站 → 选模型"的方式挑连接。
 *
 * 设计约束：
 *   - 只做"选择"：站点/模型的增删改（模板编辑）只在 系统设置 → API 配置
 *   - value 是纯三件套 {baseUrl, apiKey, model}，与各处存储结构天然兼容
 *   - 旧用户手填过的、不在任何站点里的遗留值：不破坏，显示"自定义遗留配置"，
 *     用户换选任何站点后自然被覆盖
 *   - allowFollow：家园/彼方式的"跟随默认"语义（onChange(null)）
 */
import React from 'react';
import { useOS } from '../../context/OSContext';
import { deriveStations, stationKey } from '../../utils/apiStations';
import GlassSelect from './GlassSelect';

export interface ApiTriple {
    baseUrl: string;
    apiKey: string;
    model: string;
}

interface ApiConnectionPickerProps {
    value: ApiTriple | null;
    onChange: (cfg: ApiTriple | null) => void;
    /** 提供后，站点下拉多一个"跟随"选项（值为 null），如「跟随主 API」/「跟随聊天默认」 */
    followLabel?: string;
    /** follow 项的小字说明（一般填当前主 API 的 model · host） */
    followSub?: string;
    compact?: boolean;
    /** 底部指路小字，默认提示去系统设置管理站点；传 null 隐藏 */
    hint?: string | null;
}

const FOLLOW = '__follow__';

const ApiConnectionPicker: React.FC<ApiConnectionPickerProps> = ({
    value, onChange, followLabel, followSub, compact, hint,
}) => {
    const { apiPresets } = useOS();
    const stations = React.useMemo(() => deriveStations(apiPresets), [apiPresets]);

    const hasValue = !!value?.baseUrl;
    const activeKey = hasValue ? stationKey(value!.baseUrl, value!.apiKey) : '';
    const activeStation = hasValue ? stations.find(s => s.key === activeKey) : undefined;
    // 手填遗留：有值但不属于任何站点
    const isLegacy = hasValue && !activeStation;

    const stationOptions = [
        ...(followLabel ? [{ value: FOLLOW, label: followLabel, sub: followSub }] : []),
        ...stations.map(s => ({ value: s.key, label: s.name, sub: `${s.models.length} 个模型` })),
    ];

    const pickStation = (v: string) => {
        if (v === FOLLOW) { onChange(null); return; }
        const st = stations.find(s => s.key === v);
        if (!st || st.models.length === 0) return;
        // 换站时尽量保住同名模型，否则用站内第一个
        const m = st.models.find(x => x.model === value?.model) || st.models[0];
        onChange({ baseUrl: st.baseUrl, apiKey: st.apiKey, model: m.model });
    };

    const pickModel = (presetId: string) => {
        if (!activeStation) return;
        const m = activeStation.models.find(x => x.presetId === presetId);
        if (!m) return;
        onChange({ baseUrl: activeStation.baseUrl, apiKey: activeStation.apiKey, model: m.model });
    };

    const stationValue = !hasValue ? (followLabel ? FOLLOW : '') : (activeStation?.key || '');

    return (
        <div className="space-y-2">
            <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1 block">API 站</label>
                <GlassSelect
                    compact={compact}
                    value={stationValue}
                    placeholder={isLegacy ? '自定义遗留配置（换选即覆盖）' : '— 选择站点 —'}
                    options={stationOptions}
                    onChange={pickStation}
                />
            </div>
            <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1 block">模型</label>
                <GlassSelect
                    compact={compact}
                    disabled={!activeStation}
                    value={activeStation?.models.find(m => m.model === value?.model)?.presetId || ''}
                    placeholder={isLegacy ? (value?.model || '—') : '— 选择模型 —'}
                    options={(activeStation?.models || []).map(m => ({
                        value: m.presetId, label: m.label, sub: m.label !== m.model ? m.model : undefined,
                    }))}
                    onChange={pickModel}
                />
            </div>
            {isLegacy && (
                <p className="text-[10px] text-amber-500/90 leading-relaxed px-1">
                    当前是旧版手填的配置（{value?.model || '未知模型'}），仍正常生效；从上面选择站点后会替换它。
                </p>
            )}
            {hint !== null && (
                <p className="text-[10px] text-slate-400 leading-relaxed px-1">
                    {hint || '站点与模型的添加、编辑在 系统设置 → API 配置 里统一管理。'}
                </p>
            )}
        </div>
    );
};

export default ApiConnectionPicker;
