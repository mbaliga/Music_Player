# FX: performance effects on the platter

FX is the **Booth** section of the drawer. Everything plays your own local records and CDs. It is
inspired by hardware DJ scratch controllers in general (a touch platter, a small mode menu, a ring of light); nothing of any product's name,
artwork or layout is used. The code is original and lives in `src/fx/`.

## Where it lives, and why

FX is the **Booth** section of the navigation shell (the last item in the drawer: Albums, Mixtapes, Radio, Booth; `src/shell/booth.js` mounts it lazily
the first time the section is shown, never at boot). It first lived as the last section of the old control panel, before the shell workstream
replaced the library overlay with the drawer; the component was built to be placement-independent, so only the mount line changed.

The Booth screen has no platter, so **the FX pad is the touch surface** (a round pad with the same gestures and its own light ring). That also
makes FX work the same for vinyl and CD tracks. **Blend scratch needs the platter** (you scratch it), so it is greyed out unless the shell passes
`hasPlatter: true` and forwards the platter's pointer events and rate to `handle.platter` (see the contract below); the worklet and controller
support is built and tested.

## Component contract (for the shell)

`src/fx/section.js` (re-exporting `src/fx/ui.js`) is the one entry point:

```js
const fx = mountFxSection(container, deps);   // -> { unmount, onShow, onHide, onTrack, platter, controller }
```

