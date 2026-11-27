// artwork.js — album art for the notification / lock screen. The native service wants the bytes (a blob: URL means nothing to it), so the cover is
// scaled down (<= 512 px, JPEG) and handed over as base64. Cached per URL, so a new track of the same album attaches its art at once.
// env (all injectable for tests): { fetchBlob(url) -> Blob, decode(blob) -> { width, height, draw(ctx2d, w, h) , close?() }, makeCanvas(w, h) -> { getContext, toDataURL }, maxPx, quality }
export const MAX_PX = 512;
export const MAX_B64 = 1_500_000;     // the native side drops anything larger than ~2 MB of base64

export function scaleToFit(w, h, maxPx = MAX_PX) {
  if (!(w > 0) || !(h > 0)) return null;
  const k = Math.min(1, maxPx / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** "data:image/jpeg;base64,AAAA" -> "AAAA" (null for anything else or an oversize image). */
export function stripDataUrl(u) {
  const m = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
  return m && m[1].length <= MAX_B64 ? m[1] : null;
}

function browserEnv() {
  return {
    fetchBlob: async (url) => (await fetch(url)).blob(),
    decode: async (blob) => {
      const bmp = await createImageBitmap(blob);
      return { width: bmp.width, height: bmp.height, draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h), close: () => { try { bmp.close(); } catch { /* */ } } };
    },
    makeCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
  };
}

export function createArtwork(envIn = {}) {
  const env = { ...browserEnv(), maxPx: MAX_PX, quality: 0.82, ...envIn };
  const cache = new Map();            // url -> base64 | null (a failure is remembered: no retry storm)
  const pending = new Map();
  async function convert(url) {
    const blob = await env.fetchBlob(url);
    const img = await env.decode(blob);
    try {
      const sz = scaleToFit(img.width, img.height, env.maxPx);
      if (!sz) return null;
      const cv = env.makeCanvas(sz.w, sz.h);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, sz.w, sz.h);
      img.draw(ctx, sz.w, sz.h);
      return stripDataUrl(cv.toDataURL('image/jpeg', env.quality));
    } finally { try { img.close && img.close(); } catch { /* */ } }
  }
  return {
    /** The cached base64 (string), null (known to fail) or undefined (not asked yet). */
    peek: (url) => cache.get(url),
    /** Resolve to base64 or null; never rejects. */
    get(url) {
      if (!url || typeof url !== 'string') return Promise.resolve(null);
      if (cache.has(url)) return Promise.resolve(cache.get(url));
      if (pending.has(url)) return pending.get(url);
      const p = convert(url).catch(() => null).then((b) => {
        cache.set(url, b); pending.delete(url);
        while (cache.size > 6) cache.delete(cache.keys().next().value);       // a few albums, not the whole library
        return b;
      });
      pending.set(url, p);
      return p;
    },
  };
}
