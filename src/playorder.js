// playorder.js — shuffle and repeat for an album / "Play all" queue. Pure: no DOM, no engine, no storage.
//
// The queue's TRACK SLOTS never move (slot i is always the same file, title and id: the record layout, the sheet's list, the track-id -> audio
// mapping and the resume record all index by slot). Shuffle only changes the ORDER in which slots are visited: `order` is a permutation of
// 0..n-1. Without shuffle `order` is absent and the order is 0,1,2...
//
//   repeat 'off'  the record ends after the last track of the order
//   repeat 'all'  after the last track of the order it starts again (natural end and Next)
//   repeat 'one'  the track that ends plays again; a pressed Next / Prev still moves on (like every player)
export const REPEATS = Object.freeze(['off', 'all', 'one']);
export const isRepeat = (v) => REPEATS.includes(v);
export const nextRepeat = (v) => REPEATS[(REPEATS.indexOf(v) + 1) % REPEATS.length] || 'off';

/** A fresh visiting order of n slots. Shuffled: `first` (the track being played) leads, the rest in random order (Fisher-Yates). */
export function makeOrder(n, first = 0, shuffle = false, rng = Math.random) {
  const a = Array.from({ length: Math.max(0, n | 0) }, (_, i) => i);
  if (!shuffle || a.length < 2) return a;
  const f = first >= 0 && first < a.length ? first : -1;
  const rest = a.filter((i) => i !== f);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.min(i, Math.floor(rng() * (i + 1))); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return f >= 0 ? [f, ...rest] : rest;
}

/** Is `order` a usable permutation of n slots? */
export function validOrder(order, n) {
  if (!Array.isArray(order) || order.length !== n) return false;
  const seen = new Set(order);
  return seen.size === n && order.every((i) => Number.isInteger(i) && i >= 0 && i < n);
}

/**
 * The slot to go to from `from` in direction dir (+1 / -1), or -1 when the record ends there.
 *   playable(i)  can slot i play right now (has its file, did not fail to decode)
 *   natural      the track ran out by itself (Repeat one replays it; a pressed Next / Prev does not)
 * Walks the order, skipping unplayable slots. With repeat 'all' it wraps; the walk is bounded by n, so a queue with a single playable
 * track returns that track itself (it repeats) and a queue with none returns -1.
 */
export function stepSlot({ n, order = null, from, dir, repeat = 'off', natural = false, playable = () => true }) {
  if (!(n > 0)) return -1;
  if (natural && repeat === 'one' && from >= 0 && from < n && playable(from)) return from;
  const ord = validOrder(order, n) ? order : Array.from({ length: n }, (_, i) => i);
  const p = ord.indexOf(from);
  const wrap = repeat === 'all' || (repeat === 'one' && !natural);
  const d = dir < 0 ? -1 : 1;
  if (p < 0) {   // `from` is not in the order (a stale index): fall back to plain slot order
    for (let j = from + d; j >= 0 && j < n; j += d) if (playable(j)) return j;
    return -1;
  }
  for (let k = 1; k <= n; k++) {
    const raw = p + d * k;
    if (!wrap && (raw < 0 || raw >= n)) return -1;
    const j = ord[((raw % n) + n) % n];
    if (playable(j)) return j;
  }
  return -1;
}