`deps` (everything optional except `engine`): `engine` (the `AudioEngine`: `ctx`, `musicBus`, `setFx`, `position`, `frames`, `sampleRate`),
`storage` (localStorage-like, for the saved mode), `blocked()` (or `host.blocked()`), returning `'radio'`, `'mixtape'`, another reason string or null,
`host` with `getTrack, nominalRate, omegaNominal, sampleRate, blocked` (and optionally `envelope, durationSec, positionSec, view, geom`; missing
ones are derived from the engine), `resume()`, `hasPlatter` (enables Blend scratch), `stage` (platter stage element: adds the ring and HUD over it),
`close` (the idle button's fallback), `goto(sectionId)` (the idle / blocked button), `haptic(ms)`; `host` may also give `hasRecord()` and `nowPlaying()`. The component makes no assumption about where it sits, lays out in any container (checked at 360 x 780), keeps all CSS
under `.fx-` (`src/fx/fx.css`, loaded lazily) and runs its own animation loop between `onShow()` and `onHide()`. It notices a new track by itself
(`host.getTrack()` identity). `onHide()` releases any held effect and stops the loop; `unmount()` removes everything and the bus chain.
`platter` = `{ wantsPlatter, grabsPlatter, pointerDown(p, surface, t), pointerMove(p, t), pointerUp(), rateFor(rate) }` is for a shell that wants
the real platter to drive FX (hold effects, Blend scratch); it is not needed for the pad.

**One edit in the shell:** `src/shell/booth.js` line `const loadFxSection = () => import('../fx/section.js');` (it was `null`, the placeholder).
Nothing else in the shell was touched.

## Ownership: radio, canned shows and mixtapes

FX is **off, with a plain message**, whenever something else owns the engine: a streamed or canned station (`state.radioOn`), You Radio (any
radio session), or a playing mixtape (`state.mixtapes.play`). The message reads, for example, "FX is off: a mixtape is playing. Close the tape
to use FX." The controller polls this every frame, releases any held effect, zeroes the worklet block and removes the bus chain. Loading a
new record or tape (every `loadTrack`, mixtape `adoptTrack` and radio `adopt`) also releases FX and re-analyses the tempo. FX never starts,
stops or loads anything itself, so it cannot interfere with the engine gate (`src/engine-gate.js`).

## The instrument screen

Earlier versions opened on a text menu (a list of six rows, then a mode page), which on a phone read as "lines of text". The Booth is now one
hardware-style screen with everything on it at once (`src/fx/ui.js`, `src/fx/fx.css`; theme tokens only, so it follows Dark soft / OLED black / Light
and custom themes; the displays are always dark glass like a real unit, the faceplate is the theme surface; each effect keeps the hue of its light ring):

* **Deck strip:** what is on the deck (record or CD spinning, title, `VINYL 33.3`, `track n of m`), the tempo in an LCD (`BPM`, or `FIXED BPM` when
  no tempo was found) and the waveform with the playhead and the held slice.
* **FX rack:** six buttons (Scratch, Blend, Beat repeat, Stutter, Filter, Echo), each with an LED: lit = selected, pulsing = live.
* **XY touch plate** (the surface; class `.fx-pad`, a rounded glass square): for Beat repeat and Stutter, concentric slice zones labelled `1/16 ... 1/1`
  with the one in force lit and the light ring; for Filter an XY grid with the resonance curve; for Echo an XY grid with ripples. A glowing puck follows
  the finger, a dashed ghost puck shows where it will land, axis labels name what X and Y do, the big readout shows `1/8 +120%` or `2.5 kHz Q 6.8`.
* **Blend fader** and **level meter** beside the plate (the meter is a read-only analyser on the music bus; it feeds nothing).
* **Switches:** Latch, Ring, half / double tempo, Restart (beat repeat returns to the start of the slice on release).
* **Knobs** (drawn, drag up or down; arrow keys, Home and End too): BEAT (stepped 1/1 ... 1/16), GATE (stutter), DELAY / ROOM (echo).
* **Eight performance pads:** Repeat 1/4, 1/8, 1/16, Stutter 1/8, 1/16, Filter sweep, Echo 1/4, 1/2. Hold to play (the pad sets the effect and the beat, then
  engages it); with Latch on, tap to switch on and tap again to switch off. Pads light when selected and glow when live. `haptic(ms)` is called on press
  (the shell passes it: it respects the Haptics setting).
* **Empty states:** no record on the deck shows "Nothing on the deck. Play a record on Albums first." with a **Go to Albums** button; a radio station or
  mixtape owning the engine shows what is playing and an **Open Radio / Open Mixtapes** button (`deps.goto(sectionId)`). The instrument stays visible,
  dimmed, behind it. `deps.host.hasRecord()` / `nowPlaying()` feed this and the deck strip.
* **Layout:** portrait is one column (deck, rack, plate with fader and meter, switches, knobs, pads) that fits 360 x 780 without scrolling (the plate takes
  the height that is left, up to the column width); landscape phones put the plate on the left and the rest beside it (checked at 915 x 412; the shell
  frame is capped at 560 px wide). Touch targets are 44 px or more in portrait.
* **Lock seams (device mode):** rack, switches, knobs and fader carry `data-lock-ok` and stay live while locked; the plate and the pads are gestures
  (`allowsGesture('fx-pad')`: frozen unless "Allow the FX pad while locked"); `registerLockFace('booth', ...)` in `src/devicemode/default-faces.js` names the
  selectors; `setAod(on)` (the AOD subscriber) stops every canvas.
* **Root cause of the old "just text" look:** the component opened on its menu view (a plain list) until a mode other than Scratch had been saved, and its
  one touch surface was a small circular canvas below the fold. Nothing was missing from the build (`www/src/fx/` ships every module and `fx.css`;
  `test/fx-ship.test.mjs` checks it).

Arrow keys move along the rack; the plate takes Space / Enter (hold) and arrows (nudge); the pads take Space / Enter.

The last mode and its parameters are saved in `localStorage` (`runout.fx.v1`, versioned, sanitised, never throws) and restored the next time
the section is opened.

## Surfaces: the platter and the pad

* **The pad** (inside the Booth): a round touch surface; spin is measured about its centre, slide is radial or x/y. It works for vinyl and CD tracks
  alike. Blend scratch is greyed out on a CD and without a platter.
* **The platter** (only if the shell forwards it through `handle.platter`): a finger on the groove area is routed to FX when a mode other than Scratch is
  selected; the tonearm area keeps working as before. This was verified on the old panel layout (earlier run) but is not wired in the drawer shell.

## The six modes (interpretations; see "Guesses" below)

Definitions follow the on-screen captions of the reference video and common DJ practice. Division means a fraction **of one beat**
(1/1 is a whole beat, 1/16 a sixteenth of a beat; at 120 BPM that is 500 ms down to 31 ms).

| Mode | While held | Notes |
|---|---|---|
| **Scratch** | Nothing changes. The normal platter scrub. | Default. The audio path is byte-identical to before FX existed. |
| **Blend scratch** | You scratch as usual, and a second read head keeps the song playing at normal speed underneath; the two are cross-faded. | Blend amount = slider (0 to 100 %), or from where you touch (outer edge = more song) with "by touch radius". |
| **Beat repeat** | The last slice before the playhead loops. Slide inward for shorter slices (1/1, 1/2, 1/4, 1/8, 1/16), outward for longer. Spin faster to speed the repeat up (shown as `+n%`). | The song does not scratch while repeating; its read head keeps its normal speed. |
| **Stutter** | The moment you touched is retriggered every division, with a gate. | Slide to change the rate; gate length slider (10 to 100 %). |
| **Band pass** | A resonant band-pass filter on the music bus. Finger x = centre frequency (150 Hz to 8 kHz, log), finger y = Q (0.7 to 14, log). | Pad, not scratch. |
| **Reverb / delay** | A feedback delay plus a small generated-impulse-response reverb. Finger x = wet send (left dry to right full), y = how long the echoes last (feedback 0.1 to 0.85). | Delay time = a division of the beat; slider balances delay against room. The tail rings out after release. |

### Gestures and the tunable constants (`src/fx/gesture.js`, `GESTURE_KNOBS`)

* **Division from a radial drag.** The division in force when the finger lands is the one chosen with the chips (last used). Moving the
  finger toward the spindle steps toward 1/16, outward toward 1/1; one step per `(divOuter - divInner) / 5` of the platter's radial span
  (`divInner` 0.10, `divOuter` 0.96), with `divHyst` 0.18 of a zone of hysteresis so a wobbling finger does not flicker.
* **Rate from spin.** The finger's angular speed is measured about the platter centre, relative to nominal platter speed (`s`, 1 = 33 1/3 rpm
  speed). `|s| <= spinDead` (0.40) leaves the repeat at 100 %. Forward: `rate = 1 + (s - 0.40) * spinUpGain (0.85)`. Backward:
  `rate = 1 - (|s| - 0.40) * spinDownGain (0.35)`. **Clamp: -50 % to +900 %** (rate 0.5 to 10). The measured spin is smoothed (60 ms).
  A resting finger measures zero.
