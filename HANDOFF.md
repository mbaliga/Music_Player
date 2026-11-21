# Runout — Project Handoff (current state)

Codename **Runout** (after the runout groove). Repo `mbaliga/Music_Player`, work lives on `main`. This is the one engineering handoff: what the app is, where
things are, what is verified and what is not, how to run everything, and what only a phone (or the owner) can settle. Per-feature depth is in `docs/`; the
short status is `STATE.md`; the user-facing overview is `README.md`.

**Status:** v0 pre-release, gated on a hands-on feel test on the RedMagic 11 Pro. Everything below has been exercised in **desktop Chromium** (Playwright, real
touch events through CDP, real decoded audio, a CPU renderer) and in node tests. **Nothing has been run on a phone by us.** CI proves the Android build compiles
(including both custom Java plugins) and ships; it does not prove the app runs on a device.

APK: rolling `https://github.com/mbaliga/Music_Player/releases/download/v0-latest/app-debug.apk`; per commit `runout-<sha7>.apk` on the same release.

---

## 1. How to run, test, verify, build

| What | Command |
|---|---|
| Dev server (COOP/COEP set, SharedArrayBuffer on) | `python3 serve.py [port]` |
| Unit tests (node:test, no deps; currently ~1,030) | `npm test` |
| Stage the web build (what the APK ships) | `npm run build:web` → `www/` (gitignored) |
| Every browser verifier in one go | `CHROME=/path/to/chrome python3 scripts/verify-all.py [outdir] [name-filter...]` |
| One verifier | start `serve.py`, then `URL=http://localhost:PORT/index.html CHROME=... python3 scripts/verify-X.py outdir` |
| Android | CI only (`.github/workflows/android.yml`): `npm test` → `build:web` → `cap add android` → icon → `apply-android-plugins.mjs` (device library Java) → `apply-android-display.mjs` (device display Java) → `cap sync` → `assembleDebug` → release `v0-latest` (`runout-<sha7>.apk` + `app-debug.apk`) |

Browser verifiers need Playwright for Python, ffmpeg (libmp3lame, libopus), numpy. In this sandbox use `CHROME=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`.
Scripts (each exits non-zero when an assertion fails; `verify-all.py` prints the table):

| script | covers |
|---|---|
| `verify-shell.py` | drawer / sections, real-touch arbitration, mini bar, persistence of the last section |
| `verify-turntable.py` | the Albums stage with real audio: play/stop/resume, speed, scratch rate == finger ω, palm brake, dimple seek / gap drop / flick, pinch, library, CD routing, portrait + landscape |
| `verify-turntable-library.py` | the coverflow component on its own harness page (`test/support/turntable-library.html`) |
| `verify-fx.py` | Booth effects with measured audio (periods, no clicks, FX-off byte identity) |
| `verify-mixtapes.py` | mixtape editor end to end, caps, sides, AUTO / FLIP with real audio, 5,000-track picker |
| `verify-search-settings.py` | search overlay and every Settings group, theme / accent / custom theme, persistence |
| `verify-devicemode.py` | lock key, frozen / live faces on the real stage, coverflow and cassette, hint card, AOD on every section, keep-awake (mocked), audio across AOD |
| `verify-device-library.py` | mocked native Android MediaStore plugin: permission card, scan, albums, playback through `DeviceFile` |
| `verify-radio-layout.py`, `verify-you-radio.py`, `verify-canned-radio.py` | radio sections (fake speech injected; real speech is never heard) |
| `verify-tour.py` | **the acceptance tour**: the whole app at 360x780 and 412x915 (+ landscape), mocked native, 5,000 tracks, measurements; `TOUR_PUBLISH=1` refreshes `docs/screenshots/tour/` |
| `fidelity-turntable.py` | dev only: pixel diff of the stage against the owner's prototype (`ORIG=...`) |

`scripts/verify-devicemode.py`, `verify-shell.py` and `verify-canned-radio.py` share helpers by `exec`-ing a prefix of `verify-canned-radio.py`; keep that file's
helper block above `def run():`.

---

## 2. Section map

