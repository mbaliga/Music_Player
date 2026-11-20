// booth.js — the mount point of the DJ / FX section. Everything about Workstream X's component is behind ONE line.
//
//   Workstream X exposes mountFxSection(container, deps) -> { unmount, onShow, onHide }. Until it is on main, a clearly marked
//   placeholder is mounted instead. To switch over, change the single line marked MOUNT POINT below to
//       const loadFxSection = () => import('../fx/section.js');      // whatever module exports mountFxSection
//   (the module is then lazy: it is fetched the first time the section is shown, never at boot).
import { BOOTH_LABEL } from './sections.js';

// MOUNT POINT (one line): null = placeholder.
const loadFxSection = null;

/** deps: whatever the FX component needs from the app (engine, host accessors, storage, a blocked() probe); built in main.js. */
export async function mountBooth(host, deps = {}) {
  if (loadFxSection) {
    const mod = await loadFxSection();
    return mod.mountFxSection(host, deps);
  }
  const note = document.createElement('div');
  note.className = 'booth-note'; note.dataset.placeholder = 'fx';
  const b = document.createElement('b'); b.textContent = BOOTH_LABEL;
  note.append(b, 'The DJ and effects section will appear here. (Placeholder: the effects component is not wired in yet.)');
  host.replaceChildren(note);
  return { unmount() { note.remove(); }, onShow() {}, onHide() {} };
}