* **Band pass.** `bpFreqMin/Max` 150 to 8000 Hz, `bpQMin/Max` 0.7 to 14, both logarithmic.
* **Echo.** wet send = x mapped to 0..1; feedback = 0.1 + 0.75 * y01 (never reaches 1: `bus.js` additionally caps it at 0.85).
* **Blend by radius.** `0.15 + 0.85 * u` (u = 0 spindle, 1 outer edge).
* Keyboard: Space / Enter on the pad holds; arrow left/right step the division (or move x), up/down change the repeat rate (or y). Escape releases.

### Beat length

`src/fx/tempo.js` estimates one global tempo from the loaded track (up to 60 s of audio, starting 5 % in): an onset curve (rise of the log
energy of the high-passed signal), autocorrelation over 60 to 180 BPM with the 2x and 4x lag multiples added, a gentle prior around 110 BPM,
parabolic refinement. It returns `{bpm, confidence}`. At confidence >= 0.3 the beat is `60 / bpm`; otherwise the app uses a **fixed 500 ms
beat** and says so on the mode screen ("no tempo found - fixed 500 ms beat"). `1/2x tempo` and `2x tempo` buttons fix an octave error. It
does not reuse `src/radio/core/cues.js` (that is intro/outro/loudness, not tempo). It is not a beat tracker: no phase, no tempo changes.
A "last slice at the playhead" needs no phase, so none is needed.

### Release behaviour (beat repeat, stutter)

A toggle on the mode screen: **Keep time** (default) resumes as if the song had kept playing (the underlying head never stopped), or **Back to
start** returns to the point where you started holding. After a hold, the platter is returned to nominal speed so the song continues without a
spin-up glide.

## How it works (audio)

* **Worklet** (`src/worklet.js`): beat repeat, stutter and blend scratch are a second read head inside the existing read loop. The "capture" is
  just a read window into the song's PCM that is already in memory, so there is **no extra buffer** and memory is bounded by construction.
  Loop wrap is cross-faded over 2 ms through the song's own continuation (so entering the loop is seamless); stutter gates have 1.5 ms ramps;
  changing the division re-captures with a 2 ms blend; the wet mix is slewed (3 ms). No per-sample allocation.
