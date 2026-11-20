<p align="center"><img src="assets/icon.png" alt="Runout" width="128" height="128"></p>

# Runout — v0

> **Constellation** · `state: seeded` · public · [registry: `Personal-Tracker/CONSTELLATION.md`](https://github.com/mbaliga/Personal-Tracker/blob/main/CONSTELLATION.md)
> "Runout" — tactile vinyl audio instrument for web/mobile (SharedArrayBuffer + AudioWorklet, sub-30ms scrub).

A music player for your own files that you operate with your hands: a **turntable** whose disc is the playhead (drag it to scratch, drag the arm to
seek, hold the label to brake), a **cassette** stack for mixtapes, a **radio** dial (internet stations and pre-written offline shows) and a **booth**
of performance effects. It plays local audio only; nothing is streamed from a service and nothing leaves the phone unless you tap an internet-radio row.

This is **v0, "prove the feel"**: the one milestone gate is whether a hand-scrub feels like it is *on* the sound (target under 30 ms, ceiling 50 ms).
That gate is **owner-verified on a phone and has not been passed yet**; everything below is verified in desktop Chromium only unless it says otherwise.
See [`STATE.md`](STATE.md) for the short status and [`HANDOFF.md`](HANDOFF.md) for the full current-state handoff (section map, architecture, what is
verified, the prioritised on-device checklist, open owner decisions).

## The app in one screen map

Five sections, a rounded page pulled aside from the left edge (the menu button, top left, or a drag from the screen edge) over a list of names:

| Section | What it is | Docs |
|---|---|---|
| **Albums** | The vinyl player: stage with a disc, a linear tonearm, a dot display, Play/Stop, 33/45/78 and − / +. Pinch in and it becomes the **library** (a coverflow of albums, the track list below; CDs open a CD player). | [`docs/TURNTABLE.md`](docs/TURNTABLE.md), [`docs/TURNTABLE_LIBRARY.md`](docs/TURNTABLE_LIBRARY.md) |
| **Mixtapes** | A stack (or spines) of cassettes. A phone-first editor (tape length C30/C60/C90, sides A and B, search, drag to reorder, 37 styles), suggested tapes, two player skins with AUTO and FLIP. | [`docs/MIXTAPES.md`](docs/MIXTAPES.md) |
| **Radio** | A dial of public Radio Browser stations, six **pre-written offline shows** (hosts talk between your songs), favourites, recents; an experimental offline "You Radio" behind a flag. | [`docs/RADIO_ARCHITECTURE.md`](docs/RADIO_ARCHITECTURE.md) |
| **Booth** (working name) | Beat repeat, stutter, blend scratch, band pass, reverb/delay on a touch pad. | [`docs/FX.md`](docs/FX.md) |
| **Settings** | Theme (Dark / OLED black / Light / custom JSON), accent, text size, reduced motion, library, playback, radio, booth, device mode, privacy. | [`docs/SETTINGS.md`](docs/SETTINGS.md) |

Across sections: **Search** (the magnifier in every header, Ctrl/Cmd+K or `/`: songs, albums, artists, mixtapes, stations; offline) — [`docs/SEARCH.md`](docs/SEARCH.md);
the **lock key** (padlock, top right of every page: frozen face, keep-awake, dim always-on display) — [`docs/DEVICE_MODE.md`](docs/DEVICE_MODE.md);
the **phone library** (Android app only: scans the phone's own audio through MediaStore; the web build keeps the folder picker) — [`docs/DEVICE_LIBRARY.md`](docs/DEVICE_LIBRARY.md);
the navigation shell — [`docs/SHELL.md`](docs/SHELL.md).

## Run it

```bash
python3 serve.py            # http://localhost:8000  (sets COOP/COEP so SharedArrayBuffer works)
npm test                    # node:test, no dependencies: ~1,030 tests
npm run build:web           # stages index.html + src + assets + content/stations into www/ (what the APK ships)
```

The app boots with a **synthesized test pressing** (no copyrighted audio is bundled). Scan your music with the **Scan** button in the library (pinch in on
Albums): a browser asks for a folder, the Android app scans the phone (after a permission card). Drop a file onto the page, or use Deck details > Load, for a single file.
Opening `index.html` over `file://` works but degrades to a `postMessage` audio path; measure the latency gate on the SharedArrayBuffer path.

### Verify (desktop Chromium with real touch events and real audio)

```bash
CHROME=/path/to/chrome python3 scripts/verify-all.py [outdir]     # starts serve.py on a free port, runs every verify script, prints a table
CHROME=... python3 scripts/verify-all.py /tmp/out tour            # only scripts whose name contains "tour"
```

Needs Playwright for Python, ffmpeg (with libmp3lame, libopus) and numpy. The scripts and what each proves are listed in `HANDOFF.md` "How to run".
`scripts/verify-tour.py` is the end-to-end acceptance tour (first run to reload persistence at two phone sizes and landscape, a mocked native device
library, a 5,000-track library, measured numbers). None of this replaces testing on a phone.

## Get a sideloadable APK

A Capacitor wrapper and `.github/workflows/android.yml` build a debug APK on every push to `main` (the workflow runs `npm test` first, builds `www/`, compiles
**both** custom Java plugins — the device library and the device display — and publishes):

- **Rolling release asset:** <https://github.com/mbaliga/Music_Player/releases/download/v0-latest/app-debug.apk>
- **Per-commit asset on the same release:** `runout-<sha7>.apk`
- **Actions artifact:** the run's `runout-debug-apk` (a zip).

The APK runs the web build in the system **WebView**: the wrapped-web audio path the spec flags as the latency weak point; the local scheme has no
cross-origin isolation, so the engine uses its `postMessage` fallback. It measures *wrapped-web* feel, **not** native Oboe. For the truest web read, use
`adb reverse tcp:8000 tcp:8000` and `serve.py` over `localhost`.

## How the core is built (spec §8: layered so the audio engine is swappable)

```
src/model.js          Portable model layer, PURE: spiral geometry, 1-DOF platter physics, RMS envelope. Survives a native port intact.
src/worklet.js        AudioWorklet that OWNS the read loop (one float readPosition, Catmull-Rom interpolation, any rate incl. negative).
src/control-layout.js Lock-free Float64 SharedArrayBuffer layout shared with the worklet (constants duplicated in worklet.js).
src/audio-engine.js   The SWAPPABLE engine behind a stable interface (load / setRate / seek / setPlaying / position).
src/turntable/        The Albums stage (SVG + canvas) and the coverflow library; pure geometry / camera / arm / spiral / state modules.
src/main.js           Wires input -> platter physics -> engine -> stage; owns the audio; the sections hang off the shell (src/shell/).
```

Vinyl is constant-angular-velocity, so **platter angular velocity, normalised to the nominal RPM, is the playback rate**; audio time is owned by the worklet
and the needle position is a *display* of it. Scrubbing is hand-driving the platter's angular velocity; coupled pitch and tempo only (no time-stretch).
The four feel knobs (J inertia, k motor, c friction, brake damp; `model.js: DEFAULT_PARAMS`, live in Deck details > audiophile mode) are most of v0's tuning job.

## Do not touch

- The **pure model layer** (`src/model.js`) is isolated for a later native swap — keep it free of browser dependencies.
- **COOP/COEP headers** in `serve.py` are what enable SharedArrayBuffer — do not drop them.
- Boot path: the radio, Booth, search UI and settings page are lazy imports; the static-import tests (e.g. `test/fx-ship.test.mjs`) and `test/build-web.test.mjs` guard what the first paint may load and that every shipped file is reachable.

## Licence

Source-available, free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). If you make money with it, you need a commercial
licence: see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
