// index.js — the pure search core. No DOM, no storage, no network. Never throws, deterministic (same input -> same output).
//
//   buildIndex({ tracks, albums, artists, mixtapes, stations }, { now? })            -> index   (synchronous)
//   createIndexBuilder(data, { schedule, chunk })  -> { index, done, progress(), cancel() }   (chunked, queryable while building)
//   query(index, text, { types, limit, now })     -> { songs, albums, artists, mixtapes, stations, counts, tokens, fuzzy, empty, ... }
//   parseQuery(text)                              -> { tokens, types }       (`type:artist` style prefixes; chips do the same in the UI)
//   highlight(text, tokens, { fuzzy })            -> [[start, end), ...] ranges in the ORIGINAL text
//
// MATCHING. Every query token must match (AND). A token matches a field as: exact word (class 4) > word prefix (3) > substring (2)
// > fuzzy (1, edit distance <= 1, tokens of >= 4 letters, only when the strict pass found fewer than FUZZY_BELOW results).
// The match class decides first; the field (title > artist > album > other) breaks ties inside a class; a whole-title or
// title-prefix phrase gets a bonus; play count / recency adds a bonus capped below the field gap so it never beats a better match.
// Scripts without word spaces (CJK, kana, Hangul, Thai) match by plain substring.
//
// COST. A query is one linear pass over the docs of the asked types (no regex, no allocation per doc on the strict path) and keeps
// only the top `limit` of each group in a small sorted array. Hostile input is bounded: query <= MAX_QUERY chars, <= MAX_TOKENS tokens,
// tokens <= 64 chars, fields <= MAX_FIELD chars, <= MAX_DOCS docs per type.
import { fold, foldMap, tokenize, isUnspaced, within1, MAX_FIELD } from './fold.js';

export const TYPES = Object.freeze(['songs', 'albums', 'artists', 'mixtapes', 'stations']);
export const SINGULAR = Object.freeze({ songs: 'song', albums: 'album', artists: 'artist', mixtapes: 'mixtape', stations: 'station' });
export const MAX_QUERY = 200;
export const MAX_TOKENS = 8;
export const MAX_DOCS = 100000;
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 5;
export const SOLO_LIMIT = 50;      // when one type is asked for (a chip is selected) the group may be longer
export const FUZZY_BELOW = 3;      // run the typo pass only when the strict pass found fewer than this many results in total
export const MAX_BOOST = 8;

const CLASS_SCORE = [0, 100, 200, 300, 400];   // fuzzy, substring, prefix, exact (index = class)
const F_TITLE = 30, F_ARTIST = 20, F_ALBUM = 10, F_OTHER = 0;

const TYPE_WORDS = {
  song: 'songs', songs: 'songs', track: 'songs', tracks: 'songs',
  album: 'albums', albums: 'albums', artist: 'artists', artists: 'artists',
  mixtape: 'mixtapes', mixtapes: 'mixtapes', tape: 'mixtapes', tapes: 'mixtapes',
  radio: 'stations', station: 'stations', stations: 'stations', channel: 'stations', channels: 'stations',
};

const s = (v, max = MAX_FIELD) => (typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '')).slice(0, max);
const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);

/** Split a user query into tokens and optional `type:` filters. Never throws. */
export function parseQuery(text) {
  const raw = typeof text === 'string' ? text.slice(0, MAX_QUERY) : '';
  const folded = fold(raw, MAX_QUERY);
  const types = [];
  const rest = [];
  for (const part of folded.split(/\s+/)) {
    if (!part) continue;
    const m = /^(?:type|in|is):([a-z]+)$/.exec(part);
    if (m && TYPE_WORDS[m[1]]) { if (!types.includes(TYPE_WORDS[m[1]])) types.push(TYPE_WORDS[m[1]]); continue; }
    rest.push(part);
  }
  const tokens = [];
  for (const tk of tokenize(rest.join(' '), MAX_TOKENS, 64)) if (!tokens.includes(tk.t)) tokens.push(tk.t);
  return { tokens, types };
}

function mkField(text, bonus) {
  const t = fold(text);
  return { t, toks: t ? tokenize(t).map((x) => x.t) : [], b: bonus };
}

