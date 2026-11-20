# STATE — Runout

Short status. The full handoff (section map, architecture, verified vs not, on-device checklist, open decisions) is `HANDOFF.md`; the overview is `README.md`.

## Where we are

**v0 pre-release, gated on a hands-on feel test on the RedMagic 11 Pro** (owner-verified on-device latency / scrub feel is the one gate; not yet done).
The app is five sections behind a pull-aside drawer: **Albums** (vinyl stage + coverflow library + CD view), **Mixtapes** (cassette stack, editor, sides, AUTO / FLIP),
**Radio** (stations, six pre-written offline shows, a flagged offline "You Radio"), **Booth** (performance effects; working name) and **Settings**; plus a global
**Search** overlay, a **lock key** with a frozen face and a dim always-on display, and, in the Android app, the **phone's own music library** (MediaStore).
All of it has been integrated and exercised together by `scripts/verify-tour.py` in desktop Chromium; **nothing has been run on a phone by us**.

## Verified (desktop Chromium, node)

`npm test`: all pass (1,030+). `python3 scripts/verify-all.py`: every browser verifier plus the end-to-end tour (see `HANDOFF.md` §1 for what each proves).
CI builds the debug APK on every push, compiling both custom Java plugins (device library, device display). Tour measurements (headless CPU renderer, not a phone)
are in the table below.

| measure | value |
|---|---|
| first interactive (Play tapped and acting, local server) | TTI_VALUE |
| app boot with a 5,000-track library | BOOT5K_VALUE |
| Albums stage cost per frame while playing | STAGE_VALUE |
| JS heap after the whole tour (after GC) | HEAP_VALUE |
| search over 5,000 songs | SEARCH5K_VALUE |
| `www/` shipped | WWW_VALUE |

## Not verified

Anything on a device: gesture feel, the §3 latency gate, WebView audio / speech / SVG behaviour, native plugin runtime, keep-awake / refresh / brightness, TalkBack,
battery. Real speech has never been heard (fake `speechSynthesis` in tests). The prioritised on-device list is `HANDOFF.md` §6; the owner decisions are §7.

## Next

1. Owner: the v0 feel gate on the RedMagic with the per-commit APK (`runout-<sha7>.apk` on the `v0-latest` release), then the P1 items in `HANDOFF.md` §6 (phone library permission + scan, device mode).
2. If the web audio path fails the gate: swap `src/audio-engine.js` for a native Oboe wrapper (the only swappable layer).
3. After the gate: AI radio P1 device spikes (`docs/RADIO_SPIKE_P1.md`), then P2.
4. Multi-platform packaging is a plan only (`PORTING_PLAN.md`) and waits on the gate.

## Integration pass (Workstream I) — what changed at the seams

* Lock x new UI: every gesture entry point of the stage, coverflow, cassette, shelf and editor asks `allowsGesture`; surfaces are `data-lock-surface`; a live key inside a surface no longer swallows its own ancestors' pointerdown (this had broken the cassette's transport / AUTO / FLIP while locked); the hint card is capped at 4 s, tap-dismissible, never in AOD.
* AOD x new UI: subscribers for the Albums stage (hairline circles, static), the cassette player (reels frozen) and Booth; rAF stays at 1 Hz on every section and audio is untouched across enter / exit.
* Device library x UI: "Scan phone" on native; `year` / `added` / `genre` / exact durations flow from both sources (and the persisted index) into suggestions and search; MP3 length from the first frame when there is no TLEN; one read-model confirmed with a parity test.
* Removed: `GridView` + its CSS and other dead card / grid CSS, the temporary lock-sheet gear (Device mode is reached from Settings).
* New: `scripts/verify-all.py`, `scripts/verify-tour.py`, `docs/screenshots/tour/`; the walkthrough text was rewritten to the real UI.
