# Runout — multi-platform porting plan

> Part of the constellation-wide porting program (`Personal-Tracker/PORTING_PROGRAM.md`, 2026-10-06).
> Status: **PLAN — nothing in this document has been built.** Every claim about a target platform is
> labelled with its evidence class (§0). This file is owned by the lead planning session; a platform
> track updates only its own §4 row and appends its entries to this repo's own state file, `STATE.md`
> (it has no PROGRESS section, so entries go under its existing "Owner-verified" and "Next" headings).

## 0. Evidence labels (never dropped)

asom's set, unchanged: `LAB` · `CI (hosted VM) evidence` · `EMULATOR EVIDENCE` · `SIMULATOR` ·
`CI-APPROX — NOT DEVICE EVIDENCE` · `SIMULATED — NOT DEVICE EVIDENCE` · `VIRTUALIZED — NOT DEVICE EVIDENCE` ·
`SYNTHETIC` · `CI-ONLY / NOT RUN` · `NEEDS-DEVICE-VALIDATION` (NDV) · `NEEDS-OWNER-VALIDATION` (NOV).
This program's additions: `PLAN` · `NOT-APPLICABLE (<reason>)` · `CONTAINER-BUILD-ONLY` (this container: JVM x86_64
compile/tests, nothing else) · `BROWSER-HEADLESS`. For Runout the one result that matters on every platform, the
touch-to-sound feel gate, can only ever be `NEEDS-OWNER-VALIDATION`: it is a by-feel test on a device (STATE.md).

## 1. What this repo is, in porting terms

**Product.** Runout (repo `Music_Player`, v0 "prove the feel"): a tactile vinyl listening instrument in which
platter angular velocity *is* the playback rate (scrub, silent tonearm seek, 33/45/78 coupled pitch and tempo,
palm brake, flick) over a local-only music library (`README.md`; `HANDOFF.md` "Key architectural decisions").

**State.** `README.md` header: `state: seeded`, public. `STATE.md`: "v0 pre-release, gated on a hardware
feel-test on the RedMagic 11 Pro"; "Owner-verified: On-device latency" is still the open item. All four v0
close-out boxes in `HANDOFF.md` ("What's pending", v0) are unchecked. `HANDOFF.md` records a preliminary
"12 ms estimated output latency" on the RedMagic WebView; that is the browser's own estimate, not an end-to-end
measurement, and `HANDOFF.md` says so; this plan does not treat it as gate evidence. The repo has 24 commits
(2026-06-22 to 2026-09-12); feature work stopped on 2026-06-30 and later commits are docs and Actions-storage
cleanup. `package.json` is `0.0.0`. The product spec (§2–§10) that the docs cite is not in the repo, so this plan
cites only `README.md`, `STATE.md` and `HANDOFF.md`.

**Targets today.** (1) Web, only through `python3 serve.py` on localhost (COOP/COEP): there is no hosted
deployment, no PWA manifest and no service worker (grep of `index.html`). (2) Android: a Capacitor 6 debug APK
(`com.runout.app`) built by `.github/workflows/android.yml` into the rolling pre-release `v0-latest`; it runs on
the `postMessage` fallback because the local scheme sends no COOP/COEP (`README.md` "Get a sideloadable APK").
**Targets of this plan,** in the owner's order: Ubuntu Touch, Linux desktop, iOS/iPadOS, macOS, Windows. Nothing
here changes Android behaviour, package names or appIds (NAMES.md rule 1).

**Stack.**
- Languages: JavaScript ES modules (no transpile, no bundler), one `index.html` (753 lines with inline CSS and an
  inline SVG tonearm), Python 3 (`serve.py`, dev only), YAML (Actions).
- UI toolkit: hand-rolled DOM and canvas2D (`render.js` and `mat.js` bake sprites once, then rotate-blit).
- Build: none for the app; `scripts/build-web.mjs` copies `index.html` and `src/` into `www/` and stamps the
  build id. Capacitor 6 (`@capacitor/core`, `/android`, `/cli`, all `^6.2.0`) is the only dependency; the
  Android project is generated in CI and `android/`, `ios/`, `www/` are git-ignored.
- Key platform features: AudioWorklet, SharedArrayBuffer under cross-origin isolation (`postMessage` fallback
  otherwise), Pointer Events, File System Access `showDirectoryPicker` with an `<input webkitdirectory>`
  fallback, `decodeAudioData`, `localStorage`.
- Native dependencies: none. Network calls: none (no `fetch`, XHR, WebSocket or external URL in `src/` or
  `index.html`, by grep).

**Size (measured 2026-10-06 on this checkout).** `git ls-files | wc -l` gives 23 tracked files;
`wc -l index.html src/*.js` gives 3,004 lines (10 source files plus the page); `wc -l test/*` gives 287 lines in
2 files; `grep -c "^test(" test/*.mjs` gives 22 model checks and 5 worklet checks. Not run here: `npm test`.

**Observations, not fixed by this change.** The README file map omits `src/library.js`, `src/mat.js` and
`src/walkthrough.js`. The README claim that `file://` works is doubtful for module scripts and unverified.
`serve.py` binds every interface (`("", PORT)`); that is acceptable for a dev server and is not a pattern any
shipped wrapper may copy (the Ubuntu Touch launcher in §6 is a separate file and binds `127.0.0.1` only).

## 2. Portable core vs platform-bound layers

