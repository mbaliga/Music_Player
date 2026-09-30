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
