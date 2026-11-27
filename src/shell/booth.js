// booth.js — the mount point of the DJ / FX section: lazy-loads src/fx/section.js (mountFxSection) the first time the Booth is shown,
// never at boot. deps are whatever the FX component needs from the app (engine, host accessors, storage, a blocked() probe); built in main.js.
import { onAodOutlineMode } from '../devicemode/aodhooks.js';

const loadFxSection = () => import('../fx/section.js');

export async function mountBooth(host, deps = {}) {
  const mod = await loadFxSection();
  const h = await mod.mountFxSection(host, deps);
  if (h && h.setAod) { const off = onAodOutlineMode((on) => h.setAod(on)); const un = h.unmount; h.unmount = (...a) => { off(); return un && un.apply(h, a); }; }   // device mode AOD: no drawing
  return h;
}
