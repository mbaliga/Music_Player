# Radio spike P1: results and device-run procedure

Status: spike complete as far as a sandbox allows. Code is THROWAWAY and lives in `spike/radio-p1/`. Companion to `docs/RADIO_ARCHITECTURE.md` section 11 (P1). Evidence labels as in that doc, plus:
- **MEASURED (sandbox)**: produced by code in this repo, conditions stated. Never a phone, never a real speaker/mic path.
- **CONFIGURED**: a number I typed in as an adapter delay. Not a measurement of anything.
- **KNOWLEDGE**: from my background knowledge of Android/Chromium, not checked here. Treat as a hypothesis for the device run.
- **UNVERIFIED**: could not be checked here.

## 1. Verdicts

| # | Unknown | Verdict | Why |
|---|---|---|---|
| 1 | Echo cancellation / full-duplex in a WebView | **NEEDS-DEVICE. No go or no-go can be given.** | The sandbox has no speaker-to-mic acoustic path, so AEC cannot be exercised at all. The harness is built and its measurement chain is validated against known simulated echoes. Keep the accepted default (headphones full-duplex, push-to-talk on speaker) until a device run says otherwise. |
| 2 | Background / screen-off audio | **NEEDS-DEVICE. Treat as the highest risk to the feature.** | Nothing about a paused Android activity or a vendor battery manager can be observed in a desktop headless browser. A concrete checklist, a test page, a foreground-service/MediaSession/wake-lock test APK and a manual-only CI workflow are ready, but the APK has not been built (no Android SDK here, workflow not yet run). |
| 3 | Caller-loop latency | **NEEDS-DEVICE and needs vendors. Framework: GO.** | The pipeline skeleton, instrumentation and report work, and found real problems in the budget table (section 5.4). No vendor was wired, so stages 2 to 6 are configured delays. The S1 exit (p50 <= 2.0 s, p95 <= 3.0 s) is untestable until a vendor spike exists. |

Nothing in this spike changes a locked decision. It does surface four corrections to the architecture doc (section 5.4) and one practical constraint on how to run the device test (secure context, section 7).

## 2. What was built

All under `spike/radio-p1/` except the workflow. Every file is marked throwaway. No `src/` file was changed. `serve.py` was not touched (the owner-accepted `credentialless` change was already in `main`).

| Path | Purpose |
|---|---|
| `lib/budget.mjs` | Latency budget table from architecture doc 8.3, percentile/summary, `buildReport`, markdown formatter. Each stage carries a **provenance** (`measured`, `configured-fake`, `reported`, `self-referenced`) and the report prints a warning unless every stage is `measured`, so a fake delay cannot pass as a result. |
| `lib/pipeline.mjs` | `runTurn`: mic, VAD/endpointing, STT, transport, writer, chunker, TTS, playback. Pluggable adapters, injectable clock (`VirtualClock` for deterministic tests, `RealClock` for the browser). Nine timestamps per turn map to the eight budget stages. |
| `lib/adapters-fake.mjs` | Fake adapters with per-stage configurable median delay and log-normal spread, seeded. |
| `lib/adapters-real.mjs` | **Stubs only.** STT, LLM writer and TTS classes that refuse to construct without `RUNOUT_SPIKE_STT_KEY` / `_LLM_KEY` / `_TTS_KEY` in the environment, and throw `NotImplementedError` even with a key. No network code, no vendor chosen, no vendor claim made. Keys are never read from a file or committed. |
| `lib/vad.mjs` | Toy energy VAD with adaptive noise floor, onset debounce and hangover endpointing. Stand-in so stage 1 is runnable, not a production VAD. |
| `lib/synth.mjs`, `lib/rng.mjs` | Speech-like synthetic signal (harmonic source, formant resonators, syllable envelope, noise bursts) and seeded RNG. Not speech, not TTS. |
| `lib/echo.mjs` | FFT cross-correlation echo analysis: acoustic lag, fitted coupling gain, correlation, playback level over pre-playback noise floor, a clean/marginal/leaky heuristic. |
| `lib/gaps.mjs`, `scripts/find-gaps.mjs` | Offline dropout finder for a second-device recording of the phone speaker (PCM16 WAV). |
| `web/index.html`, `web/spike.js` | The single device page: environment probe, echo suite (4 mic modes), background test with heartbeat log, live-mic caller-loop turns, one results JSON (copy/download). |
| `scripts/run-fake-pipeline.mjs`, `scripts/vad-sweep.mjs` | Node simulations. |
| `scripts/headless-run.mjs` | Playwright driver (headless Chromium, fake media devices). |
| `android/java/*.java`, `android/apply-spike.mjs` | Foreground service (mediaPlayback type, framework `MediaSession`, partial wake lock, 2 h cap) and a Capacitor plugin `SpikeBackground`; script that patches a freshly generated Capacitor project. |
| `.github/workflows/radio-spike-apk.yml` | **Manual-only** workflow building a separate side-by-side APK (`com.runout.radiospike`). Uploads a workflow artifact only. It does not touch `v0-latest` and `android.yml` is unchanged. |
| `test/*.test.mjs` | 37 node:test cases for the pure logic (budget calculator, stage-timing report, VAD, pipeline, chunker, echo maths, gap finder, Android patch strings). Run with `npm test` (121 tests total incl. the 84 pre-existing, all green). |