// ── doc builders: one per type. `ref` is the display record handed back in results ────────────────────────────────────────
function songDoc(x) {
  const title = s(x.title) || s(x.name) || 'Untitled';
  const artist = s(x.artist) || s(x.albumArtist), album = s(x.album);
  return {
    f: [mkField(title, F_TITLE), mkField(artist, F_ARTIST), mkField(album, F_ALBUM), mkField(x.genre, F_OTHER)],
    ref: { type: 'song', id: s(x.id, 120), title, subtitle: [artist, album].filter(Boolean).join(' · '), artist, album, albumId: s(x.albumId, 120), relink: !!x.relink },
    plays: num(x.plays), last: num(x.lastPlayed),
  };
}
function albumDoc(x) {
  const title = s(x.name) || s(x.album) || 'Untitled album';
  const artist = s(x.artist);
  const n = num(x.trackCount) || (Array.isArray(x.tracks) ? x.tracks.length : 0);
  return {
    f: [mkField(title, F_TITLE), mkField(artist, F_ARTIST), mkField(x.genre, F_OTHER)],
    ref: { type: 'album', id: s(x.id, 120), title, subtitle: artist, artist, kind: x.kind === 'cd' ? 'cd' : 'vinyl', trackCount: n, detail: `${x.kind === 'cd' ? 'CD' : 'Vinyl'}${n ? ` · ${n} song${n === 1 ? '' : 's'}` : ''}` },
    plays: num(x.plays), last: num(x.lastPlayed),
  };
}
function artistDoc(x) {
  const name = s(x.name) || 'Unknown artist';
  const a = num(x.albums), t = num(x.tracks);
  return {
    f: [mkField(name, F_TITLE)],
    ref: { type: 'artist', id: name, title: name, subtitle: [a ? `${a} album${a === 1 ? '' : 's'}` : '', t ? `${t} song${t === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '), albums: a, tracks: t },
    plays: num(x.plays), last: num(x.lastPlayed),
  };
}
function mixtapeDoc(x) {
  const name = s(x.name) || 'Untitled mixtape';
  const author = s(x.author);
  const list = [];
  for (const t of (Array.isArray(x.tracks) ? x.tracks : []).slice(0, 100)) {
    const title = typeof t === 'string' ? t : (t && s(t.title, 120));
    const artist = t && typeof t === 'object' ? s(t.artist, 120) : '';
    if (title) list.push(artist ? `${title} · ${artist}` : title);
  }
  const n = Array.isArray(x.tracks) ? x.tracks.length : 0;
  const d = {
    f: [mkField(name, F_TITLE), mkField(author, F_ARTIST), mkField(list.join(' | ').slice(0, 1200), F_OTHER)],
    ref: { type: 'mixtape', id: s(x.id, 120), title: name, subtitle: [author ? `by ${author}` : '', `${n} song${n === 1 ? '' : 's'}`].filter(Boolean).join(' · '), author, trackCount: n },
    plays: num(x.plays), last: num(x.lastPlayed), list: list.map((t) => t.slice(0, 120)),
  };
  return d;
}
function stationDoc(x) {
  const name = s(x.name) || 'Station';
  const tags = Array.isArray(x.tags) ? x.tags.filter((t) => typeof t === 'string').slice(0, 8).join(' ') : '';
  const hosts = Array.isArray(x.hosts) ? x.hosts.map((h) => (typeof h === 'string' ? h : h && s(h.name, 80))).filter(Boolean).slice(0, 12).join(' ') : '';
  return {
    f: [mkField(name, F_TITLE), mkField(x.dial, F_ARTIST), mkField(x.tagline, F_OTHER), mkField(tags, F_OTHER), mkField(hosts, F_OTHER), mkField(x.country, F_OTHER)],
    ref: {
      type: 'station', id: s(x.id, 120), stationType: s(x.stationType || x.type, 40), key: s(x.key, 200), title: name,
      subtitle: s(x.subtitle) || s(x.tagline) || s(x.country), dial: s(x.dial, 12), source: s(x.source, 20),
      disabled: !!x.disabled, note: s(x.note, 80), fav: !!x.fav, station: x.station && typeof x.station === 'object' ? x.station : null,
    },
    plays: num(x.plays), last: num(x.lastPlayed),
  };
}
const BUILDERS = { songs: songDoc, albums: albumDoc, artists: artistDoc, mixtapes: mixtapeDoc, stations: stationDoc };

function addDoc(index, type, item) {
  const arr = index.docs[type];
  if (arr.length >= MAX_DOCS || !item || typeof item !== 'object') return false;
  try { const d = BUILDERS[type](item); d.title = d.f[0].t; d.i = arr.length; arr.push(d); return true; } catch { return false; }
}

// the input key for songs is `tracks` (the library's word); `songs` is accepted too
const listOf = (data, t) => { const a = data && (t === 'songs' ? (data.tracks || data.songs) : data[t]); return Array.isArray(a) ? a : []; };

export function emptyIndex() { return { v: 1, docs: { songs: [], albums: [], artists: [], mixtapes: [], stations: [] } }; }
export const indexSize = (ix) => TYPES.reduce((n, t) => n + ((ix && ix.docs && ix.docs[t]) ? ix.docs[t].length : 0), 0);

/** Synchronous build. `data` keys are optional arrays; anything else is ignored. */
export function buildIndex(data = {}) {
  const ix = emptyIndex();
  for (const t of TYPES) { const arr = listOf(data, t); for (const it of arr) addDoc(ix, t, it); }
  return ix;
}

/** Replace one type's docs in place (e.g. mixtapes changed). Synchronous; use the builder for large `items`. */
export function replaceType(ix, type, items) {
  if (!ix || !ix.docs || !ix.docs[type]) return ix;
  ix.docs[type] = [];
  for (const it of Array.isArray(items) ? items : []) addDoc(ix, type, it);
  return ix;
}

/**
 * Chunked build for big libraries: `schedule(fn)` runs fn later (setTimeout 0 by default; tests inject a queue; the app may inject
 * requestIdleCallback). The index is queryable while it builds (partial results). `done` resolves with the index; cancel() stops it.
 */
export function createIndexBuilder(data = {}, { schedule, chunk = 1000, onProgress } = {}) {
  const sched = typeof schedule === 'function' ? schedule : (fn) => setTimeout(fn, 0);
  const ix = emptyIndex();
  const queue = [];
  let total = 0, done = 0, cancelled = false;
  for (const t of TYPES) { const arr = listOf(data, t); total += arr.length; queue.push({ t, arr, at: 0 }); }
  let resolve;
  const doneP = new Promise((r) => { resolve = r; });
  const step = () => {
    if (cancelled) return resolve(ix);
    let budget = Math.max(1, chunk | 0);
    while (budget > 0 && queue.length) {
      const q = queue[0];
      while (budget > 0 && q.at < q.arr.length) { addDoc(ix, q.t, q.arr[q.at++]); budget--; done++; }
      if (q.at >= q.arr.length) queue.shift();
    }
    try { onProgress && onProgress(done, total); } catch { /* observer errors never stop the build */ }
    if (queue.length) sched(step); else resolve(ix);
  };
  if (total === 0) resolve(ix); else sched(step);
  return { index: ix, done: doneP, progress: () => (total ? done / total : 1), cancel: () => { cancelled = true; } };
}

// ── matching ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// best class (0 none, 1 fuzzy, 2 substring, 3 prefix, 4 exact) of token q in one field
function fieldClass(fld, q, unspaced, fuzzy) {
  if (!fld.t) return 0;
  if (unspaced) return fld.t.indexOf(q) >= 0 ? (fld.t === q ? 4 : fld.t.startsWith(q) ? 3 : 2) : 0;
  const toks = fld.toks;
  let best = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === q) return 4;
    if (best < 3 && t.length > q.length && t.startsWith(q)) best = 3;
  }
  if (best) return best;
  if (q.length >= 2 && fld.t.indexOf(q) >= 0) return 2;
  if (fuzzy && q.length >= 4) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (Math.abs(t.length - q.length) <= 1 && within1(q, t)) return 1;
      if (t.length > q.length + 1 && within1(q, t.slice(0, q.length))) return 1;   // a typo while still typing the word
    }
  }
  return 0;
}

const FLAG_UNSPACED = (tokens) => tokens.map(isUnspaced);

function boostOf(d, now) {
  let b = 0;
  if (d.plays > 0) b += Math.min(5, Math.log2(1 + d.plays));
  if (d.last > 0 && now > 0) { const days = Math.max(0, (now - d.last) / 86400000); b += 3 * Math.exp(-days / 30); }
  return Math.min(MAX_BOOST, b);
}

// score one doc for the token list; -1 when any token fails (AND)
function scoreDoc(d, tokens, unsp, phrase, fuzzy, now) {
  let sum = 0;
  for (let k = 0; k < tokens.length; k++) {
    let bestScore = -1;
    for (let j = 0; j < d.f.length; j++) {
      const fld = d.f[j];
      const c = fieldClass(fld, tokens[k], unsp[k], fuzzy);
      if (c) { const sc = CLASS_SCORE[c] + fld.b; if (sc > bestScore) bestScore = sc; }
    }
    if (bestScore < 0) return -1;
    sum += bestScore;
  }
  let score = sum / tokens.length;
  const title = d.f[0].t;
  if (phrase && title) {
    if (title === phrase) score += 60;
    else if (title.startsWith(phrase)) score += 20;
    else if (tokens.length > 1 && title.indexOf(phrase) >= 0) score += 10;
  }
  return score + boostOf(d, now);
}

// keep the best `k` hits in a sorted array (binary insertion); ties: score desc, title asc, doc order asc
function better(a, b) { return a.score !== b.score ? a.score > b.score : a.d.title !== b.d.title ? a.d.title < b.d.title : a.d.i < b.d.i; }
function offer(top, k, hit) {
  if (top.length >= k && !better(hit, top[top.length - 1])) return;
  let lo = 0, hi = top.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (better(top[mid], hit)) lo = mid + 1; else hi = mid; }
  top.splice(lo, 0, hit);
  if (top.length > k) top.pop();
}

function runPass(ix, types, tokens, unsp, phrase, fuzzy, now, keepBy) {
  const out = {}; let total = 0;
  for (const type of types) {
    const top = []; let count = 0;
    const k = keepBy[type];
    const arr = ix.docs[type] || [];
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i];
      const sc = scoreDoc(d, tokens, unsp, phrase, fuzzy, now);
      if (sc < 0) continue;
      count++; offer(top, k, { d, score: sc });
    }
    out[type] = { top, count }; total += count;
  }
  return { out, total };
}

function mergeRanges(r) {
  r.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const o = [];
  for (const x of r) { const last = o[o.length - 1]; if (last && x[0] <= last[1]) { if (x[1] > last[1]) last[1] = x[1]; } else o.push([x[0], x[1]]); }
  return o;
}

/** Match ranges ([start, end) in UTF-16 units of the ORIGINAL text) for the query tokens. Never throws; at most ~24 ranges. */
export function highlight(text, tokens, { fuzzy = false } = {}) {
  try {
    if (typeof text !== 'string' || !text || !tokens || !tokens.length) return [];
    const m = foldMap(text);
    if (!m.s) return [];
    const words = tokenize(m.s, 64, 64);
    const ranges = [];
    const push = (a, b) => { if (b > a && m.from[a] !== undefined && m.to[b - 1] !== undefined && ranges.length < 24) ranges.push([m.from[a], m.to[b - 1]]); };
    for (const q of tokens) {
      let found = 0;
      if (!isUnspaced(q)) {
        for (const w of words) if (found < 6 && w.t.startsWith(q)) { push(w.at, w.at + q.length); found++; }
      }
      if (!found && (q.length >= 2 || isUnspaced(q))) {
        let at = m.s.indexOf(q);
        while (at >= 0 && found < 6) { push(at, at + q.length); found++; at = m.s.indexOf(q, at + q.length); }
      }
      if (!found && fuzzy && q.length >= 4) {
        for (const w of words) {
          if (Math.abs(w.t.length - q.length) <= 1 && within1(q, w.t)) { push(w.at, w.at + w.t.length); found++; break; }
          if (w.t.length > q.length + 1 && within1(q, w.t.slice(0, q.length))) { push(w.at, w.at + q.length); found++; break; }
        }
      }
    }
    return mergeRanges(ranges);
  } catch { return []; }
}

function present(d, score, tokens, fuzzy, empty) {
  const r = d.ref;
  const res = { ...r, score: Math.round(score * 100) / 100, ranges: { title: [], subtitle: [] } };
  if (!empty) {
    res.ranges.title = highlight(r.title, tokens, { fuzzy });
    res.ranges.subtitle = highlight(r.subtitle, tokens, { fuzzy });
    if (r.type === 'mixtape' && d.list && d.list.length) {
      // when the tape matched through a song on it, say which one
      const allIn = (txt) => { const f = fold(txt); return tokens.every((q) => f.indexOf(q) >= 0); };
      if (!allIn(`${r.title} ${r.author || ''}`)) {
        const hit = d.list.find((t) => allIn(t)) || d.list.find((t) => { const f = fold(t); return tokens.some((q) => f.indexOf(q) >= 0); });
        if (hit) { res.detail = `has “${hit}”`; res.ranges.detail = highlight(res.detail, tokens, { fuzzy }); }
      }
    }
  }
  return res;
}

/**
 * Run a query. Options: types (array of TYPES names; default all), limit (number, or {songs: n, ...}; default 5 per group, 50 when a
 * single type is asked for), now (ms epoch for the recency boost; default Date.now()).
 * An empty query returns the boosted (played / saved recently) docs per group with `empty: true`.
 */
export function query(ix, text, opts = {}) {
  const empty = { songs: [], albums: [], artists: [], mixtapes: [], stations: [] };
  try {
    if (!ix || !ix.docs) return { text: '', tokens: [], types: [...TYPES], empty: true, fuzzy: false, ...empty, counts: { songs: 0, albums: 0, artists: 0, mixtapes: 0, stations: 0, total: 0 } };
    const pq = parseQuery(text);
    let types = Array.isArray(opts.types) && opts.types.length ? opts.types.filter((t) => TYPES.includes(t)) : [];
    if (pq.types.length) types = pq.types;                       // a `type:` prefix in the text wins over chips
    if (!types.length) types = [...TYPES];
    types = TYPES.filter((t) => types.includes(t));              // canonical order
    const now = typeof opts.now === 'number' && isFinite(opts.now) ? opts.now : Date.now();
    const baseLimit = (t) => {
      const L = opts.limit;
      const v = L && typeof L === 'object' ? L[t] : L;
      const dflt = types.length === 1 ? SOLO_LIMIT : DEFAULT_LIMIT;
      return Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(v) ? Math.floor(v) : dflt));
    };
    const keepBy = {}; for (const t of types) keepBy[t] = baseLimit(t);
    const res = { text: typeof text === 'string' ? text.slice(0, MAX_QUERY) : '', tokens: pq.tokens, types, empty: false, fuzzy: false, ...empty, counts: { songs: 0, albums: 0, artists: 0, mixtapes: 0, stations: 0, total: 0 } };

    if (!pq.tokens.length) {   // nothing typed: what you played / saved lately
      res.empty = true;
      for (const type of types) {
        const arr = ix.docs[type] || [];
        const top = []; let count = 0;
        for (const d of arr) { const b = boostOf(d, now); if (b <= 0) continue; count++; offer(top, keepBy[type], { d, score: b }); }
        res[type] = top.map((h) => present(h.d, h.score, [], false, true)); res.counts[type] = count; res.counts.total += count;
      }
      return res;
    }

    const unsp = FLAG_UNSPACED(pq.tokens);
    const phrase = pq.tokens.length ? pq.tokens.join(' ') : '';
    let pass = runPass(ix, types, pq.tokens, unsp, phrase, false, now, keepBy);
    if (pass.total < FUZZY_BELOW && pq.tokens.some((t, i) => t.length >= 4 && !unsp[i])) {
      const p2 = runPass(ix, types, pq.tokens, unsp, phrase, true, now, keepBy);
      if (p2.total > pass.total) { pass = p2; res.fuzzy = true; }
    }
    for (const type of types) {
      res[type] = pass.out[type].top.map((h) => present(h.d, h.score, pq.tokens, res.fuzzy, false));
      res.counts[type] = pass.out[type].count; res.counts.total += pass.out[type].count;
    }
    return res;
  } catch {
    return { text: '', tokens: [], types: [...TYPES], empty: true, fuzzy: false, ...empty, counts: { songs: 0, albums: 0, artists: 0, mixtapes: 0, stations: 0, total: 0 } };
  }
}

/** Ordered non-empty groups of a result, for rendering: [{ type, label, items, count }]. */
export function groupsOf(result) {
  const LABEL = { songs: 'Songs', albums: 'Albums', artists: 'Artists', mixtapes: 'Mixtapes', stations: 'Radio' };
  return TYPES.filter((t) => result[t] && result[t].length).map((t) => ({ type: t, label: LABEL[t], items: result[t], count: result.counts[t] }));
}
