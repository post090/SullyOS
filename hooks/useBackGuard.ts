/**
 * App 内返回守卫 —— 让 Android 系统返回手势先关"最上层的子视图"，而不是一杆子退回桌面。
 *
 * 背景：OSContext 提供 registerBackHandler（全局单处理器，PhoneShell 的 backButton
 * 监听会先问它）。但大部分 App 没接，导致二级页面里滑返回直接关 App。
 *
 * 用法（steps 按"最上层 → 最下层"排，命中第一个打开的就消费这次返回）：
 *   useBackGuard([
 *       [!!confirmDialog, () => setConfirmDialog(false)],  // 弹窗最优先
 *       [!!selId,         () => setSelId(null)],           // 详情页其次
 *   ]);
 *
 * 实现细节：steps 走 ref，注册只在挂载时发生一次——避免每次 state 变化都
 * 重新 register/unregister（并发挂载的其他 App 会被抢走处理器）。
 */

import { useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';

export type BackStep = [open: boolean, close: () => void];

export function useBackGuard(steps: BackStep[]): void {
    const { registerBackHandler } = useOS();
    const stepsRef = useRef(steps);
    stepsRef.current = steps;
    useEffect(() => registerBackHandler(() => {
        for (const [open, close] of stepsRef.current) {
            if (open) { close(); return true; }
        }
        return false; // 没有子视图 → 交回默认（关 App）
    }), [registerBackHandler]);
}
