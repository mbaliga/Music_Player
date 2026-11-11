// ─────────────────────────────────────────────────────────────────────────────
// song-select.js — on-device, deterministic song choice (architecture 3.2, 5).
//
// The Director only states CONSTRAINTS (mood, energy, genres, artists) and an
// optional trackIdHint; the track that actually plays is chosen here from the
// listener's own library shortlist (libraryDigest.candidates). No LLM, no network,
// no randomness except a seeded PRNG: same (seed, slot, library, history) always
// gives the same track. A track never repeats within a show, never comes from
// excludeTrackIds, and ids the model invented are never returned.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32, hashSeed, normText } from './util.js';

const lc = (a) => (Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : []);

function score(t, c, state, rng) {
  let s = 0;
  if (c.genres && lc(c.genres).includes(String(t.genre || '').toLowerCase())) s += 2;
  if (c.artistsAnyOf && lc(c.artistsAnyOf).includes(String(t.artist || '').toLowerCase())) s += 3;
  if (typeof c.energy === 'number' && typeof t.energy === 'number') s += 2 * (1 - Math.abs(t.energy - c.energy));
  if (state.lastArtist && t.artist === state.lastArtist) s -= 3;
  else if ((state.recentArtists || []).includes(t.artist)) s -= 1;
  if (t.lastPlayedAgoSec === null || t.lastPlayedAgoSec === undefined) s += 1;
  else if (t.lastPlayedAgoSec < 3600) s -= 2;
  return s + rng() * 0.5; // seeded tie-break
}

/**
 * pickTrack({candidates, constraints, hint, state, seed, slotKey}) ->
 *   {trackId, reason:'hint'|'scored'} | {trackId:null, reason:'empty'|'exhausted'}
 * state = {playedIds:[], excludeIds:[], lastArtist, recentArtists:[]}
 */
export function pickTrack({ candidates, constraints = {}, hint = null, state = {}, seed = 0, slotKey = '' }) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { trackId: null, reason: 'empty' };
  const blocked = new Set([...(state.playedIds || []), ...(state.excludeIds || [])]);
  const pool = list.filter((t) => t && typeof t.trackId === 'string' && !blocked.has(t.trackId));
  if (!pool.length) return { trackId: null, reason: 'exhausted' };
  if (hint && pool.some((t) => t.trackId === hint)) return { trackId: hint, reason: 'hint' };
  const rng = mulberry32(hashSeed(`${seed}|${slotKey}`));
  const scored = pool.map((t) => ({ t, s: score(t, constraints || {}, state, rng) }));
  scored.sort((a, b) => b.s - a.s || (a.t.trackId < b.t.trackId ? -1 : 1));
  return { trackId: scored[0].t.trackId, reason: 'scored' };
}

/**
 * Fill every song slot of a rundown in order, threading history so nothing repeats.
 * -> {picks: Map(slotId -> trackId|null), state}   (state is a new object)
 */
export function planSongs(slots, candidates, { state = {}, seed = 0 } = {}) {
  const st = { playedIds: [...(state.playedIds || [])], excludeIds: [...(state.excludeIds || [])], lastArtist: state.lastArtist || null, recentArtists: [...(state.recentArtists || [])] };
  const byId = new Map((candidates || []).map((t) => [t.trackId, t]));
  const picks = new Map();
  for (const sl of slots || []) {
    if (!sl || sl.kind !== 'song') continue;
    const song = sl.song || {};
    const r = pickTrack({ candidates, constraints: song.constraints, hint: song.trackIdHint, state: st, seed, slotKey: sl.slotId });
    picks.set(sl.slotId, r.trackId);
    if (r.trackId) {
      const t = byId.get(r.trackId);
      st.playedIds.push(r.trackId);
      st.lastArtist = t.artist;
      st.recentArtists = [...st.recentArtists, t.artist].slice(-3);
    }
  }
  return { picks, state: st };
}

/**
 * Resolve a listener's song request against the library ONLY (never invented).
 * -> {trackId, confidence:'exact'|'title'|'artist'|'words'} | null
 */
export function resolveRequest(query, candidates, { excludeIds = [] } = {}) {
  const q = normText(query);
  if (!q) return null;
  const ex = new Set(excludeIds);
  const pool = (candidates || []).filter((t) => t && !ex.has(t.trackId));
  const exact = pool.find((t) => normText(t.title) === q);
  if (exact) return { trackId: exact.trackId, confidence: 'exact' };
  const titleIn = pool.find((t) => normText(t.title) && q.includes(normText(t.title)));
  if (titleIn) return { trackId: titleIn.trackId, confidence: 'title' };
  const artistIn = pool.find((t) => normText(t.artist) && q.includes(normText(t.artist)));
  if (artistIn) return { trackId: artistIn.trackId, confidence: 'artist' };
  const qw = new Set(q.split(' ').filter((w) => w.length > 3));
  let best = null, bestN = 0;
  for (const t of pool) {
    const n = normText(`${t.title} ${t.artist}`).split(' ').filter((w) => qw.has(w)).length;
    if (n > bestN) { best = t; bestN = n; }
  }
  return best && bestN >= 2 ? { trackId: best.trackId, confidence: 'words' } : null;
}
