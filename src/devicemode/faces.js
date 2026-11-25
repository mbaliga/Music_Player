// faces.js — the LOCK FACE registry. A section declares which of its controls stay live while the device is locked, and which stay lit
// (and what text stays readable) in the always-on display. Pure data + selector builders; the DOM layer (index.js) and the CSS generator
// both read from here, so there is ONE allowlist. Docs: docs/DEVICE_MODE.md "Add a section face".
//
//   registerLockFace(sectionId, { buttons: [selectors], aod: [selectors], aodText: [selectors], notes: '...' })
//     buttons  controls that stay live while locked. Anything not matched is frozen. Sliders/knobs that act like physical controls go
//              here too (or carry the attribute `data-lock-ok`, which is allowed in every section).
//     aod      the subset drawn lit in AOD (default: all of `buttons`).
//     aodText  text that stays readable (dim) in AOD: the now-playing name and little else.
//     notes    one line shown as the locked-face hint for the section ("The dial is not usable while locked").
//
// Selectors are plain CSS and may be a bit generous; they are evaluated against the whole document (overlays such as the cassette player live
// outside the section element).

/** Allowed in EVERY section while locked: the lock key itself, the unlock/notice/hint UI, explicit opt-ins, the mini bar's Stop / Pause / Next (its title button, which navigates, stays frozen). */
export const GLOBAL_LIVE = Object.freeze(['.dm-key', '.dm-ui', '[data-lock-ok]', '.minibar-stop', '.minibar-toggle', '.minibar-next']);
export const GLOBAL_AOD = Object.freeze(['[data-lock-ok]', '.minibar-stop', '.minibar-toggle', '.minibar-next']);   // the lock key styles itself in AOD (devicemode.css)
export const GLOBAL_AOD_TEXT = Object.freeze(['.dm-key', '.dm-notice', '.minibar-title']);

/** Always frozen, even if a face selector is generous enough to match them: the shell chrome of a fixed device face. */
export const ALWAYS_FROZEN = Object.freeze(['.hamburger', '.drawer', '#edgeStrip', '.card-handle', '#cardCover']);

const faces = new Map();
const clean = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []);

export function registerLockFace(sectionId, face = {}) {
  if (typeof sectionId !== 'string' || !sectionId) return false;
  const buttons = clean(face.buttons);
  faces.set(sectionId, Object.freeze({ id: sectionId, buttons, aod: face.aod ? clean(face.aod) : buttons, aodText: clean(face.aodText), notes: String(face.notes || '') }));
  return true;
}
export const getLockFace = (id) => faces.get(id) || null;
export const registeredFaces = () => [...faces.keys()];
export function _clearFacesForTests() { faces.clear(); }

/** Generic fallback for a section with no registered face: every native button and role=button/switch. Logged by the caller. */
export const GENERIC_FACE = Object.freeze({ buttons: ['button', '[role=button]', '[role=switch]'], aod: ['button', '[role=button]', '[role=switch]'], aodText: [], notes: '' });

/** The live selectors for a section under the given settings. `fxPadWhileLocked` adds the pad to the Booth. */
export function liveSelectors(sectionId, settings = {}) {
  const f = getLockFace(sectionId) || GENERIC_FACE;
  const out = [...GLOBAL_LIVE, ...f.buttons];
  if (sectionId === 'booth' && settings.fxPadWhileLocked) out.push('.fx-pad', '.fx-perf');
  return out;
}
export function aodSelectors(sectionId) { const f = getLockFace(sectionId) || GENERIC_FACE; return [...GLOBAL_AOD, ...f.aod]; }
export function aodTextSelectors(sectionId) { const f = getLockFace(sectionId) || GENERIC_FACE; return [...GLOBAL_AOD_TEXT, ...f.aodText]; }

const join = (a) => a.join(', ');

/** The CSS for one section's locked face (generated; appended to the static devicemode.css). */
export function faceCss(sectionId, settings = {}) {
  const live = liveSelectors(sectionId, settings), aod = aodSelectors(sectionId), txt = aodTextSelectors(sectionId);
  const L = `body[data-devicemode~="locked"][data-dm-section="${sectionId}"]`;
  const A = `body[data-devicemode~="aod"][data-dm-section="${sectionId}"]`;
  const liveJ = join(live), frozenJ = join(ALWAYS_FROZEN);
  return [
    `${L} :is(${liveJ}), ${L} :is(${liveJ}) * { pointer-events: auto; touch-action: manipulation; }`,
    `${L} :is(${frozenJ}) { pointer-events: none !important; }`,
    `${L}[data-dm-dim="1"] #shell :is(:not(:has(*)), svg):not(:is(${liveJ}, ${liveJ.split(', ').map((s) => s + ' *').join(', ')})):not(:has(${liveJ})) { opacity: .84; }`,
    `${A} :is(${join(aod)}) { color: var(--dm-accent) !important; -webkit-text-fill-color: var(--dm-accent) !important; border-color: var(--dm-accent) !important; outline: 1px solid var(--dm-accent) !important; outline-offset: -1px; box-shadow: 0 0 10px var(--dm-glow), inset 0 0 6px var(--dm-glow) !important; }`,
    `${A} :is(${join(aod)}) :is(path, rect, circle, line, polyline, polygon, ellipse, g) { stroke: var(--dm-accent) !important; stroke-width: 1.4px !important; }`,
    `${A} :is(${join(aod)}) text { fill: var(--dm-accent) !important; stroke: none !important; }`,
    `${A} :is(${join(txt)}) { color: var(--dm-ink) !important; -webkit-text-fill-color: var(--dm-ink) !important; }`,
  ].join('\n');
}
