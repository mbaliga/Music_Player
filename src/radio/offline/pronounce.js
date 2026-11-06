// ─────────────────────────────────────────────────────────────────────────────
// pronounce.js — make text safe for a flat system TTS voice (offline host).
//
// Two jobs, both pure:
//   cleanTitle(raw)     library metadata -> something a host can name on air (file-name cruft,
//                       track-number prefixes, "[Remastered]" tags removed), or null when the
//                       title is not worth naming (empty, "Track 03", "Unknown", too long).
//   speakable(text)     final text handed to the engine: numbers, years, times, ordinals, "feat.",
//                       "&", symbols and emoji turned into words. Idempotent on already-spoken text.
// The written Script keeps digits (the grounding verifier compares them with fact values);
// speakable() runs at voice time, after verification, so it can never add a claim.
// ─────────────────────────────────────────────────────────────────────────────

import { numberToWords } from '../core/numbers.js';

const NUM_WORDS_SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const digitWords = (s) => s.split('').map((d) => NUM_WORDS_SMALL[Number(d)]).join(' ');

const ORD_IRREG = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
export function ordinalWords(n) {
  const w = numberToWords(n);
  const m = /^(.*?)([a-z]+)$/.exec(w);
  if (!m) return w;
  const last = m[2];
  let o;
  if (ORD_IRREG[last]) o = ORD_IRREG[last];
  else if (last.endsWith('y')) o = `${last.slice(0, -1)}ieth`;
  else o = `${last}th`;
  return m[1] + o;
}

/** 1100..2099 as a year: 1999 -> nineteen ninety-nine, 2007 -> two thousand seven, 2000 -> two thousand. */
export function yearWords(y) {
  if (y >= 2000 && y <= 2009) return y === 2000 ? 'two thousand' : `two thousand ${numberToWords(y - 2000)}`;
  const hi = Math.floor(y / 100), lo = y % 100;
  if (lo === 0) return `${numberToWords(hi)} hundred`;
  return `${numberToWords(hi)} ${lo < 10 ? `oh ${numberToWords(lo)}` : numberToWords(lo)}`;
}

function bigNumberWords(n) {
  if (n <= 9999) return numberToWords(n);
  if (n < 1e6) return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
  if (n < 1e9) { const m = Math.floor(n / 1e6), r = n % 1e6; return `${bigNumberWords(m)} million${r ? ` ${bigNumberWords(r)}` : ''}`; }
  return digitWords(String(n));
}

const ROMAN = { II: 'two', III: 'three', IV: 'four', VI: 'six', VII: 'seven', VIII: 'eight', IX: 'nine' };

// ── titles ───────────────────────────────────────────────────────────────────

const JUNK_TAG = /^(?:\d{4}\s+)?(?:re-?master(?:ed)?(?:\s+\d{4})?|\d{4}\s+re-?master(?:ed)?|official(?:\s+\w+)*|(?:lyric|music|audio|hd|hq|4k)\s*(?:video)?|lyrics?|explicit|clean|mono|stereo|deluxe(?:\s+\w+)?|bonus(?:\s+track)?|single\s+version|radio\s+edit|album\s+version|digital\s+\w+|\w*\s*rip|web|youtube|free\s+download|\d{2,3}\s*kbps?)$/i;
const NON_TITLES = /^(?:track\s*\d*|untitled(?:\s*\d*)?|unknown(?:\s+(?:title|track))?|audio\s*track\s*\d*|no\s+title|\d+)$/i;

/**
 * Library title -> a name to say on air, or null. Never throws; always returns a string <= 60 chars or null.
 * Removes: extension, leading track numbers ("01 - ", "1. ", "A2 "), underscores, and bracketed junk tags
 * ("[Remastered 2011]", "(Official Video)"). Keeps meaningful brackets such as "(Live)" or "(Part 2)".
 */
export function cleanTitle(raw) {
  try {
    let s = String(raw ?? '').normalize('NFC');
    s = s.replace(/\.(mp3|flac|ogg|m4a|aac|opus|wav|wma|aiff?)$/i, '');
    s = s.replace(/[_•·]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(?:[A-D]\d{1,2}|\d{1,3})\s*[-.)\]:]\s+/i, '').replace(/^\d{1,3}\s+(?=\D)/, '').trim();
    s = s.replace(/\s*[[(]([^\])]*)[\])]/g, (m, inner) => (JUNK_TAG.test(inner.trim()) ? '' : m)).replace(/\s+/g, ' ').trim();
    s = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>{}\\|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || NON_TITLES.test(s)) return null;
    if (!/[\p{L}\p{N}]/u.test(s)) return null;
    if (s.length > 60) {
      const cut = s.split(/\s+[-–—:]\s+|\s*\(/)[0].trim();
      if (cut.length >= 2 && cut.length <= 60) s = cut; else return null;
    }
    return s;
  } catch { return null; }
}