| Module / dir | Role | Portability | Approx LOC | Notes |
|---|---|---|---|---|
| `src/model.js` | Spiral geometry, 1-DOF platter physics, RMS envelope, feel knobs | Unchanged on every target | 156 | Zero browser globals by header; 22 tests under Node. README "Do not touch". |
| `src/control-layout.js` + `src/worklet.js` | SAB slot layout; AudioWorklet read loop with Catmull-Rom interpolation | Unchanged where the engine has AudioWorklet | 20 + 159 | Constants duplicated verbatim (worklets cannot import modules). 5 tests via mocked globals. |
| `src/audio-engine.js` | The one swappable audio layer; picks SAB or `postMessage` from `self.crossOriginIsolated === true` | Unchanged unless a platform fails its gate | 147 | A native engine (Oboe, AVAudioEngine, cpal) would replace only this file. |
| `src/track.js` | Procedural 24 s test pressing; `loadFile()` via `decodeAudioData` | Unchanged; codec coverage is per engine | 121 | Decodes the whole file to PCM (see risks in §4). |
| `src/render.js`, `src/mat.js` | canvas2D record and slipmat | Unchanged | 197 + 212 | No WebGL; the Hyle material pass is roadmap only. |
| `src/main.js` | Input, physics, engine and render wiring; layouts; latency readout | Mostly unchanged; two small edits proposed (RP-2, RP-3) | 596 | Pinch is touch-only; Space is the only keyboard affordance (no wheel or gesture handlers, by grep). |
| `src/library.js` | Folder scan, ID3v2 and FLAC parsers, album grid | **Adapter needed per wrapper** | 504 | The only real code port. `scan()` at lines 283-294 is the seam; `pickFilesViaInput()` at 367-385. |
| `src/walkthrough.js` | First-run overlay | Copy edits per platform | 139 | Text is phone-centric ("for your phone"). |
| `index.html` | Page, CSS, inline SVG | Unchanged | 753 | Desktop two-column media query at line 97; `user-scalable=no`. |
| `test/` | `node:test` model and worklet gate | Runs on any runner with Node | 287 | The pure-core gate on every target (R4). |
| `scripts/build-web.mjs` | Stages `www/`, stamps build id | Reused as every wrapper's first step | 32 | Not edited by this plan. |
| `serve.py` | Dev server sending COOP/COEP | Dev only | 41 | Each wrapper must deliver the same headers by its own mechanism. |
| `capacitor.config.json`, `android.yml`, `cleanup-artifacts.yml` | Android wrapper and CI | Android-bound; untouched | 8 + 99 + 100 | `android.yml` uploads an Actions artifact and uses unpinned `@v4` actions; recorded, not changed (R2, R3). |

| Platform-bound API | Where | Porting impact |
|---|---|---|
| SharedArrayBuffer and `crossOriginIsolated` (needs COOP `same-origin` and COEP `require-corp`) | `audio-engine.js:35-40,59`, `control-layout.js`, `serve.py` | Every wrapper needs its own header mechanism: Tauri `app.security.headers`; Capacitor needs a native scheme-handler header patch (unverified); Ubuntu Touch needs a bundled loopback server (OQ-15). Without it the engine degrades to `postMessage`, which is not the gate path. |
| AudioWorklet loaded by `new URL('./worklet.js', import.meta.url)` | `audio-engine.js:48-49` | The module fetch must resolve under `tauri://`, `capacitor://` or the Ubuntu Touch origin. WebKitGTK, WKWebView and the Ubuntu Touch engine versions are unverified. |
| `AudioContext({latencyHint:'interactive'})`, `baseLatency`, `outputLatency` | `audio-engine.js:44-45,143-144`; readout `main.js:363-370` | `outputLatency` is reported as 0 or missing on some WebKit builds (unverified here; RS-1, RS-3 and RS-4 record the actual values), so on WebKit the readout could show about 0 ms and a "✓" verdict that means nothing (RP-3). Real latency is the OS audio stack's and is measured by feel. |
| `decodeAudioData` | `track.js:94` | Codec coverage differs per engine (WebKitGTK depends on installed GStreamer plugins; WKWebView reportedly lacks ogg/opus; the library regex also lists wma/aiff). A probe decides what the picker offers. |
| `showDirectoryPicker`, `<input webkitdirectory>` | `library.js:283-294, 367-385` | Chromium-only picker; WebKit picks files on iOS; Ubuntu Touch routes through content-hub (no directory, unverified for the container). |
| `localStorage` (`runout.layout`, `.theme`, `.playCount`, `.wtDone`) | `main.js:51,83,88,203,533-535`; `walkthrough.js:60,76` | Persistence across restarts is per wrapper and must be probed, especially on Ubuntu Touch. |
| Pointer Events, `setPointerCapture`, non-passive touch listeners | `main.js:224-297, 411-440`; `library.js:396-398` | Mouse scrub should need no change (Pointer Events; unverified per engine); pinch-to-grid and grid zoom are touch-only (Q7). |
| Capacitor 6, `capacitor.config.json` | `package.json`, `.gitignore` | Android only today; the iOS lane uses Capacitor 8 per the program (§6, proposed P-3). |

## 3. Binding rules this port must not break