CI effect: the existing `android.yml` runs `npm test`, which now also runs these 37 deterministic tests (about 1 s). It does not stage `spike/` into the shipped APK (`build-web.mjs` only copies `index.html` and `src/`).

## 3. What was measured (and under what conditions)

Environment: Linux sandbox VM, Node 22.22, Chromium 153.0.8010.12 headless via Playwright 1.63 with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>`. Output goes to a null sink. Two full runs are in `spike/radio-p1/results/headless-run1.json` and `headless-run2.json`; they agree closely. **Not a phone. No acoustic coupling between speaker and mic.**

### 3.1 Echo harness validation (MEASURED, simulated paths only)

The page can replace the mic with an in-page stream carrying the played signal through a known delay, gain and noise (a control for the harness, not for AEC). Playback and capture run on one AudioContext clock.

| Truth (delay, gain) | Recovered echo coupling | Recovered lag | rho | Verdict by heuristic |
|---|---|---|---|---|
| 60 ms, -20 dB | -20.0 dB (both runs) | 77.4 ms | 0.99 | leaky |
| 120 ms, -35 dB | -35.0 dB | 140 to 142 ms | 0.85 | marginal |
| 60 ms, -50 dB (below -60 dBFS noise floor) | -50.0 dB | 78.7 ms | 0.28 | clean |

Reading it: gain recovery is accurate to about 0.15 dB. The lag reads about 17 to 21 ms above the truth; that is the harness's own graph and capture-chunk latency, so on a device, lag = acoustic round trip (output + air + input) **plus roughly 17 to 21 ms** of harness. The same maths is covered by unit tests with exact assertions.

Null control (fake mic = -60 dBFS noise, nothing coupled): all four mic modes report `clean`, rho 0.01, excess -0.9 to 0 dB. The reported "lag" in those rows is meaningless noise (rho below 0.1); the page now prints `n/a` for lag when rho < 0.2.

Two facts about Chromium 153 headless: `getUserMedia` honoured the constraints (`getSettings()` returned `echoCancellation:false` for the raw mode and `true` for default / AEC-only / AEC+NS+AGC), and with default constraints the browser applied noise suppression to the fake input (floor moved from -60.8 to -64.9 dBFS). Whether anything similar happens in the Android WebView is UNVERIFIED.

**What this does NOT show**: whether browser AEC removes playback from the mic. The fake device cannot hear the speaker.

### 3.2 Pipeline overhead and a live-mic run (MEASURED stage 1 and framework only)

Headless live turns (real `getUserMedia`, real AudioWorklet, real VAD, real timers, real WebAudio playback; stages 2 to 6 CONFIGURED at the doc p50s, LLM and TTS p50 of 450 and 250 ms), 5 turns per run, two runs:

| Stage | p50 run 1 / run 2 (ms) | Source |
|---|---|---|
| 1 VAD hangover | 290 / 290 | self-referenced (see below) |
| 2 STT | 156 / 156 | CONFIGURED |
| 3 Uplink | 94 / 94 | CONFIGURED |
| 4 LLM TTFT | 591 / 591 | CONFIGURED (target 450; log-normal spread on a looped seed, so tail draws) |
| 5 First chunk | 206 / 208 | CONFIGURED |
| 6 TTS TTFB | 266 / 265 | CONFIGURED |
| 7 Downlink | 0 | local buffer, no network |
| 8 Output | 45 | REPORTED by `AudioContext` (baseLatency + outputLatency in a headless null sink), not measured |
| Total | 1604 / 1600 | not a result: it is the configuration |

The only things this run establishes: the instrumentation adds no visible overhead (stage 7 reads 0.3 ms for a local buffer; the configured delays come out at the configured medians within a few ms), and the live pipeline completes turns without stalls. **Stage 1 in a live run is self-referenced**: with no ground truth for "true end of speech", the speech-end mark is the VAD's own estimate, so stage 1 equals the hangover by construction. A real stage-1 number needs a known-end-of-speech signal.

### 3.3 Toy VAD against ground truth (MEASURED on synthetic signals only)

`results/vad-sweep.md`: 30 synthetic utterances per cell, 16 kHz, endpoint time minus true speech end.

| Hangover | Background noise | Endpoint latency p50 / p95 | Missed |
|---|---|---|---|
| 200 / 300 / 500 ms | -60 dBFS | 200 / 300 / 500 (p95 equal) | 0 |
| 200 / 300 / 500 ms | -40 dBFS | 180 / 280 / 480 | 0 |
| any | -30 dBFS | no detection | 30 of 30 |

So endpointing latency is the hangover to within one 20 ms frame, and this energy VAD fails once speech is within about 12 dB of the noise. That is expected for a toy and is not evidence about the VAD a real build would use.

### 3.4 What the budget looks like under different assumptions (CONFIGURED, not measured)

200 simulated turns per scenario, stage 1 from the real VAD on synthetic audio, stages 2 to 8 are log-normal draws with the stated medians (`run-fake-pipeline.mjs`):

| Scenario | Configuration | Total p50 / p95 (ms) | Doc p50 <= 1600 | Doc p95 <= 2500 |
|---|---|---|---|---|
| budget | medians = doc p50s, sigma 0.25 | 1614 / 1904 | fail (by 14 ms) | pass |
| slow-llm | LLM median 800 (top of doc range), sigma 0.3 | 1989 / 2537 | fail | fail |
| lte | uplink 150, downlink 200, sigma 0.35 | 1829 / 2304 | fail | pass |
| tail | doc medians, sigma 0.6 | 1785 / 2749 | fail | fail |

Use: it shows which assumptions break which targets. It says nothing about any real service.

### 3.5 Background harness sanity (MEASURED, trivially)

12 s of the tick worklet in headless Chromium: 4125 blocks, 0 clock discontinuities, wall-vs-audio-clock drift 1 to 2 ms, max stall 2 to 3 ms, 0 non-running heartbeats. This proves the logger runs. It says nothing about backgrounding: a headless page is never paused.

## 4. Unknown 1: echo cancellation and full-duplex

**Built.** `echo` suite: for each of four mic modes (raw all off; browser defaults; AEC only; AEC+NS+AGC) it opens the mic, records 1.8 s of baseline, plays 5 s of speech-like audio through the same AudioContext, records until 1.5 s after, then reports granted constraints (`getSettings()`), acoustic lag, echo coupling (dB), correlation, floor and playback levels, and `excess` (capture during playback minus pre-playback floor). The raw mode is a **validity control**: if it shows no speaker-to-mic coupling the page prints INVALID RUN, because "clean" everywhere else would then mean only that the phone was too quiet.

**Known limits of the test (also on the page):**
- Single-talk only. The user is silent. AEC behaviour during double-talk (the user interrupting, which is exactly barge-in) is not measured; a canceller can pass single-talk and still clip the user's voice.
- Single-tap fit. In a reverberant path it under-reports echo, so a `clean` verdict is a lower bound on leakage and the margins should be generous.
- The clean/marginal/leaky thresholds (3 and 10 dB over the noise floor) are my choice, not validated.
- Output route changes (Bluetooth, wired) change the path; each route is a separate run.

**KNOWLEDGE, to be confirmed on the device (not verified here):**
- Chromium's AEC is built for WebRTC-style playout and it is not guaranteed to reference arbitrary Web Audio output on every platform. On Android, Chromium may use the platform's hardware echo canceller where the device offers one. Whether the Capacitor WebView on the RedMagic does either is exactly what the suite tests.
- Capturing with echo cancellation on Android can switch the audio route/stream to a "communication" mode that changes playback loudness or routing. If so, the music bus will sound different while a call is live. The page does not check this; listen for it.
- Android WebView needs the app to hold `RECORD_AUDIO` for `getUserMedia`; the Capacitor bridge is expected to prompt for it. The spike manifest patch declares it. UNVERIFIED that no extra `WebChromeClient` work is required.

**Verdict: NEEDS-DEVICE.** Decision rule for the owner (also in section 7): AEC counts as proven on speaker only if, in a valid run, the AEC-only and browser-defaults rows are `clean` at media volume 60% and again at 100%, in three repeats, and a person talking over the playback is still transcribed (manual check, double-talk). Otherwise the accepted fallback stands: full-duplex on headphones, push-to-talk on speaker, and the native voice-communication plugin option from 8.5 stays open. Note that push-to-talk and "mic closed while the RJ speaks" do not depend on AEC at all, so the caller loop itself is not blocked by this unknown, only the barge-in feel on speaker.

## 5. Unknown 3: caller-loop latency

### 5.1 Pipeline skeleton

`runTurn` implements the 8.2 pipeline with these timestamps: `speech_end`, `vad_endpoint`, `stt_final`, `uplink_done`, `llm_first_token`, `first_chunk`, `tts_first_byte`, `playback_ready`, `audible`; consecutive differences are exactly the eight rows of the 8.3 table, so the report lines up with the doc. Adapter contracts are documented at the top of `pipeline.mjs`. Swapping the fake STT for a vendor adapter changes one object. The first-chunk stage uses a pure chunker (first clause boundary after at least 12 characters), covered by tests.

### 5.2 Instrumentation honesty

Each adapter declares `kind`. The report shows it per stage and prints a WARNING when any stage is not a real measurement, and its PASS/FAIL lines then describe the configuration. In the browser run, stage 8 is `reported` (the `AudioContext` figure), stage 1 is `self-referenced`. A true stage 8 and a true end-to-end figure need an acoustic loopback; the echo suite's lag is a partial stand-in because it spans output + air + input.

### 5.3 What cannot be measured here

STT, LLM time-to-first-token, TTS time-to-first-byte, uplink and downlink on real networks (Wi-Fi and LTE), real output latency on the RedMagic, and everything involving a real voice. All need vendors, keys and the device. Real adapter stubs exist behind env keys; no vendor was selected or priced.

### 5.4 Findings about the architecture doc's budget (from running the calculator)

1. **The range row does not match the columns.** Summing the plausible-range columns gives 942 to 2,830 ms; the table says about 1,100 to 2,900. The p50 sum (1,570) is right. (Unit-tested.)
2. **The masking rule fires on every turn at budget.** Stages 1 to 5 at their p50 already sum to 1,180 ms, above the 900 ms threshold in 8.3, so the backchannel would play on essentially 100% of turns if the budget is met exactly (simulated: 95 to 100%). Either the threshold should be about 1,400 ms or the rule needs another trigger, otherwise "at most once per few turns" is violated by design.
3. **A sum of medians is not the median of the sum.** With right-skewed stage times, hitting every p50 gives an end-to-end p50 above 1,570: +44 ms at sigma 0.25, about +215 ms at sigma 0.6 (section 3.4). The 1.6 s target has essentially no slack; p95 is the number to gate on.
4. **The S1 exit in 11 (p50 <= 2.0 s, p95 <= 3.0 s) is looser than 8.3 (1.6 / 2.5).** Fine for a spike, but note which is the product target.

## 6. Unknown 2: background and screen-off audio

### 6.1 Checklist (verified vs needs device)

| # | Item | Status |
|---|---|---|
| 1 | Web Audio worklet keeps a continuous clock, 0 discontinuities, in a foreground desktop page | **Verified in sandbox** (section 3.5). Irrelevant to backgrounding. |
| 2 | Test page logs wall vs audio clock, context state changes, visibility, worklet clock jumps, and persists to `localStorage` so a killed page leaves evidence | **Built; runs in headless** |
| 3 | Does the AudioContext keep running when the Activity is paused / screen locks (no service)? | **Needs device** (run B0). KNOWLEDGE: `WebView.onPause()` pauses best-effort work such as animations and says it does not pause JavaScript; whether Capacitor's bridge pauses timers or the media pipeline on `onPause` is UNVERIFIED. |
| 4 | Foreground service of type `mediaPlayback` + ongoing notification keeps it alive | **Code written, never compiled or run** (`SpikeForegroundService.java`). Syntax-checked with `javac` only (all remaining errors are missing Android/Capacitor classes). Needs device (run B1). |
| 5 | Android 14 rules: type must be in the manifest (`foregroundServiceType="mediaPlayback"`) and `FOREGROUND_SERVICE_MEDIA_PLAYBACK` declared; Android 13+ needs the `POST_NOTIFICATIONS` runtime grant to *see* the notification | KNOWLEDGE; the manifest patch and plugin implement it; **needs device** |
| 6 | `navigator.mediaSession` in the WebView: do metadata and action handlers reach the OS lock-screen controls? | **Needs device** (run B2). KNOWLEDGE: desktop and Android Chrome bridge this to system UI; WebView is not assumed to. The native framework `MediaSession` in the service is the fallback, with JS bridged for play/pause (not built). |
| 7 | Screen wake lock (`navigator.wakeLock`) | Exists in headless (`'wakeLock' in navigator`). It only keeps the **screen on**, which is the opposite of the goal; included as a comparison arm only. |
| 8 | Partial CPU wake lock (native) | Code written (2 h cap). Needs device. |
| 9 | Timer throttling while hidden: do `setInterval`/`setTimeout` slow down (the page logs the max heartbeat interval)? | **Needs device.** Design consequence either way: the scheduler's lookahead should be well over 60 s (the architecture doc already schedules on the audio clock ahead of time), and anything that must happen on time should be driven from the worklet or service, not a main-thread timer. |
| 10 | Vendor battery/background managers on the RedMagic (kills, freezes, "game mode" policies) | **Needs device.** Exempt the app from battery optimization for the run and record whether results differ with it on. UNVERIFIED how this OEM behaves. |
| 11 | Mic in the background | Out of scope by NG7 (station calls only while the app is open). Android restricts background mic capture; not tested. |
| 12 | `mediaPlaybackRequiresUserGesture` / autoplay after the first tap | The page starts audio from a button tap. Whether Capacitor relaxes autoplay is UNVERIFIED and not needed for the spike. |
| 13 | Audible gaps | Clock-based checks cannot see an underrun that does not move the clock. Needs a second-device recording plus `scripts/find-gaps.mjs`. |

### 6.2 Test APK wiring

`.github/workflows/radio-spike-apk.yml` (manual dispatch only): npm install and test, `build:web`, replace the app screen with the spike page in that build only, change the appId to `com.runout.radiospike` in the runner's working copy (not committed), `cap add android`, run `apply-spike.mjs` (adds permissions `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, the service declaration, copies the service and plugin, registers the plugin in `MainActivity`), `cap sync`, `assembleDebug`, upload artifact `runout-radio-spike-apk`. The manifest and `MainActivity` string surgery is unit-tested against an *approximated* Capacitor 6 template written from memory, so the first CI run is the real test of the anchors; `apply-spike.mjs` fails loudly if an anchor is missing. It cannot affect `android.yml` or the shipped APK. **UNVERIFIED until run once.**

