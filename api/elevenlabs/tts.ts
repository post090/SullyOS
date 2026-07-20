/**
 * ElevenLabs TTS 代理（Vercel serverless）。
 * 转发到 https://api.elevenlabs.io/v1/text-to-speech/{voice_id}，把二进制音频原样回传。
 * ElevenLabs 要求每个请求带 `xi-api-key` 头 + body 里的 model_id / voice_settings。
 *
 * 客户端约定（与 api/fishaudio/tts.ts 平行）：
 *   - URL: POST /api/elevenlabs/tts
 *   - Header: xi-api-key: <ElevenLabs API Key> （可省，由 env ELEVENLABS_API_KEY 兜底）
 *   - Body:  {
 *       voice_id: '<ElevenLabs voice_id>',
 *       text: '要合成的文本',
 *       model_id: 'eleven_v3',
 *       voice_settings: { speed, stability, similarity_boost, style, use_speaker_boost }
 *     }
 *   - 返回：音频二进制（audio/mpeg）
 */
const ELEVEN_UPSTREAM_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL = 'eleven_v3';

function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,xi-api-key,Authorization');
}

function normalizeApiKey(raw?: string): string {
  if (!raw) return '';
  return raw.trim().replace(/^Bearer\s+/i, '').trim();
}

export default async function handler(req: any, res: any) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // xi-api-key 头优先；fallback 到 Authorization Bearer（兼容静态部署走通用 worker 时
    // 不能用自定义头的场景）；最后 fallback 到 env ELEVENLABS_API_KEY（hosted 模式）。
    const incomingXiKey = typeof req.headers['xi-api-key'] === 'string' ? req.headers['xi-api-key'] : '';
    const incomingAuth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const envKey = typeof process.env.ELEVENLABS_API_KEY === 'string' ? process.env.ELEVENLABS_API_KEY : '';
    const finalApiKey = normalizeApiKey(incomingXiKey) || normalizeApiKey(incomingAuth) || normalizeApiKey(envKey);
    if (!finalApiKey) {
      res.status(400).json({ error: 'Missing API key. Provide xi-api-key header or ELEVENLABS_API_KEY.' });
      return;
    }

    const requestBody = { ...(req.body || {}) };
    const voiceId = typeof requestBody.voice_id === 'string' ? requestBody.voice_id.trim() : '';
    if (!voiceId) {
      res.status(400).json({ error: 'Missing voice_id in body' });
      return;
    }
    // body 里若没传 model_id，兜底默认 eleven_v3；同时支持 env ELEVENLABS_MODEL 覆盖。
    if (!requestBody.model_id) {
      const envModel = typeof process.env.ELEVENLABS_MODEL === 'string' ? process.env.ELEVENLABS_MODEL.trim() : '';
      requestBody.model_id = envModel || DEFAULT_MODEL;
    }
    // voice_id 是 URL 参数，不要塞进 body 发给上游。
    delete requestBody.voice_id;

    const requestStartedAt = Date.now();

    console.log('[elevenlabs:tts] request', {
      model_id: requestBody.model_id,
      voice_id: voiceId,
      text_length: typeof requestBody.text === 'string' ? requestBody.text.length : 0,
      has_voice_settings: !!requestBody.voice_settings,
    });

    const upstream = await fetch(`${ELEVEN_UPSTREAM_BASE}/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': finalApiKey,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(requestBody),
    });

    const elapsedMs = Date.now() - requestStartedAt;
    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.log('[elevenlabs:tts] error', { http_status: upstream.status, duration_ms: elapsedMs, body_preview: errText.slice(0, 200) });
      res.status(upstream.status);
      res.setHeader('Content-Type', contentType.includes('json') ? 'application/json' : 'text/plain');
      res.send(errText);
      return;
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log('[elevenlabs:tts] response', { http_status: upstream.status, duration_ms: elapsedMs, bytes: buffer.length });

    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.send(buffer);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Proxy request failed' });
  }
}
