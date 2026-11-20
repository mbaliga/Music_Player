// ─────────────────────────────────────────────────────────────────────────────
// divisions.js — beat / slice-length maths for the FX section (pure, no browser globals).
//
// A "division" is a fraction OF ONE BEAT: 1/1 is one whole beat, 1/16 is a sixteenth of a beat.
// (This follows the owner's brief literally. At 120 BPM: 1/1 = 500 ms ... 1/16 = 31 ms, which is a buzz, not a rhythm.)
// The beat length comes from tempo.js when it is confident; otherwise a FIXED beat length is used and the UI says so.
// ─────────────────────────────────────────────────────────────────────────────

export const DIVISIONS = Object.freeze(['1/1', '1/2', '1/4', '1/8', '1/16']);
export const DIV_BEATS = Object.freeze({ '1/1': 1, '1/2': 1 / 2, '1/4': 1 / 4, '1/8': 1 / 8, '1/16': 1 / 16 });

/** Fixed beat used when no confident tempo exists (500 ms = 120 BPM). Shown on screen as "fixed". */
export const FALLBACK_BEAT_SEC = 0.5;
/** Minimum tempo-estimator confidence (0..1) for the beat length to be believed. */
export const MIN_TEMPO_CONFIDENCE = 0.3;
/** A slice never gets shorter than this many frames (keeps the loop wrap cross-fade meaningful). */
export const MIN_SLICE_FRAMES = 96;
/** Upper bound on a slice, seconds (1/1 of a very slow tempo): bounds how far back a capture reaches. */
export const MAX_SLICE_SEC = 3;

export const isDivision = (d) => typeof d === 'string' && Object.prototype.hasOwnProperty.call(DIV_BEATS, d);
export const clampDivision = (d, fallback = '1/4') => (isDivision(d) ? d : fallback);

/**
 * Beat length from a tempo estimate `{bpm, confidence}` (or null).
 * -> { beatSec, bpm, fixed }  `fixed` is true when the fallback beat is in use.
 */
export function beatInfo(tempo, { minConfidence = MIN_TEMPO_CONFIDENCE, scale = 1 } = {}) {
  const ok = tempo && Number.isFinite(tempo.bpm) && tempo.bpm >= 30 && tempo.bpm <= 300
    && Number.isFinite(tempo.confidence) && tempo.confidence >= minConfidence;
  if (!ok) return { beatSec: FALLBACK_BEAT_SEC, bpm: 60 / FALLBACK_BEAT_SEC, fixed: true };
  const s = scale === 0.5 || scale === 2 ? scale : 1;     // the user's "half / double" octave fix
  const bpm = tempo.bpm * s;
  return { beatSec: 60 / bpm, bpm, fixed: false };
}

/** Slice length in frames for a division. Clamped to [MIN_SLICE_FRAMES, MAX_SLICE_SEC]. */
export function sliceFrames(div, beatSec, sampleRate) {
  const beats = DIV_BEATS[clampDivision(div)];
  const raw = Math.round(beats * beatSec * sampleRate);
  return Math.max(MIN_SLICE_FRAMES, Math.min(Math.round(MAX_SLICE_SEC * sampleRate), raw));
}

export const sliceMs = (div, beatSec) => DIV_BEATS[clampDivision(div)] * beatSec * 1000;

/** Fraction of one beat a division covers, for the red slice bar (1/1 -> 1 ... 1/16 -> 0.0625). */
export const sliceFraction = (div) => DIV_BEATS[clampDivision(div)];

export function stepDivision(div, dir) {
  const i = DIVISIONS.indexOf(clampDivision(div));
  return DIVISIONS[Math.max(0, Math.min(DIVISIONS.length - 1, i + (dir > 0 ? 1 : dir < 0 ? -1 : 0)))];
}

/** Human label of the beat source: "120 BPM" or "fixed 500 ms beat (no tempo found)". */
export function beatLabel(info) {
  return info.fixed ? `no tempo found · fixed ${Math.round(info.beatSec * 1000)} ms beat` : `${Math.round(info.bpm * 10) / 10} BPM`;
}
