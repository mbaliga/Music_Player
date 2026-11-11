// ─────────────────────────────────────────────────────────────────────────────
// index.js — the public surface of the pure radio core (see README.md).
// Loaded only by dynamic import() when the `radio.ai` flag is on; never on the boot path.
// ─────────────────────────────────────────────────────────────────────────────

export * from './schemas.js';
export * from './markup.js';
export * from './numbers.js';
export * from './grounding.js';
export * from './canned.js';
export * from './untrusted.js';
export * from './memory.js';
export * from './song-select.js';
export * from './director-client.js';
export { ShowClock, LEAD, STAGES as TASK_STAGES } from './show-clock.js';
export * from './scheduler.js';
export * from './turn-taking.js';
export * from './latency.js';
export { mulberry32, hashSeed, normText, clamp } from './util.js';
export * from './cues.js';
// Fakes, fixtures and the simulated show are dev/test tooling and are NOT exported here (this barrel is what the
// lazy import ships to the APK; scripts/build-web.mjs excludes the dev files). Import them from './dev.js'.

export const CORE_VERSION = 1;