- **Keep `src/model.js` portable**: no DOM, Web Audio, canvas or browser globals (`README.md` "Do not touch"; `model.js` header). Ports never fold platform code into it.
- **Never drop COOP/COEP; the gate is measured on the SAB path** (`README.md` "Do not touch", `serve.py`, `audio-engine.js`). A wrapper that cannot deliver cross-origin isolation is a degraded surface and must say so in-app, as `main.js:370` already does; it can make no gate claim.
- **`audio-engine.js` is the only swappable layer** and its interface (`load`, `setRate`, `seek`, `setPlaying`, `position`, `latencyEstimate`) is stable (`README.md` §8, `HANDOFF.md`).
- **Keep `control-layout.js` and the constants in `worklet.js` in sync** (`HANDOFF.md`, `worklet.js`).
- **Locked decisions** (`HANDOFF.md`): single deck and spiral; coupled pitch and tempo only; one spiral per track; **local-only library, no streaming, ever**; audio time owned by the worklet; the feel knobs are the product, dialled by hand on-device.
- **Environment honesty** (`STATE.md`, `README.md` "Latency & the go/no-go gate"): on-device latency is owner-verified only; the browser's `outputLatency` is not end-to-end latency; no platform's gate result is claimed from theory or from the self-reported estimate.
- **No copyrighted audio is bundled**; the app boots with the synthesized test pressing (`README.md`). Probe fixtures follow the same rule.
- **`npm test` runs before any packaging step**, so a broken model fails the build (`android.yml`, `HANDOFF.md`). Every new lane keeps that order.
- **Constellation hygiene** (commit 484016d): `README.md` keeps its registry header block; `STATE.md` keeps Current state, Next and Owner-verified.
- **No telemetry, analytics or phoning home** (program I-1). The app makes zero network calls today and must stay that way: every wrapper's CSP and permissions start closed, and no updater plugin is added, because an auto-updater is a network call nobody asked for.
- **Colour never carries meaning alone** (program I-3; inherited, not written in this repo). Runout is in the Hyle-consumer set (`Personal-Tracker/DECISIONS.md` D-L), so any new UI (degraded-surface label, probe output, readout) uses words plus a shape glyph.
- **Identifiers need a registry row first** (program R11; `Personal-Tracker/NAMES.md`): the Runout row reads "Capacitor wrapper TBD", repo name lags brand (owner-gated). No bundle id, click name, Flatpak id, MSI or winget id is written into a manifest before it has a row (OQ-25).
- **Licence is unstated** (no `LICENSE`, no SPDX headers; README says "public"; listed as a gap in `Personal-Tracker/CONSTELLATION.md`). No store, Flathub or OpenStore submission before OQ-12 is ruled.
- **Program rules that bind the work:** R1 disjoint directories; R2 the existing gate stays green (`npm test`, the Android APK build); R3 new workflow files only, SHA-pinned; R5 no listener, server or key material in CI; R6 nothing released, every artefact `UNSIGNED — not for release`, binaries to draft releases and never to Actions artifacts; R7 real output or `BLOCKED(<reason>)`.

## 4. Target matrix (owner's order)

| Target | Feasibility | Approach | Blockers | Effort (eng-weeks, estimate) | Evidence today |
|---|---|---|---|---|---|
| Ubuntu Touch | moderate | Click around the static build: `webapp-container` (Morph engine) started by a launcher that first starts a bundled loopback-only static server sending COOP/COEP (OQ-15). If OQ-15 is no, Runout is skipped on UT (program §7). If OQ-15 is yes but RS-2 shows the bind is impossible under confinement, ship a labelled degraded surface with no gate claim. | OQ-15; OQ-1 (no UT device on record); webapp-container engine on 24.04-2.x unverified; loopback bind under AppArmor unknown; content-hub import unverified; PulseAudio over libhybris latency unknown; OQ-12 | 2 | PLAN |
| Linux desktop | straight | Tauri 2 shell (WebKitGTK 4.1): `frontendDist` is the staged `www/`, `app.security.headers` sends COOP/COEP, CSP closed, native folder dialog adapter behind the library seam; deb, tarball and a Flatpak draft built on ubuntu-22.04 (glibc baseline). | RS-1 (COI, AudioWorklet and codecs on WebKitGTK, in both the host and Flatpak engines); Q7 desktop input; OQ-25; OQ-4; OQ-5 | 2 | PLAN |
| iOS / iPadOS | moderate | Capacitor 8 (WKWebView) in `apple/` with its own manifest, built on `macos-latest`; native scheme-handler header patch if RS-3 shows it is needed; multi-file document-picker adapter; unsigned `.xcarchive`; TestFlight or ad-hoc lanes as disabled templates. | OQ-2; OQ-3; RS-3; no folder scan on iOS; codec gaps; possible silent-switch muting (assumption); memory under full-file decode; iPad Pro M4 is the only Apple device on record; OQ-12 | 3 | PLAN |
| macOS | straight | The same Tauri shell on WKWebView, built on `macos-latest` into an unsigned `.app` and `.dmg`; notarisation as a disabled template. "Designed for iPad" is the no-Mac alternative once iOS ships. | Linux shell must exist first; OQ-3; OQ-5 (no Mac on record, so device gates are NOV); RS-4 | 1 | PLAN |
| Windows | straight | The same Tauri shell on WebView2 (NSIS and MSI) on `windows-2025`, after the R3 path lint; the same dialog adapter as Linux unless RS-4 shows `showDirectoryPicker` works. | Shell must exist first; OQ-3 (unsigned builds meet SmartScreen); OQ-5 (the Dell while it is Windows); RS-4 | 0.5 | PLAN |

Total 8.5 engineer-weeks, an estimate matching the program's §5 row; shared work (probe, seam) is paid once in the first wave that needs it (§6), so rows move if the order changes.

**Why not Electron.** Program rule R8 rejects Electron for web apps unless a WebKitGTK spike fails (OQ-15). Here "fail" means a capability failure in RS-1: `crossOriginIsolated` stays false with the documented header configuration, or the AudioWorklet cannot register under the shell's scheme. If that happens the owner is asked (Q2) with the evidence attached; nothing switches automatically. A latency failure on a platform is a different outcome: it is a feel-gate result, and `HANDOFF.md`'s remedy is a native engine behind the `audio-engine.js` seam.

