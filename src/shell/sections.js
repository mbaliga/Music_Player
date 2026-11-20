// sections.js — the section registry, ordering and persistence of the last-visited section. Pure (storage is injected).

// ── THE NAME OF THE DJ / FX SECTION ─────────────────────────────────────────────────────────────────────────────────────
// 'Booth' is a working name (a DJ booth); the owner has not approved it. Rename it HERE, nowhere else: the drawer, the page
// title, the walkthrough and the now-playing bar all read this constant.
export const BOOTH_LABEL = 'Booth';

/** Menu order. `home` = the section a now-playing source returns to. */
export const SECTIONS = Object.freeze([
  Object.freeze({ id: 'albums', label: 'Albums' }),
  Object.freeze({ id: 'mixtapes', label: 'Mixtapes' }),
  Object.freeze({ id: 'radio', label: 'Radio' }),
  Object.freeze({ id: 'booth', label: BOOTH_LABEL }),
]);

export const DEFAULT_SECTION = 'albums';
export const STORAGE_KEY = 'runout.section';

export const ids = (list = SECTIONS) => list.map((s) => s.id);
export const labelOf = (id, list = SECTIONS) => (list.find((s) => s.id === id) || {}).label || '';
export const indexOf = (id, list = SECTIONS) => Math.max(0, list.findIndex((s) => s.id === id));

/** A stored/unknown id -> a valid section id (the default for anything not in the registry). */
export function resolveSection(id, list = SECTIONS) {
  return list.some((s) => s.id === id) ? id : (list.some((s) => s.id === DEFAULT_SECTION) ? DEFAULT_SECTION : list[0].id);
}

export function loadSection(storage, list = SECTIONS) {
  try { return resolveSection(storage && storage.getItem(STORAGE_KEY), list); } catch { return resolveSection(null, list); }
}
export function saveSection(storage, id) {
  try { if (!storage) return false; storage.setItem(STORAGE_KEY, id); return true; } catch { return false; }
}

/** Keyboard navigation inside the menu: index after a key (wraps). Unhandled keys return the same index. */
export function stepMenu(index, key, n) {
  if (n <= 0) return 0;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (index + 1) % n;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (index - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return index;
}

/** Which section a now-playing source belongs to (the mini bar sends you there). */
export const HOME_OF = Object.freeze({ album: 'albums', mixtape: 'mixtapes', radio: 'radio' });