| Section (drawer order) | Code | Docs | Notes |
|---|---|---|---|
| Shell | `src/shell/` (`nav.js`, `drawer.js`, `arbitration.js`, `sections.js`, `nowplaying.js`, `booth.js`, `*.css`) | `docs/SHELL.md` | rounded card pulled aside over a menu; mini now-playing bar; edge strip 24 px; `BOOTH_LABEL` is one constant |
| **Albums** | `src/turntable/` (stage, camera, arm, spiral, display, state, geometry, disc-draw, stage-svg), `src/turntable/library*.js`, `covers.js`, `src/cd-view.js`, `src/cd.js`, `src/tonearm.js`, `src/albums.js` | `docs/TURNTABLE.md`, `docs/TURNTABLE_LIBRARY.md` | stage = SVG + one canvas; library = DOM coverflow + track list; `window.__rt` test hooks |
| **Mixtapes** | `src/mixtape.js` (model v4), `src/mixtape-ui.js`, `src/mixtape-pick.js`, `src/mixtape-search.js`, `src/mixtape-suggest.js`, `src/cassette/**` | `docs/MIXTAPES.md` | caps 15 / 30 / 45 min per side and 20 songs per side (owner to confirm); AUTO / FLIP; suggested tapes |
| **Radio** | `src/radio.js`, `src/radio-player.js`, `src/radio-store.js`, `src/radio-session.js`, `src/stations.js`, `src/radio/{core,canned,offline}` | `docs/RADIO_ARCHITECTURE.md`, `docs/VOICES.md`, `docs/CANNED_REVIEW_FINDINGS.md` | `content/stations/` six pre-written shows; AI flag `radio.ai` default off |
| **Booth** (working name) | `src/fx/**`, mounted lazily by `src/shell/booth.js` | `docs/FX.md` | worklet slicer behind `C_FX_*` control slots; FX off = byte-identical output |
| **Settings** | `src/settings/**`, `src/theme.js` | `docs/SETTINGS.md` | one versioned blob `runout.settings.v1` that mirrors three legacy keys |
| Search (overlay) | `src/search/**` | `docs/SEARCH.md` | pure core (diacritics / CJK / typo tolerant); adapters read the library read-model |
| Device mode (lock) | `src/devicemode/**`, `native/android-display/` | `docs/DEVICE_MODE.md` | lock key, frozen face, keep-awake, always-on display |
| Phone library (Android) | `src/device/**`, `src/library-model.js`, `src/library-prefs.js`, `native/android/` | `docs/DEVICE_LIBRARY.md` | MediaStore through a custom Capacitor plugin; web unchanged |
| Library core | `src/library.js` (`LibraryManager`), `src/libindex.js`, `src/library-store.js`, `src/tags.js` | this file §4 | ONE read model: `library.tracks` / `albums()` |
| Audio core | `src/model.js`, `src/worklet.js`, `src/audio-engine.js`, `src/control-layout.js`, `src/track.js`, `src/queue.js` | README | the swappable engine; gapless queue; FX bus |

---

## 3. Features per section (what exists, as verified in desktop Chromium)

