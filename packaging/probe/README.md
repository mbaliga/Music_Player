# Runout capability probe (RP-1)

One static page, `capability-probe.html`: no network, no dependencies, not staged into `www/`.
It prints crossOriginIsolated, whether a SharedArrayBuffer read loop in an AudioWorklet advances
`C_READ_POS`, AudioWorklet registration, raw baseLatency and outputLatency, decodeAudioData per
codec, localStorage persistence across runs, and presence of showDirectoryPicker, webkitdirectory,
pointer capture and navigator.audioSession. Each line is a glyph plus a word, never colour alone.

Fixtures in `fixtures/` are 0.1 s synthesized sine tones, embedded in the page by
`node packaging/probe/build-probe.mjs`; `test/probe.test.mjs` checks the two agree.

## OWNER_STEPS (nothing here has been run on a device)
1. Answer plan Q1 (may RP-1 run before the RedMagic feel gate closes).
2. Serve or wrap the page in the wrapper whose scheme you want to measure (iOS WKWebView needs the
   Capacitor project, which needs a Mac, your Apple account and a NAMES.md row for the bundle id).
3. Press Run twice, restarting the app between runs, and paste the text into STATE.md.
Until then every probe result is NEEDS-DEVICE-VALIDATION.