### 6.3 Verdict: NEEDS-DEVICE (risk: high)

I cannot say go or no-go. The honest prior is that a bare Capacitor WebView is not a safe place to promise a 30-minute screen-off program without a foreground service, and that the service plus a native MediaSession may still not stop an OEM from freezing the WebView. S2 should be the first thing the owner runs; if B1 fails, the radio bus must move to a native audio path (consistent with architecture risk R1) and this decision should be made before P2 starts.

## 7. Device-test steps (RedMagic 11 Pro)

You need: the phone, a laptop, the repo, and either path A or B. Path A tests the real target (the Capacitor WebView). Path B tests Chrome on the phone and is quicker; do A for any verdict.

**Path A: APK (WebView).**
1. GitHub, Actions, workflow "Radio spike P1 APK (manual)", Run workflow on `main`. If the build fails, send me the log (most likely an anchor in `apply-spike.mjs` or a Java compile error: this code has never been compiled).
2. Download artifact `runout-radio-spike-apk`, unzip, install `app-debug.apk` (it installs beside Runout). Grant microphone and notifications when asked.
3. The app opens straight onto the spike page.

**Path B: Chrome on the phone.** Microphone access needs a secure context, and `http://<laptop-ip>:8000` is **not** secure. Use `adb reverse`:
1. On the laptop, in the repo: `python3 serve.py 8000`.
2. USB-connect the phone with debugging on: `adb reverse tcp:8000 tcp:8000`.
3. In Chrome on the phone open `http://localhost:8000/spike/radio-p1/web/index.html`.