**If the RedMagic gate fails.** `HANDOFF.md` then swaps `audio-engine.js` for a native Oboe engine, and every estimate above is void: each target would need its own native engine behind the same seam (AVAudioEngine, cpal, a Qt or PulseAudio engine on Ubuntu Touch, for which there is no cheap path). A pass on the RedMagic does not carry over either: it is an Android WebView result, and each platform has its own engine and audio stack and its own owner-run gate.

**Risks to carry, all unverified.** `track.js` decodes whole files and `audio-engine.js` copies the PCM into a planar buffer, so a one-hour file at 44.1 kHz stereo is about 1.27 GB of float PCM before copies (3600 × 44100 × 2 × 4 bytes); mobile WebViews will probably refuse that, and the limit is unmeasured. Engine versions differ by install path on Linux (deb uses the host WebKitGTK, Flatpak the runtime's). Tauri's own IPC, which the dialog and fs plugins use, must survive COEP `require-corp`; RS-1 tests it.

## 5. Tier and sequencing

**Tier C (thin or reframe)**, as in the program's §5 row. Runout is about 3k lines of static web with no runtime dependencies, no backend and no network calls, so every target is a packaging exercise plus one real adapter (library file access) and one header mechanism per engine. It is not a flagship because v0 is `seeded` and its single gate has never been recorded as passed. It is not deferred because its size makes it the cheapest pathfinder for the shared Tauri, Capacitor-iOS and Ubuntu Touch web lanes. Promotion to tier B is proposed only if the feel gate passes and the v1 library work (which the adapters sit on) proceeds.

**Repo-local gate before any wave: the v0 feel gate on the RedMagic 11 Pro** (program §5; `STATE.md` still says "gated"). It is the owner's by-feel test and is recorded under `STATE.md` "Owner-verified". The capability probe (RP-1) ships nothing and costs nothing against the gate; whether it may run before the gate closes is Q1.

| Target | Wave (program §7) | Build-entry | Device-entry |
|---|---|---|---|
| Ubuntu Touch | P-UT a, in parallel with P-LX, **only if OQ-15 is answered yes**; if no, Runout is skipped on Ubuntu Touch (program §7), with no degraded surface and no UT lane; if yes but RS-2 finds the loopback bind impossible under confinement, only the labelled degraded surface may ship, with no gate claim | F7 webapp template and the OpenStore policy (§7); the gate; OQ-12 | A UT 24.04-2.x device (OQ-1) or an explicit CI-only waiver |
| Linux desktop | P-LX, in the Tauri trio: Animalcules pilots the lane, then Runout after its RS-1 spike, then Bocal | The gate; OQ-25 row; F10's Tauri template if it exists by then, else a local config flagged for reconciliation (OQ-24) | `DEVICE_CHECKLIST_LINUX.md` on the Steam Deck (Desktop Mode, touch), the Dell only if OQ-5 says Linux |
| iOS / iPadOS | P-iOS, with Bocal (Capacitor 8), after the Kotlin apps | The gate; `macos-latest` lanes; F10's Apple privacy lints (§7) | Apple Developer Program and a delivery route (OQ-2); the iPad Pro M4 |
| macOS | P-mac, packaging over the Tauri shell | P-LX shell green; OQ-3 for signing | No Mac on record, so NOV (OQ-5) |
| Windows | P-win, packaging over the Tauri shell | P-LX shell green; the R3 path lint; OQ-3 or accepted unsigned | The Dell while it is Windows (OQ-5), else `CI (hosted VM) evidence` only |

HANDOFF v2 already puts Linux, Windows and macOS in Runout's scope ("Desktop via Tauri"), so the three Tauri lanes may be written together (one `tauri.conf.json`, paid once under R10). Their macOS and Windows jobs stay `workflow_dispatch` until their waves unless the owner says otherwise (Q11). The repo is public, so hosted minutes cost nothing; Actions artifact storage is the scarce resource (Q12).

## 6. Work breakdown

**Placement (R1: disjoint from the existing build; root `package.json`, `src/`, `android.yml`, `cleanup-artifacts.yml` and `.gitignore` are unchanged by every lane; RP-2 and RP-3 are `src/` edits and land only as separate repo PRs after their proposals are ruled).**

| Path | Owner | Contents |
|---|---|---|
| `packaging/probe/` | all lanes | `capability-probe.html` and a few-KB synthesized fixture per codec; no network, no dependencies, never staged into a shipped `www/` |
| `desktop/` | Linux, macOS, Windows | `src-tauri/` (config, capabilities, icons), `host.js`, own `.gitignore` for `target/` and `gen/` |
| `apple/` | iOS | own `package.json` (Capacitor 8), `capacitor.config.json` with `webDir` `../www`, `overlay/` Swift files applied after `cap add ios`; the generated `apple/ios/` is already ignored by the root `ios/` pattern |
| `ubuntu-touch/` | Ubuntu Touch | `clickable.yaml`, `manifest.json.in`, AppArmor policy, `.desktop`, launcher, loopback server, `host.js` |
| `.github/workflows/` | each lane | new files only: `desktop-linux.yml`, `desktop-macos.yml`, `desktop-windows.yml`, `ios.yml`, `ubuntu-touch.yml` |

**CI conventions for every lane.** SHA-pinned actions; `npm test` first (Node on each runner is itself the R4 pure-core check); then `npm run build:web`; compile-only on pull requests, packaging on `main` and tags only; no `upload-artifact`; binaries go to a draft release labelled `UNSIGNED — not for release` (not `v0-latest`, which stays Android's); no server or listener started in CI (R5); the Windows path lint runs before any `windows-*` job. `cleanup-artifacts.yml` deletes every Actions cache every six hours, so cold builds are expected and their duration is unmeasured.

**RP: shared preparation, paid once (counted in the first wave that needs it; Linux unless Ubuntu Touch lands first).**
- **RP-0 (owner, no code).** NAMES.md rows for the Tauri identifier, Flatpak id (OQ-4 domain), iOS bundle id, click name and Windows ids (R11, OQ-25); answers to OQ-12 and OQ-15; icon source art (Q13).
- **RP-1 capability probe.** One static page printing, as words plus a glyph and never colour alone: `crossOriginIsolated`; whether the engine's own SAB path advances `C_READ_POS` (a flag is not enough: `audio-engine.js` notes that an unshareable SAB presents as silence, and a CI run cannot hear); AudioWorklet registration under the wrapper's scheme; raw `baseLatency` and `outputLatency`; `decodeAudioData` per codec on the fixtures; `localStorage` persistence across two runs; presence of `showDirectoryPicker`, `webkitdirectory`, pointer capture, `navigator.audioSession`. Output is plain text for the owner to paste into `STATE.md`.
- **RP-2 library host seam (proposed P-2).** One additive branch in `library.js` `scan()`: if `window.runoutHost?.pickLibrary` exists, use it and skip the Chromium and input paths. It returns file-like objects (`name`, `size`, `slice(a,b).arrayBuffer()`, `arrayBuffer()`) so the ID3 parser reads only the first 512 KB. Absent the object, behaviour is identical on web and Android. Gate: `npm test` and the unchanged Android build.
- **RP-3 honest latency readout (proposed P-4).** When `baseLatency` and `outputLatency` are both 0 or missing, `main.js` shows "not reported by this engine; measure by loopback" instead of a verdict. Chromium's output is unchanged.

**Linux desktop (2 w).**

| Step | What | Where | Done when | Evidence | Wk |
|---|---|---|---|---|---|
| LX-1 | RP-1 (RP-3 is a separate repo PR, not part of this step); spike RS-1 on WebKitGTK | `packaging/probe/`; `desktop-linux.yml` probe job | RS-1 questions answered for the host engine and the Flatpak runtime; Electron question raised only on a capability failure; the `src/` edit (RP-2 / RP-3) lands through a separate repo PR after its proposal is ruled, not inside this lane (R1) | `CI (hosted VM) evidence` under xvfb, capability only (whether an AudioContext can start on a runner with no sound device is unknown); NDV on a desktop and the Deck | 0.5 |
| LX-2 | Tauri scaffold: `frontendDist` `../../www`, `app.security.headers` COOP `same-origin` and COEP `require-corp`, CSP from `default-src 'self'` adding only `img-src blob:` (`library.js:266`) and inline styles (`index.html`), minimal capabilities (dialog, read-only fs), no updater, no http or shell plugin | `desktop/src-tauri/` | Compile-only job green on ubuntu-22.04 with the existing gate untouched | `CI (hosted VM) evidence` | 0.5 |
| LX-3 | `host.js`: native folder dialog, fs reads through file handles (no whole-library reads), written against the RP-2 hook | `desktop/host.js` | Adapter unit-tested under `node:test` with mocks; folder scan exercised in the shell once the hook exists; the `src/` edit (RP-2 / RP-3) lands through a separate repo PR after its proposal is ruled, not inside this lane (R1) | `CI (hosted VM) evidence`; NDV | 0.75 |
| LX-4 | deb and tarball on `main` and tags; Flatpak manifest as a CI-built draft; Flathub submission is separate, owner-gated (OQ-4) and not estimated | `desktop/`; `desktop-linux.yml` | Draft release holds unsigned packages | `CI (hosted VM) evidence` | 0.25 |
| LX-5 | Owner feel gate on a Linux desktop and the Steam Deck; Termux:X11 on the RedMagic optional | `STATE.md` "Owner-verified" | One line per device: build id, SAB or fallback path, verdict | NDV / NOV | owner |

**Ubuntu Touch (2 w; only if OQ-15 is yes).**

| Step | What | Where | Done when | Evidence | Wk |
|---|---|---|---|---|---|
| UT-1 | Spike RS-2: does the 24.04-2.x `webapp-container` use the Morph engine; can a launcher bind `127.0.0.1` under confinement (and does that need the `networking` group, which would then be a permission the app never uses for an external call and must be disclosed, I-1); is COI reached; does `<input type=file multiple>` (no `webkitdirectory`) route through content-hub | `ubuntu-touch/`, `packaging/probe/` | Written verdict; if OQ-15 is yes but the loopback server is not viable, ship the labelled degraded surface only | CI half `CI-APPROX — NOT DEVICE EVIDENCE`; device NDV | 0.75 |
| UT-2 | Click: Clickable build, manifest, AppArmor (common groups only), launcher that starts the loopback server, execs the container and stops the server on exit; server serves only the bundle, picks a free port, lists no directories | `ubuntu-touch/`; `ubuntu-touch.yml` | Click builds and passes click-review in CI; the server is never started in CI (R5) | `CI-APPROX — NOT DEVICE EVIDENCE` | 0.5 |
| UT-3 | Library import: the plain multi-file input through `host.js` if RS-2 says content-hub serves it; a QML bridge only if not; verify `localStorage` survives restarts | `ubuntu-touch/host.js` | Import path exercised on a device | NDV | 0.75 |
| UT-4 | Owner feel gate on a UT device on the SAB path (and on the `postMessage` path only in the RS-2-failed case) | `STATE.md` | Recorded per device | NDV / NOV | owner |

**iOS / iPadOS (3 w).**

| Step | What | Where | Done when | Evidence | Wk |
|---|---|---|---|---|---|
| IOS-1 | Capacitor 8 project in its own manifest (Node 22, Xcode 26 per the iOS brief); `npm test`, `build:web`, `cap add ios`, `cap sync`, simulator build with `CODE_SIGNING_ALLOWED=NO` | `apple/`; `ios.yml` on `macos-latest` | Simulator build green; Android lane unaffected | `CI (hosted VM) evidence` | 0.5 |
| IOS-2 | Spike RS-3: is `crossOriginIsolated` true under `capacitor://localhost` once a scheme-handler header patch from `apple/overlay/` is applied; AudioWorklet and codecs; whether the hardware silent switch mutes Web Audio and whether `navigator.audioSession` or an AVAudioSession setting fixes it (both assumptions) | `apple/overlay/`, `packaging/probe/` | Written verdict; if isolation is unreachable, ship the labelled degraded surface | `SIMULATOR` for capability; NDV on the iPad | 0.5 |
| IOS-3 | Library import: document picker for multiple files (no folder scan on iOS), copy-in versus scoped access decided in the spike, picker limited to codecs the probe proved | `apple/overlay/`, `apple/host.js` | Import exercised in the simulator and on the iPad | `SIMULATOR`; NDV | 1.5 |
| IOS-4 | Delivery: unsigned `.xcarchive` to a draft release; signing, TestFlight and ad-hoc jobs exist only as disabled templates until OQ-2 and OQ-3; privacy manifest declares no tracking and no network | `apple/`; `ios.yml` | Templates present and disabled | `CI (hosted VM) evidence` | 0.5 |
| IOS-5 | Owner feel gate on the iPad Pro M4; iPhone items stay NDV until an iPhone exists | `STATE.md` | Recorded | NDV / NOV | owner |

**macOS (1 w).** MAC-1 (0.5): `desktop-macos.yml` builds the same Tauri shell into an unsigned `.app` and `.dmg` on `macos-latest`, `UNSIGNED — not for release`; `CI (hosted VM) evidence`. MAC-2 (0.5): run the probe on the shell (RS-4, WKWebView behind Tauri's scheme, not assumed equal to RS-3), keep notarisation and Developer ID as a disabled template (OQ-3), and check the "Designed for iPad" route once IOS-4 exists; `CI (hosted VM) evidence`, NOV. MAC-3: owner gate on a Mac if one exists (OQ-5), otherwise it stays open.

**Windows (0.5 w).** WIN-1 (0.25): add the R3 path lint, then `desktop-windows.yml` building NSIS and MSI on `windows-2025` into a draft release, unsigned (OQ-3); `CI (hosted VM) evidence`. WIN-2 (0.25): run the probe (RS-4 on WebView2): COI under the shell's origin, whether `showDirectoryPicker` works inside WebView2 (unverified), decide whether Windows reuses the Linux dialog adapter (the default, for one behaviour everywhere). WIN-3: owner gate on the Dell while it is Windows (OQ-5), else open.

## 7. Shared foundation this repo consumes or provides

**Consumes.** F7 (Ubuntu Touch shell): the webapp-container click template with its optional 127.0.0.1 static server (OQ-15), the OpenStore account and policy, `DEVICE_CHECKLIST_UT.md`; S-UT1 (the headless-JVM verdict) does not gate Runout, which has no JVM. F10: the `tauri.conf.json` with COOP/COEP headers and the `window.<app>Host` bridge contract (RP-2's `window.runoutHost` follows it), the Linux, Windows and macOS packaging templates, and the Apple privacy lints. F11: the evidence record and `DEVICE_CHECKLIST_{UT,LINUX,IOS,MACOS,WINDOWS}.md` templates. F9: only its conventions (SHA-pinning, compile-only pull requests, the Windows path lint, no artifact uploads); `kmp-matrix.yml` is for KMP repos and Runout is not one, so it keeps its own workflows. Until OQ-24 rules how non-Gradle templates are shared, Runout consumes them by SHA-pinned `uses:` or a generator, never by copy-vendoring; if F10 lags Runout's wave, the local `tauri.conf.json` is flagged for reconciliation.

**Not consumed.** F1 (no Hyle code is used today; the WebGL material pass would need a web-consumable Hyle export, a request to Hyle and not an assumption, Q8), F2 (no crash-recovery module), F3, F4 (no model routing), F5, F6 (Kotlin libraries; no keys held, so OQ-22 is `NOT-APPLICABLE (the app stores no secrets)`), F8. F12 only if Q10 is yes. OQ-18 is `NOT-APPLICABLE (no third-party calls)`.

**Provides.** The first recorded COOP/COEP results for Tauri on WebKitGTK, WKWebView and WebView2, for Capacitor on WKWebView and for the Ubuntu Touch container, written into §4 and offered to F7 and F10 and to Bocal, which needs the same isolation answers. The capability probe page, offered to Bocal and Animalcules through whatever OQ-24 rules. The loopback-launcher pattern, if OQ-15 is yes, as the first consumer of F7's optional server.

## 8. Open questions for the owner

Numbered; each says what it blocks. Master ids in brackets.

1. **Has the v0 feel gate on the RedMagic been run since 2026-06, and may packaging start before it?** `STATE.md` still says gated, and its result decides whether `audio-engine.js` stays web. Blocks every wave (program §5 gate); the narrower ask is whether RP-1 may run now.
2. **Desktop engine.** Accept Tauri (WebKitGTK, WKWebView, WebView2) with the WebKitGTK risk, or prefer Electron for Chromium parity at the cost of size? [OQ-15, second half; R8 rejects Electron unless RS-1 fails.] Blocks only the LX-2 branch point, and only on a capability failure.
3. **Ubuntu Touch.** Which device, does the owner have it for the gate, and is OpenStore publication intended? The program fixes the baseline at 24.04-2.x and excludes 20.04, so this plan assumes a 24.04-2.x minimum. [OQ-1, OQ-4, and OQ-15 for the loopback server.] Blocks UT-1 onward and every UT device gate.
4. **Apple.** Developer Program membership, a Mac, an iPhone as well as the iPad, and the delivery route: App Store, TestFlight only (which uploads tester crash reports automatically; I-1 asks whether that is acceptable if disclosed) or ad-hoc. [OQ-2, OQ-3, OQ-5.] Blocks IOS-4 and every Apple device gate.
5. **Licence.** No `LICENSE` exists and the README says "public"; the constellation uses FSL-1.1-ALv2 for apps and Apache-2.0 for engines elsewhere. [OQ-12.] Blocks Flathub, OpenStore, App Store and Store submissions.
6. **Per-platform file bridges.** Is it acceptable to add native file-source adapters (Tauri fs, Capacitor document picker, content-hub) behind one `window.runoutHost` hook in `library.js`, the first platform-specific code beside the pure-web tree (proposed P-2), and may the latency readout change in `main.js` (RP-3, proposed P-4) land the same way, as a separate repo PR? Blocks RP-2, RP-3, LX-1 (RP-3 part), LX-3, UT-3, IOS-3.
7. **Desktop interaction.** Should mouse and trackpad get equivalents for the touch-only pinch gestures (for example Ctrl+wheel to open the grid and zoom it), and should the phone-centric walkthrough copy change per platform? The feel knobs are the product, so this is a design call. Blocks desktop UX work only, not packaging.
8. **Hyle material pass.** Is the WebGL/AGSL pass expected on the desktop, iOS and Ubuntu Touch ports, or deferred with the native Android path? Blocks nothing now; blocks any F1 web-token request later.
9. **The original spec (§2–§10).** Where does it live, and may it be checked in so this plan can cite it? Blocks citing spec text; this plan does not.
10. **Hosted web build or installable PWA.** None exists, and it needs a host that sets COOP/COEP (GitHub Pages cannot; a service-worker shim or a header-capable host can). R8 lists PWA first for web apps, and it would also be the Morph route on Ubuntu Touch. [F12.] Blocks an optional web lane; does not change tier or waves.
11. **Windows order.** With one Tauri shell Windows costs about 0.5 w beside Linux; may the Windows and macOS lanes be written in the Linux wave and left `workflow_dispatch` until their own waves (§5)? [Program §7 order.] Blocks scheduling only.
12. **Actions budget.** Hosted minutes are free on this public repo, but the account's Actions storage was exhausted twice (the cleanup commits of 2026-08-31 and 2026-09-12). Is a multi-OS matrix acceptable, with binaries on draft releases only, or should macOS and iOS be on demand? [OQ-20, R6.] Blocks the cadence of the macOS and iOS lanes.
13. **Icon and brand art** (added by this plan). No icon or splash source is tracked (`git ls-files` lists none), and Tauri, iOS, the click and every store listing need one. Who supplies it, and is a generated placeholder acceptable for unsigned builds? Blocks LX-2's bundle step and any store listing.

**Proposals awaiting a ruling (not decisions).** This repo has no decision register, so proposals live here and are not copied into `HANDOFF.md` by this change.
- **Proposed P-1.** `HANDOFF.md` v2 sequences "Desktop via Tauri" after the native Android port. Proposal: do not sequence it behind that port; the library adapter comes first, and an audio adapter is added per platform only if that platform's own feel gate fails.
- **Proposed P-2 (a seventh locked decision).** The only two platform seams in `src/` are `audio-engine.js` (audio) and the optional `window.runoutHost` (library source); every other piece of platform code lives outside `src/`.
- **Proposed P-3.** The iOS lane pins Capacitor 8 in `apple/package.json`; the root `package.json` stays on `^6.2.0` for Android. Aligning the two is a separate change after the gate, not part of this plan.
- **Proposed P-4.** The latency readout reports "not reported by this engine" instead of a verdict when the engine reports nothing (RP-3).

## 9. Sources read

In this repo: `README.md`, `STATE.md`, `HANDOFF.md`, `package.json`, `capacitor.config.json`, `serve.py`, `.gitignore`, `.github/workflows/android.yml`, `.github/workflows/cleanup-artifacts.yml`, `scripts/build-web.mjs`, `index.html` (head, tags, external-URL grep), `src/audio-engine.js` (full), `src/model.js` (header and API), `src/worklet.js`, `src/library.js`, `src/track.js`, `src/mat.js`, `src/walkthrough.js`, `src/main.js` (greps and the latency readout), `test/model.test.mjs`, `test/worklet.test.mjs`, and `git log`, `git ls-files`, `git remote` (read-only).

Outside this repo: `Personal-Tracker/PORTING_PROGRAM.md` (§0–§3, §4, this repo's §5 row, §6, §7, §8), `Personal-Tracker/NAMES.md` (Runout row), `Personal-Tracker/DECISIONS.md` (D-L), `Personal-Tracker/CONSTELLATION.md` (licence gap), and the platform briefs `Personal-Tracker/porting/platforms/{ubuntu-touch,linux,ios,macos,windows,framework-strategy}.md`. Platform facts in this plan come from those briefs, except the `outputLatency` WebKit note in §2, which is the author's unverified recollection and not in the briefs; all are unverified here and nothing was built or run.

## Owner rulings and the proposed line (added 2026-10-07)

Status: PLAN. Nothing here is built, run on a device, signed or submitted. The program-level plan is Personal-Tracker `PORTING_PROGRAM.md` ([PR #10](https://github.com/mbaliga/Personal-Tracker/pull/10)), which holds the owner's rulings and section 5A, the proposed port / no-port line. The cells, estimates and open questions above are this repo's original plan and are unedited. Where the owner has since answered a question, the answer is below. Section 5A is a proposal; the owner has not yet confirmed it.

### Where Music_Player sits in the proposed line (program section 5A.3, a proposal)

| Target       | Verdict | Weeks and flags |
| ------------ | ------- | --------------- |
| Ubuntu Touch | port    | 2w g            |
| Linux        | no-port | -               |
| iOS/iPadOS   | port    | 3w              |
| macOS        | no-port | -               |
| Windows      | no-port | -               |

Key: `follows` means it ports only as far as the products that depend on it; `exists` means the program reads it as already running there, unverified (finish, verify and sign); flags: `g` gated on a prerequisite, `r` re-estimate or floor, `o` its own program, `s` scope note. The program's P4, P8, P12 and P13 gate whole columns or repos and are not flagged per cell. A port verdict counts the deliverable in the line; where this repo's plan calls a deliverable a reframe (program rule R12) it keeps that label. Tests cited in the reason: (a) the owner said it is needed there; (b) its job is really done on that OS by real users; (c) that OS is where it is sold or its audience is; it has no reason to exist if (x) its surface is absent or untouchable, (y) the capability is forbidden or impossible, or (z) the only form is a thin wrapper or a different product nobody asked for. Numbers written "program P4" and OQ-numbers refer to the program plan; this plan's own "Proposed P-1 to P-4" are local (Personal-Tracker `PORTING_PROGRAM.md`, sections 5A.5 and 8).

Reason: iOS is the port. On UT it is a web-view host, a port after the owner's answer of 2026-10-07 (OQ-34) with its 30 ms audio-latency probe (program P15) as a precondition; it goes back to no-port if the probe fails (the program plan's reading of the option's "if its audio-latency probe passes"). Its desktop cells stay no-port: it is a touch-feel instrument and a browser tab does the same job there.

### Owner rulings that apply here

- **OQ-34 web hosts (2026-10-07):** "Yes, extend it": a web bundle in a native host counts as a port for Runout on Ubuntu Touch, with its audio-latency probe as a precondition; Runout is a web app and not on the program plan's Android-only list for the Ubuntu Touch scope ruling (its reading, not the owner's words), so the program plan does not apply that ruling to it. Its desktop cells stay no-port.
- **Ubuntu Touch device:** the owner owns one and says it is a OnePlus 6; research reads it as 20.04-only while the program plan targets 24.04. On 2026-10-07 the owner chose "OnePlus 6 pre-spike now, decide later" (OQ-37): a labelled "S-UT1 (focal)" headless-JVM pre-spike, no 24.04 flashing, a 24.04 device decision afterwards. Every Ubuntu Touch device gate stays NDV until then. The pre-spike tests a headless JVM and does not exercise this repo's shape (a web-view host with a loopback server). S-UT1 does not gate Runout (plan section 7); its Ubuntu Touch gates are the audio-latency probe (program P15) and the plan's RS-2 spike.
- **OQ-31 Mac (2026-10-06 and 2026-10-07):** "Buy a Mac", and on 2026-10-07 an Apple-silicon Mac mini, not yet bought; no Apple device gate is called checkable before then.
- **Apple (OQ-2, 2026-10-06):** "Whatever let's me sell apps on the app store": the paid Developer Program and the App Store are the target channel. TestFlight is not used until the exception to I-1 (OQ-32, drafted as PROPOSED-1, not approved) is approved.
- **OQ-20 CI (2026-10-06):** "Linux-only CI when private (Recommended)": this repo is public, so the ruling does not limit its macOS and Windows lanes; going private would stop them. Actions artifact storage is still exhausted (program rule R6).
- **Directives (2026-10-06):** "Draft amendments for approval": program directives I-1 to I-12 and rules R1 to R12 are unchanged; PROPOSED-1 to PROPOSED-4 in Personal-Tracker `DECISIONS.md` are drafts awaiting the owner.

### Prerequisites and open questions that touch this repo (program sections 5A.5 and 8)

Prerequisites (program-level; not costed here):

- program P4: A device that can run the 24.04 Ubuntu Touch the program plan targets (the owner's OnePlus 6 is read as 20.04-only)
- program P8: An Apple-silicon Mac (OQ-31: a Mac mini chosen on 2026-10-07, not yet bought)
- program P15: Runout's 30 ms audio-latency probe and the OQ-15 loopback server

Owner questions in the program register that concern this repo (status as of 2026-10-07):

- OQ-2 (ruled): Apple Developer Program and the delivery route
- OQ-12 (open): Licences for repos without a LICENSE
- OQ-15 (open): Runout and Bocal: loopback server for COOP/COEP, Electron fallback
- OQ-20 (ruled): CI minutes, storage and repo visibility
- OQ-31 (ruled): CI for App Store builds; which Mac
- OQ-32 (open): Exception to I-1 for TestFlight and App Store crash reports
- OQ-34 (ruled): Web-view hosts and "installed apps will always have more to offer"
- OQ-37 (answered in part): A second Ubuntu Touch device

When the owner confirms or changes the line, this repo's original cells above stay as the engineering detail; only the verdicts and re-costs in program section 5A change.
