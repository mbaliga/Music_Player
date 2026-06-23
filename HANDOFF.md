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

---

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
- [ ] **Tonearm silent-seek UI polish.** Currently the needle jumps on `pointerup`. Should show a ghost position while dragging and confirm with a brief set-down animation.
- [ ] **Atmosphere subsystem (§7).** Separate audio bus: filtered noise + crackle impulses, wet/dry control. Material: dust/fog density on the glass instead of a slider. Empty-groove mode (needle past runout → music bus silent, atmosphere only). Selectable surfaces (clean crackle, rain, tape warmth, brown noise).
- [ ] **Hyle WebGL/AGSL material pass (§6).** The canvas2D renderer validates feel; the real glass + ferrofluid materials come in the WebGL pass. This is the visual upgrade that makes it feel like the spec's Hyle language.
- [ ] **Persistence beyond wear counter.** Last position per track, per-track atmosphere settings.
- [ ] **Wear surfaces.** Play count → crackle density + patina material (already scaffolded: `dust` param in `drawFrame`, `playCount` in localStorage).

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
4. **Local-only library.** No streaming, ever.
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
