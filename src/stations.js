// ─────────────────────────────────────────────────────────────────────────────
// stations.js — the STATION-TYPE seam.
//
// Everything the Radio tab lists is a Station of some registered StationType.
// Today there is exactly one type, 'radio-browser' (real public streams). This
// file is where other kinds will plug in WITHOUT touching the Radio UI:
//
//   ┌─ EXTENSION POINT ──────────────────────────────────────────────────────┐
//   │ AI radio ("You" / "You City") is NOT implemented here. It will register│
//   │ its own StationType(s) — see docs/RADIO_ARCHITECTURE.md — by calling    │
//   │ registerStationType({...}) with the same shape. A generated station has │
//   │ no stream URL, so a type's behaviour is a *session*, not a URL:         │
//   └────────────────────────────────────────────────────────────────────────┘
//
//   StationType = {
//     id:       string               unique, e.g. 'radio-browser'
//     label:    string               shown as the section heading
//     browse?:  (query) => Promise<{ ok, stations[], error?, kind? }>
//                                    how to LIST stations of this type (optional:
//                                    a type may offer fixed stations only)
//     createSession: (station, env) => Session
//   }
//   Station  = { type, id, name, ... }            (type must match a StationType.id)
//   Session  = { start(): Promise<void>, stop(): void,
//                onChange(cb: ({phase, error}) => void): void }
//     phase ∈ 'idle' | 'connecting' | 'buffering' | 'playing' | 'error'
//     (the reducer in radio.js:reduceSession is the reference state machine)
//   env      = { audioElement?, isOnline(), ... }  supplied by the host
//
// Pure registry, no DOM. The real-stream Session (an <audio> element) is in
// radio-player.js, which registers the 'radio-browser' type at boot.
// ─────────────────────────────────────────────────────────────────────────────

const registry = new Map();

export function registerStationType(type) {
  if (!type || typeof type.id !== 'string' || !type.id) throw new Error('StationType needs an id');
  if (typeof type.createSession !== 'function') throw new Error(`StationType "${type.id}" needs createSession()`);
  registry.set(type.id, type);
}

export const getStationType = (id) => registry.get(id) || null;
export const listStationTypes = () => [...registry.values()];
export const _resetStationTypes = () => registry.clear(); // tests only

/** Session for a station via its type; null if its type isn't registered. */
export function createSessionFor(station, env) {
  const t = station && getStationType(station.type);
  return t ? t.createSession(station, env) : null;
}
