/**
 * 远程图片本地 Blob 缓存 —— 跨角色共享，秒开不走网络。
 *
 * 背景：角色音乐角落的「钟爱的人 / 钟爱的原声」头像/封面来自网易云 CDN。
 * 同一个艺人（如"周杰伦"）会出现在多个角色的 profile 里，picUrl 相同，
 * 但 WebView 每次进页面都要重新下载渲染 → 渐变占位闪烁、体验差。
 *
 * 方案：第一次加载成功后把图片 Blob 存进 blob_assets store（复用既有 store，
 * id 用 `urlcache:<hash>` 前缀，不占新 schema），后续任何角色用到同一 URL
 * 都直接读本地 Blob 转 objectURL 秒开。
 *
 * 失败兜底：fetch 受 CORS 限制或网络失败时返回 undefined，调用方回退到原 URL
 * 走浏览器 <img> 缓存，体验不比现在差。
 *
 * 失效时机：编辑艺人/OST 名字时，profile 里旧的 picUrl/coverUrl 会被清掉
 * （见 CharVisitPage.saveEntryName），下次匹配到新名字会重新 fetch 写缓存。
 */
import React, { useEffect, useState } from 'react';
import { DB } from './db';

const ID_PREFIX = 'urlcache:';
const memCache = new Map<string, string>(); // url -> objectURL（进程内，避免重复 createObjectURL）
const pending = new Map<string, Promise<string | undefined>>();

const simpleHash = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
};

const idOf = (url: string): string => ID_PREFIX + simpleHash(url);

async function loadFromDB(url: string): Promise<string | undefined> {
  try {
    const blob = await DB.getBlobAsset(idOf(url));
    if (blob) {
      const objUrl = URL.createObjectURL(blob);
      memCache.set(url, objUrl);
      return objUrl;
    }
  } catch { /* ignore */ }
  return undefined;
}

async function fetchAndCache(url: string): Promise<string | undefined> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return undefined;
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) return undefined;
    try { await DB.putBlobAsset(idOf(url), blob); } catch { /* 缓存写失败不阻塞 */ }
    const objUrl = URL.createObjectURL(blob);
    memCache.set(url, objUrl);
    return objUrl;
  } catch {
    return undefined;
  }
}

function resolve(url: string): Promise<string | undefined> {
  let p = pending.get(url);
  if (p) return p;
  p = (async () => {
    // 1. 内存命中
    const mem = memCache.get(url);
    if (mem) return mem;
    // 2. IndexedDB 命中
    const fromDB = await loadFromDB(url);
    if (fromDB) return fromDB;
    // 3. 网络拉取并缓存
    return fetchAndCache(url);
  })().finally(() => { pending.delete(url); });
  pending.set(url, p);
  return p;
}

/**
 * 用法跟 useBlobRefUrl 类似：传一个远程图片 URL，返回可用的 src。
 * - 命中缓存（内存/IndexedDB）→ 返回本地 objectURL，秒开不走网络。
 * - 未命中 → 先返回原 URL 兜底渲染（<img> 走浏览器加载，体验同改造前），
 *   同时后台 fetch 拉 Blob 写缓存，成功后切到本地 objectURL。
 *   下次任何角色用到同一 URL 直接命中缓存秒开。
 *
 * fetch 受 CORS 限制失败时保持原 URL 不变，体验不比改造前差。
 */
export function useRemoteImgUrl(url: string | undefined | null): string | undefined {
  const cached = url ? memCache.get(url) : undefined;
  const [objUrl, setObjUrl] = useState<string | undefined>(cached ?? url ?? undefined);

  useEffect(() => {
    if (!url) { setObjUrl(undefined); return; }
    const mem = memCache.get(url);
    if (mem) { setObjUrl(mem); return; }
    // 未命中：先用原 URL 兜底渲染，避免比改造前更差
    setObjUrl(url);
    // 后台拉取并缓存，成功后切本地 objectURL（下次秒开）
    let alive = true;
    resolve(url).then(u => { if (alive && u && u !== url) setObjUrl(u); });
    return () => { alive = false; };
  }, [url]);

  return objUrl;
}

/** React 组件版 —— 方便在 map 里用（hook 不能在循环里调用）。命中缓存秒开，未命中用原 URL 兜底。 */
export const RemoteImg: React.FC<{
  url?: string;
  className?: string;
  alt?: string;
}> = ({ url, className, alt }) => {
  const src = useRemoteImgUrl(url);
  if (!src) return null;
  return <img src={src} alt={alt} className={className} />;
};
