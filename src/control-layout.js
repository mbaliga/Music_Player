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

// FX section (src/fx, docs/FX.md). All zero = FX off: the worklet's original read loop runs untouched.
export const C_FX_MODE     = 8;  // main → worklet : 0 off, 1 blend scratch, 2 beat repeat, 3 stutter
export const C_FX_ENGAGE   = 9;  // main → worklet : 1 while the finger holds the effect
export const C_FX_LEN      = 10; // main → worklet : slice / retrigger period, frames
export const C_FX_RATE     = 11; // main → worklet : repeat playback rate, or the song-under-the-scratch rate (blend)
export const C_FX_GATE     = 12; // main → worklet : stutter gate length, 0..1 of the period
export const C_FX_AMOUNT   = 13; // main → worklet : blend amount 0..1
export const C_FX_RESUME   = 14; // main → worklet : 0 = resume in time, 1 = resume at the capture point

export const CONTROL_SLOTS = 16;
