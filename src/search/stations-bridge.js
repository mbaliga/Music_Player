// stations-bridge.js — the radio-side reads Search and Settings need, behind ONE lazy door (main.js imports this file dynamically).
// The boot path must stay free of radio code (test/radio-core/boot-path.test.mjs), so everything that touches src/radio*.js lives here.
import { loadModel, saveModel, clearRecents } from '../radio-store.js';
import { isRadioAiEnabled } from '../radio/flag.js';

export { loadModel, saveModel, clearRecents, isRadioAiEnabled };

/** The pre-written stations index (a local asset: content/stations/index.json shipped as stations/index.json). No network. */
export async function loadCannedIndex(base = document.baseURI) {
  const m = await import('../radio/canned/session.js');
  return m.loadStationsIndex({ fetchFn: (u, o) => fetch(u, o), baseUrl: base });
}

/** Forget the per-station host voice choices (Settings -> Radio). */
export async function resetHostVoices(storage) {
  const m = await import('../radio/canned/voices.js');
  try { storage.removeItem(m.VOICE_PREFS_KEY); return true; } catch { return false; }
}
