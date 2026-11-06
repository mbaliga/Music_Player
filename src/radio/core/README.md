# `src/radio/core/` — the pure AI-radio core (Phase P0)

Status: **P0 done** (contracts and skeleton, no network, no vendor code). Plan and rationale: `docs/RADIO_ARCHITECTURE.md`
(section numbers below refer to it). Device spikes: `docs/RADIO_SPIKE_P1.md`. Nothing here plays audio yet.

## What this is, and the one rule

Portable, dependency-free ES modules that decide **what the show is and when things happen** — rundown repair, song choice,
talk placement, grounding, call turn-taking, memory — as pure functions of their inputs. Same spirit as `model.js` vs
`audio-engine.js`: this folder is the logic; everything that touches a clock, a socket, a microphone or an `AudioContext` is an
*adapter* that is injected.

The rule, enforced by `test/radio-core/purity.test.mjs`: core files import only each other and use no `window`/`document`/
`navigator`/storage/`fetch`/`WebSocket`/`AudioContext`/timers, no `Date.now()`, no `new Date()` without arguments, no
`Math.random()`. Time comes in as numbers (`nowSec`, `atMs`), randomness as a seed, storage and services as parameters.
That is what makes every test deterministic and what lets the core move unchanged if the audio engine ever goes native (R1).

## It is behind a flag and off the boot path

* Flag `radio.ai` (`src/radio/flag.js`), **default off**. No UI in P0. Dev switch:
  `localStorage.setItem('runout.flag.radio.ai', '1')` and reload.
* Off: no station type is registered, nothing in this folder is fetched, no network. Behaviour is identical to before.
* On: `src/stations.js` registers the stub types `ai-you` / `ai-you-city` (ids `you`, `you-city:<slug>`, so they share the
  existing `type|id` favourites/recents keys, the "one dial"). Their session lazy-loads `./radio/core/index.js` through the single
  dynamic `import()` in `src/radio-player.js`, then reports phase `error` / `unavailable` — there is no engine until P2.
* `test/radio-core/boot-path.test.mjs` walks the static import graph from `index.html` and fails if anything under
  `radio/core/` is reachable, or if any file other than `radio-player.js` imports the core dynamically.

## Module map

| Module | Job | Architecture |
|---|---|---|
| `schemas.js` | The contracts, versioned (`schemaVersion: 1`), hand-written validators `(v) => {ok, errors[]}` that never throw: ContextSnapshot, Rundown, **Segment**, Script (with markup checked), CallerTurn, StationMemory | 3.3 |
| `markup.js` | Parse/validate/strip `{pause:N} {breath} {laugh} {sfx:x} {em}..{/em} {{time.spoken}}`; `degradeUtterance(utt, caps)` maps one utterance onto an engine's capabilities (SSML / named styles / direction / audio tags / none) and drops the rest without leaking a marker; late-bound template resolver | 3.4, 4.3 |
| `numbers.js` | Number extraction (digits and spelled) + rounding-tolerant matching for the verifier | 10.1 |
| `grounding.js` | `writerFacts` (what the Writer sees: `{id, say, value}`), `verifyScript` (factRefs, numbers, names, unreferenced claims, PII, unmentionable text, staleness), `nextStepAfterVerify` (regenerate once, then canned), `degradeSlotForServices`, `dropStaleUtterances`, expiry derivation | 10.1, 9.2 |
| `canned.js` | Fact-free fallback lines, the "on a break" line, local stinger/filler catalogue | 4.6, 10.2 |
| `director-client.js` | `repairRundown`: never trust the Director — drops unknown/repeated hints, clamps durations, recomputes `horizonSec`, no adjacent talk (callers exempt), first slot music or ID, overlay rule, service-down → chat; `rundownProblems` property checks; `musicOnlySlots` | 5, 13 |
| `song-select.js` | Deterministic, seedable, no-repeat selection from the user's own shortlist; request resolution against the library only | 3.2 |
| `show-clock.js` | Rolling-horizon timeline: lead times per the section 5 table (select 3 slots, script 2, TTS 1 slot and >= 90 s, decode 45 s, horizon 6–8), `due()`/`overdue()`, re-flow on actual durations, drop, invalidate, insert | 5 |
| `scheduler.js` | Talk-over-intro placement (+ trim / pre-roll / between songs), ducking envelope, crossfade, `scheduleShow` (items → validated Segments), dead-air detector, caller/alert safe points and insertion, dead-air ladder | 4.3, 4.6 |
| `turn-taking.js` | Call state machine `step(state, event) → {state, effects}`: endpointing, barge-in (duck then cancel after 300 ms, cough restore), backchannel rules, full-duplex / half-duplex / push-to-talk, limits, safety | 8.4 |
| `latency.js` | The corrected 8.3 budget and the p95 gate | 8.3 |
| `memory.js` | Listener notes (expiring, PII/injection/safety filtered), recent shows, anti-repeat, compact writer summary, view/forget, persistence with injected storage | 7.3 |
| `untrusted.js` | Prompt-injection hygiene: sanitise, `safeJson`, `<untrusted_data>` blocks, library allowlist (never paths), `filterActions` (only `request_song`, `note_for_show`, `end_call`) | 9.4 |
| `cues.js` | Cue extraction (4.5): `extractCuesFromEnvelope` (cheap, over an RMS envelope) and `extractCuesFromPcm` (one pass, mono/stereo, BS.1770-style gated loudness); `introEnd`, `outroStart`, `startTrim`/`endTrim`, per-cue confidence, `toLibraryCues` (hand-set override wins), synthetic-signal generators for tests. Never throws | 4.3, 4.5 |
| `fake-adapters.js` | Fake Context, Director, Writer, Brain, Voice, STT, Decoder: configurable delays on a virtual clock, failure injection | 13 |
| `fixtures.js` | Snapshot scenarios, library generator, golden rundown and scripts | 13 |
| `sim.js` | `runSimulatedShow`: a whole show through clock + scheduler + verifier with fakes on a virtual clock | 11 P2 exit |
| `index.js` | Shipped barrel (what the lazy import returns); no dev files | |
| `dev.js` | Dev/test barrel: fakes, fixtures, `runSimulatedShow`. Not shipped | |

