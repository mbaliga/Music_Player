// ─────────────────────────────────────────────────────────────────────────────
// stations.js — the STATION-TYPE seam.
//
// Everything the Radio tab lists is a Station of some registered StationType.
// Today there is exactly one type, 'radio-browser' (real public streams). This
// file is where other kinds will plug in WITHOUT touching the Radio UI:
//
//   ┌─ EXTENSION POINT ──────────────────────────────────────────────────────┐
//   │ AI radio ("You" / "You City") registers its own StationType(s) — see    │
//   │ docs/RADIO_ARCHITECTURE.md — with the same shape. A generated station   │
//   │ has no stream URL, so a type's behaviour is a *session*, not a URL.     │
//   │ P0 ships only an INERT STUB ('ai-you', 'ai-you-city', bottom of file):  │
//   │ registered only when the `radio.ai` flag is on, and its session cannot  │
//   │ play yet. The engine arrives in P2 (src/radio/core/).                   │
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
//     phase ∈ 'idle' | 'connecting' | 'buffering' | 'reconnecting' | 'playing' | 'error'
//     (the reducer in radio.js:reduceSession is the reference state machine)
//   Identity for favourites/recents is (station.type, station.id) — see radio-store.js; ids must be
//   stable across sessions (a directory UUID, or e.g. 'you' / 'you-city:<slug>' for AI stations).
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

// ── AI stations (P0 stub) ─────────────────────────────────────────────────────
//
// Same "one dial" identity as every other station: (type, id) -> radio-store key "type|id".
//   You Radio       { type:'ai-you',      id:'you' }
//   You City Radio  { type:'ai-you-city', id:'you-city:<slug>' }   (slug = a typed or saved city)
// A snapshot is identity + display fields only (no stream URL), so a favourite survives
// with no network. Pure builders; they work whether or not the flag is on, so a favourite
// saved earlier still lists. Only *playing* needs the type registered.

export const AI_TYPE_YOU = 'ai-you';
export const AI_TYPE_YOU_CITY = 'ai-you-city';

export const aiYouStation = () => ({ type: AI_TYPE_YOU, id: 'you', name: 'You Radio', tags: ['ai'] });
export const aiYouCityStation = (slug = 'home') => ({
  type: AI_TYPE_YOU_CITY, id: `you-city:${String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home'}`,
  name: 'You City Radio', tags: ['ai'],
});

/**
 * The inert Session: it can load the lazily-imported core (to prove the seam end to end) but has no
 * engine, so start() ends in a clear 'error' phase. Replaced by the real show session in P2.
 */
function createAiStubSession(station, env = {}, loadCore) {
  let state = { phase: 'idle', error: null };
  let cb = () => {};
  let gen = 0;
  const set = (s) => { state = s; cb(state); };
  return {
    onChange(fn) { cb = fn; },
    get state() { return state; },
    async start() {
      const my = ++gen;
      set({ phase: 'connecting', error: null });
      try { if (typeof loadCore === 'function') await loadCore(); } catch { /* core failing to load is the same outcome */ }
      if (my !== gen) return;
      set({ phase: 'error', error: { kind: 'unavailable', message: 'AI radio is not available in this build yet.' } });
    },
    stop() { gen++; set({ phase: 'idle', error: null }); },
  };
}

/**
 * Register the AI station types IF the flag is on. Returns whether it did.
 *   isEnabled: () => boolean            (reads the `radio.ai` flag; see src/radio/flag.js)
 *   loadCore:  () => Promise<module>    (a dynamic import of src/radio/core; supplied by the caller
 *                                        so this file never names the core and the boot-path test
 *                                        can prove the core is not statically reachable)
 * Off (the default): registers nothing and calls neither argument beyond isEnabled.
 */
export function registerAiStationTypes({ isEnabled, loadCore } = {}) {
  let on = false;
  try { on = typeof isEnabled === 'function' && isEnabled() === true; } catch { on = false; }
  if (!on) return false;
  registerStationType({ id: AI_TYPE_YOU, label: 'You Radio', createSession: (station, env) => createAiStubSession(station, env, loadCore) });
  registerStationType({ id: AI_TYPE_YOU_CITY, label: 'You City Radio', createSession: (station, env) => createAiStubSession(station, env, loadCore) });
  return true;
}
