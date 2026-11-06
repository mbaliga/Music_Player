# Runout — Project Handoff

Codename: **Runout** (after the runout groove — also the atmosphere zone).  
Spec: see the full product & engineering spec in the original brief.  
Branch: `claude/runout-vinyl-instrument-tad8i4` → PR #1 into `main`.  
APK (latest): https://github.com/mbaliga/Music_Player/releases/download/v0-latest/app-debug.apk

---

## What's built

### Core architecture (all files in `src/`)

| File | Role |
|---|---|
| `model.js` | **Portable, pure model layer.** Spiral geometry (radius↔time inversion), 1-DOF platter physics (motor + friction + brake), RMS envelope. Zero browser deps — survives web → native Android port intact. This was the highest-priority architectural decision in the spec (§8). |
| `worklet.js` | **AudioWorklet read loop.** Owns the single float `readPosition`. Each output sample: `readPosition += rate`, then Catmull-Rom interpolation. Supports arbitrary rate: fractional, zero, and true negative (reverse). This is why we skip `AudioBufferSourceNode`. |
| `control-layout.js` | Lock-free Float64 SAB control channel layout (6 slots: target rate, read position, seek pos/gen/ack, playing flag). Constants duplicated verbatim in `worklet.js` (worklets can't import ES modules). |
| `audio-engine.js` | **Swappable engine** behind a stable interface (`load / setRate / seek / setPlaying / position`). Uses SharedArrayBuffer when the page is cross-origin isolated; falls back to postMessage otherwise. Replacing this one file with a native Oboe wrapper is the entire web→native swap. |
| `track.js` | Procedural test track (24 s, dynamic arc: quiet intro → full → breakdown → outro, sharp transients for scrub feel) + `loadFile()` for local audio decode. |
| `render.js` | canvas2D renderer. Bakes the groove spiral + envelope banding into an offscreen sprite **once per track**; each frame is a single rotated blit of that sprite plus the screen-fixed tonearm/needle. Tonearm pivot at upper-right (ferrofluid violet node), needle tip tracks `r(t)`. |
| `main.js` | Wires everything: input → platter physics → audio engine → render. Pointer events for scrub + tonearm seek. Speed dial 33/45/78 + continuous slider. Palm brake (pad + spacebar). Live feel knobs. Wear counter persisted to localStorage. |

### Gestures implemented

| Gesture | Status |
|---|---|
| Scrub (drag disc to set ω) | ✓ Working. Finger angular velocity → platter ω → rate → audio. Release → motor winds back. |
| Silent seek (tonearm swing) | ✓ Implemented. Drag from outer edge → sets `seekRadius` → silence while lifted → hard jump on release. *Not yet stress-tested on touch.* |
| Speed dial 33 / 45 / 78 + slider | ✓ Working. Rate normalised to fixed reference RPM so 45 plays faster and pitched up (authentic coupled transform). |
| Palm brake | ✓ Working. Motor target drops to 0 while braking so the motor doesn't fight the brake. ω decays to a true stop. |
| Flick / nudge / coast | ✓ Emergent from platter physics (friction coefficient `c`). |

### CI / delivery

- GitHub Actions workflow (`.github/workflows/android.yml`) builds a Capacitor debug APK on every push.
- APK is published to a rolling `v0-latest` GitHub Release — tap-to-install URL, no login, no zip:  
  `https://github.com/mbaliga/Music_Player/releases/download/v0-latest/app-debug.apk`
- `serve.py` sets COOP/COEP headers for cross-origin isolation (enables SharedArrayBuffer) for local dev.

### §3 latency gate — preliminary result

The screenshot showed **12 ms estimated output latency ("on the sound ✓")** on the RedMagic WebView. That beats the 30 ms target. **However:** that's the browser's self-reported estimate, not a true end-to-end touch-to-sound measurement (which needs a loopback mic). Treat it as a green signal but confirm by feel on-device before closing the gate.

### Tests & hardening (automated, this round)

The pure model layer now has a committed, dependency-free test suite (`test/model.test.mjs`, run with `npm test` — uses only `node:test`). It is wired into CI **before** the APK build, so a broken model fails the build rather than shipping. 22 checks cover radius↔time inversion exactness, the RPM↔rate transform (1× at reference, 1.35× at 45, true −1× reverse), platter spin-up/brake/coast, envelope normalization, and the angle-wrap helper.

Three correctness fixes fell out of that work and a source review:

1. **Steady-state speed was ~6% slow (the record played flat).** With proportional-only motor control, ω settled where motor pull balanced friction — `ω_ss = target·k/(k+c)` ≈ 0.9375× at the default knobs, ~1.1 semitones flat. Worse, the offset depended on `k`, so dialing the motor knob on-device would have *detuned playback*. Fixed in `model.js:stepPlatter` with a direct-drive-style friction feed-forward (`+c·motorTarget`) so steady-state ω locks to nominal regardless of the knobs — the brake still wins (its target is 0). This makes the on-device knob-dialing clean: `k` now changes spin-up snappiness without touching pitch.
2. **Scrub could fling / NaN on a high-refresh panel.** `main.js` capped frame `dt` on the high side but never floored it; a sub-millisecond frame made `angleDelta/dt` explode (Infinity/NaN → poisoned audio rate). Now `dt` is clamped to `[1 ms, 50 ms]` and finger ω is bounded to ±40 rad/s (≈380 rpm, past any real backspin).
3. **SAB capability over-claimed.** `audio-engine.js` treated `crossOriginIsolated === undefined` as SAB-capable, which could hand the worklet a buffer it can't share (presents as silence). Now requires `=== true`; the WebView/`file://` path degrades cleanly to postMessage as intended.

### Custom theme (JSON paste → verbatim preview → Apply)

Added `src/theme.js` + a "Custom theme…" entry in the settings popover
(`#btnSettings`), so the owner can restyle the app by pasting a JSON theme
document — the same feature, and the same shared JSON schema (`version`,
`name`, `colors.light`/`colors.dark`, 8 hex keys each, `#RRGGBB` or the
`#AARRGGBB` alpha-prefixed superset), already shipped on the Fylz/Fyl-Manager
and Fotoz/Foto-Xplorr apps. This is a **separate, independent** selector from
the existing dark/light toggle (`#btnTheme` → `data-theme`, unchanged) — a
custom theme supplies its own light *and* dark color pairs, and the existing
toggle just decides which of those (or which of the built-in pair) is showing.

**Flow:** paste/edit JSON in a textarea → "Preview →" shows the *exact* text
back, byte-for-byte, in a read-only monospace block (never a swatch/summary)
→ a malformed paste shows a specific named error there (e.g. `Missing
"colors.dark.primary".`) and disables Apply → only an explicit "Apply" from
that screen commits it (writes `localStorage['runout.customTheme']` and sets
the CSS vars); Cancel/Back change nothing. Also added a "Reset to default"
action in the edit step (not explicitly asked for, but there was otherwise no
way back out of a custom theme once applied) — clears the stored theme and
the inline CSS vars, reverting to the built-in defaults.

**Validation** (`parseTheme` in `src/theme.js`) never throws and always names
the exact problem: JSON parse failure, missing/wrong `version`, missing
`colors`/`colors.light`/`colors.dark`, a missing key naming the exact field
(`colors.<mode>.<key>`), or a bad hex naming the field and the bad value
(missing `#`, wrong length, non-hex digit). `name` has no named malformed
case in the spec, so a missing/blank one is tolerated (defaults to "Custom
theme") rather than refusing the whole document.

**CSS variable mapping** — index.html's tokens are `--violet` (fixed accent,
same in both modes today), `--violet-glow`, `--bg`, `--surface`, `--surface2`,
`--border`, `--ink`, `--ink2`. The schema's 8 keys land as:

| schema key | CSS var | reasoning |
|---|---|---|
| `primary` | `--violet` | the instrument's core accent — toolbar active state, RPM dial, brake, sliders, stat readouts, walkthrough nav (all the places `--violet` already drove) |
| `secondary` | `--secondary` (new) | the library/browsing surface — sort-chip active state + scan button. A visible, self-contained second accent without touching the turntable's own controls |
| `tertiary` | `--tertiary` (new) | optional/audiophile info surfaces — feel-knob values + the latency readout's bold figures |
| `background` | `--bg` | direct |
| `surface` | `--surface` | direct |
| `surfaceVariant` | `--surface2` | direct — reads naturally as the "variant" input/button surface it already was |
| `onSurface` | `--ink` | most UI text sits on `--surface` (panel, track name, stats, etc.) |
| `onBackground` | `--ink-bg` (new) | the *one* piece of text painted directly on `--bg` — the toolbar logo. `.logo` reads `var(--ink-bg, var(--ink))`, so the built-in theme needs no new default and is untouched until a custom theme sets `--ink-bg` |

`--secondary`/`--tertiary` are declared once in `:root` as `var(--violet)` (a
pure alias, zero default-appearance change) so the built-in theme still
renders exactly as before; a custom theme overrides them directly via inline
style, which always wins over that stylesheet default.

Two tokens have no schema slot, by design:
- `--violet-glow` and `--ink2` **are** derived — alpha-blended from
  `primary`/`onSurface` at the same alphas the built-in theme already uses
  (glow: .28 dark / .18 light; ink2: .48 dark / .5 light). Same kind of call
  the Fotoz agent made blending its `AccentPalette` presets into concrete
  secondary/tertiary hex — a real, accepted design call, not an oversight.
- `--border` is deliberately **left alone** — the built-in low-alpha
  white/black hairline, not derived from the palette at all. It's a
  structural separator, not a themed color slot in the schema, and reads
  fine over any custom background/surface without a schema-side alpha value
  to derive it from.

8-digit `#AARRGGBB` hex is accepted (Android's `Color.parseColor` alpha-first
order) and converted to an `rgba()` CSS value; 6-digit hex passes straight
through.

Verified end-to-end with Playwright against `serve.py` (headless Chromium):
opened the settings gear → "Custom theme…", pasted a malformed theme (missing
`colors.dark.primary`) and confirmed the exact named error showed with Apply
disabled and nothing changed; pasted a valid theme and confirmed the preview
matched the pasted text byte-for-byte, Apply changed `--violet`/`--secondary`/
`--tertiary`/`--bg`/`--surface`/`--ink`/`--ink-bg` (computed via
`getComputedStyle`) and the *rendered* background-color of real elements
(the mode toggle button, the library scan button/sort chip, the logo text);
toggling dark/light while the custom theme was active correctly swapped to
its own light color set; and "Reset to default" reverted every var. Added
`test/theme.test.mjs` (24 tests: valid round-trip incl. 8-digit hex, every
named malformed case, the color-math helpers) alongside the existing
`test/model.test.mjs`/`test/worklet.test.mjs` — `npm test` went from 27 to 51
passing checks.

---

## Albums, Mixtapes, Radio (Workstream A)

**New files:** `albums.js`, `mixtape.js`, `radio.js`, `stations.js` are PURE (node:test in `test/`); `cassette.js`, `mixtape-ui.js`, `radio-player.js` are browser glue. `library.js`/`main.js` only wire them. Library overlay now has Albums | Mixtapes | Radio tabs. `npm test` is 84 checks (now 300+ with the radio core; see "AI radio" below).

### Albums
- **Exact rule** (`albums.js`): a disc label is `cd|disc|disk` + optional one of ` . _ -` + 1-2 digit number as a standalone word (`CD1`, `cd 2`, `Disc 02`, `Album [CD1]`, `(Disc 2)`, optional `of N`). Looked for in the album tag first, then folder names deepest-first. `CD` with no number, `Discovery`, `ACD1`, `CD123` are NOT labels. A disc-number ID3 tag alone does not make a CD.
- One labelled track makes its whole album a CD (tags are often inconsistent). Disc-labelled variants merge into one album keyed by (albumArtist||artist, label-stripped title); the shelf shows one CD per disc ("Title · CD 2"). Untagged tracks fall back to their parent folder name, so `library.js` now stores a folder path per track (FS Access files get a stamped `runoutPath`; the `webkitdirectory` fallback uses `webkitRelativePath`).
- **Visuals:** vinyl = square sleeve with a record peeking out, badge "LP"; CD = jewel case with spine strip + rainbow disc, badge "CD". **Playing UI:** a CD gets its own player view (see "Track jumping + CD view" below); vinyl keeps the platter. Track order inside an album is natural-sorted by file path (no track-number tag parsing yet).

### Mixtapes
- Refs are `{title, artist, album}` metadata, not file handles (a File can't survive a reload). Playing resolves them against the CURRENT scanned library (`resolveTracks`); unmatched refs stay on the tape, dimmed, and resolve after a re-scan. So a tape only plays after the library has been scanned this session.
- Colours are `#RRGGBB`/`#AARRGGBB` validated with `theme.js:validateHexColor`; JSON is `{version:1,name,style,font,fontColor,tracks}`; parser never throws and names the exact error; import shows the pasted text verbatim before Add (same idiom as custom theme).
- Reels: `reelRadii(progress)` conserves tape area (rS^2 + rT^2 constant). Progress = tape position, equal weight per track (durations are unknown before decode; `tapeProgress` is time-weighted if durations are supplied).
- Playback uses the same engine/platter as the vinyl view, so the speed dial and scrub still apply; the next playable track loads at the runout; the tape stops at the end.

### Radio
- Directory: discovery list (`all.api.radio-browser.info/json/servers`) -> shuffled, plus hard-coded fallbacks (de1 first); tries servers in order with a 6 s timeout each. Stations filtered to: last check ok, not HLS (`<audio>` can't play `.m3u8` in Chromium/Android WebView), **https only** (a Capacitor https origin blocks http media as mixed content; flip `httpsOnly` in `parseStations` if you serve over http). Dedupe by name+url, sort by votes.
- Playback via `<audio>` (not the worklet); the vinyl bus is muted while a station plays and restored on Stop. Failures: offline, directory unreachable (Retry), connect timeout 12 s, dead/unsupported stream (message + Retry).
- **`serve.py` now sends `COEP: credentialless`** instead of `require-corp`: still cross-origin isolated (SAB on), but third-party radio streams (no CORP header) can load. With `require-corp` they were blocked. The Capacitor WebView isn't isolated anyway.
- **Extension point:** `stations.js` StationType/Session interface (documented at the top). AI/"You"/"You City" stations register a type there; see `docs/RADIO_ARCHITECTURE.md`. Nothing AI is implemented.

### Radio: favourites, recents, resume, robustness (Workstream R)
- **`radio-store.js`** (pure) — one versioned JSON (`localStorage` key `runout.radio.v1`, `{v:1,favs,recents,last}`). Entries are keyed by **`type|id`** (`radio-browser|rb:<directory UUID>`), so AI stations (`ai-you`, ...) can join the same lists with no migration; they carry a **snapshot** (name, stream URLs, favicon, tags, country, codec) so favourites play with the directory down. Recents capped at 20 (UI shows 8), deduped, move-to-front; recorded when a station first reaches `playing`, which also refreshes a favourite's snapshot and promotes the URL that actually worked. `parseModel` never throws (bad JSON / unknown version -> empty); every storage access is try/caught. Favicons are stored but never fetched (no extra network).
- **UI** (`radio-player.js`): star on every row and in the now-playing bar; top of the Radio tab shows `Resume <last>`, Favourites, Recents, rendered from storage before/independent of the directory.
- **`radio-session.js`** (browser-agnostic, tested with a fake `<audio>`) is the `radio-browser` Session. A dead URL falls through to the directory's other URL (`streamUrls` = url_resolved + url, https/HLS rules applied) before erroring. After sound, a drop (error/ended/15 s stall) reconnects at 1/2/4/8 s, max 4 (`MAX_RECONNECTS`), phase `reconnecting` ("Reconnecting (n/4)"); budget refills only after 30 s stable. Offline drops fail immediately with Retry. New session phase `reconnecting` added to the Station interface docs.
- Tests: `test/radio-store.test.mjs`, `test/radio-session.test.mjs`. Playwright with a stubbed directory + fake WAV stream covered: star/persist, alt URL, dead stream, forced mid-stream drop and recovery, reload with directory unreachable then Resume.
- Not done on purpose: AI stations; click/vote reporting to the directory.

### Not verified on a real device
Everything here was exercised in desktop headless Chromium only (Playwright against `serve.py`): grouping on generated WAV folders, mixtape build/play/persist, a live station playing, dead-stream and directory-down states. NOT checked on the RedMagic/Android WebView: radio codec/mixed-content behaviour, touch ergonomics of the new tabs, mixtape playback latency, the CD/vinyl card look on a real screen, FS Access folder paths.

## Track jumping + CD view (Workstream V)

**Files:** `tonearm.js` and `cd.js` are PURE (tests: `test/tonearm.test.mjs`, `test/cd.test.mjs`); `cd-view.js` (canvas CD + rainbow), `needle-fx.js` (synth lift/drop sounds) are browser glue; `main.js` wires them; `render.js` draws the ghost and gap lanes. `audio-engine.js:load()` now disconnects the previous worklet node (before, every track change left the old node sounding underneath).

### Vinyl (album = one record, one band per track)
- Picking a track from an LP builds a queue (`queueFor` in main.js: matches the picked track in `library.albums()`; falls back to a single track). The record is one spiral divided into **bands** (width ~ track duration) with thin bare-vinyl **gaps**. Durations of tracks not yet decoded are estimated (mean of known) so the layout shifts slightly as tracks are played. One track = exact old behaviour (tested against `model.js`).
- **Silent seek (arm zone, d > 0.9 rOut):** while held, a dashed **ghost ring** + marker + label ("2 · 1:12", or "▸ track 3" in a gap) shows where the needle will land. Dropping **in a gap** starts the **next track at 0:00**; landing within `startSnapFrac` of a band's outer edge also snaps to 0:00. Entering a gap fires a short haptic (`navigator.vibrate(8)`, Android).
- **Release:** set-down ripple on the canvas, arm settle animation (`#arm.dropping`), synthesized thump + stylus tick + hiss burst; the music bus reopens `dropDelayMs` later. **Lift** plays a soft click + rumble. Silence while lifted already existed.
- **Flick = next / previous track:** while holding the tonearm, a quick *sideways* (tangential) swipe. It cannot be confused with a seek because seeks are radial; it is judged only on release. Clockwise = next, counter-clockwise = previous (previous restarts the track if > `prevRestartSec` in). Plain scrubbing on the platter (d < 0.9 rOut) is untouched. Prev/next buttons also sit under "Now playing" for LP queues.
- Changing track decodes the file (arm stays lifted, silent), then seeks. No prefetch / gapless yet; a vinyl track still stops at its runout (CDs auto-advance).

### Knobs to tune on the device (`TONEARM_KNOBS` in `tonearm.js`, `CD_KNOBS` in `cd.js`, `NEEDLE_FX` in `needle-fx.js`)
`gapFrac` (drawn gap width, 0.02 of groove span), `gapGrabPx` (finger hit width of a gap, 14), `startSnapFrac`; flick: `flickMinArcPx` 70, `flickMaxMs` 280, `flickMinSpeed` 0.45 px/ms, `flickMaxRadialPx` 22; `dropDelayMs` 55, `dropAnimMs` 340, `prevRestartSec` 3; sound levels `liftLevel/dropLevel/hissLevel`; CD: `segGapRad`, ring radii, `skipMuteMs` 70. The arm-grab threshold is still `rOut * 0.9` in main.js.

### CD view (albums classified CD by `albums.js`)
Replaces platter + arm in `.stage` (speed dial and brake sections hidden via `.vinyl-only`). Disc drawn procedurally: static two-lobe diffraction field (light does not rotate) under a rotating data-ring/print/dust layer. Audio is always rate 1 (or 0 paused): **no scrub, no pitch bend**. Controls: play/pause, prev/next (deck semantics), a **segment ring** (one arc per track, tap = jump) and a **progress ring** (tap = seek, with `skipMuteMs` of silence), plus a tappable track list. Centre shows track number and time. Auto-advances at track end.

### Not verified
Only desktop headless Chromium (Playwright, generated WAV albums, mouse not touch): ghost/gap drop/flick/prev-next/CD taps all behave and screenshots look right. NOT done: any feel test on the RedMagic (flick thresholds, gap grab width, haptic, sound levels, arm-zone ergonomics), touch events, real-album durations/decode time, FS Access paths.

---

## Tags, library persistence, gapless mixtapes (Workstream M)

- **Tag parsing** (`src/tags.js`, pure, dependency-free; tests use generated fixtures in `test/support/tagfix.mjs`, and it was also checked against real ffmpeg-written mp3 ID3v2.3/2.4, flac, m4a, ogg and opus files). Reads title/artist/albumArtist/album/genre/year, **track + disc numbers (and totals)**, cover bytes and, when the container gives it cheaply, duration (flac STREAMINFO, mp4 mvhd). ID3v2.2/2.3/2.4 (unsync, UTF-16/UTF-8), Vorbis comments (flac/ogg/opus), MP4 `ilst` (moov before or after mdat). Picks the parser by magic bytes, never throws.
- **Ordering rule** (`albums.js`): tracks with a track number sort by it (ties/unnumbered fall back to natural file-path order, unnumbered last). A disc tag never makes a CD (rule unchanged: an explicit CD/Disc label is still required; vinyl box sets often carry "1/2"). It only (a) orders a *vinyl* album disc-major and (b) places an *unlabelled* track in a label-CD album on its tagged disc; a label number beats a tag.
- **Library persistence** (`src/libindex.js` pure + `src/library-store.js` IndexedDB glue). Scanned metadata only (no audio, no cover art) is saved after each scan and restored at startup (`library.restore()`); restored tracks have `relink: true`, no `File`, and show **needs re-link** (dimmed cards, a "N saved tracks need re-linking" bar, a Re-link button in the tape player). **Re-link** first tries stored `FileSystemDirectoryHandle`s (File System Access API; `queryPermission`, and `requestPermission` only inside that button click, never at startup), else the folder picker; a scanned file replaces the persisted entry with the same id. **Stable track id** = FNV hash (64 bit) of normalised title/artist/album + track/disc no + file size + container duration.
- **Mixtape v2**: refs are still `{title, artist, album}` and now carry an optional `id`. Matching order: id, exact (artist, album, title), loose (artist, title); a linked track beats a needs-re-link one. `MIXTAPE_VERSION` 2 reads v1 and v2 (v1 simply has no ids; the next save writes v2). Parsers never throw; a collection blob written by a *newer* version is copied to `runout.mixtapes.backup` before anything can overwrite it.
- **Gapless queue** (`src/queue.js` pure reducer + engine hook in `audio-engine.js` + host in `mixtape-ui.js`). Memory is bounded to TWO decoded tracks (current + next, about 170 MB for two 4-minute stereo tracks; cap `maxResidentBytes` = 200 MB): the next track is decoded `preloadLeadSec` (40 s) before the runout, parked on a second silent "deck", joined with a short equal-power crossfade (`fadeSec` 0.05 s by default; raise it for a real crossfade), then the old deck is released (`free` message to the worklet + disconnect). If the next track would bust the budget (e.g. a 40-minute DJ mix, judged from the library's known durations) the preload is skipped and that boundary is a cold load (short gap) rather than risking an out-of-memory kill. Engine interface is unchanged; additive methods: `prepareNext(channels, frames)`, `joinNext({fadeSec})`, `dropNext()`, `hasNext`. After a join the public `setRate/seek/position` address the new deck from frame 0 and the rate carries over. `load()` now frees the replaced deck (it previously could keep a stale node sounding). Honours `docs/RADIO_ARCHITECTURE.md` 4.5 (at most 2 songs resident).
- **Verified**: unit tests (tags, albums ordering, libindex, mixtape v1/v2, queue) plus headless Chromium: scan -> ordered albums -> reload shows "needs re-link" -> v1 mixtape resolves -> Re-link -> plays -> auto-advances across 4 tracks with no dropout at joins (output tap) -> jump to queued / other track works.
- **Not verified**: anything on the RedMagic (decode time and memory of a real 4-minute track in the WebView; sample-accuracy of the join is tick-driven, about one frame of jitter hidden by the 50 ms fade); FS Access handle re-link (headless has no picker, so only the input fallback was exercised); m4a/ogg cover art in real files; mono/odd sample-rate files across a join.

## What's pending

### v0 — still to close

These are the remaining items before the v0 gate is officially passed:

- [ ] **Confirm scrub feel on the RedMagic 11 Pro.** The layout fix (disc no longer overlays the panel) was the blocker for usable on-device testing. Now testable. The question: does the hand-drag feel like it is *on* the sound? If yes, web stack is confirmed. If no, swap the audio engine (see below).
- [ ] **Stress-test the tonearm seek gesture on touch.** The outer-edge drag threshold (`rOut * 0.9`) may need tuning for reliable activation vs. a normal platter grab.
- [ ] **Tune the feel knobs (J / k / c / brake damp)** by hand on the actual device. The spec is explicit that this is most of v0's job. Good starting defaults are in `DEFAULT_PARAMS` in `model.js` but they haven't been felt yet.
- [ ] **True latency measurement** — loopback mic on-device (tap screen, capture audio, measure offset).

### v1 — the player

- [ ] **Local library + import UI.** MediaStore / File System Access. File hash → envelope cache key.
- [ ] **Off-thread envelope precompute** (Worker). Currently inline/sync — fine for the 24 s synth track, slow for real album-length files.
- [ ] **Per-track procedural grooves from real audio.** Currently the groove uses the synth track's envelope. Each imported file needs its own envelope baked and used for groove banding.
- [ ] **Album art label fill.** `bakeGroove()` in `render.js` already accepts an `albumImage` param (drawn inside `rIn`); just needs a real image source from track metadata.
- [x] **Tonearm silent-seek UI polish.** Done (ghost ring, lift/set-down, track gaps, flick). See "Track jumping + CD view". Feel NOT tested on device.
- [ ] **Atmosphere subsystem (§7).** Separate audio bus: filtered noise + crackle impulses, wet/dry control. Material: dust/fog density on the glass instead of a slider. Empty-groove mode (needle past runout → music bus silent, atmosphere only). Selectable surfaces (clean crackle, rain, tape warmth, brown noise).
- [ ] **Hyle WebGL/AGSL material pass (§6).** The canvas2D renderer validates feel; the real glass + ferrofluid materials come in the WebGL pass. This is the visual upgrade that makes it feel like the spec's Hyle language.
- [ ] **Persistence beyond wear counter.** Last position per track, per-track atmosphere settings.
- [ ] **Wear surfaces.** Play count → crackle density + patina material (already scaffolded: `dust` param in `drawFrame`, `playCount` in localStorage).
- [ ] **Harden the seek handshake with `Atomics`.** The seek control channel writes `C_SEEK_POS` then bumps `C_SEEK_GEN` as two plain Float64 stores; the worklet reads them in the opposite order. The write/read ordering is correct, but without `Atomics` release/acquire there's no formal barrier, so a CPU/JIT reorder could (very rarely) let the worklet see a new generation with a stale position — one occasional tonearm seek landing wrong, self-corrected by re-seeking. Negligible for v0; the proper fix needs an `Int32Array` view for the gen/ack counters (Float64 can't take `Atomics`), so it was deferred rather than redesign the control channel mid-v0.

### v2 — depth + port

- [ ] **Native Android audio engine (Oboe/AAudio).** Only needed if the §3 latency gate fails on the web path. Architecture is ready: swap `src/audio-engine.js` for a Capacitor plugin wrapping Oboe. Model + render layers are untouched.
- [ ] **AGSL shaders for Hyle materials** (native Android path). Already on the roadmap; runs alongside the native audio swap.
- [ ] **Crate-flip browsing.** Physical metaphor for the library — stacked records, flip through them.
- [ ] **Gapless / queue.** Multiple tracks without silence between (requires cross-fade in the worklet).
- [ ] **Desktop via Tauri** (Linux / Windows / Mac). The web codebase is already the seed; Tauri wraps it. After the native Android port the file I/O and audio layers would need platform-specific adapters.
- [ ] **Two-hand multitouch** (reserved, not v0). Input layer is already multitouch-capable (`setPointerCapture` per pointer ID). Gestures like one hand scrubs / other hand brakes are open.

---

## Key architectural decisions (locked)

1. **Single deck, single spiral.** Load-bearing for the whole data model. No two-deck drift.
2. **Coupled pitch+tempo only.** Rate = pitch. No time-stretch / phase vocoder. Keeps the engine simple and latency low.
3. **One continuous spiral per track** (not A/B sides). Album = a crate of tracks.
4. **Local-only library.** The library itself never streams. (Radio, below, is a separate live-stream surface; it does not touch the library or the worklet.)
5. **Audio time `t` owned by the worklet**, never the main thread. Main thread only reads it back for display.
6. **The feel knobs are the product.** `J`, `k`, `c`, `brakeDamp` in `model.js:DEFAULT_PARAMS` — dial them by hand on-device, not by theory.

---

## How to run / test locally

```bash
python3 serve.py          # → http://localhost:8000 (COOP/COEP set for SharedArrayBuffer)
```

For on-device testing without an APK build:
```bash
adb reverse tcp:8000 tcp:8000     # phone's localhost → this machine
# then open http://localhost:8000 in Chrome on the phone
```
`localhost` is a secure context even without HTTPS, so SharedArrayBuffer stays on and you get the full SAB latency path — the truest read of the §3 gate.

---

## AI radio ("You" / "You City"): status

Plan: `docs/RADIO_ARCHITECTURE.md`. Spike notes: `docs/RADIO_SPIKE_P1.md`.

* **P0 DONE (contracts and skeleton).** `src/radio/core/` is a pure, dependency-free core with `node:test` coverage in `test/radio-core/` (`src/radio/core/README.md` has the module map, the pure-vs-adapter split and how the fakes swap for real adapters). Feature flag `radio.ai` (`src/radio/flag.js`), **default off, no UI**; when off nothing in `src/radio/core/` is on the boot path (`test/radio-core/boot-path.test.mjs`) and behaviour is unchanged. `stations.js` has an inert `ai-you` / `ai-you-city` stub (registered only when the flag is on) that shares the existing `type|id` favourites keys.
* **Cues + build (Workstream K).** `src/radio/core/cues.js` extracts introEnd/outroStart/trims/BS.1770-style loudness from an envelope or PCM (synthetic-signal tested only; see core README for limits); the simulated show uses extracted cues by default (`cues: 'handset'` keeps fixtures). `scripts/build-web.mjs` now has an explicit dev-only deny list (fakes, fixtures, sim, `dev.js`) and `src/radio/core/index.js` no longer re-exports dev tooling (import it from `dev.js`); `test/build-web.test.mjs` guards exclusions, reachability (incl. the lazy radio core) and determinism.
* **P1 device spikes pending** (owner runs `docs/RADIO_SPIKE_P1.md` section 7: S2 background audio first, then S1 echo/AEC and the vendor latency spike). Latency gate is now p95 <= 2.5 s (p50 <= 1.6 s reported); the 8.3 doc errors were corrected in P0.
* **P2 gated** on the v0 feel gate and the owner's device results (if the engine goes native, the radio bus follows; `core/` stays portable). Open items for P2: see the P0 final report / `src/radio/core/README.md`.