* **Controls**: eight new `Float64` slots in the control block (`C_FX_*`, `CONTROL_SLOTS` 8 -> 16) on the SharedArrayBuffer path, or one
  `{type: 'fx', ...}` message on the postMessage fallback. Both carry the same parameters (a test compares their output).
* **FX off = identical.** With all FX slots zero (the default) `process()` runs the original loop untouched. A golden-hash test, with the hash
  taken from the unmodified worklet before any FX code existed, proves the output is byte-identical on both the SAB and postMessage paths. A
  mode that is selected but not engaged is also byte-identical.
* **Effects bus** (`src/fx/bus.js`): band pass and reverb/delay are Web Audio nodes inserted after `AudioEngine.musicBus` (the node the radio
  ducks). Until an effect is first engaged **no node exists** and the graph is exactly `musicBus -> destination`. On first use a unity "hub" is
  inserted (`musicBus -> dry(1) -> out(1) -> destination`, sample-identical to the direct link); the effect chain taps `musicBus` and adds
  into `out`. Every audible parameter moves with `setTargetAtTime` (no zipper noise). Band pass tears down 140 ms after release. Reverb/delay
  keeps its chain for 5 s so the tail rings out (then a 0.4 s fade and removal). `dispose()` restores the original graph.
* **Reverb** is a `ConvolverNode` with an impulse response generated at runtime (`dsp.js`: decaying filtered noise, 1.6 s, seeded, stereo); no
  audio files or downloads. **Delay** is a `DelayNode` (max 2 s) with a low-pass (3.8 kHz) in the feedback path; its time glides slowly when
  changed.

## The light ring

`ring.js` (pure) maps mode and hand speed to colour and intensity; `ring-draw.js` paints 48 arcs (a soft halo plus a core line) around the
platter on a canvas overlay (and around the pad), with a bright marker at the finger. Each mode has its own base hue (scratch violet, blend
magenta, beat repeat coral, stutter gold, band pass cyan, reverb teal). Speed pushes the hue toward cyan, then lime; past 85 % of full speed
the ring becomes a slowly turning spectrum, with a faint radial shimmer. A blocked state dims it. `prefers-reduced-motion`: no turning, no
shimmer, no spectrum (colour and brightness only). Settings has an on/off switch. A static ring is painted once, not every frame.

## Measured results (desktop Chromium, `scripts/verify-fx.py`, real audio, SharedArrayBuffer path)

Fixtures: 128 BPM click track over a seeded noise bed, exponential tone sweep, 300 Hz + 3 kHz, one ping every 2 s. The output is taken from a
unity gain node in front of the destination.