const UNKNOWN_ARTIST = /^(?:unknown(?:\s+artist)?|<unknown>|various(?:\s+artists)?|va|n\/?a|none|artist|no\s+artist)$/i;
/** Artist tag -> a nameable artist, or null (unknown / compilation / too long). */
export function cleanArtist(raw) {
  try {
    const s = String(raw ?? '').replace(/[_\u0000-\u001f\u007f<>{}\\|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || UNKNOWN_ARTIST.test(s) || s.length > 50 || !/[\p{L}\p{N}]/u.test(s)) return null;
    return s;
  } catch { return null; }
}

/** Album tag -> nameable album or null. */
export function cleanAlbum(raw) {
  try {
    const s = cleanTitle(raw);
    return s && !/^(?:unknown(?:\s+album)?|untitled|singles?)$/i.test(s) ? s : null;
  } catch { return null; }
}

// ── speakable text ───────────────────────────────────────────────────────────

const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/**
 * Text -> what the engine should be handed. Idempotent: running it twice gives the same string.
 * Handles: "feat./ft./featuring", "&", "+", "w/", "vs.", "%", degree sign, "#", "$", "@", "/", dashes,
 * ellipses, underscores, URLs, emoji, honorifics, "No.", "Vol.", "Pt.", 4-digit years, "1990s"/"90s",
 * clock times ("4:52", "4:52pm", "12:00"), ordinals ("3rd"), thousands separators, decimals, long numbers,
 * and roman numerals II-IX after a capitalised word ("Rocky IV").
 */
export function speakable(text) {
  try {
    let s = String(text ?? '');
    s = s.normalize('NFC').replace(EMOJI, ' ').replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
    s = s.replace(/\bfeat\.?(?=\s)|\bft\.(?=\s)/gi, 'featuring').replace(/\bw\/(?=\s|\w)/gi, 'with ').replace(/\bvs\.?(?=\s)/gi, 'versus');
    s = s.replace(/\bMr\./g, 'Mister').replace(/\bMrs\./g, 'Missus').replace(/\bDr\./g, 'Doctor').replace(/\bMs\./g, 'Miss');
    s = s.replace(/\bNo\.\s*(?=\d)/g, 'number ').replace(/\bVol\.\s*(?=\d)/gi, 'volume ').replace(/\bPt\.\s*(?=\d)/gi, 'part ');
    s = s.replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/@/g, ' at ');
    s = s.replace(/(\d)\s*%/g, '$1 percent').replace(/%/g, ' percent ');
    s = s.replace(/(-?\d+(?:\.\d+)?)\s*°\s*[CcFf]?/g, (m, n) => `${n} degrees`).replace(/°/g, ' degrees ');
    s = s.replace(/#\s*(?=\d)/g, 'number ').replace(/\$\s*(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars');
    // clock times
    s = s.replace(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/gi, (m, h, mi, ap) => clock(Number(h), Number(mi), `${ap.toLowerCase()} m`));
    s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mi) => clock(Number(h), Number(mi), ''));
    // decades
    s = s.replace(/\b(1[0-9]|20)(\d)0s\b/g, (m, a, b) => (a === '20' && b === '0' ? 'two thousands' : `${numberToWords(Number(a))} ${b === '1' ? 'tens' : decade(Number(`${b}0`))}`));
    s = s.replace(/\b'?([2-9]0)s\b/g, (m, d) => decade(Number(d)));
    // ordinals
    s = s.replace(/\b(\d{1,3})(?:st|nd|rd|th)\b/gi, (m, n) => ordinalWords(Number(n)));
    // numbers with separators / decimals / years / plain
    s = s.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b|\b\d+\b/g, (m, off, str) => {
      const prevCh = str[off - 1], nextCh = str[off + m.length];
      if (prevCh === '.' || nextCh === '.' && /\d/.test(str[off + m.length + 1] || '')) return m;
      const clean = m.replace(/,/g, '');
      if (clean.includes('.')) { const [i, f] = clean.split('.'); return `${bigNumberWords(Number(i))} point ${digitWords(f)}`; }
      if (/^0\d/.test(clean)) return digitWords(clean);
      const n = Number(clean);
      if (clean.length === 4 && m === clean && n >= 1100 && n <= 2099) return yearWords(n);
      if (n > 9999999999) return digitWords(clean);
      return bigNumberWords(n);
    });
    // roman numerals after a capitalised word, at a phrase end
    s = s.replace(/\b([A-Z][a-z]+)\s+(II|III|IV|VI|VII|VIII|IX)\b(?=\s*(?:[,.;:!?)]|$))/g, (m, w, r) => `${w} ${ROMAN[r]}`);
    s = s.replace(/[–—]/g, ', ').replace(/\s-\s/g, ', ').replace(/…/g, '...').replace(/_/g, ' ');
    s = s.replace(/\//g, ' ').replace(/[*~^=<>|\\[\]{}]/g, ' ').replace(/["“”]/g, '').replace(/[‘’]/g, "'");
    s = s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/\s+/g, ' ').trim();
    return s;
  } catch { return ''; }
}

function decade(d) {
  const w = { 20: 'twenties', 30: 'thirties', 40: 'forties', 50: 'fifties', 60: 'sixties', 70: 'seventies', 80: 'eighties', 90: 'nineties' };
  return w[d] || `${d}s`;
}

function clock(h, mi, suffix) {
  if (h > 24 || mi > 59) return `${h}:${String(mi).padStart(2, '0')}`;
  const hh = numberToWords(h === 0 ? 12 : h > 12 && !suffix ? h : h);
  const mm = mi === 0 ? (suffix ? '' : " o'clock") : mi < 10 ? ` oh ${numberToWords(mi)}` : ` ${numberToWords(mi)}`;
  return `${hh}${mm}${suffix ? ` ${suffix}` : ''}`.trim();
}
