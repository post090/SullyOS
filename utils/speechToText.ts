/**
 * Unified speech-to-text (STT) — used by the Call app for voice input.
 *
 * Hybrid strategy (A+B):
 *   - Web platform  → native `webkitSpeechRecognition` / `SpeechRecognition`
 *                     (zero dependency, streams interim results).
 *   - Capacitor app → `@capacitor-community/speech-recognition` (on-device capable),
 *                     loaded via dynamic import so it never enters the web bundle.
 *
 * The user speaks Chinese to the character by default, so the default recognition
 * language is zh-CN regardless of the character's TTS output language.
 */
import { Capacitor } from '@capacitor/core';

export interface SttCallbacks {
  /** Fired repeatedly with the best-so-far transcript (interim + final). */
  onPartial?: (text: string) => void;
  /** Fired once with the final transcript when recognition settles. */
  onFinal?: (text: string) => void;
  /** Fired on any recognition error (already turned into a friendly message). */
  onError?: (message: string) => void;
  /** Fired when the session ends for any reason (success, error, or stop). */
  onEnd?: () => void;
}

export interface SttSession {
  /** Stop listening. Safe to call multiple times. */
  stop: () => void;
}

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

const getWebCtor = (): any =>
  (typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;

/** Whether voice input is usable in the current environment. */
export const isSttSupported = (): boolean => {
  if (isNative()) return true; // plugin present; actual availability resolved at start()
  return !!getWebCtor();
};

const friendlyError = (raw: string): string => {
  if (/not-allowed|denied|permission/i.test(raw)) return '麦克风权限被拒绝，去系统设置里允许一下';
  if (/no-speech/i.test(raw)) return '没听清，再说一次？';
  if (/network/i.test(raw)) return '语音识别服务连不上，检查下网络';
  if (/aborted/i.test(raw)) return '';
  // Native 端常见：插件 reject 但 message 是 "native-error" / "null" / 空 —— 给可操作文案。
  if (/native-error|null|^\s*$/i.test(raw)) {
    return '系统语音识别不可用（国产 ROM 常裁剪 RecognitionService）。可以试试装个带 GMS 的设备、或者用文字输入。';
  }
  return raw || '语音识别出错了';
};

// 看门狗时长：开麦后这么久还没有任何音频/语音/结果信号，就判定这个浏览器的
// 在线识别后端不可用（国内套壳浏览器常见：有 webkitSpeechRecognition 对象、
// 麦克风也亮，但永远不返回结果、也不报错）。
const STT_WATCHDOG_MS = 7000;

const startWeb = (lang: string, cb: SttCallbacks): SttSession => {
  const Ctor = getWebCtor();
  if (!Ctor) throw new Error('当前浏览器不支持语音识别');
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  // 持续聆听到用户手动停（贴合 UI 的「点麦克风结束」），别一遇停顿就自己断。
  rec.continuous = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  let ended = false;
  // 是否收到过识别器「活着」的信号（音频开始 / 检测到说话 / 出结果）。
  let gotSignal = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
  const markAlive = () => { gotSignal = true; clearWatchdog(); };

  rec.onaudiostart = markAlive;
  rec.onspeechstart = markAlive;
  rec.onresult = (e: any) => {
    markAlive();
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    cb.onPartial?.((finalText + interim).trim());
  };
  rec.onerror = (e: any) => {
    const msg = friendlyError(String(e?.error || ''));
    if (msg) cb.onError?.(msg);
  };
  rec.onend = () => {
    if (ended) return;
    ended = true;
    clearWatchdog();
    const f = finalText.trim();
    if (f) cb.onFinal?.(f);
    cb.onEnd?.();
  };
  rec.start();
  // 若在看门狗时限内识别器毫无生命迹象，多半是这个浏览器没有可用的在线识别
  // 服务（套壳浏览器/缺 Google 服务的 WebView）。明确告诉用户，别让麦克风空亮。
  watchdog = setTimeout(() => {
    if (gotSignal || ended) return;
    cb.onError?.('这个浏览器识别不到语音，多半不支持在线语音识别（国内套壳浏览器常见）。换 Chrome / Edge，或者直接打字吧。');
    try { rec.stop(); } catch { /* ignore */ }
  }, STT_WATCHDOG_MS);
  return { stop: () => { clearWatchdog(); try { rec.stop(); } catch { /* ignore */ } } };
};

const startNative = async (lang: string, cb: SttCallbacks): Promise<SttSession> => {
  const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');

  // ── 1. 实际可用性探测：available() 检查系统有没有 RecognitionService ──
  // isSttSupported() 在 native 端无条件 return true（插件存在），但插件存在 ≠ 系统能识别。
  // 国产 ROM（华为/小米/OPPO 老版本）经常裁剪 RecognitionService，必须实际查一下。
  // 注意：部分插件版本在某些 ROM 上 available() 会 reject 一个非 Error 原生对象（.message 还是对象），
  // 这里把任何 reject 都当不可用处理 —— 与其继续往下走撞墙，不如直接报清楚。
  try {
    const avail = await SpeechRecognition.available();
    if (!avail.available) {
      throw new Error('系统语音识别不可用（国产 ROM 常裁剪 RecognitionService）。可以试试装个带 GMS 的设备、或者用文字输入。');
    }
  } catch (e: any) {
    const raw = (e && (e.message || String(e))) || '';
    const msg = typeof raw === 'string' ? raw : String(raw);
    if (/不可用|RecognitionService|available/i.test(msg)) throw new Error(msg);
    throw new Error('系统语音识别不可用（available() 探测失败）。可能是 ROM 裁剪了 RecognitionService，可以试试装个带 GMS 的设备、或者用文字输入。');
  }

  // ── 2. 权限检查 ──
  const perm = await SpeechRecognition.checkPermissions().catch(() => ({ speechRecognition: 'prompt' as const }));
  if (perm.speechRecognition !== 'granted') {
    const req = await SpeechRecognition.requestPermissions();
    if (req.speechRecognition !== 'granted') throw new Error('麦克风权限被拒绝');
  }

  let lastPartial = '';
  let ended = false;
  let gotSignal = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };

  // addListener 在部分 ROM 上会 reject（插件版本不实现 partialResults 事件），必须包 try/catch。
  // 拿不到 handle 时让 finish 不再尝试 handle.remove()。
  let handle: { remove: () => Promise<void> } | null = null;
  try {
    handle = await SpeechRecognition.addListener('partialResults', (data: any) => {
      gotSignal = true;
      clearWatchdog();
      const m = data?.matches?.[0];
      if (m) { lastPartial = m; cb.onPartial?.(m); }
    });
  } catch (e: any) {
    // 部分国产 ROM 不支持 partialResults 事件流，但不一定不支持识别本身 ——
    // 继续往下走 start()，最坏情况是没 partial 但 start() resolve 时能拿到 final。
    console.warn('[stt:native] addListener(partialResults) failed, will rely on start() result only:', e);
  }

  const finish = (finalText: string, errMsg?: unknown) => {
    if (ended) return;
    ended = true;
    clearWatchdog();
    if (handle) handle.remove().catch(() => { /* ignore */ });
    if (errMsg) {
      // errMsg 可能是 Error / 字符串 / 原生对象 —— 都规整成字符串。
      const raw = (errMsg instanceof Error && errMsg.message) || (typeof errMsg === 'string' && errMsg) || String(errMsg);
      const text = typeof raw === 'string' ? raw : String(raw);
      console.error('[stt:native] error:', text, errMsg);
      cb.onError?.(friendlyError(text));
    } else if (finalText) {
      cb.onFinal?.(finalText);
    }
    cb.onEnd?.();
  };

  // 把任意异常对象规整成字符串。Capacitor 原生 Error 的 .message 可能还是对象。
  const normalizeErr = (e: any): string => {
    if (!e) return 'native-error';
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message || e.toString();
    if (typeof e.message === 'string') return e.message;
    if (typeof e.message === 'object' && e.message) {
      try { return JSON.stringify(e.message); } catch { /* fallthrough */ }
    }
    try { return JSON.stringify(e); } catch { /* fallthrough */ }
    try { return String(e); } catch { return 'native-error'; }
  };

  // 实际启动识别。先试 popup:false + partialResults:true（最理想，能流式），
  // 失败再 fallback 到 popup:true（部分国产 ROM 自带的 RecognitionService 只支持 popup 模式）。
  const doStart = async (): Promise<{ matches?: string[] } | null> => {
    try {
      return await SpeechRecognition.start({ language: lang, partialResults: true, popup: false, maxResults: 1 });
    } catch (e1: any) {
      const msg1 = normalizeErr(e1);
      console.warn('[stt:native] start(popup:false) failed, retrying with popup:true:', msg1);
      try {
        return await SpeechRecognition.start({ language: lang, partialResults: true, popup: true, maxResults: 1 });
      } catch (e2: any) {
        // 把第二个错误抛出去让上层 finish 处理
        throw e2;
      }
    }
  };

  // With partialResults: true, start() resolves once recognition settles.
  // 关键：某些 ROM 上 start() 会同步抛异常（不在 Promise 链里），必须用 try 包住。
  try {
    doStart()
      .then((res: any) => finish((res?.matches?.[0] || lastPartial || '').trim()))
      .catch((e: any) => finish('', normalizeErr(e)));
  } catch (e: any) {
    // 同步抛出（doStart 立即 reject 的情况）：把异常对象规整成字符串后走 finish。
    finish('', normalizeErr(e));
  }

  // ── 3. native 端看门狗：和 web 端对齐 ──
  // 部分 ROM 上 start() 既不 resolve 也不 reject（卡死等待系统回调），用户看到麦克风一直亮着但无响应。
  // 7 秒内没收到任何 partialResults，就判定系统识别器没启动起来，主动停 + 报错。
  watchdog = setTimeout(() => {
    if (gotSignal || ended) return;
    finish('', '系统语音识别没响应（国产 ROM 常见）。可以试试装个带 GMS 的设备、或者用文字输入。');
    try { SpeechRecognition.stop().catch(() => { /* ignore */ }); } catch { /* ignore */ }
  }, STT_WATCHDOG_MS);

  return { stop: () => { clearWatchdog(); SpeechRecognition.stop().catch(() => { /* ignore */ }); } };
};

/**
 * Start a speech-to-text session. Resolves to a handle you can `stop()`.
 * All transcripts arrive via the callbacks.
 */
export const startStt = async (lang: string, cb: SttCallbacks): Promise<SttSession> => {
  const language = lang || 'zh-CN';
  if (isNative()) return startNative(language, cb);
  return startWeb(language, cb);
};
