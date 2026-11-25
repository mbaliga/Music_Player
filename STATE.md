# STATE — Runout

Short status. The full handoff (section map, architecture, verified vs not, on-device checklist, open decisions) is `HANDOFF.md`; the overview is `README.md`.

## Where we are

**v0 pre-release, gated on a hands-on feel test on the RedMagic 11 Pro** (owner-verified on-device latency / scrub feel is the one gate; not yet done).
The app is five sections behind a pull-aside drawer: **Albums** (vinyl stage + coverflow library + CD view), **Mixtapes** (cassette stack, editor, sides, AUTO / FLIP),
**Radio** (stations, six pre-written offline shows, a flagged offline "You Radio"), **Booth** (performance effects; working name) and **Settings**; plus a global
**Search** overlay, a **lock key** with a frozen face and a dim always-on display, and, in the Android app, the **phone's own music library** (MediaStore).
All of it has been integrated and exercised together by `scripts/verify-tour.py` in desktop Chromium; **nothing has been run on a phone by us**.

## Verified (desktop Chromium, node)

`npm test`: all pass (1,099, 1 skipped). `python3 scripts/verify-all.py`: every browser verifier plus the end-to-end tour (see `HANDOFF.md` §1 for what each proves).
CI builds the debug APK on every push, compiling both custom Java plugins (device library, device display). Tour measurements (headless CPU renderer, not a phone)
are in the table below (run B of `verify-all.py`; the screenshots of the tour are in `docs/screenshots/tour/`, 1x, 412x915 portrait + landscape + the native and 5k phases).

| measure | value |
|---|---|
| first interactive (Play tapped and acting, local server) | 0.72 s (app ready 0.55 s, first paint 79 ms; 98 requests, 1.17 MB at boot) |
| app boot with a 5,000-track library | 0.66 s (400 albums in the coverflow) |
| Albums stage cost per frame while playing | 2.4 ms average, 4.1 ms worst (about 31 frames/s on this machine's CPU renderer) |
| JS heap after the whole tour (after GC) | 6.8 MB used at the end of the tour (3.9 MB after a reload and playing); JS heap only, decoded audio buffers are off-heap and not counted |
| search over 5,000 songs | about 96 ms to first results, 87 ms for a later query (including the debounce); the mixtape picker answers in 15 ms |
| `www/` shipped | 2,830 KB in 190 files (JS 1,493 KB); largest `assets/mat.jpg` 216 KB, then the station packs at 120-146 KB each |

## UX round (final integration)

Seven parallel UX fixes were merged and proven together: `verify-tour.py` has a real-library journey that asserts the audio actually playing is the chosen real track (dominant frequency of the engine output, never the Demo record). Found and fixed while integrating: the stage measured its card while the shell scaled it (the now-playing line sat on the keys after visiting another section); a tape kept "owning" the engine after the user started an album track (Booth said a mixtape was playing); `verify-you-radio.py` crashed on an empty list (now fixed and a real gate); the Device mode sheet is full width on landscape phones; Booth landscape rows / switches / pads are 44 px tall. On-device checklist item 12 in `HANDOFF.md` §6 lists what only a phone can settle.

## Final integration pass (four fix rounds: shell/turntable/native, playback + memory, Booth/mixtape/radio, first-time user)

`verify-all.py` was run twice on the merged main (all 13 scripts). The only failure that repeated was `verify-canned-radio.py` (a stale test: since the single-Stop change the dial card's own Stop is hidden while a show plays, so the script now ends a sign-off with the panel's "Stop now"). `verify-real-playback.py` failed once and passed once: the unreadable-file toast is "Runout lost access to your music. Tap Allow." for a permission-type failure and "Cannot play ..." otherwise; the check now accepts either (this is D's errtext.js and B's failText agreeing, not a bug). One small seam fix: the "unsupported format" toast now shortens a long title like every other play failure. Still open and documented: in landscape the last row of Booth pads can sit partly under the mini bar until the page is scrolled a little (reachable by scrolling; judge on the phone). The repo has no `package-lock.json`, so `npm ci` fails and `npm install` is used (CI does the same).

## Not verified

Anything on a device: gesture feel, the §3 latency gate, WebView audio / speech / SVG behaviour, native plugin runtime, keep-awake / refresh / brightness, TalkBack,
battery. Real speech has never been heard (fake `speechSynthesis` in tests). The prioritised on-device list is `HANDOFF.md` §6; the owner decisions are §7.

## Next

1. Owner: the v0 feel gate on the RedMagic with the per-commit APK (`runout-<sha7>.apk` on the `v0-latest` release), then the P1 items in `HANDOFF.md` §6 (phone library permission + scan, device mode).
2. If the web audio path fails the gate: swap `src/audio-engine.js` for a native Oboe wrapper (the only swappable layer).
3. After the gate: AI radio P1 device spikes (`docs/RADIO_SPIKE_P1.md`), then P2.
4. Multi-platform packaging is a plan only (`PORTING_PLAN.md`) and waits on the gate.

## Integration pass (Workstream I) — what changed at the seams

* Lock x new UI: every gesture entry point of the stage, coverflow, cassette, shelf and editor asks `allowsGesture`; surfaces are `data-lock-surface`; a live key inside a surface no longer swallows its own ancestors' pointerdown (this had broken the cassette's transport / AUTO / FLIP while locked); the hint card is capped at 4 s, tap-dismissible, never in AOD.
* AOD x new UI: subscribers for the Albums stage (hairline circles, static), the cassette player (reels frozen) and Booth; rAF stays at 1 Hz on every section and audio is untouched across enter / exit.
* Device library x UI: "Scan phone" on native; `year` / `added` / `genre` / exact durations flow from both sources (and the persisted index) into suggestions and search; MP3 length from the first frame when there is no TLEN; one read-model confirmed with a parity test.
* Removed: `GridView` + its CSS and other dead card / grid CSS, the temporary lock-sheet gear (Device mode is reached from Settings).
* New: `scripts/verify-all.py`, `scripts/verify-tour.py`, `docs/screenshots/tour/`; the walkthrough text was rewritten to the real UI.
