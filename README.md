# Runout — v0

A tactile vinyl listening instrument. One disc, one needle, direct manipulation:
the gestures **are** the playback. Position on the disc maps continuously to
position in the sound, with no progress bar in between.

This is **v0 — "prove the feel"** (spec §10). The single job of this milestone
is the go/no-go gate: *does a hand-scrub feel like it is **on** the sound?*
(< 30 ms perceived target, < 50 ms ceiling.) Everything else waits behind it.

## Run it

```bash
python3 serve.py            # serves on http://localhost:8000
# then open http://localhost:8000 in a browser
```

The server sets the `COOP`/`COEP` headers that enable cross-origin isolation, so
`SharedArrayBuffer` is available — that's the lock-free control channel and the
shared PCM buffer the audio worklet reads (spec §3). Opening `index.html` over
`file://` works too, but degrades to a `postMessage` fallback; the latency gate
must be measured on the SAB path.

The app boots with a **synthesized test pressing** (no copyrighted audio is
bundled) built with sharp transients and a quiet→loud→breakdown dynamic arc, so
the groove banding visibly shows the music's shape. **Drop in any local audio
file** to scrub real material.

## Get a sideloadable APK

A Capacitor wrapper + a GitHub Actions workflow (`.github/workflows/android.yml`)
build a debug APK on every push and publish it two ways:

- **Release asset (easiest — tap to install on the phone):**
  <https://github.com/mbaliga/Music_Player/releases/download/v0-latest/app-debug.apk>
  Direct `.apk`, no login, no zip. Updated on every push.
- **Actions artifact:** the run's **Artifacts → `runout-debug-apk`** (downloads
  as a `.zip` you must unpack first; requires being logged in).

Then `adb install app-debug.apk`, or just open the `.apk` on the phone.

> The APK runs the web build inside the system **WebView**. That uses the
> web-Android audio output path the spec flags as the latency weak point, and
> cross-origin isolation headers aren't sent for the local scheme, so
> `SharedArrayBuffer` is unavailable and the engine takes its `postMessage`
> fallback. It's a real installable app, but it measures *wrapped-web* feel —
> **not** native Oboe. For the truest web read of the §3 gate, prefer
> `adb reverse tcp:8000 tcp:8000` + `serve.py` over `localhost` (a secure
> context, so SAB stays on).

## Gestures (spec §5)

| Gesture | How | What you hear |
|---|---|---|
| **Scrub** | Drag the disc round | Scratch at finger velocity; release → motor winds ω back up to speed |
| **Silent seek** | Drag inward from the outer edge (swings the tonearm) | Silence while lifted; hard jump on set-down |
| **Speed dial** | 33/45/78 buttons or the slider | Pitch + tempo shift together (coupled) |
| **Palm brake** | Hold the brake pad, or the spacebar | Pitch bends down to a stop; winds back up on release |
| **Flick / nudge** | A quick drag-and-release | Momentary bend that coasts out via friction |

The four **feel knobs** (`J` inertia, `k` motor, `c` friction, brake damp) are
live sliders — dialing them by hand is most of v0's job (spec §4).

## How it's built (spec §8 — layered so the audio engine is swappable)

```
src/model.js          Portable model layer — PURE functions, no browser deps.
                      Spiral geometry + 1-DOF platter physics + RMS envelope.
                      This survives the web → native Android port intact.
src/worklet.js        The AudioWorklet that OWNS the read loop. Holds the one
                      float readPosition; each sample: readPosition += rate, then
                      Catmull-Rom interpolate. Arbitrary rate — fractional, zero,
                      negative (TRUE reverse) — falls out of one line. This is
                      why we don't use AudioBufferSourceNode.
src/control-layout.js The lock-free Float64 SAB layout shared with the worklet.
src/audio-engine.js   The SWAPPABLE engine. Stable interface (load/setRate/seek/
                      setPlaying/position) so the §3 gate can replace it with
                      native Oboe/AAudio without touching model or render.
src/track.js          Procedural test track + local-file decode.
src/render.js         canvas2D. Bakes the groove (envelope banding) to a sprite
                      ONCE, then per-frame rotates that blit under a fixed needle.
src/main.js           Wires input → physics → engine → render.
```

### The model (spec §2)

Vinyl is constant-angular-velocity, so one revolution is always the same amount
of audio time. The consequence:

> **Platter angular velocity, normalized to nominal RPM, *is* the playback rate.**

Audio time `t` is the single source of truth, owned by the worklet. The needle
radius `r(t)` is a *display* of progress; placing the needle inverts it into a
seek. There is no separate scrub logic — scrubbing is hand-driving the platter's
angular velocity. The speed dial moves the motor's target ω, while `rate` is
normalized to the track's **fixed mastered RPM**, so 45 plays faster and pitched
up (the authentic transform), rather than re-defining "1×".

## Latency & the go/no-go gate

The panel shows the browser's reported output-latency estimate. That is **not**
true end-to-end touch-to-sound latency — measuring that properly needs an
external loopback (tap the screen next to a mic, capture both the tap and the
resulting audio, measure the offset) on the actual RedMagic 11 Pro. The spec is
explicit: **decide the stack by feel on-device, not on theory.**

- Web feel acceptable on the RedMagic → wrap with Capacitor; keep this codebase.
- Web scrub breaks the illusion → swap **only** `audio-engine.js` for native
  Oboe/AAudio. Because the engine is the only swappable layer, that is not a
  rewrite.

## Not in v0 (later phases)

Local library + import, off-thread envelope precompute, per-track procedural
grooves from real files, the Hyle WebGL/AGSL material pass, the atmosphere
subsystem (patina bus + empty-groove surfaces), persistence beyond the wear
counter, and the native port. See the spec phasing (§10).
