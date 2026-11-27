# STATE — Runout

Short status. The full handoff (section map, architecture, verified vs not, on-device checklist, open decisions) is `HANDOFF.md`; the overview is `README.md`.

## Where we are

**v0 pre-release, gated on a hands-on feel test on the RedMagic 11 Pro** (owner-verified on-device latency / scrub feel is the one gate; not yet done).
The app is five sections behind a pull-aside drawer: **Albums** (vinyl stage + coverflow library + CD view), **Mixtapes** (cassette stack, editor, sides, AUTO / FLIP),
**Radio** (stations, six pre-written offline shows, a flagged offline "You Radio"), **Booth** (performance effects; working name) and **Settings**; plus a global
**Search** overlay, a **lock key** with a frozen face and a dim always-on display, and, in the Android app, the **phone's own music library** (MediaStore).
All of it has been integrated and exercised together by `scripts/verify-tour.py` in desktop Chromium; **nothing has been run on a phone by us**.

## Verified (desktop Chromium, node)

`npm test`: all pass (1,106, 1 skipped). `python3 scripts/verify-all.py`: every browser verifier plus the end-to-end tour (see `HANDOFF.md` §1 for what each proves).
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

## UX round 2 (heuristics evaluation)

Cover tap plays (`COVER_TAP_PLAYS`) and the library has a Play album button; the stage has Previous / Next keys and a visible seek bar (CD view too); the mini bar has Previous; touch targets are >= 48 px
where the layout allows (stage keys scale-aware, mini bar, header, search chips, Booth fader); text under 12 px raised across Albums, Booth, Mixtapes and the library; the AOD clock fits at 360 px and keeps a title line;
deleting a mixtape (shelf menu or editor) has a snackbar Undo (`src/ui/snackbar.js`); empty Mixtapes and the editor's Add tab offer Scan music; the tour is 5 short cards with a fixed Next and a scan button; the first Light
pick toasts that players stay dark; 'Pick an album' shows only while nothing is selected; the tape deck's eject key stops the tape (Back keeps it loaded); Booth has a first-visit coachmark, an 'Effects' drawer subtitle and clears the
mini bar; untitled tapes are named after their first artist; the landscape Albums header drops its title. Still unproven on a phone (device checks: gesture-bar overlap of the seek bar, one-handed reach of the seek bar, large text).

## UX round (final integration)

Seven parallel UX fixes were merged and proven together: `verify-tour.py` has a real-library journey that asserts the audio actually playing is the chosen real track (dominant frequency of the engine output, never the Demo record). Found and fixed while integrating: the stage measured its card while the shell scaled it (the now-playing line sat on the keys after visiting another section); a tape kept "owning" the engine after the user started an album track (Booth said a mixtape was playing); `verify-you-radio.py` crashed on an empty list (now fixed and a real gate); the Device mode sheet is full width on landscape phones; Booth landscape rows / switches / pads are 44 px tall. On-device checklist item 12 in `HANDOFF.md` §6 lists what only a phone can settle.

## Final integration pass (four fix rounds: shell/turntable/native, playback + memory, Booth/mixtape/radio, first-time user)

`verify-all.py` was run twice on the merged main (all 13 scripts). The only failure that repeated was `verify-canned-radio.py` (a stale test: since the single-Stop change the dial card's own Stop is hidden while a show plays, so the script now ends a sign-off with the panel's "Stop now"). `verify-real-playback.py` failed once and passed once: the unreadable-file toast is "Runout lost access to your music. Tap Allow." for a permission-type failure and "Cannot play ..." otherwise; the check now accepts either (this is D's errtext.js and B's failText agreeing, not a bug). One small seam fix: the "unsupported format" toast now shortens a long title like every other play failure. Still open and documented: in landscape the last row of Booth pads can sit partly under the mini bar until the page is scrolled a little (reachable by scrolling; judge on the phone). `package-lock.json` is committed and CI installs with `npm ci`; after changing `package.json` run `npm install` and commit the updated lockfile.

## Accessibility / layout pass (independent review)

Text on an accent fill now uses `--on-accent` (`#111` on the default violet, 5.8:1; `onAccent()` picks `#fff`/`#111` per accent, custom themes set `--on-accent` / `--on-secondary` from their own primary / secondary), and `--ink2` is .64 (OLED / dark), .66 (soft dark) and .68 (light) so secondary text is >= 4.5:1 on every surface in all three themes (audited numerically across 6 accents x 3 themes x 5 sections). Booth labels are >= 9-10 px and its rack / switches wrap instead of clipping; the turntable key labels shrink to fit their key; sheets, the mixtape editor and the custom-theme overlay are modal (focus trap, Escape, `#shell` inert behind the editor). Locked, frozen controls carry `aria-disabled`. AOD: live-key labels use `--dm-label` (>= 3:1 on black), the empty-state card, the arm engraving and "TONEARM REST" are hidden, key hit-area boxes are not stroked.

Known and deliberate: Android `textZoom` is NOT honoured by the WebView right now (owner decision pending, so the layouts are made robust to larger text but the system font scale does not reach them); the viewport meta keeps `user-scalable=no` because pinch is an app gesture (library zoom). Turntable speed keys are ~36-43 px wide on screen (their hit areas are >= 44 px); widening the drawn shapes means moving the key columns and was left alone. Not verified on a device.

## Final integration pass (hardening, playback review, accessibility)

Merged on main: playback review fixes (row-vs-queue guard, adopt-focus intent, tape / CD / radio ownership, empty-library radio and mixtape copy), hardening (service lifecycle, CSP meta, CI split into `build-apk` + `publish` jobs with a lockfile and pinned actions), and the accessibility / contrast / layout pass. Proven together on the merged tree, serially on a quiet machine: `npm ci`, `npm test` (1,106, 1 skipped), `npm run build:web`, `verify-all.py` twice (14 scripts each), then every verifier run on its own again (turntable twice) and `verify-playback-review.py`; plus a Playwright drive WITHOUT `bypass_csp` over Search, theme import, the mixtape editor, radio, Booth and lock / AOD at 360x780 and 915x412: zero CSP violations (the only console error is the known dev-server `stations/` 404).
Found and fixed: `verify-radio-layout.py` failed on both `verify-all` runs. Not a flake: it was a real, deterministic consequence of the playback fix "offline shows need songs" (an empty library now shows a "scan your music first" card instead of starting a show), and it reproduced on 7ffd0a1 and not on 50f9652. The verifier now scans the fixture library before tapping a card and ends a show with the panel's Stop / Stop now. No app change.
`verify-turntable.py` did not flake (4 of 4 clean runs: twice inside `verify-all`, twice alone). Screenshots in `docs/screenshots/tour/` were regenerated from this run.
Seen but not changed: with the Radio mini bar up at 915x412 (landscape) the Albums stage's second caption line ("Radio playing - tap Stop to end it") is half hidden behind the bar; the tape editor makes `#shell` inert while open, the other modal surfaces rely on `trapFocus` alone.

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
