# STATE — Runout

## Current state
v0 pre-release, gated on a hardware feel-test on the RedMagic 11 Pro.
Beyond the v0 instrument, the library overlay now has **Albums** (Vinyl vs CD, by `CD1`/`Disc 2` labels), **Mixtapes** (custom cassette playlists, localStorage) and **Radio** (real Radio Browser stations). Desktop-Chromium verified only; see HANDOFF.md "Albums, Mixtapes, Radio".

## Next
Run the v0 feel-gate; if web audio fails latency, swap `audio-engine.js` for native.
Then: on-device check of the three new tabs (radio codecs/mixed content in the WebView); AI/"You" stations via the `stations.js` seam (plan: `docs/RADIO_ARCHITECTURE.md`).
Multi-platform packaging is a plan only (nothing built) and waits on that gate: see `PORTING_PLAN.md`.

Vinyl track-jumping (ghost needle, gap drop = next track, flick) and a distinct CD player view are in; desktop-Chromium verified only, knobs listed in HANDOFF.md "Track jumping + CD view" need on-device tuning.

Tag parsing, persisted library metadata (needs re-link) and the bounded-memory gapless mixtape queue are in (desktop-Chromium verified; device decode time/memory unverified; see HANDOFF.md).

## Owner-verified
On-device latency.

## Radio P1 spike
Radio spike P1 done as far as a sandbox allows; verdicts are NEEDS-DEVICE (echo, background audio) and framework-GO (latency). Device procedure and results: `docs/RADIO_SPIKE_P1.md`. Throwaway code in `spike/radio-p1/`.

## AI radio
P0 (contracts and skeleton) done: pure core in `src/radio/core/`, flag `radio.ai` default OFF, not on the boot path, inert `ai-you`/`ai-you-city` station stub. Cue extraction (`cues.js`) done and wired into the sim (synthetic signals only, not validated on real music); web/APK build excludes dev-only core files. P1 device spikes pending (owner). P2 gated on the v0 feel gate and the owner's device results. See HANDOFF.md "AI radio".