## Pure vs adapter

```
 PURE (this folder)                      ADAPTER (injected; P2 supplies real ones)
 ──────────────────────────────────      ───────────────────────────────────────────
 schemas, markup, grounding, ...         ContextProvider  getSnapshot({nowMs})                  -> ContextSnapshot
 ShowClock, scheduleShow, step()         Director         plan({snapshot, wantSlots, nowMs})    -> raw Rundown JSON
 repairRundown, planSongs                Writer           write({slot, facts, persona, seed})   -> raw Script JSON
 verifyScript, memory, untrusted         Voice (TTS)      capabilities(), render({script})      -> {utterances[{id, durationSec, rendered}]}
                                         Stt              finalize()                            -> {text, confidence}
                                         Decoder          decode(trackId)                       -> {trackId}
                                         Brain (call)     respond({transcript})                 -> {script, actions, safety}
                                         Store            getItem/setItem (memory persistence)
                                         Clock            nowSec / virtual clock for the sim
```

The core never trusts an adapter's output: Director output goes through `repairRundown`, Writer output through `validateScript` +
`verifyScript`, call actions through `filterActions`, STT text through `sanitizeText`. Adapter errors are `AdapterError`-shaped
(`.code`: `offline`, `timeout`, `http_429`, `refusal`, `tts_stall`, ...); the show runner maps each to a row of the 10.2 failure matrix.

## How the fakes swap for real adapters in P2

1. **Same method names and shapes.** The fakes in `fake-adapters.js` are the interface definition. A real `Writer` is
   `write({slot, facts, persona, seed})` over the backend client; a real `Voice` adds the vendor call behind `render()` and keeps
   `capabilities()` honest (its caps record drives `degradeUtterance`).
