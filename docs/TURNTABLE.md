# The Vinyl player (Albums page) — Workstream T1

The Albums section is the owner's turntable prototype built into the app: a landscape **stage** (the phone is the player) with a huge disc on a
cantilevered platter, a linear-tracking brushed-metal tonearm, a dot-matrix display and one Play/Stop toggle; pinch **in** and the player shrinks
into a **zoom-out library** (T2's component, `docs/TURNTABLE_LIBRARY.md`) where the disc descends into the focused album's sleeve. The prototype
page is the source of truth; the owner's rules are in `TURNTABLE_HANDOFF.md` (the handoff). Radio, Mixtapes, Booth, the shell and the drawer are untouched.

## Files (`src/turntable/`)

| file | role | pure? |
|---|---|---|
| `geometry.js` | stage coordinates, carriage kinematics (`QY 80, AD 22°, DS 502, TY, TX0/TX1, QS, TRAVEL, QPARK 1393, DIMX 330`), `rOf / thG / thS / phiOf`, control centres | pure |
| `camera.js` | `camFor` (landscape / portrait), `viewBoxFor`, `layers(z)` (every layer's opacity), `discPlacement` (phase A/B + 6 % lift), pinch / wheel / easing, `ZOOM` tunables | pure |
| `arm.js` | `armPose(s, d)`, dimple drag mapping (`sFromPointer`, `grabOffset`), parked extent | pure |
| `spiral.js` | `M = 14000`, tables, `computePeaks`, `fillRibbon` (hot loop, no allocation, no trig per point) | pure |
| `display.js` | 5×7 font, 25×25 grid, name scroll, `pipLayout`, equaliser fill | pure |
| `state.js` | the player reducer: playing / starting / dragging / dep / armS / frozenS / z / focus | pure |
| `../tonearm.js` (additions) | `buildArmLayout`, `locateS`, `seekTargetS`, `sFor`, `classifyArmFlick`, `ARM_KNOBS` | pure |
| `stage-svg.js`, `turntable.css` | the prototype's SVG art (ids prefixed `tt-`), CSS | markup |
| `disc-draw.js` | canvas painting of disc / spiral / label / display / seek ghost | canvas |
| `stage.js` | DOM + gestures: layer stack, camera, hit-testing, pinch / wheel, controls, `window.__rt` hooks | DOM |
| `library.js` (T2) | the zoom-out library; mounted by `main.js` into `stage.libHost` | DOM |

`main.js` owns the audio: the stage reports *intent* (toggle, speed, scratch angle, arm grab / move / release, zoom) through hooks and is fed the
playhead every frame.

## Coordinates

Stage window X ∈ [222.5, 1463.5], Y ∈ [−15, 546] (viewBox `222.5 -15 1241 561`). Disc centre C = (278, 457), RDISC 644 (mat 646, flush). Landscape
= the stage as is; portrait = rotated 90° clockwise (`translate(561 0) rotate(90) translate(-222.5 15)`), controls and the dot display counter-rotated
about their own centres (`BTN`, `DISP`). Hit-testing converts client px to stage units through the SVG's own matrix (`getScreenCTM().inverse()`), so
rotation is free. The camera shrinks to `K1 = .56` while zooming; the canvas matrix `MX` and both SVG viewBoxes always agree.

Arm position **s ∈ [0, 1]**: 0 = outer groove (radius 612), 1 = inner (268), along the horizontal stylus chord at `TY = QY + sin(AD)·DS`. The groove
spiral has 12 turns (`TURNS`); the disc rotation that keeps groove point *s* under the stylus is `phi(s) = thS(s) − thG(s)`.

## Audio: how the real engine sits behind the prototype's stage

* **Platter angle vs derived rotation (decision).** The disc's drawn rotation is *derived from the audio position* (`phiOf(position fraction)`), as in
  the prototype, so the waveform playhead is always at the stylus, also while scratching. The platter physics (`model.js`, `state.platter`) is
  untouched and still decides the audio rate: finger angular velocity → ω → `rateFromOmega` → worklet. `state.platter.theta` is no longer drawn.
  Consequence: the disc turns about 12 turns per *track* (the stylised spiral), not at the physical 33⅓ rpm, and under the finger the disc follows
  the audio, not the finger one-to-one. Proof the scrub feel is unchanged: `scripts/verify-turntable.py` asserts on every frame of a real touch scratch
  that `engine rate == finger ω / reference ω` (clockwise = forward, counter-clockwise = reverse) in portrait and landscape; it is the same
  `stepPlatter(...touching...)` path as before (the stage only supplies the pointer angle, in stage coordinates, a rotation of the screen so the sense is
  preserved).
* **Play / Stop.** The deck used to spin always. Now the *motor* runs while the vinyl record is `playing`: Stop = rate 0 + bus muted + motor target 0
  (the record freezes exactly, so resume is exact); Play lowers the arm (≈1.1 s), then the bus opens and ω climbs (the audible spin-up). A finished
  record restarts from 0 (an album restarts at track 1). A stopped record cannot be scratched (rate is held at 0). Mixtape / radio tracks keep the old
  always-spinning engine (`state.vinylOwned = false`), so those sections behave as before.
* **Booth** works on the loaded record; entering it puts the needle down if the deck was stopped (the old deck was always spinning).
* **Tonearm on the chord.** Grab the dimple (only when the arm is down): bus muted, needle-lift sound, ghost ring + marker on the disc and a pill label
  (`2 · 1:12`, `▸ track 3` in a gap, haptic tick entering a gap); release = a set-down: inside a band → that point, in a gap → the next track at 0:00,
  within a hair of a band start → 0:00. A quick short sweep along the rail is a flick = next / previous (`classifyArmFlick`; "previous" restarts a track
  that is more than 3 s in, as before). The pure mapping is `tonearm.js` re-expressed on the unit interval (`buildArmLayout` = `buildLayout(d, 1, 0)`;
  `seekTargetS(layout, s) === seekTarget(layout, 1 − s)` with the gap zone widened to `ARM_KNOBS.gapGrab`, tested). The old radius functions stay for the CD
  tests; `classifyFlick` (angular) is now unused by the app and kept with its tests.
* **Album as one record.** One band per track on the unit chord, gaps between; only the track on the platter is decoded (one resident track, the
  engine decodes whole files). Other bands show a quiet placeholder groove; the real min / max peaks of the loaded band come from one pass over the
  decoded PCM (`computePeaks`, ≤ 512 samples per bin). The app's RMS envelope (`computeEnvelope`) is not the same thing (one-sided) and is kept for the
  mixtape meter / You Radio; after a gapless join (PCM owned by the engine) the spiral falls back to the envelope mirrored.
* At the end of a track the needle crosses the gap into the next one (`onVinylTrackEnd`: a cold load, a short gap, no pre-fetch; see open items); the
  end of the album freezes at the runout.
* Speed: **33 / 45 / 78** buttons (78 is new, in the free cell left of Play) and **− / +** (×.98 / ×1.02 of the chosen speed, 0.7–1.3). The continuous
  fine-speed slider lives in **Turntable settings**. Persisted: `runout.tt.speed`, `runout.tt.last` (last album id + track, used to refocus the carousel;
  files need re-linking before it can play). There is no volume control in the app, so none is persisted.
* Palm brake: hold the platter **label** (r < 217), or the space bar (unless a control has focus). The old BRAKE pad is gone.
* FX: `src/fx/**` untouched; the platter pointer angle / rate are exposed (`stage.scratchAngle()`, `state.fingerOmega`, `engine._rate`) so Booth's Blend scratch can be wired later.

## Albums page

The stage fills the card (`.tt-wrap`, black always — a physical object). The drawer hamburger, Library, search, Turntable settings and lock keys sit over the top as dark chips
(`page-head` is absolutely positioned). The disc overhangs *inside* the stage as in the prototype, but at the card edge it is clipped (the card is a
rounded, scaled element; overhang beyond it is impossible). **Landscape:** the shell caps its frame at 560 px; the stage is 2.21:1, so on landscape
screens the Albums page takes the full width (`.shell[data-section="albums"]`, `turntable.css`); other sections keep the cap. The side effect is that the drawer's grab strip is at the
screen edge there (the hamburger remains the primary affordance). Gesture arbitration: the 24 px strip is above the page (unchanged); the stage's
own gestures (scratch, arm drag, pinch, a second finger) report through `isPageGestureLive`, so the drawer cannot start during them.
`touch-action: none` on the stage; two-finger pinch = zoom (`z = z0 − (ratio − 1)·2.2`, snaps .35 / .65), Ctrl+wheel (`deltaY > 0` = out), Esc = back in, a
visually-hidden "Open album library" button for keyboard / screen reader users. Reduced motion: zoom works, easing ×3.4 faster.

CD albums show as CD cases; a CD track opens the existing CD view (`cd.js`) over the stage; its **Library** button shows the library again.
First run / empty library: the one album is the built-in synthesized **Demo record** (`builtinTestPressing`, title 'Demo record'; the word "test pressing" is never shown). Focusing another vinyl album loads it
(debounced 420 ms; stops the current record); CD cases wait for a track pick.

**Turntable settings** (was Deck details; element ids `#deckSheet` / `#btnDeck` unchanged): the sliders icon in the header opens a sheet: the album on the platter (title,
artist, its track list: tap a row to play it), track nav (⏮ ⏭), the fine-speed dial, an **Add music file** button (the file input is visually hidden behind it) and the gestures
note. Rate / position / wear, the feel knobs and the latency gate are behind the **Advanced** fold; the build id lives in Settings > Privacy & about.

**What the stage says (UX pass).** The header carries an always-visible **Library** button (>= 44 px, labelled; it becomes **Player** while the library is up; the pinch stays; on phones narrower than 400 px the "Albums" title steps aside, screen-reader only, so the lock key stays on screen). The
stage has a readable layer (`.tt-hud`, DOM text, `stage.setNow / setNowTime / setEmpty`): a now-playing band (title, "Artist · Album", elapsed / total) placed in stage space *below*
the controls (portrait: the strip left of the arm slot; landscape: under the display), so it never meets the disc, the arm or the keys; and, with nothing scanned, an empty-state card
("Demo record: scan your phone / a music folder to play your own music", with a Scan button). Controls are visible buttons (>= 3:1 edge, >= 4.5:1 label) inside a >= 44 px hit area
(`stage.js: CTL_DIM`, sized per orientation); Play is the big key and reads Play / Stop. The record label is the album's own art, or a generated label from its seed / title / artist
(`label-art.js`, `stage.setLabelArt`); the demo and loose files keep the stock swirl. After a scan the app toasts "Found N songs" and, until the user has picked something
(`runout.tt.picked`), opens the library with a "Pick an album" nudge. The scan chip reads Rescan once the phone has been read, with "N songs · last scan ..." under the track list.
CD view: the title is the track, the line under it is "Artist · Album", and the Library button sits with the transport; a disc label in a track title (`[CD1]`, `(Disc 2)`) is
dropped for display only (`cleanTrackTitle`; the CD grouping still reads the originals).

## Device mode

The stage's gesture entry points ask `allowsGesture` (`platter-scrub`, `platter-brake`, `tonearm-drag`, `pinch-zoom`); the top SVG is `data-lock-surface`; Play/Stop, 33/45/78 and − / + stay live while locked. In the always-on display `stage.setOutline(true)` draws hairline circles only and redraws on change (no spiral, mat image or cover art). See `docs/DEVICE_MODE.md`.

## Tunables (on-device)

`ZOOM` (`camera.js`): `PINCH_GAIN 2.2`, `SNAP_OUT .35`, `SNAP_IN .65`, `K1 .56`, `EASE_RATE`. `ARM_KNOBS` (`tonearm.js`): `gapGrab`, flick thresholds. `AMP` (`spiral.js`).
`TRIM` (`main.js`). `DEPLOY_S`, `RETRACT_RATE`, `FINISHED` (`state.js`). `TONEARM_KNOBS`, `NEEDLE_FX` as before.

## Playback integrity (the playback review)

* **One intent token** (`intent` in `main.js`): every user-initiated play action (a library pick, Play all, a track jump, a loose file, a tape song, a station) takes a fresh one, and every async path re-checks it after each await *before* it commits a decoded track. A stale decode drops its result. Jumps are last-tap-wins (`jumpTo`: a newer jump supersedes the one still decoding; the arm follows the newest target).
* **`loadTrack` is transactional**: the engine takes the audio first, only then does the app state (track, queue, album id / meta, envelope, view) switch, so a failed load leaves the old record exactly as it was. The brake from a paused tape is lifted when an album track takes the engine.
* **A track that cannot be decoded** is marked (`queue.items[i].bad`) and skipped: a natural end or Next goes to the next playable index; with none left a natural end finishes the record (frozen at the runout, nothing claims to play) and a manual jump stays on the loaded track. Formats the WebView cannot decode (`src/formats.js`: wma, amr, midi, ape, dsd, ALAC `.m4a` by its sample entry) are greyed in the library and say "unsupported format".
* **Album gapless**: while a vinyl album track plays, `queue.js` decides when to decode the next playable track into the engine's parked second deck (`prepareNext`); at the end `joinNext` swaps decks at the current platter rate (scratch / brake / speed keep acting on the active deck). Over the memory budget (current + next deck <= 240 MB estimated) or after a failed decode-ahead the boundary is the old cold load. A joined track's spiral is drawn from the RMS envelope (the engine owns the PCM). Measured silence at a boundary: ~0 - 20 ms (the 50 ms equal-power join), was 130 - 440 ms.
* **Memory**: `track.channels` is dropped after `engine.load` (peaks, envelope and a 60 s mono tempo excerpt for the Booth are kept; a mono file stays one channel, the worklet plays it on both ears); decodes use `copy: false` everywhere; the encoded bytes are released right after `decodeAudioData`; `DECODE_LIMITS` (`track.js`) refuses a file whose decoded size (duration x rate x channels x 4) is over 250 MB with "too long to load" (checked before decoding when the duration is known) and skips decode-ahead above the smaller preload cap. The envelope reads at most 512 samples per window, so a 60-minute file no longer stalls the main thread; the worklet outputs silence at the runout instead of holding the last sample as DC.
* **Demo record**: only for an empty library. The decision (`platterIsDemo`, the empty-library card) uses the *whole* library, never the filtered shelf, and waits for the persisted library to restore. A CD adopts the platter too (paused). Tapping the centre cover or settling the carousel never replaces a tape / station that is playing.

## Test hooks

`window.__rt` = the prototype's (`show(s,on)`, `park()`, `pose(s,d,a)`, `setZ(v)`, `focus(i)`, `tip(s)`) plus `setName`, `setScroll(ms)`, `live()`,
`app()` → `{ state, stage, tlib, albums, shelf }`, `goTo(target, needle)`. `turntable-harness.html` (repo root, dev only, not shipped) mounts the stage +
library alone; `scripts/fidelity-turntable.py` renders it next to the prototype; `scripts/verify-turntable.py` drives real touch + real audio.

## How the old renderer was replaced

Removed: `src/render.js` (canvas record + mat sprite + ghost overlay), `src/mat.js`, the old arm SVG, the `.stage / .nowline / .rpms / .brake` CSS, the shelf grid
(`GridView` and its CSS were removed in the integration pass; the scan / relink flows of `LibraryManager` are what the library's Scan button calls), the Layout
section of the settings popover (Compact / Utilitarian / Cinematic). The CD view, the mixtape and radio code paths and all their tests are intact. Tests
retired: `test/fx-ship.test.mjs` listed `render.js` in a "no static fx import" file list → now lists `turntable/stage.js`. No other test was removed.

## Known differences from the prototype

`scripts/fidelity-turntable.py` (same peaks, frozen clock): stage states match to a mean absolute difference of ≈0.3/255 over the frame (0.25 % of pixels > 24, all
from the added **78** button and 1–2 px anti-aliasing); z = .25 is 0.2. At z ≥ .5 the library is T2's, with real album data and generated covers.
Other deliberate differences: the dot display is lit after the first Play (dark single dot before, as the prototype), 78 button + header chips are new,
the EQ bars keep the prototype's growth-from-centre quirk, no synthesized demo albums / "Your Files" flow (real files replace them).

## On-device checks (not testable here)

Real-finger pinch gain / snaps; the dimple's drag feel and the flick thresholds; frame rate of the 14 000-point spiral on a mid phone (one full redraw per frame
while playing); memory with the extra canvas layer (device pixel ratio capped at 2.5); the landscape strip vs the system back gesture; scrub feel with the derived
disc rotation.

## Open items

Blend scratch (Booth) wiring on the platter events; optional finger-following disc
(visual offset that decays on release).
