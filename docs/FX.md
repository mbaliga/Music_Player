# FX: performance effects on the platter

FX is the last section of the control panel (below "Load track"). Tap **FX** to open it. Everything plays your own local records and CDs. It is
inspired by hardware DJ scratch controllers in general (a touch platter, a small mode menu, a ring of light); nothing of any product's name,
artwork or layout is used. The code is original and lives in `src/fx/`.

## Where it lives, and why

The app has two top-level lists: the **Library overlay tabs** (Albums | Mixtapes | Radio) and the **main control panel** (Now playing, Speed
dial, Palm brake, Stats, Feel knobs, Latency, Load track). FX is about performing on the platter, so it belongs with the platter controls, in
the panel. It is the final `.section` of the panel (a test pins this). It is not a Library tab because the library is about choosing what to
play, and an effect needs the platter and its waveform on screen at the same time.

## Component contract (for the shell)

`src/fx/ui.js` exports one entry point:

```js
const fx = mountFxSection(container, deps);   // -> { unmount, onShow, onHide, onTrack, platter, controller }
```

`deps = { engine, host, resume, stage?, close? }` where `engine` is the `AudioEngine` (`ctx`, `musicBus`, `setFx`), `host` carries the accessors
(`getTrack, envelope, durationSec, positionSec, nominalRate, omegaNominal, sampleRate, blocked, view, geom`), `resume()` resumes the audio
context, `stage` (optional) is the platter stage element for the light ring and HUD overlay, `close` (optional) adds a "Back" row. The component
makes no assumption about its placement, lays out in any container (checked at 360 x 780), keeps all CSS under `.fx-` (`src/fx/fx.css`, loaded
lazily) and runs its own animation loop between `onShow()` and `onHide()`. `platter` is what the shell wires to its platter (pointer events and
the playback rate); without it the pad inside the section still works. Call `onTrack()` whenever a track is loaded or adopted.

**Temporary mount in the old shell** (one block in `src/main.js`, "FX section"; plus `#fxSection` at the end of `aside.panel` and a few `.fx-head`
CSS lines in index.html). To relocate into the drawer: `openFx()` with the new container, `fx.onShow()/onHide()` as the section is shown or
hidden, keep `fx.platter.*` in the canvas pointer handlers and the rate line in the frame loop, keep `fx?.onTrack()`, delete the old markup.

The section is collapsed by default in the old shell. Opening it loads `src/fx/ui.js` (lazy `import()`; nothing under `src/fx/` is loaded at app boot).
Closing it tears everything down: the effects bus is removed and the worklet's FX block is zeroed.

## Ownership: radio, canned shows and mixtapes

FX is **off, with a plain message**, whenever something else owns the engine: a streamed or canned station (`state.radioOn`), You Radio (any
radio session), or a playing mixtape (`state.mixtapes.play`). The message reads, for example, "FX is off: a mixtape is playing. Close the tape
to use FX." The controller polls this every frame, releases any held effect, zeroes the worklet block and removes the bus chain. Loading a
new record or tape (every `loadTrack`, mixtape `adoptTrack` and radio `adopt`) also releases FX and re-analyses the tempo. FX never starts,
stops or loads anything itself, so it cannot interfere with the engine gate (`src/engine-gate.js`).

## The menu

A scrollable list, like a small device menu: `Back`, `Settings...`, then the six modes, each with a one-line description. The selected row has
a violet glow and a lit ferrofluid-style dot. Choosing a mode flashes an "ACTIVE" card, then shows the **mode screen**: the track's waveform
(from the existing RMS envelope, drawn in Runout violet) with a playhead, the readout, the mode's controls and a touch pad. Rows, chips and
buttons are at least 44 px tall; arrow keys move through the list, Enter selects; the pad takes Space / Enter (hold) and arrow keys (nudge).
It works at 360 x 780 with no horizontal scroll.

`Settings...` has: light ring on/off, **latch** (tap to switch an effect on, tap again to switch it off, instead of hold).

The last mode and its parameters are saved in `localStorage` (`runout.fx.v1`, versioned, sanitised, never throws) and restored the next time
the section is opened.

## Surfaces: the platter and the pad

* **Vinyl view:** the real platter is the surface. A finger on the groove area is routed to FX when a mode other than Scratch is selected. The
  tonearm area (outer 10 %) keeps working as before.
* **The pad** (inside the FX section): a round touch surface with the same gestures. It is the only surface in the **CD view** (a CD has no
  platter and no scrub), and a convenient one on a phone when the platter is scrolled out of view. Blend scratch needs a vinyl record, so it
  is greyed out on a CD.

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
* **Blend scratch** with the platter held still: blend 100 % output RMS 0.0295 (the song itself 0.0315), blend 50 % 0.0158 (about half).
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
* **Teardown:** closing the section removes the ring, the HUD and every bus node (destination has one input again).
* **CD track:** repeat from the pad on a CD album track: 10352 samples (expected 10352.1); Blend scratch is disabled on a CD.
* **Lazy loading:** zero requests under `src/fx/` before the section is opened.
* **Layout at 360 x 780:** no horizontal scroll; rows, chips and buttons measure 44 px or more.
* Not run: the postMessage (no SharedArrayBuffer) path in the browser (unit test compares its output with the SAB path).

Screenshots: `docs/screenshots/fx-menu.png`, `fx-repeat-1-1.png`, `fx-repeat-1-16.png` (with the `+n%` readout), `fx-ring.png`, `fx-bandpass.png`.

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