* **Tempo** found: 127.8 BPM (true 128), confidence 0.85. Beat repeat period at 1/1, 1/2, 1/4, 1/8, 1/16, from a real pointer hold: measured
  20704, 10352, 5176, 2588, 1294 samples, each within 0.001 % of the expected slice (derived from the app's own beat; 0.16 % from the true beat).
* **Division drag:** a real mouse drag inward steps 1/1, 1/2, 1/4, 1/8, 1/16 and outward 1/16 ... 1/1.
* **Spin -> rate:** a finger at 2.0x nominal gives +136 % and the loop period shrinks to 4387 samples (expected 4386.4); 4.0x gives +306 %
  (2550 vs 2549.8); backward 1.5x gives -38 % (16821 vs 16832.5). A 10.5x spin reads `+858 %` (the +900 % clamp is unit tested).
* **Stutter** at 1/4, gate 50 %: period 5176 samples (expected 5176.1), silent fraction 0.51.
* **Blend scratch** (measured on the previous panel layout, where the platter was on screen) with the platter held still: blend 100 % output RMS 0.0295 (the song itself 0.0315), blend 50 % 0.0158 (about half).
  (A plain held-still scratch was silent in four of five runs and not in one; the platter-stop timing was not investigated, it is the existing path.)
* **Band pass** on 300 Hz + 3 kHz: finger right (centre 2990 Hz) gives +32.5 dB for 3 kHz over 300 Hz, finger left (300 Hz) gives -32.6 dB;
  the passed tone is within 0.1 dB of the unfiltered level. The Q mapping (0.9 to 12.1 here) is unit tested; the quality factor itself is the
  browser's `BiquadFilterNode`, not measured here.
* **Echo** (`1/2` of a fixed 500 ms beat, so 250 ms): echoes of a ping at 0.255, 0.508, 0.761, 1.014 s (5 ms is envelope-peak latency); feedback 0.72.
* **No clicks** entering and leaving each mode on the smooth sweep: the largest sample-to-sample step is 0.035 (repeat), 0.040 (stutter), 0.031
  (blend), 0.047 (band pass), 0.086 (echo, which legitimately adds the echo of a loud sweep) against 0.033 for the FX-free baseline, and an isolated-spike
  ratio of 1.0 to 1.07 in every mode (a click would be well above 4).
* **FX off / idle:** a sample-aligned A/B of `musicBus` against the final output over 131072 samples has maximum difference **0**; the same after a
  band-pass chain was built, used and released (0 over 65536 samples, hub removed). The worklet golden-hash test covers the worklet itself.
* **Persistence:** mode and parameters restored after a reload; corrupt storage falls back to Scratch without an error.
* **Teardown:** `onHide()` releases a held effect and removes the bus chain; `unmount()` removes the DOM and every node (destination has one input again).
* **CD track:** repeat from the pad on a CD album track: 10352 samples (expected 10352.1); Blend scratch is disabled on a CD.
* **Lazy loading:** zero requests under `src/fx/` before the section is opened.
* **Layout** (the Booth page of the drawer shell, measured by section M of the script at 360 x 780, 412 x 915 and 915 x 412): no horizontal scroll; the instrument fits without scrolling; the plate is square (254 / 318 / 222 px); rack buttons, switches and pads are 44 px or more in portrait (30 to 38 px in the cramped landscape layout). Also measured: a held pad engages the right effect and beat and lights; Latch toggles; knob and fader drags change the stored parameters; the level meter lights while a record plays; every live control carries `data-lock-ok` and the plate and pads do not; `setAod(true)` stops the plate repainting.
* Not run: the postMessage (no SharedArrayBuffer) path in the browser (unit test compares its output with the SAB path).

Screenshots: `docs/screenshots/booth-360x780.png`, `booth-412x915.png`, `booth-915x412.png`, `booth-filter.png`, `booth-idle.png`, `booth-light.png` (the instrument screen). The older `fx-*.png` files show the previous menu layout.

## Limits and honesty

* The tempo estimate is global and can be an octave off, or low-confidence on music without clear transients (the fixed beat is then used).
* 1/16 of a beat is a buzz (about 31 ms at 120 BPM), not a rhythm. That is what "a fraction of a beat" means; it is kept as asked.
* Beat repeat with a strong rate (+900 %) reads the slice 10x faster (pitched up); the slice length stays tied to the beat, so the loop period
  is `slice / rate`.
* On a slow phone the extra read head costs a few percent of one audio thread while an effect is held (and nothing otherwise). Not measured
  on a device.
* FX during mixtape playback is not available (see the open question in the report).

## Interpretations and guesses (from the video, captions and DJ practice)

* The **menu order and names** follow the video; the **mode semantics** are inferred from the names and the on-screen readouts, not from any
  documentation of the device.
* "Division steps as the hand moves across the platter": taken as a radial drag (relative to where the finger landed). The video does not show
  whether the device uses radial or tangential position; tangential motion is used for **rate** instead (spin), as the `+n%` readout implies.
* "Red slice display gets shorter at smaller divisions": drawn as a bar of one beat whose filled length is the division.
* The `+n%` clamp (-50 % to +900 %), the dead zone, the gains, and the colour path of the ring are my choices. The video shows `+9`, `+168`,
  `+888` percent; backward spin slowing the repeat (down to -50 %) is my guess.
* Band pass and reverb/delay axes (x and y of a pad, with the song running at normal speed) are my design; the video shows the menu entries only.
* Beat repeat "captures the last slice": my reading of the standard beat-repeat effect.
