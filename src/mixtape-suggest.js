// ─────────────────────────────────────────────────────────────────────────────
// mixtape-suggest.js — SUGGESTED TAPES: auto-generated draft mixtapes built from the
// library by pure, deterministic functions that respect the tape caps. The Mixtapes
// page shows them as a small dismissible row; tapping one opens it in the editor as a
// DRAFT (never auto-saved).
//
// Generators (each returns 0..n drafts; a draft needs at least MIN_SONGS songs):
//   recent   Recently added   newest files first (track.added | file.lastModified)
//   played   Most played      from the local play history (read defensively)
//   genre    <Genre>          the top two genres by song count
//   decade   The 1990s...     the top decade by song count (needs track.year)
//   long     Long player      the album with the most playing time
// Library fields used when present: id, title, artist, album, genre, year, durationSec,
// added / file.lastModified. A generator whose data is absent returns nothing (never throws).
//
// Setting keys (for the Settings page): see SUGGEST_KEYS.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createMixtape, addMany, cassetteStyles, PEN_IDS, TAPES, MAX_SONGS_PER_SIDE, refSeconds, makeTrackRef, withText,
  fmtDur,
} from './mixtape.js';
import { groupTracks } from './albums.js';

export const SUGGEST_KEYS = Object.freeze({
  enabled: 'runout.mixtapes.suggest',            // '0' hides the Suggested row everywhere; default on
  dismissed: 'runout.mixtapes.suggest.dismissed', // JSON array of dismissed suggestion ids (reset by the Settings page)
});
export const MIN_SONGS = 5;
export const MAX_SUGGESTIONS = 5;

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const secOf = (t) => refSeconds(makeTrackRef(t)).sec;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const stable = (t) => `${t.id || ''}\0${t.artist || ''}\0${t.album || ''}\0${t.title || ''}`;

const CAP = TAPES.C90.sideSec;

/** Best split index k (A = first k songs) so both sides fit `cap`/20 songs and the sides are as even as possible; -1 if none. */
function splitIndex(secs, cap) {
  const total = secs.reduce((a, b) => a + b, 0);
  let best = -1, bestGap = Infinity, a = 0;
  for (let k = 0; k <= secs.length; k++) {
    if (k > 0) a += secs[k - 1];
    const b = total - a;
    if (a <= cap && b <= cap && k <= MAX_SONGS_PER_SIDE && secs.length - k <= MAX_SONGS_PER_SIDE) {
      const gap = Math.abs(a - b);
      if (gap < bestGap) { bestGap = gap; best = k; }
    }
  }
  return best;
}
/** Smallest tape that holds the list in some A|B split, else C90. */
function pickTape(secs) {
  for (const l of ['C30', 'C60', 'C90']) if (splitIndex(secs, TAPES[l].sideSec) >= 0) return l;
  return 'C90';
}

/**
 * Pour a draft onto a tape split into two sides as even as the order allows (A = a prefix).
 * Pure and deterministic; draft tracks come out of capList so they always fit.
 */
export function draftToMixtape(draft, { id } = {}) {
  const secs = draft.tracks.map(secOf);
  const length = pickTape(secs);
  let m = createMixtape({ id: id || draft.id, name: draft.name, tape: { length },
    cfg: { style: styleFor(draft.id), pen: PEN_IDS[hash(draft.id + 'pen') % PEN_IDS.length] } });
  m = withText(m, { subtitle: draft.tagline || '' });
  const k = Math.max(0, splitIndex(secs, TAPES[length].sideSec));
  const A = addMany(m, 'A', draft.tracks.slice(0, k)).mixtape;
  return addMany(A, 'B', draft.tracks.slice(k)).mixtape;
}

function styleFor(seed) {
  const st = cassetteStyles();
  return st[hash(seed) % st.length].id;
}

/** Keep songs of `list` in order (one per identity) while the whole list still fits a C90 in some A|B split. */
function capList(list) {
  const seen = new Set(), res = [], secs = [];
  for (const t of list) {
    const k = stable(t); if (seen.has(k)) continue; seen.add(k);
    if (res.length >= 2 * MAX_SONGS_PER_SIDE) break;
    secs.push(secOf(t));
    if (splitIndex(secs, CAP) < 0) { secs.pop(); continue; }
    res.push(t);
  }
  return res;
}

const draft = (kind, key, name, tagline, tracks) => ({ id: `sg-${kind}-${hash(key).toString(36)}`, kind, key, name, tagline, tracks });

// ── generators ───────────────────────────────────────────────────────────────
const genAdded = (t) => { const a = Number(t.added) || Number(t.file && t.file.lastModified) || 0; return a > 0 ? a : 0; };

