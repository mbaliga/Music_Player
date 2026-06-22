// ─────────────────────────────────────────────────────────────────────────────
// control-layout.js — the lock-free SAB control channel layout.
//
// One Float64Array shared between the main thread (platter physics) and the
// audio worklet (the read loop). This is the hottest path in the app, so it is
// a lock-free SAB ring rather than postMessage — no main-thread scheduling
// jitter between touch and sound (spec §3, "Control path").
//
// These indices are duplicated as constants at the top of worklet.js (which
// cannot import ES modules). If you change them here, change them there too.
// ─────────────────────────────────────────────────────────────────────────────

export const C_TARGET_RATE = 0; // main → worklet : desired playback rate
export const C_READ_POS    = 1; // worklet → main : current readPosition (frames)
export const C_SEEK_POS    = 2; // main → worklet : requested seek position (frames)
export const C_SEEK_GEN    = 3; // main → worklet : bumped to request a seek
export const C_SEEK_ACK    = 4; // worklet → main : last seek gen consumed
export const C_PLAYING     = 5; // main → worklet : 1 = engine live, 0 = silent

export const CONTROL_SLOTS = 8; // a little headroom for future fields
