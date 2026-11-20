// fold.js — text folding for search. Pure, never throws, no regex built from user input.
//
// fold(text) -> lower-case, NFKD-decomposed, combining marks stripped ("Björk" -> "bjork", "ﬁ" -> "fi", "Ｒｕｎｏｕｔ" -> "runout").
// Non-Latin scripts (CJK, Cyrillic, Greek, Arabic ...) pass through unchanged apart from lower-casing, so they match by plain substring.
// foldMap(text) additionally returns, for every UTF-16 unit of the folded string, the [start,end) of the original it came from,
// so a match found in the folded text can be highlighted in the original (see highlight.js users in index.js).

export const MAX_FIELD = 240;   // longest field text we index / fold (hostile inputs are cut here)

// letters whose NFKD form keeps them intact but that people type as plain ASCII
const EXTRA = { 'ß': 'ss', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'æ': 'ae', 'œ': 'oe', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't' };
const MARK = /\p{M}/gu;

function foldChar(ch) {
  let s;
  try { s = ch.normalize('NFKD').replace(MARK, '').toLowerCase(); } catch { s = ch.toLowerCase(); }
  if (s.length === 1 && EXTRA[s]) return EXTRA[s];
  if (s.length > 1 && s.length < 8) { let o = ''; for (const c of s) o += EXTRA[c] || c; return o; }
  return s;
}

/** Folded copy of `text` (cut at MAX_FIELD). Non-strings fold to ''. */
export function fold(text, max = MAX_FIELD) {
  if (typeof text !== 'string' || !text) return '';
  const src = text.length > max ? text.slice(0, max) : text;
  // fast path: plain ASCII
  let ascii = true;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) return src.toLowerCase();
  let out = '';
  for (const ch of src) out += foldChar(ch);
  return out;
}

/** { s: folded, from: Int32Array, to: Int32Array } where from[i]/to[i] bound the original range of folded unit i. */
export function foldMap(text, max = MAX_FIELD) {
  const src = typeof text === 'string' ? (text.length > max ? text.slice(0, max) : text) : '';
  let s = '';
  const from = [], to = [];
  let pos = 0;
  for (const ch of src) {
    const f = foldChar(ch);
    const end = pos + ch.length;
    for (let k = 0; k < f.length; k++) { from.push(pos); to.push(end); }
    s += f; pos = end;
  }
  return { s, from, to };
}

const isWordUnit = (c) => /[\p{L}\p{N}]/u.test(c);

/** Split a folded string into word tokens [{t, at}] (at = index in the folded string). Letters/digits only; capped. */
export function tokenize(folded, maxTokens = 32, maxLen = 64) {
  const out = [];
  let i = 0;
  const n = folded.length;
  while (i < n && out.length < maxTokens) {
    // skip separators
    while (i < n && !isWordUnit(folded[i])) i++;
    if (i >= n) break;
    const at = i;
    while (i < n && isWordUnit(folded[i])) i++;
    out.push({ t: folded.slice(at, Math.min(i, at + maxLen)), at });
  }
  return out;
}

/** Is the token made of scripts that have no word spaces (CJK, kana, Hangul, Thai ...)? Those match by substring only. */
export const isUnspaced = (t) => /[฀-๿぀-ヿ㐀-鿿가-힯豈-﫿]/u.test(t);

/**
 * true when a and b differ by at most one insertion, deletion, substitution or adjacent transposition.
 * Linear time, no allocation beyond locals.
 */
export function within1(a, b) {
  const la = a.length, lb = b.length;
  if (a === b) return true;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i === la || i === lb) return true;                 // one is a prefix of the other (length differs by 1)
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;                                   // substitution
    return a.charCodeAt(i) === b.charCodeAt(i + 1) && a.charCodeAt(i + 1) === b.charCodeAt(i) && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);         // deletion / insertion
}