function recent(lib) {
  const dated = lib.filter((t) => genAdded(t) > 0);
  if (dated.length < MIN_SONGS) return [];
  // newest day first, album order inside a day so a fresh album stays together
  const sorted = dated.slice().sort((a, b) => genAdded(b) - genAdded(a) || cmpStr(stable(a), stable(b)));
  const tracks = capList(sorted.slice(0, 40));
  return tracks.length >= MIN_SONGS ? [draft('recent', 'recent', 'Fresh Finds', 'recently added', tracks)] : [];
}

function played(lib, history) {
  const rec = history && history.tracks && typeof history.tracks === 'object' ? history.tracks : null;
  if (!rec) return [];
  const rows = [];
  for (const t of lib) {
    const r = t.id && Object.prototype.hasOwnProperty.call(rec, t.id) ? rec[t.id] : null;
    if (r && Number.isInteger(r.n) && r.n > 0) rows.push({ t, n: r.n, last: Number(r.last) || 0 });
  }
  if (rows.length < MIN_SONGS) return [];
  rows.sort((a, b) => b.n - a.n || b.last - a.last || cmpStr(stable(a.t), stable(b.t)));
  const tracks = capList(rows.slice(0, 40).map((r) => r.t));
  return tracks.length >= MIN_SONGS ? [draft('played', 'played', 'On Repeat', 'most played', tracks)] : [];
}

function genres(lib) {
  const by = new Map();
  for (const t of lib) {
    const g = String(t.genre || '').trim();
    if (!g || /^\(?\d+\)?$/.test(g)) continue;
    const k = g.toLowerCase();
    if (!by.has(k)) by.set(k, { name: g, tracks: [] });
    by.get(k).tracks.push(t);
  }
  const top = [...by.values()].filter((g) => g.tracks.length >= MIN_SONGS)
    .sort((a, b) => b.tracks.length - a.tracks.length || cmpStr(a.name.toLowerCase(), b.name.toLowerCase())).slice(0, 2);
  return top.map((g) => {
    // album order inside the genre (groupTracks order), so it reads like records, not noise
    const ordered = groupTracks(g.tracks).flatMap((a) => a.tracks);
    return draft('genre', 'genre:' + g.name.toLowerCase(), g.name.slice(0, 28), `${g.tracks.length} ${g.name} songs`, capList(ordered));
  }).filter((d) => d.tracks.length >= MIN_SONGS);
}

function decades(lib) {
  const by = new Map();
  for (const t of lib) {
    const y = Number(t.year);
    if (!(y >= 1900 && y <= 2099)) continue;
    const d = Math.floor(y / 10) * 10;
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(t);
  }
  const top = [...by.entries()].filter(([, a]) => a.length >= MIN_SONGS).sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
  if (!top) return [];
  const [d, list] = top;
  const ordered = list.slice().sort((a, b) => (a.year - b.year) || cmpStr(stable(a), stable(b)));
  return [draft('decade', 'decade:' + d, `The ${d}s`, `${list.length} songs from the ${d}s`, capList(ordered))];
}

function longest(lib) {
  const albums = groupTracks(lib).filter((a) => a.tracks.length >= MIN_SONGS);
  if (!albums.length) return [];
  const score = (a) => a.tracks.reduce((n, t) => n + secOf(t), 0);
  albums.sort((a, b) => score(b) - score(a) || cmpStr(a.key, b.key));
  const a = albums[0];
  return [draft('long', 'long:' + a.key, a.title.slice(0, 28), `${a.artist} · the long player`, capList(a.tracks))];
}

/**
 * All suggestions for a library, deterministic for the same input, capped at MAX_SUGGESTIONS.
 * opts: { history (play-history store object, optional), dismissed (ids to hide) }
 * -> [{ id, kind, name, tagline, tracks, count, seconds }]
 */
export function suggestTapes(libraryTracks, { history, dismissed = [] } = {}) {
  const lib = (Array.isArray(libraryTracks) ? libraryTracks : []).filter((t) => t && typeof t.title === 'string' && t.title);
  if (lib.length < MIN_SONGS) return [];
  const hidden = new Set(dismissed);
  const lists = [];
  for (const gen of [() => played(lib, history), () => recent(lib), () => genres(lib), () => decades(lib), () => longest(lib)]) {
    try { lists.push(gen()); } catch { lists.push([]); /* a generator never breaks the page */ }
  }
  // round-robin: one of each kind first, then the extras (a second genre), so the row is varied
  const all = [];
  for (let r = 0; lists.some((l) => l.length > r); r++) for (const l of lists) if (l[r]) all.push(l[r]);
  const seen = new Set(), out = [];
  for (const d of all) {
    if (hidden.has(d.id) || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({ ...d, count: d.tracks.length, seconds: d.tracks.reduce((a, t) => a + secOf(t), 0) });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** "5 songs · 21:40" for the chip subtitle. */
export function suggestionBlurb(s) { return `${s.count} songs · ${fmtDur(s.seconds)}`; }