2. **`sim.js` becomes the show runner.** `runSimulatedShow` is the orchestration the P2 runner needs (rolling rundown, per-stage
   lead-time tasks, commit at T-8 s with the ladder, regenerate-once, canned, quota break). Replace the virtual clock with the audio
   clock (`ctx.currentTime`), run `show.due(now)` from a lookahead tick of well over 60 s (timers can throttle in the background:
   RADIO_SPIKE_P1.md 6.1 #9), and hand each committed `Segment` to the program bus instead of collecting them.
3. **Delays stop being configured.** The fakes' `delayMs` become real durations; keep `calls[]` (start, end, ms, fault) as the stage
   timing log the latency harness already needs (`latency.js` `evaluateGate` is the gate).
4. **Keep the fakes.** They become the contract tests for each real adapter (same call sequence, same fault kinds) and the CI show
   (`test/radio-core/simulated-show.test.mjs`) keeps running with fakes; real-vendor runs are nightly/manual.
5. **Not shipped to users.** `fake-adapters.js`, `fixtures.js`, `sim.js`, `dev.js` (and this README) are excluded by the explicit
   deny list in `scripts/build-web.mjs` (about 54 KB; the old "180 KB" figure was an overestimate). `index.js` deliberately does not
   re-export them, so the lazy import still works in the APK. `test/build-web.test.mjs` builds into a temp dir and checks that dev
   files are absent, everything reachable from `index.html` (static, dynamic, `new URL`) is present, and the build is deterministic.
   A new dev-only file must be added to `DENY`.

## Testing

`npm test` runs `test/radio-core/*.test.mjs` (node:test, no dependencies): contracts, markup golden outputs per engine capability,
grounding mutation/hallucination corpus, repair properties, scheduler math, turn-taking scripted event streams, memory, injection
corpus, a simulated 45-minute show (zero dead air, every script verified), the section 10.2 failure matrix, purity, and the
boot-path test. Nothing needs a network, a clock or a device.

## Used by the offline host

`src/radio/offline/` (docs/RADIO_ARCHITECTURE.md section 16) implements the Context, Director, Writer and Voice seams offline on top of these modules. One core change came out of it: the grounding proper-noun scan is Unicode-aware (`test/radio-core/grounding-unicode.test.mjs`).

## Conventions worth knowing

* Seconds on the show clock, milliseconds for wall time (`atMs`) and for the call state machine.
* `talk_over_intro` is an **overlay**: it takes no timeline time and must precede the song it talks over (repair enforces this).
* `Segment` (`runout/segment/1`) is the scheduler's output unit; it is in the P0 brief but not in the doc's 3.3. Candidates may carry
  an optional `energy` (0–1) the selector uses; `StationMemory.listenerNotes[].id` is added for forgetting a single note.
* Tuning numbers (duck -14 dB, hit margin 0.4 s, 250 ms/400 ms ramps, backchannel at 1.4 s) are starting values, not measurements.

## Cue extraction (`cues.js`)

Library candidates carry `cues: {introEndSec, outroStartSec, loudnessGainDb?, confidence}` (times in seconds from file start). `extractCues*`
produces exactly that shape plus additive `startTrimSec`/`endTrimSec`, and a `detail` block with per-cue `{sec, confidence 0..1, reason}`.
The scheduler's single `confidence` label is the intro cue's when there is one (it gates talk-over-intro), else the weakest cue found.

* **Cheap path:** `extractCuesFromEnvelope(env, {durationSec, absolute?, curve?})` over an envelope you already have (`model.js computeEnvelope`
  output is accepted as is: normalised, `pow 0.6`; loudness is then unknown because the level is gone). About 0.3 ms for 1024 bins.
* **PCM path:** `extractCuesFromPcm({channels|samples, sampleRate})`: real BS.1770-4 K-weighting + 400 ms/75 % blocks + -70/-10 gates,
  mono as dual-mono. 4-minute stereo 44.1 kHz synthetic track: about 0.3 s in node (one run; machine dependent). Run it off the main
  thread (decode worker) on device and prefer the envelope path when only structure cues are needed.
* **Honest limits:** loudness is BS.1770-style, verified on sine references (+/-0.15 LU) and the K-filter gain at 997 Hz / 10 kHz / 30 Hz, NOT
  against the official EBU test files, no true-peak. Envelope-only loudness is an unweighted RMS approximation (a few LU off on music).
  `introEnd` is the first sustained rise to body level (band/main-section entry), not a vocal detector; thresholds were tuned and tested on
  synthetic songs only. Gradual builds return null or low/med confidence on purpose.
* **Sim:** `runSimulatedShow({cues: 'extracted' (default) | 'handset', cueOverrides: {trackId: partialCues}})` synthesises an envelope per
  candidate and runs the extractor; hand-set fixture cues remain available and per-track overrides win key by key.
