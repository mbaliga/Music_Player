// ─────────────────────────────────────────────────────────────────────────────
// index.js — the offline host's public surface. Loaded only by dynamic import() from radio-player.js (through the
// stations.js seam) when the `radio.ai` flag is on and a You station is started; never on the boot path.
// ─────────────────────────────────────────────────────────────────────────────

export { createOfflineSession, loadLocation, saveLocation } from './station-session.js';
export { mountYouPanel } from './panel.js';
export { createShowRunner } from './show-runner.js';
export { reduceShow, initialShow } from './show-state.js';
export { createOfflineContext, daypartFor, localParts, makeTrackFact, HOSTS, STATION_NAME } from './context.js';
export { createOfflineDirector } from './director.js';
export { createTemplateWriter, estimateScriptSec } from './writer.js';
export { BANK, BANK_LINE_COUNT } from './bank.js';
export { createSystemVoice, webSpeechBackend, capacitorBackend, resolveCapacitorTts, prepareUtterance, SYSTEM_CAPS } from './voice.js';
export { createDuckController, applyEnvelope } from './ducking.js';
export { speakable, cleanTitle, cleanArtist } from './pronounce.js';
export { sunTimes, season } from './sun.js';
export { emptyHistory, recordPlay, loadHistory, saveHistory } from './play-history.js';

export const OFFLINE_HOST_VERSION = 1;
