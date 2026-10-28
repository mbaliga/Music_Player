# STATE — Runout

## Current state
v0 pre-release, gated on a hardware feel-test on the RedMagic 11 Pro.
Beyond the v0 instrument, the library overlay now has **Albums** (Vinyl vs CD, by `CD1`/`Disc 2` labels), **Mixtapes** (custom cassette playlists, localStorage) and **Radio** (real Radio Browser stations). Desktop-Chromium verified only; see HANDOFF.md "Albums, Mixtapes, Radio".

## Next
Run the v0 feel-gate; if web audio fails latency, swap `audio-engine.js` for native.
Then: on-device check of the three new tabs (radio codecs/mixed content in the WebView); a distinct CD playing view; track-number/disc-number tag parsing; AI/"You" stations via the `stations.js` seam (plan: `docs/RADIO_ARCHITECTURE.md`).
Multi-platform packaging is a plan only (nothing built) and waits on that gate: see `PORTING_PLAN.md`.

## Owner-verified
On-device latency.