**Run order.**
1. **Environment.** Tap "Probe environment". In the APK, check `capacitor.native` is true and `spikeNativePlugin` is true.
2. **Echo, speaker.** Phone flat on a table, quiet room, media volume 60%, route "speaker", no headphones. Tap "Run echo suite". Do not speak. Read the last lines: the run must say "Valid run". Repeat 3 times, then once at 100% volume. Repeat once with wired headphones on the table (route "wired-headphones") and once with Bluetooth. Optional: download the capture WAVs.
   - Pass: `browser-defaults` and `aec-only` rows `clean` in all valid repeats at both volumes.
   - Double-talk (manual, 2 min): while an RJ-like voice plays, speak. If you cannot get it transcribed or it chops your voice, AEC is not good enough for barge-in on speaker.
3. **Background, run for 30 minutes each, same tone/volume.** Start from a fresh page each time, press "Start background test", then press the power button (screen off), leave the phone alone, return after 30 min, unlock, press "Summarize".
   - B0: all boxes off, native unticked. Baseline: does it survive at all?
   - B1: MediaSession on + native foreground service ticked (APK only). The main question.
   - B2: MediaSession only (Path B or APK with native unticked).
   - B3 (optional): screen wake lock only, to confirm what a wake lock alone does.
   - Record the settings page for the app: battery optimization (run once with it unrestricted).
   - For audible gaps, record the speaker with a second device for the full 30 min, export a PCM16 WAV and run `node spike/radio-p1/scripts/find-gaps.mjs recording.wav 250`.
   - Pass (S2 exit): `nonRunningHeartbeats` 0, `heartbeatsWithStallOver250ms` 0, `workletDiscontinuities` 0, find-gaps reports no gap of 250 ms or more, and the tone is still audible after 30 min. Also note `maxHeartbeatIntervalMs` (throttling) and the `events` list (context state changes, visibility).
