// guard.js — the gesture guard. Every gesture entry point that a parent surface owns asks `allowsGesture(kind)` before it starts.
// Deliberately tiny and dependency-free so any module can import it. The DOM layer (index.js) calls `_setGuard` as the state changes.
//
// kind                    live while locked?
//   'button' 'key'          yes   (a press on an allowed control; also 'wind-hold': holding a wind key is a button press)
//   'wind-hold' 'slider'    yes
//   'fx-pad'                only when the setting `fxPadWhileLocked` is on (default off)
//   everything else         no    ('drawer-drag' 'platter-scrub' 'tonearm-drag' 'pinch-zoom' 'coverflow-swipe' 'list-scroll' 'text-input'
//                                   'stage-drag' 'select' 'context-menu' 'tape-stack' ...)
const LIVE = new Set(['button', 'key', 'wind-hold', 'slider']);
let locked = false, fxPad = false, aod = false;

export function allowsGesture(kind) {
  try {
    if (!locked) return true;
    if (LIVE.has(kind)) return true;
    if (kind === 'fx-pad') return fxPad;
    return false;
  } catch { return true; }          // a broken guard must never freeze the app
}
export const isLocked = () => locked;
export const isAod = () => aod;
export function _setGuard(s) { locked = !!(s && s.locked); aod = !!(s && s.aod); fxPad = !!(s && s.fxPadWhileLocked); }
