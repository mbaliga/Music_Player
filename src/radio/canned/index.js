// ─────────────────────────────────────────────────────────────────────────────
// index.js — the canned stations' public surface. Loaded only by dynamic import() from radio-player.js (through the stations.js
// seam) when the Radio tab is opened or a pre-written station is started; never on the boot path.
// ─────────────────────────────────────────────────────────────────────────────

export { createCannedSession, loadStationPack, loadAudioPack, loadStationsIndex } from './session.js';
export { mountCannedPanel } from './panel.js';
export { renderDial } from './dial.js';
export { parsePack, validatePackDoc } from './pack.js';
export { createChooser, CADENCE, canFollow } from './chooser.js';
export { chooseShowSource, CLOUD_AVAILABLE } from './policy.js';
export { createFallbackController } from './fallback.js';
export { createNetAdapter } from './net.js';
export { buildCatalog, CANNED_TYPE, PRE_WRITTEN_LABEL } from './catalog.js';
export { AI_STYLES, AUDITION_SCRIPT } from './ai-styles.js';

export const CANNED_VERSION = 1;
