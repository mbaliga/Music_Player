// ─────────────────────────────────────────────────────────────────────────────
// flag.js — the `radio.ai` feature flag (docs/RADIO_ARCHITECTURE.md 3.1, 11 P0).
//
// AI radio ("You" / "You City") is OFF by default and, when off, changes nothing: no
// station type is registered, no radio/core module is fetched, no network is touched.
// This file is the only part of src/radio/ the app boot path imports, so it has no imports.
//
// There is deliberately no UI for the flag in P0. A developer turns it on from the
// console:  localStorage.setItem('runout.flag.radio.ai', '1')  (reload to apply).
// Storage is injected (anything with getItem/setItem/removeItem) and every access is
// try/caught, so blocked storage means "off", never an error.
// ─────────────────────────────────────────────────────────────────────────────

export const RADIO_AI_FLAG = 'radio.ai';
export const RADIO_AI_STORAGE_KEY = 'runout.flag.radio.ai';

/** true only when the flag was explicitly set to '1'. Default and every failure: false. */
export function isRadioAiEnabled(storage) {
  try { return !!storage && storage.getItem(RADIO_AI_STORAGE_KEY) === '1'; } catch { return false; }
}

/** Dev helper. true when written. */
export function setRadioAiEnabled(storage, on) {
  try {
    if (on) storage.setItem(RADIO_AI_STORAGE_KEY, '1'); else storage.removeItem(RADIO_AI_STORAGE_KEY);
    return true;
  } catch { return false; }
}
