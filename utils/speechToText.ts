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
  /** Cloud mode only: mic input level 0..1, ~10 times/sec — drives the waveform UI. */
  onLevel?: (level: number) => void;
  /** Cloud mode only: recording stopped, upload/recognition in flight — show a busy state. */
  onRecognizing?: () => void;
  /** Cloud mode only: 录音结束、拿到完整音频 Blob（面试音频说话状态分析用；系统/浏览器识别拿不到音频流，不触发）。 */
  onAudioBlob?: (blob: Blob) => void;
}

/** Cloud STT settings (OpenAI-compatible /v1/audio/transcriptions). */
export interface SttProviderConfig {
  provider?: 'system' | 'cloud';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface SttSession {
  /** Stop listening. Safe to call multiple times. Returns a Promise on native
   *  (cleanup is async — awaits RecognitionService.stop()); void on web.
   *  Callers may ignore the return value: callbacks (onFinal/onEnd) fire
   *  after cleanup completes either way. */
  stop: () => void | Promise<void>;
}

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

const getWebCtor = (): any =>
  (typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;

/** Whether voice input is usable in the current environment. */
export const isSttSupported = (cfg?: SttProviderConfig): boolean => {
  if (cfg?.provider === 'cloud' && cfg.apiKey) {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
      && typeof MediaRecorder !== 'undefined';
  }
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
  // 关键设计：@capacitor-community/speech-recognition 在 partialResults:true 模式下，
  // start() 应当 *立刻 resolve*（不带结果），通过 partialResults 事件持续推送部分识别
  // 结果，直到调用 stop() 才结束。这是 plugin 文档明确写的契约：
  //   "if partialResults is true, the function respond directly without result
  //    and event partialResults will be emit for each partial result, until stopped."
  //
  // 但在部分 ROM 上（尤其是裁剪过的国产 ROM），start() 会异常 reject：
  //   - "Didn't understand, please try again." (ERROR_NO_MATCH，用户没立刻说话)
  //   - "RecognitionService busy" / "Client side error" (上一轮资源未释放)
  // 这时需要重启 start() 让麦克风保持开启。但重启有讲究：
  //   1. 重启前必须 await stop() 让 RecognitionService 完整释放，否则下一轮必报 busy
  //   2. 重启间隔要够长（≥600ms），50ms/100ms 远不够 Android 释放原生资源
  //   3. busy / Client side error 也是可恢复的，等久一点再试，不要直接 finish
  //   4. 总重启次数要有上限，避免无限循环把日志刷爆
  let ended = false;                  // 用户主动停止
  let accumulatedText = '';           // 累计识别到的文字（覆盖式，跟 web 端一致）
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let popupTried = false;             // 是否已经 fallback 过 popup:true
  let totalRestarts = 0;              // 累计重启次数（任何原因）

  const MAX_TOTAL_RESTARTS = 8;       // 总重启上限，超过就停（避免日志爆炸）
  const RESTART_DELAY_MS = 600;       // no-match 重启间隔
  const BUSY_DELAY_MS = 1200;         // busy / Client side error 重启间隔（更长）

  // partialResults listener 只注册一次（整个会话共用），不在循环里重复注册
  let handle: { remove: () => Promise<void> } | null = null;
  try {
    handle = await SpeechRecognition.addListener('partialResults', (data: any) => {
      const m = data?.matches?.[0];
      if (m) {
        accumulatedText = m;
        cb.onPartial?.(accumulatedText);
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

  const cleanup = async () => {
    ended = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (handle) { await handle.remove().catch(() => {}); handle = null; }
    // stop() 必须 await，否则下一轮 start() 会撞上未释放的 RecognitionService 报 busy
    await SpeechRecognition.stop().catch(() => {});
  };

  const finish = async (finalText: string, errMsg?: unknown) => {
    if (ended) return;
    await cleanup();
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

  // ── 4. 识别循环 ──
  // 正常路径：start() resolve → plugin 进入"持续聆听"状态 → partialResults 事件推送
  //         → 用户点 stop → 结束。resolve 后 *不要* 立刻重启，否则会撞 busy。
  // 异常路径：start() reject → 按 600ms/1200ms 间隔重启 → 累计 8 次还没好就停。
  const runOneCycle = async (): Promise<void> => {
    if (ended) return;

    // 重启前先确保上一轮已停止，避免 RecognitionService busy。
    // 这一步对"start() reject 后立刻重启"的场景尤其关键。
    await SpeechRecognition.stop().catch(() => {});
    if (ended) return;

    const options = {
      language: lang,
      partialResults: true,
      popup: popupTried,  // 先 popup:false（无 UI 干扰），失败 fallback popup:true
      maxResults: 1,
    };

    try {
      await SpeechRecognition.start(options);
      // partialResults:true 模式下 start() 应当立刻 resolve —— 识别进入"持续聆听"
      // 状态，由 partialResults listener 推送结果。这里 *不要* 重启下一轮，等
      // listener 推送或用户 stop。某些 ROM 不遵守契约时，会走下面的 catch。
      return;
    } catch (e: any) {
      if (ended) return;
      const msg = normalizeErr(e);

      // popup:false 不支持 → 立刻用 popup:true 重试一次（不计入 totalRestarts）
      if (!popupTried && /popup|not.?supported|invalid/i.test(msg)) {
        popupTried = true;
        return runOneCycle();
      }

      // 用户没说话 / 没听清 —— 可恢复，等 600ms 重启
      if (/no.?match|didn.?t understand|please try again/i.test(msg)) {
        totalRestarts++;
        if (totalRestarts >= MAX_TOTAL_RESTARTS) {
          await finish('', '系统识别器一直没听到声音，可能麦克风有问题或者环境太吵。点麦克风重新开始。');
          return;
        }
        restartTimer = setTimeout(() => { runOneCycle(); }, RESTART_DELAY_MS);
        return;
      }

      // RecognitionService busy / Client side error —— 上一轮资源没释放完，
      // 等更久（1200ms）再试。这两种错误绝对不能直接 finish，否则用户看到
      // "麦克风闪一下就没了"——这是修复前最严重的体验问题。
      if (/busy|client side|service busy/i.test(msg)) {
        totalRestarts++;
        if (totalRestarts >= MAX_TOTAL_RESTARTS) {
          await finish('', '识别器响应不过来，稍后再试一次。');
          return;
        }
        restartTimer = setTimeout(() => { runOneCycle(); }, BUSY_DELAY_MS);
        return;
      }

      // 其它真错误（权限被撤销 / 网络断 / ROM 不支持） → 结束
      await finish('', msg);
    }
  };

  // 启动第一轮
  runOneCycle();

  return {
    stop: async () => {
      // 用户主动停止：把累计的文本作为 final 给出去
      if (ended) return;
      await cleanup();
      cb.onFinal?.(accumulatedText);
      cb.onEnd?.();
    },
  };
};

/**
 * Cloud STT: record with MediaRecorder, then POST to an OpenAI-compatible
 * /v1/audio/transcriptions endpoint (SiliconFlow SenseVoice / Groq Whisper / OpenAI).
 * We own the mic here, so a real AnalyserNode level feed drives the waveform UI.
 */
const resolveTranscriptionUrl = (baseUrl: string): string => {
  const b = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/audio\/transcriptions$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return `${b}/audio/transcriptions`;
  return `${b}/v1/audio/transcriptions`;
};

const DEFAULT_CLOUD_STT_BASE = 'https://api.siliconflow.cn/v1';

const startCloud = async (lang: string, cb: SttCallbacks, cfg: SttProviderConfig): Promise<SttSession> => {
  // Base URL 留空 → 默认 SiliconFlow（与设置页文案一致）
  const url = resolveTranscriptionUrl(cfg.baseUrl?.trim() || DEFAULT_CLOUD_STT_BASE);
  if (!cfg.apiKey) throw new Error('先在设置→其他 API 里填云端 STT 的 API Key');
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持录音（MediaRecorder 不可用）');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
    throw new Error('麦克风权限被拒绝，去系统设置里允许一下');
  });

  // ── 实时音量：AnalyserNode 取时域 RMS，~100ms 一次推给 UI 画波形 ──
  let audioCtx: AudioContext | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      audioCtx = new Ctx();
      const srcNode = audioCtx!.createMediaStreamSource(stream);
      const analyser = audioCtx!.createAnalyser();
      analyser.fftSize = 512;
      srcNode.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        // RMS 平时说话大概 0.02~0.2，放大到 0..1 好看些
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        cb.onLevel?.(level);
      }, 100);
    }
  } catch { /* 波形是锦上添花，失败不影响录音 */ }

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']
    .find(m => !m || (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(m))) ?? '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  let stopped = false;
  const releaseMic = () => {
    if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
    try { audioCtx?.close(); } catch { /* ignore */ }
    audioCtx = null;
    try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
  };

  recorder.onstop = async () => {
    releaseMic();
    // 录音结束 → 进入「识别中」，UI 据此显示思考态而不是瞎等
    cb.onRecognizing?.();
    try {
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      if (blob.size < 1024) {
        cb.onError?.('没录到声音，再试一次？');
        cb.onEnd?.();
        return;
      }
      // 把完整音频交给调用方（面试场景后台分析说话状态）；不影响下方 STT 转写
      cb.onAudioBlob?.(blob);
      const fd = new FormData();
      const ext = /mp4/.test(mime) ? 'm4a' : 'webm';
      fd.append('file', blob, `voice.${ext}`);
      fd.append('model', cfg.model?.trim() || 'FunAudioLLM/SenseVoiceSmall');
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: fd,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`识别接口返回 ${resp.status}：${body.slice(0, 160) || '无详情'}`);
      }
      const data = await resp.json().catch(() => ({}));
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (text) cb.onFinal?.(text);
      else cb.onError?.('没有识别到内容，再说一次？');
    } catch (e: any) {
      const raw = (e && (e.message || String(e))) || '识别失败';
      cb.onError?.(typeof raw === 'string' ? raw : String(raw));
    }
    cb.onEnd?.();
  };

  // timeslice：定期落盘，录很长也不丢数据
  recorder.start(250);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try { recorder.stop(); } catch { releaseMic(); cb.onEnd?.(); }
    },
  };
};

/**
 * Start a speech-to-text session. Resolves to a handle you can `stop()`.
 * All transcripts arrive via the callbacks.
 * Pass `cfg`（来自 APIConfig 的 stt* 字段）选择云端识别；缺省走系统/浏览器识别。
 */
export const startStt = async (lang: string, cb: SttCallbacks, cfg?: SttProviderConfig): Promise<SttSession> => {
  const language = lang || 'zh-CN';
  // 选了云端但没填 Key → 自动回退系统/浏览器识别（与设置页文案一致）
  if (cfg?.provider === 'cloud' && cfg.apiKey) return startCloud(language, cb, cfg);
  if (isNative()) return startNative(language, cb);
  return startWeb(language, cb);
};
