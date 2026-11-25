// formats.js — which audio files the WebView can actually decode (decodeAudioData), by extension / codec, so a track it cannot play says so plainly
// ("unsupported format") instead of a generic error, and the library can grey it out. Pure; no DOM.
//
// Chromium / the Android WebView decode mp3, AAC / m4a, flac, ogg (vorbis), opus, wav. They do NOT decode ALAC (lossless .m4a from iTunes), wma, amr, midi,
// ape / wavpack, DSD (dsf / dff) or mka. An .m4a can be either AAC (plays) or ALAC (does not): the extension cannot tell, the codec read from the file's
// own tags (`codec: 'alac'`, tags.js) can; without it the .m4a is assumed AAC and a decode failure is reported as unsupported.

export const UNSUPPORTED_TEXT = 'unsupported format';
const OK_EXT = new Set(['mp3', 'm4a', 'm4b', 'aac', 'mp4', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wave', 'weba', 'webm', 'aif', 'aiff']);
const BAD_EXT = new Set(['wma', 'amr', 'awb', 'mid', 'midi', 'kar', 'ape', 'wv', 'dsf', 'dff', 'dsd', 'mka', 'ra', 'rm', 'mpc', 'tta', 'ac3', 'dts', 'caf']);
const BAD_MIME = /^audio\/(x-ms-wma|amr|amr-wb|midi|x-midi|mid|x-ape|x-wavpack|x-dsf|x-dff|x-matroska|ac3|vnd\.dts|x-musepack)/i;
const BAD_CODEC = new Set(['alac', 'wma', 'ape', 'dsd', 'wavpack']);

const extOf = (name) => { const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

/** The reason a track cannot be decoded, or '' when it should play. `t` = a library / device track or anything with { path|name, mime, codec }. */
export function unsupportedReason(t) {
  if (!t) return '';
  const ext = extOf(t.path || t.name || (t.file && t.file.name));
  if (BAD_EXT.has(ext)) return UNSUPPORTED_TEXT;
  if (t.codec && BAD_CODEC.has(String(t.codec).toLowerCase())) return UNSUPPORTED_TEXT;
  if (t.mime && BAD_MIME.test(String(t.mime))) return UNSUPPORTED_TEXT;
  return '';
}
export const isSupported = (t) => !unsupportedReason(t);
/** an extension we know decodes (used to be strict about unknown extensions in a probe) */
export const knownGoodExt = (name) => OK_EXT.has(extOf(name));

/** Same, asking the browser: a MIME the WebView says it cannot play at all. canPlayType is a hint (""/"maybe"/"probably"), only "" is trusted. */
export function browserCannotPlay(mime, audioEl) {
  try { const a = audioEl || (typeof Audio === 'function' ? new Audio() : null); return !!(a && mime && a.canPlayType(String(mime)) === ''); } catch { return false; }
}
