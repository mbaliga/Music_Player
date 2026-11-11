# STATE — Runout

## Current state
v0 pre-release, gated on a hardware feel-test on the RedMagic 11 Pro.
Beyond the v0 instrument, the library overlay now has **Albums** (Vinyl vs CD, by `CD1`/`Disc 2` labels), **Mixtapes** (custom playlists as the owner's 37-style cassettes with a label editor, two player skins and reel physics driven by real playback; localStorage) and **Radio** (real Radio Browser stations). Desktop-Chromium verified only; see HANDOFF.md "Albums, Mixtapes, Radio".

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

**You Radio (offline host)** is built and usable: Radio tab > Settings > "AI stations (experimental)" (default off) adds a station with templated hosts and the phone's own speech, no network, no models (`src/radio/offline/`; HANDOFF.md "You Radio (offline host)"; architecture section 16). Desktop-Chromium verified with INJECTED fake speech only: headless Chromium has no TTS voices, so real speech has not been heard and nothing is verified on the RedMagic (on-device checklist in HANDOFF.md).

## Mixtapes (Workstream C)
The owner's cassette/mixtape design system is ported (`src/cassette/`, model v3 in `src/mixtape.js`): 37 styles, label editor, shelf, back-of-case, deck + player skins, reels driven by the real gapless queue, wind keys that seek. Desktop-Chromium verified only; on-device checklist in HANDOFF.md "Cassette mixtapes". Left out: flip-depth studio, synthesized audio, Google Fonts (see HANDOFF.md).

## Canned stations + the dial (Workstream P)
When the phone is offline the app still has radio: six pre-written fictional stations (`content/stations/`) play between the user's own songs, visible without the AI flag and labelled "Pre-written show". The Radio tab now has a station picker ("the dial"): the six stations as cards, plus (flag on) the five AI styles greyed "Needs internet — coming soon". Voices: pre-rendered recordings when an audio pack exists (none yet), else the phone's own speech with a distinguishable voice per cast member; a source-fallback policy (`chooseShowSource`, cloud never chosen while `CLOUD_AVAILABLE` is false) and a switch hook are ready for the cloud phase. Mechanical content review findings: `docs/CANNED_REVIEW_FINDINGS.md` (renames are owner decisions, not applied). Desktop-Chromium verified with INJECTED fake speech only; real speech never heard, nothing tested on the RedMagic (checklist in HANDOFF.md "Canned stations and the dial").
