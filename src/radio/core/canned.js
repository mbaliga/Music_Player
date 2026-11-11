// ─────────────────────────────────────────────────────────────────────────────
// canned.js — fact-free fallback lines and local filler (architecture 4.6, 10.2).
//
// When a talk slot cannot be generated (offline, refusal, verifier twice, TTS stall)
// the show swaps in one of these: a short in-character link that claims nothing
// (factRefs [] by construction), or a local stinger/evergreen. They are pre-rendered
// on device in P2; here they are just data so the core can reason about them and the
// tests can prove every canned line passes the verifier.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32 } from './util.js';

export const CANNED_TEXTS = Object.freeze([
  'That one is for whoever needed it. More music coming right up.',
  "Stay right there. We've got plenty more in the crate.",
  "{pause:300} Good to have you with me. Let's keep it rolling.",
  'No chatter, just records. Turn it up a little.',
  "That's the sound. Keep it close, there's more where that came from.",
]);

/** Quota / spend ceiling (429): one in-character line, then music only. */
export const ON_A_BREAK_TEXT = "We're taking a short break here at the station. Music coming right up.";

/** Local pre-rendered audio the bus can always play. durationSec is the authored length. */
export const LOCAL_STINGERS = Object.freeze([
  { id: 'stinger.id.1', kind: 'stinger', durationSec: 6 },
  { id: 'stinger.id.2', kind: 'stinger', durationSec: 5 },
  { id: 'filler.evergreen.1', kind: 'filler', durationSec: 40 },
]);

/** A Script for slotId with no facts. `seed` varies the pick deterministically. */
export function cannedScript(slotId, seed = 0) {
  const text = CANNED_TEXTS[Math.floor(mulberry32(seed + 17)() * CANNED_TEXTS.length)];
  return {
    schemaVersion: 1,
    slotId,
    utterances: [{ id: `${slotId}.canned`, text, style: { emotion: 'warm', energy: 0.4, pace: 1 }, factRefs: [], droppable: false }],
  };
}

export const localStingerById = (id) => LOCAL_STINGERS.find((s) => s.id === id) || null;

/** The in-character "on a break" line as a Script (no facts). */
export function breakScript(slotId) {
  return {
    schemaVersion: 1,
    slotId,
    utterances: [{ id: `${slotId}.break`, text: ON_A_BREAK_TEXT, style: { emotion: 'warm', energy: 0.35, pace: 1 }, factRefs: [], droppable: false }],
  };
}
