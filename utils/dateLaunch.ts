export interface DateLaunchIntent {
    surface: 'companion' | 'story';
}

type DateLaunchListener = (intent: DateLaunchIntent) => void;

const DATE_LAUNCH_EVENT = 'sullyos:date-launch';
let pending: DateLaunchIntent | null = null;

/**
 * 「见面」App 的轻量直达意图。
 *
 * pending 负责 App 尚未挂载时的首帧直达；自定义事件负责 DateApp 已经打开时的即时切换。
 * 两条路径共用一个意图，DateApp 应用后 consume，避免影响下一次普通打开。
 */
export const dateLaunch = {
    request(intent: DateLaunchIntent): void {
        pending = intent;
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent<DateLaunchIntent>(DATE_LAUNCH_EVENT, { detail: intent }));
        }
    },
    peek(): DateLaunchIntent | null {
        return pending;
    },
    consume(): DateLaunchIntent | null {
        const value = pending;
        pending = null;
        return value;
    },
    subscribe(listener: DateLaunchListener): () => void {
        if (typeof window === 'undefined') return () => {};
        const handler = (event: Event) => listener((event as CustomEvent<DateLaunchIntent>).detail);
        window.addEventListener(DATE_LAUNCH_EVENT, handler);
        return () => window.removeEventListener(DATE_LAUNCH_EVENT, handler);
    },
};
