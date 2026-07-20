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

  // ── 3. 状态变量 ──
  // 关键设计：@capacitor-community/speech-recognition 的 start() 是"一次性"的 ——
  // 它 resolve/reject 表示"识别结束"，而不是"识别开始"。在 partialResults:true 模式下，
  // 如果用户没立刻说话，系统会很快返回 ERROR_NO_MATCH ("Didn't understand, please try again.")
  // 并结束识别。要让麦克风"保持开启"持续聆听，必须在 start() 结束后自动重启。
  let ended = false;            // 用户主动停止
  let accumulatedText = '';     // 累计识别到的文字
  let consecutiveNoMatch = 0;   // 连续"没听到"次数，超过阈值就停（避免无限循环）
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  // addListener 在部分 ROM 上会 reject，包 try/catch
  let handle: { remove: () => Promise<void> } | null = null;
  try {
    handle = await SpeechRecognition.addListener('partialResults', (data: any) => {
      const m = data?.matches?.[0];
      if (m) {
        consecutiveNoMatch = 0;  // 收到结果就清零
        cb.onPartial?.(m);
      }
    });
  } catch (e: any) {
    console.warn('[stt:native] addListener(partialResults) failed, will rely on start() result only:', e);
  }

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

  const cleanup = () => {
    ended = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (handle) { handle.remove().catch(() => {}); handle = null; }
    try { SpeechRecognition.stop().catch(() => {}); } catch {}
  };

  const finish = (finalText: string, errMsg?: unknown) => {
    if (ended) return;
    cleanup();
    if (errMsg) {
      const raw = (errMsg instanceof Error && errMsg.message) || (typeof errMsg === 'string' && errMsg) || String(errMsg);
      const text = typeof raw === 'string' ? raw : String(raw);
      console.error('[stt:native] error:', text, errMsg);
      cb.onError?.(friendlyError(text));
    } else if (finalText) {
      cb.onFinal?.(finalText);
    }
    cb.onEnd?.();
  };

  // ── 4. 识别循环：start() 结束后自动重启，让麦克风保持开启 ──
  // 每一轮 start() 会持续到系统判定"有结果"或"没听到"才 resolve/reject。
  // - resolve（拿到结果）：累加文本，重启下一轮
  // - reject "no match"：连续 5 次没听到就停（避免麦克风一直亮着空转）
  // - reject 其它错误：直接 finish 报错
  const ONE_SHOT_TIMEOUT_MS = 30000;  // 单轮最长 30 秒
  const MAX_CONSECUTIVE_NO_MATCH = 5;

  const runOneCycle = (): void => {
    if (ended) return;

    let cycleTimeout: ReturnType<typeof setTimeout> | null = null;
    let cycleDone = false;

    const onCycleEnd = (finalChunk: string | null, errMsg?: unknown) => {
      if (cycleDone) return;
      cycleDone = true;
      if (cycleTimeout) { clearTimeout(cycleTimeout); cycleTimeout = null; }

      if (ended) return;

      if (errMsg) {
        const raw = (errMsg instanceof Error && errMsg.message) || (typeof errMsg === 'string' && errMsg) || String(errMsg);
        const text = typeof raw === 'string' ? raw : String(raw);
        // "Didn't understand" / "no match" 是正常情况 —— 用户可能没说话
        if (/no.?match|didn.?t understand|please try again/i.test(text)) {
          consecutiveNoMatch++;
          if (consecutiveNoMatch >= MAX_CONSECUTIVE_NO_MATCH) {
            finish('', '系统识别器一直没听到声音，可能麦克风有问题或者环境太吵。点麦克风重新开始。');
            return;
          }
          // 短暂等待后重启下一轮
          restartTimer = setTimeout(() => runOneCycle(), 100);
          return;
        }
        // 其它真错误 → 结束
        finish('', errMsg);
        return;
      }

      // 成功：累加文本，清零计数，重启下一轮
      consecutiveNoMatch = 0;
      if (finalChunk) {
        accumulatedText = finalChunk;  // 覆盖式，跟 web 端一致
        cb.onPartial?.(accumulatedText);
      }
      if (!ended) {
        restartTimer = setTimeout(() => runOneCycle(), 50);
      }
    };

    // 单轮超时保护
    cycleTimeout = setTimeout(() => {
      onCycleEnd(null);  // 超时按"本轮没结果"处理，会重启
    }, ONE_SHOT_TIMEOUT_MS);

    // 先试 popup:false（理想：无 UI 干扰），失败 fallback popup:true
    SpeechRecognition.start({ language: lang, partialResults: true, popup: false, maxResults: 1 })
      .then((res: any) => {
        const m = (res?.matches?.[0] || '').trim();
        onCycleEnd(m);
      })
      .catch((e1: any) => {
        const msg1 = normalizeErr(e1);
        // popup:false 不支持 → 试 popup:true
        if (/popup|not.?supported|invalid/i.test(msg1)) {
          SpeechRecognition.start({ language: lang, partialResults: true, popup: true, maxResults: 1 })
            .then((res: any) => onCycleEnd((res?.matches?.[0] || '').trim()))
            .catch((e2: any) => onCycleEnd(null, e2));
        } else {
          onCycleEnd(null, e1);
        }
      });
  };

  // 启动第一轮
  runOneCycle();

  return {
    stop: () => {
      // 用户主动停止：把累计的文本作为 final 给出去
      if (ended) return;
      cleanup();
      cb.onFinal?.(accumulatedText);
      cb.onEnd?.();
    },
  };
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
