// view.js — the small pure decisions behind the overlay (keyboard stepping, debounce, library change detection, range clamping).
// Kept out of ui.js so they can be tested in node.

/** Active row after a key press in the results list (-1 = none). Wraps; Up from none goes to the last row. */
export function stepActive(i, key, n) {
  if (!(n > 0)) return -1;
  if (key === 'ArrowDown') return i < 0 ? 0 : (i + 1) % n;
  if (key === 'ArrowUp') return i < 0 ? n - 1 : (i - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return i;
}

/** Debounce for typing: instant for small libraries (a query is < 5 ms there), 60 ms once the index is big. */
export const DEBOUNCE_MAX = 60;
export function debounceMs(docCount) { return docCount < 3000 ? 0 : DEBOUNCE_MAX; }

/** A cheap fingerprint of a track list: changes when songs are added / removed / re-linked. Never throws. */
export function librarySignature(tracks) {
  try {
    if (!Array.isArray(tracks)) return '0';
    const n = tracks.length;
    if (!n) return '0';
    const id = (t) => (t && (t.id || t.title)) || '';
    let relinked = 0;
    for (let i = 0; i < n && i < 5000; i++) if (tracks[i] && tracks[i].relink) relinked++;
    return `${n}|${id(tracks[0])}|${id(tracks[n >> 1])}|${id(tracks[n - 1])}|${relinked}`;
  } catch { return '0'; }
}

/** Ranges ([start,end)) -> clean, sorted, non-overlapping ranges inside a string of `len` units. */
export function cleanRanges(ranges, len) {
  const out = [];
  for (const r of Array.isArray(ranges) ? ranges : []) {
    if (!Array.isArray(r)) continue;
    const a = Math.max(0, Math.min(len, r[0] | 0)), b = Math.max(0, Math.min(len, r[1] | 0));
    if (b > a) out.push([a, b]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const m = [];
  for (const r of out) { const l = m[m.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else m.push([r[0], r[1]]); }
  return m;
}

/** text + ranges -> [{ t, mark }] segments (the DOM builder turns these into text nodes and <mark>). */
export function segments(text, ranges) {
  const s = typeof text === 'string' ? text : '';
  const out = [];
  let at = 0;
  for (const [a, b] of cleanRanges(ranges, s.length)) {
    if (a > at) out.push({ t: s.slice(at, a), mark: false });
    out.push({ t: s.slice(a, b), mark: true }); at = b;
  }
  if (at < s.length) out.push({ t: s.slice(at), mark: false });
  return out;
}

export const CHIPS = Object.freeze([
  { id: 'all', label: 'All', types: null },
  { id: 'songs', label: 'Songs', types: ['songs'] },
  { id: 'albums', label: 'Albums', types: ['albums'] },
  { id: 'artists', label: 'Artists', types: ['artists'] },
  { id: 'mixtapes', label: 'Mixtapes', types: ['mixtapes'] },
  { id: 'stations', label: 'Radio', types: ['stations'] },
]);

/** Per-group limits for a chip: the chosen type gets a long list, the others 1 (only their counts are used for the chips). */
export function limitsFor(chip, all = 5, solo = 50) {
  const l = { songs: 1, albums: 1, artists: 1, mixtapes: 1, stations: 1 };
  if (chip === 'all') { for (const k of Object.keys(l)) l[k] = all; return l; }
  if (l[chip] !== undefined) l[chip] = solo;
  return l;
}

/** Should a global key press open search? '/' when typing nowhere, Ctrl/Cmd+K anywhere. */
export function isSearchShortcut(e, target) {
  if (!e || e.defaultPrevented || e.altKey) return false;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'k') return true;
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
    return !(tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable));
  }
  return false;
}
