// aodhooks.js — the renderer hook for the always-on display. A stage that draws heavy imagery (the Albums stage's canvas layers, the cassette
// player) subscribes once and switches to an outline-only (or nothing) draw while AOD is on:
//
//   import { onAodOutlineMode } from '../devicemode/aodhooks.js';
//   const off = onAodOutlineMode((on) => { stage.outlineOnly = on; stage.requestDraw(); });   // called immediately with the current value
//
// Until a module subscribes, index.js hides its canvases by CSS (visibility: hidden) and nothing is drawn.
let on = false;
const subs = new Set();
export const aodOutlineMode = () => on;
export function setAodOutlineMode(b) {
  b = !!b; if (b === on) return;
  on = b; for (const f of [...subs]) { try { f(on); } catch { /* a renderer must not break the mode switch */ } }
}
export function onAodOutlineMode(f) { subs.add(f); try { f(on); } catch { /* */ } return () => subs.delete(f); }