4. **Caller-loop latency.** Tap "Run live turns" with 20 turns. Speak a short phrase each time, then be quiet. In this build stages 2 to 6 are fake; what you can read is the live mic and VAD chain working on the phone (turns complete, no stalls) and the reported output latency. Run with "Hangover" 200, 300, 500. Real latency numbers need vendor adapters, which is the next spike step.
5. **Send back**: tap "Copy all results JSON" (or Download) after each run and paste into an issue or the session; plus the find-gaps outputs, the phone's Android version, and whether the notification showed.

Remaining checks that are not in the page: whether the music bus changes volume/route when the mic opens (listen during the echo suite), and Bluetooth behaviour.

## 8. Verified vs unverified

**Verified (sandbox, reproducible):** the budget maths and table inconsistencies (unit-tested); the pipeline skeleton, stage timestamps and report; fake adapters produce the configured medians; the toy VAD's endpoint latency equals its hangover on clean synthetic input and fails at low SNR; the echo analysis recovers a known simulated echo's gain (about 0.15 dB) and lag; the page loads and all three tests run in headless Chromium 153 with fake devices; getUserMedia constraints round-trip through `getSettings()` there; `npm test` is green (121 tests).

**UNVERIFIED, all of it needs the device or a CI run:** whether AEC works in the Capacitor WebView or Chrome on the RedMagic on speaker or any route; AEC in double-talk; background audio with the screen off, with and without the service; MediaSession reaching the lock screen from a WebView; timer throttling; OEM battery policy; whether `SpikeForegroundService`, `SpikeBackgroundPlugin` and `apply-spike.mjs` compile and apply to the real Capacitor 6 template; whether the manual workflow succeeds; the plugin API surface used (`registerPlugin`, `requestPermissionForAlias`, `@PermissionCallback`) matches Capacitor 6.2 (written from memory); any real latency for STT, LLM, TTS or network; all vendor features, prices and licences (none were checked or claimed); the model ids and prices in the architecture doc (they came from a cached table and this spike did not re-verify them).

**Not done:** no real vendor adapter, no real network call, no key handling beyond refusing to run without one; no iOS; no native echo-cancellation plugin; no bridge from the WebView MediaSession to the native one; nothing in `src/`.

## 9. Recommended next steps

1. Owner runs section 7 (S2 first, then S1 echo). That decides whether the radio bus needs to be native before any P2 work.
2. If B1 passes: keep Web Audio; productionise the service as a proper plugin. If it fails: decide native bus now.
3. Correct the budget notes in `RADIO_ARCHITECTURE.md` 8.3 (section 5.4) when convenient.
4. Pick one STT, one writer and one TTS and replace the three stubs (S1 proper and S3), then rerun with `Source = measured` on every row.
5. Delete `spike/radio-p1/`, the workflow and this document's procedure once P2 supersedes them.
