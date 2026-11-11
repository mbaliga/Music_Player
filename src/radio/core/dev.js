// ─────────────────────────────────────────────────────────────────────────────
// dev.js — dev/test-only barrel: fakes, fixtures and the simulated show. Never imported by shipped code and
// excluded from the web/APK build (scripts/build-web.mjs). index.js (the shipped lazy barrel) does not touch it.
// ─────────────────────────────────────────────────────────────────────────────

export * from './fake-adapters.js';
export * from './fixtures.js';
export { runSimulatedShow, makeFakeAdapters, extractedCuesFor } from './sim.js';