* **Albums.** A landscape stage (portrait = rotated). Play/Stop (Stop freezes the record exactly; a stopped record cannot be scratched), 33 / 45 / 78 and − / + (±2 %, 0.7–1.3×; 45 plays faster *and* higher). Scratch = drag the disc: finger angular velocity → platter ω → rate → worklet; reverse works; the motor winds back on release. Palm brake = hold the label (r < 217 stage units) or Space. Silent seek = drag the dimple on the tonearm along its rail (bus muted, ghost ring + label on the disc); set-down inside a band = that point, in a gap = next track at 0:00; a quick sweep = next / previous. An album is one record (one band per track; only the loaded track is decoded). Pinch in (or Ctrl+wheel, `deltaY > 0`) zooms out to the coverflow **library**: swipe, tap a track to play it (a CD album opens the CD view, whose Library button shows the library again), tap the centre cover to return; Esc zooms back in. Turntable settings (sliders icon; was Deck details) holds the album on the platter and its track list, track nav, the fine-speed dial, an Add music file button and, behind Advanced, rate / position / wear, feel knobs (audiophile mode) and latency (build id: Settings). The header has an always-visible Library button; the stage prints a readable now-playing line and, with nothing scanned, a Demo record + Scan card (docs/TURNTABLE.md "What the stage says"). First run: a built-in synthesized demo record; after the first scan the library opens with a "Pick an album" nudge.
* **Library.** Folder scan (File System Access or `<input webkitdirectory>`): tags from ID3v2 / FLAC / Ogg / MP4 incl. year, genre, track / disc, cover, duration (MP3 length from a TLEN frame, else the first frame's Xing / VBRI count, else a CBR estimate), persisted (tags only, no audio) so albums and mixtape refs survive a restart as "needs re-link". Vinyl vs CD by `CD1` / `Disc 2` labels in the album tag or any folder of the path (`src/albums.js`). Android app: the same library fed by MediaStore (permission card first, incremental scan, change observer, rescan on resume); the library toolbar button says "Scan phone" there and "Scan music folder" on the web.
* **Mixtapes.** Model v4 (`tape.length` C30/C60/C90, sides A / B, `autoReverse`, per-song duration hints; v1–v3 migrate, v3 backed up once). Editor: Tape / Add / Tracks / Style tabs, live flippable cassette, capacity gauges, search-driven picker grouped by album (add a whole album, multi-select), drag or keyboard reorder, undo. Refusal toasts say why (time or the 20-song count). 37 cassette styles, pens, inks, wear, gloss, bundled pen fonts. Suggested tapes (Fresh Finds, On Repeat, genre, decade, the long player). Players: Deck and Player skins, reels driven by the real gapless queue, wind keys that seek, **AUTO** (latching; flips to side B at the end of A, default on) and **FLIP** (with AUTO off the tape stops and shows "FLIP TAPE"). JSON export / import with a verbatim preview.
* **Radio.** Radio Browser stations through an `<audio>` element (favourites, recents, resume, reconnect with backoff). **Dial** of six pre-written offline shows (hosts talk between your own songs; badged "Works offline", with a one-line plain note that they are written in advance; ducking -14 dB; speech from the phone's own voices, recordings supported but none shipped). **You Radio** (flag, default off): templated offline hosts over your library. Radio UI (`src/radio-player.js`, styles `src/radio/radio.css`): a search shows results first (spinner / empty / error / Back), every card and row has a visible Play / Stop button (>= 44 px) and the whole card plays it, cards form two columns when the page is wide. P0 of a larger AI-radio plan: contracts and a pure core only.
* **Booth.** Scratch (default), Blend scratch, Beat repeat (1/1 to 1/16 of a detected beat, `+n %` from spin), Stutter, Band pass, Reverb / delay, a light ring. Needs a loaded record; off while a radio session or mixtape owns the engine.
* **Search.** Songs, albums, artists, mixtapes, stations; chips; drill-downs with Play all / Add to mixtape; recents (setting); an explicit "search the internet radio directory" row is the only network use. 20,000 songs index in ~130 ms in chunks.
* **Settings.** Appearance (Dark soft / OLED black default / Light, accent presets or hex, text size, reduce motion, custom JSON theme with a mandatory plain-text preview, export, reset, haptics), Library (sources, minimum song length, include / exclude folders, rescan on resume, parse untagged, Scan now, clear cache), Playback (default speed, audiophile mode), Radio, Booth (read-only note), Device mode (opens the options sheet), Privacy & about (tour, licence, docs list).
* **Device mode.** The padlock at the top right of every header (a floating copy over the cassette player). Locked: the screen stays awake (native flag, else Wake Lock API), only keys work. **Live:** Albums Play/Stop, 33/45/78, − / +, prev / next in the CD view and the speed slider; Mixtapes cassette keys (transport, wind-hold, AUTO, FLIP, eject); Radio Stop / skip; Booth mode rows and chips (the pad only if the setting allows it); the lock key and the mini bar's Stop. **Frozen:** the disc scratch and label brake, the dimple drag, pinch / Ctrl+wheel zoom, the coverflow swipe, cover and track-row taps, library chips, header chips (search, Library, Turntable settings), the drawer, the shelf, the editor / importer, skin chips, the tape-tap song-list reveal (decided frozen: it is a reveal, not a key), Space / Esc shortcuts. Every frozen gesture is double-guarded: CSS `pointer-events` from one generated allowlist and an `allowsGesture(kind)` call in each gesture entry point; gesture surfaces carry `data-lock-surface`. Unlock by hold (0.8 s ring), double-tap or slide; Android back never unlocks. After the idle time a dim **always-on display** (true black, hairline stage, glowing allowed keys, pixel shift, 1 Hz rAF gate, native brightness / refresh hints) takes over; double-tap (default), long-press or the lock key wakes it. The "locked" hint card auto-dismisses in at most 4 s, dismisses on tap and never shows in AOD.

---

## 4. Architecture notes that matter when changing things

* **Engine boundary.** `audio-engine.js` is the only swappable audio layer (`load / setRate / seek / setPlaying / position` + gapless `prepareNext / joinNext / dropNext` + `setFx`). The worklet owns audio time; the main thread reads it back. SAB path when `crossOriginIsolated === true`, `postMessage` otherwise (the APK WebView). Locked decisions: single deck, single spiral, coupled pitch + tempo only, local-only library, feel knobs are the product.
* **The stage reports intent, `main.js` owns audio.** The disc's drawn rotation is *derived from the audio position*; the platter physics still decides the rate. The stage draws on demand (`needsFrame`); AOD outline mode draws once per change.
* **One library read-model.** `LibraryManager.tracks` (folder + registered sources, filtered by library prefs, de-duplicated) and `albums()` are read by the coverflow, the Albums stage queue, search (`adaptLibrary`), the mixtape picker and suggestions (`getLibraryTracks`), You Radio (`getTracks`). Do not keep a second list. Track records carry the same extra fields from both sources: `year`, `added` (epoch ms: folder `file.lastModified`, device `date_modified` × 1000), `genre`, exact `durationSec`.
* **Track ids** (`libindex.trackId`) hash tags + size + container duration; an MP3 duration derived from frames is deliberately kept OUT of the id so libraries scanned earlier keep their ids and mixtape links.
* **Lock faces.** `registerLockFace(sectionId, { buttons, aod, aodText, notes })` + `data-lock-ok` / `data-lock-surface`; one allowlist feeds the CSS and the capture-phase guard. A live press inside a surface is stopped at the surface's child (so the control's own ancestors, e.g. the cassette key group, still get it). New gesture entry points must call `allowsGesture(kind)` (`src/devicemode/guard.js`).
* **AOD renderer hook.** `onAodOutlineMode(cb)` (`src/devicemode/aodhooks.js`). Subscribers: the Albums stage (`stage.setOutline`), the cassette player (reels frozen, CSS hairlines), Booth (`handle.setAod`). Radio and the mini bar have no canvases or rAF loops, so they need none. The main frame loop still runs at 1 Hz in AOD (track-end handling, auto-advance); audio is on the audio thread.
* **Boot path rule.** Radio, Booth, search UI, settings page and the FX component are dynamic imports; `test/fx-ship.test.mjs` and `test/build-web.test.mjs` guard it. `build-web.mjs` skips dev-only radio core files.
* **Persistence keys** (all try/caught): `runout.settings.v1` (+ legacy mirrors `runout.theme`, `runout.cassette.haptics`, `runout.flag.radio.ai`), `runout.customTheme`, `runout.mixtapes` (v4) + `runout.mixtapes.v3.backup`, `runout.mixtapes.skin|view|suggest`, `runout.cassette.auto`, IndexedDB `runout-library` (tag index) / `runout-device` (phone rows), `runout.library.prefs`, `runout.devicemode.v1` (and `runout.devicemode.locked` when "stay locked after restart" is on), `runout.fx.v1`, `runout.tt.speed|last`, `runout.wtDone`, `runout.playCount`, radio store keys.

---

## 5. Verified vs not verified

**Verified (desktop Chromium + node):** everything in §3 as listed by the scripts in §1; 1,030+ unit tests; the tour (`verify-tour.py`) end to end at 360x780, 412x915 and landscape with zero console errors / failed requests beyond the known `stations/` 404 on the dev server (that server has no `stations/` folder; the packs live in `content/stations/` and the app falls back); CI compiles and packages both Java plugins.

**Not verified anywhere (needs the phone):** real-finger gestures (scratch feel, dimple drag, pinch, swipe), latency and the §3 gate, frame rate and memory on a mid phone, the Android WebView behaviour of audio / Web Speech / SVG filters / fonts, the native plugins at runtime (CI compiles them; nobody has called them on a device), keep-awake / refresh rate / brightness, TalkBack, system back gesture interplay, battery. Real speech is never heard in any test (a fake `speechSynthesis` is injected). `postMessage` (non-SAB) engine path is unit-compared, not run in the browser.

Measured in the tour (desktop Chromium on a CPU renderer, **not** phone numbers; the table is in `STATE.md`): first interactive 0.7 s, Albums stage 2.4 ms per frame, JS heap 7 MB at the end of the tour, search over 5,000 songs ~100 ms, `www/` 2.8 MB. On the BUILT `www/` tree a visit to every section plus a canned station start produced zero 404s and zero console messages; the `stations/` 404s only occur on the dev server (it has no `stations/` folder).

---

## 6. On-device checklist (consolidated, in priority order)

**P0 — the v0 gate**
1. Scrub feel and latency on the RedMagic in the WebView (postMessage path) and over `adb reverse` + `serve.py` (SAB path); loopback measurement (tap near a mic, compare). If the hand does not feel on the sound, swap `audio-engine.js` for native Oboe.
2. Albums stage with real fingers: dimple drag and flick thresholds (`TONEARM_KNOBS`, `ARM_KNOBS`), palm-brake hold on the label, pinch gain and snaps (`ZOOM`), scratch vs coverflow swipe disambiguation, the 24 px edge strip vs Android back, the full-width landscape stage. Frame rate and memory of the 14,000-point spiral redraw (one full redraw per frame while playing; DPR capped at 2.5).
3. Tune the feel knobs J / k / c / brake damp (`model.js: DEFAULT_PARAMS`) by hand.

**P1 — Android-only features (runtime never exercised)**
4. Phone library: the permission prompt on API 33+ (`READ_MEDIA_AUDIO`) and ≤ 32, Deny / Don't ask again / grant from Settings, scan time and jank on a ~5k-track phone, `DeviceFile` read speed (1 MiB base64 chunks over the bridge) and decode of a ~30 MB FLAC and a 3 h file, playback start latency, MediaStore oddities (SD card volumes, pending / cloud files, `<unknown>` per vendor, numeric genres, missing duration), art (`loadThumbnail` / retriever), `ContentObserver` on an add from another app, rescan on resume, kill mid-scan, large result strings on old WebViews (lower `chunkBytes`).
5. Device mode: `FLAG_KEEP_SCREEN_ON` against a 15 s screen timeout, whether `preferredRefreshRate` / display mode really lowers the panel rate, AOD brightness override and whether 1–40 % is visible on the AMOLED, burn-in shift visibility, TalkBack reaching the lock key and the live keys, Android back while locked (history sentinel), battery over hours of AOD, holding the unlock ring in a pocket. Also: that both plugins register and respond at runtime (the build proves only that they compile).

**P2 — per section**
6. Radio: stations' codecs / mixed content in the WebView; `speechSynthesis` presence and English voice count offline (does the cast get distinguishable voices?); `onend` reliability (watchdog ≈ 1.6 × estimate + 2 s); audio focus when speech plays over Web Audio; ducking feel (-14 dB, 220 ms / 450 ms; long monologues); Bluetooth routing; screen off / app backgrounded (breaks are dropped while hidden, music continues); Opus decode (`canPlayType`) and whether the `.m4a` alternate is needed; background audio (P1 spike S2 in `docs/RADIO_SPIKE_P1.md`).
7. Mixtapes: drag-reorder feel and scroll-vs-drag; flip animation frame rate (3D transform of a large SVG) and AUTO / FLIP key feel; cassette SVG filter cost at 60 fps (feTurbulence grain at wear > 0); fonts in the WebView; 20+ tapes on the stack (each mounts an SVG); haptics (`navigator.vibrate`); wind keys, seek accuracy and the gapless join after a wind (decode time of the target track); 5,000-track picker scroll.
8. Search: Gboard composition (the query runs after `compositionend`), 20k-song latency and chunked build jank during a scan, the back gesture closing the overlay and not the app, a long result list scrolling while audio plays.
9. Booth: touch feel and `GESTURE_KNOBS`, CPU and battery with an effect held, WebView latency with FX on, ring drawing cost, ConvolverNode cost, 2 ms loop cross-fade audibility, the postMessage path.
10. Shell / settings: edge-gesture feel vs Android back, safe-area insets on a notched phone, text size and reduced motion on device, custom theme import by paste on a phone keyboard.
11. Library on device: memory with hundreds of real embedded covers; the coverflow swipe momentum (`flingGainS`, `easeRate`, `dragSlopPx`); the toolbar position against the hamburger / drawer strip.

---

## 7. Open owner decisions (consolidated)

1. **Booth name** ("Booth" is a working name; `BOOTH_LABEL` in `src/shell/sections.js`).
2. **Mixtape caps** (15 / 30 / 45 min per side, 0 s tolerance, 20 songs per side) and whether tape lengths should be configurable.
3. **Default theme** for a fresh install: OLED black (what the app looked like) or the new soft Dark.
4. **Haptics default** is on (the cassette buzz used to be off).
5. **Canned stations:** the three suggested renames (`docs/CANNED_REVIEW_FINDINGS.md`); accents without licence-clean voices (`docs/VOICES.md`); slot segments in audio-pack mode (`slotsInAudioMode`); whether call-ins carry the `bit` tag; silent zero-line liners; whether a graceful sign-off is the default Stop.
6. **AI radio:** P1 device spikes (owner runs `docs/RADIO_SPIKE_P1.md` §7) and the open questions in `docs/RADIO_ARCHITECTURE.md` §15; P2 is gated on the feel gate.
7. **Device mode defaults** (never-timeout-while-playing, AOD 60 s, wake by double-tap, glow 30 %) and whether the always-on display should ever dim below what an AMOLED can show.
8. **Booth over mixtapes:** FX is off while a mixtape or radio session owns the engine (`docs/FX.md`); say if that should change.

---

## 8. Known issues and gaps (found during integration; see `STATE.md` for the dated list)

* The always-on display's Albums outline is faint by design (`--dm-line` is very dark); whether it is readable on the AMOLED is an on-device check.
* Locking while the library is zoomed out leaves the coverflow visible but frozen (the pinch back is frozen too); unlock to return. Locking first while on the turntable is the supported flow.
* `src/tonearm.js` keeps the old radius-based helpers and `classifyFlick` (used by the CD tests, unused by the app).
* Albums: Blend scratch in the Booth needs the shell to forward platter events (`hasPlatter: true`); gapless album pre-fetch at a track boundary is a cold load with a short gap.
* Folder scans in a browser cannot keep `File` handles across a restart (tracks show "needs re-link" until the folder is scanned again).
* Not built: the atmosphere bus, Hyle shaders, crate-flip browsing, desktop packaging (`PORTING_PLAN.md` is a plan only), native Oboe engine (only if the gate fails), two-hand multitouch, `Atomics` hardening of the seek handshake (a rare mis-seek, self-corrects).

---

## 9. History pointers

The original v0 decisions and the three correctness fixes from the first hardening pass (steady-state speed locked with a friction feed-forward, `dt` clamped, SAB capability requires `=== true`) are in `test/model.test.mjs` and `src/model.js`. The custom-theme feature (JSON paste → verbatim preview → Apply, schema keys mapped onto `--violet`, `--secondary`, `--tertiary`, `--bg`, `--surface`, `--surface2`, `--ink`, `--ink-bg`; `--border` left alone) is in `src/theme.js` and `docs/SETTINGS.md`. Workstream write-ups: `docs/TURNTABLE.md`, `docs/TURNTABLE_LIBRARY.md`, `docs/MIXTAPES.md`, `docs/SEARCH.md`, `docs/SETTINGS.md`, `docs/DEVICE_LIBRARY.md`, `docs/DEVICE_MODE.md`, `docs/FX.md`, `docs/SHELL.md`, `docs/RADIO_ARCHITECTURE.md`.
