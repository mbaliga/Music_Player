// ─────────────────────────────────────────────────────────────────────────────
// engine-gate.js — who owns the shared playback engine right now, as a counter.
//
// The engine-backed stations (You Radio, canned shows) decode on the shared engine through a host port (main.js makeAiHost).
// A decode takes a while, and in that time the user may press Stop, switch source or start a record / tape. Every such event
// bumps the epoch; a radio load / prepare captured the token when it began and refuses to install its song if the epoch moved.
//   const t = gate.token();  ...await decode...  if (gate.stale(t)) throw new Error('superseded');
// ─────────────────────────────────────────────────────────────────────────────

export function createEngineGate() {
  let epoch = 0;
  return {
    token: () => epoch,
    bump() { epoch++; return epoch; },
    stale: (t) => t !== epoch,
    /** throw if `t` is out of date (call right before touching the engine / app state) */
    check(t) { if (t !== epoch) throw new Error('superseded'); },
  };
}
