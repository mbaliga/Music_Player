# The navigation shell (Workstream S)

The app is five sections (Albums, Mixtapes, Radio, Booth, Settings; Settings and Search are described in `docs/SETTINGS.md` / `docs/SEARCH.md`). The current one is a big rounded **card**; the section menu sits **behind** it. Pulling the card aside to the
right (from the left edge, or with the hamburger) reveals the menu: logo mark on top, the four names vertically around the middle, the active
one large and dark, the others small and grey, the old header buttons in the footer. The layout is the owner's phone mock-up
(`/root/.claude/uploads/.../4eaad674-image.jpg`).

## Files

| file | role |
|---|---|
| `src/shell/drawer.js` | pure physics + decisions: travel, scale, rubber band, release velocity, settle (fling / position), spring step. All tunables in `DRAWER`. |
| `src/shell/arbitration.js` | pure: who owns a press (drawer or page). |
| `src/shell/sections.js` | the registry (`SECTIONS`, `BOOTH_LABEL`), persistence of the last section, menu keyboard stepping. |
| `src/shell/nowplaying.js` | pure: which source the mini bar describes, and whether it shows. |
| `src/shell/nav.js` | DOM: builds headers + hamburgers, menu, pointer gestures, spring loop, keyboard, focus trap, lazy section mounting, mini bar. |
| `src/shell/booth.js` | the one-line mount point of Workstream X's FX component (placeholder until then). |
| `src/shell/shell.css`, `pages.css` | shell look (tokens at the top) and page layouts. |
| `index.html` | `#shell > #drawer + .shell-peek + #card (#cardInner > #shellPages > section[data-section]) + #edgeStrip`. |
| `test/shell-*.test.mjs`, `scripts/verify-shell.py` | unit tests; Playwright (touch via CDP) verification. |

## Sections

Menu order: **Albums, Mixtapes, Radio, Booth, Settings** (Settings last, with a gear glyph; a magnifier button in the drawer header and in every page header opens Search: `createShell({ onSearch })`; `shell.ensure(id)` mounts a lazy section without showing it). First run opens Albums; the last section is remembered in `localStorage['runout.section']`.

* **Albums** - the compact turntable on top (the Utilitarian composition, stage height `42%` of the card, `clamp(236px, 42% .. 420px)`; the whole
  record and the tonearm are visible; CD albums swap in the CD view and the stage grows to 50%), then the title line with track nav and speed
  33/45/78 + palm brake in one row, then the shelf (Scan, All/Vinyl/CD, sort chips, grid; tap a card for its track list). "Deck details" at the
  bottom keeps what the old side panel had (fine-speed slider, rate/position/wear, feel knobs, latency, load track, build id). Layout choice
  (Settings): Compact (default), Utilitarian (tall), Cinematic. Preference key `runout.layout.v2`.
* **Mixtapes** - the stack of cassettes (`mountStack`, `bringToTop`): tap the top tape to play, tap another to bring it up. Spines is the secondary
  view. New / Import / Edit are the small toolbar. Player, editor and back-of-case open over the page as before.
* **Radio** - the existing dial / stations UI, mounted into the section on the first visit (the radio code is lazy). The session lives on when
  you leave.
* **Booth** - Workstream X's FX component, lazy, mounted into `#boothHost`.

Sections stay mounted (hidden) after the first visit, so a radio session, a mixtape or a half-typed search survives section changes.
The **mini bar** (bottom of the card, every section except the source's own) shows what plays from any source; tap = go to its home section, the
square stops a radio station.

## Gestures and arbitration

* Hamburger (top left of every page) toggles. A real **edge strip** (an element above the card, `EDGE_STRIP_PX = 24`, below the page header so the
  hamburger stays tappable) starts a drag; a tap on the strip / the visible handle also opens.
* The card follows the finger (translate + scale only), with a rubber band past either end. On release: speed >= `FLING_VELOCITY` decides by
  direction; otherwise the position projected `PROJECT_S` ahead is compared with `SETTLE_AT` of the travel. A spring (`SPRING_K`, `SPRING_ZETA`)
  settles it. `prefers-reduced-motion`: no spring, no page animation.
* Open: the card is `inert`, a cover over it takes taps (close) and drags. Menu item = switch section (page slides/fades in 300 ms while the card springs back).
* **Arbitration (documented rule).** The strip is above the page, so a press in the first 24 px never reaches the platter, tonearm zone, cassette
  or slider; everything else never reaches the drawer. A page gesture in progress (`touchingPlatter`, `seeking`) or a second finger blocks a drawer
  start (`arbitration.drawerMayStart`). The disc may sit near the left edge: only x <= 24 counts as the strip, the disc's tonearm/outer-edge zone starts
  at x >= 26 at 360 px. Overlays (cassette player, editors, walkthrough, theme, settings popover) are above the shell and swallow edge presses.
* **Android back gesture.** The system back swipe also starts at the screen edge; the strip is narrow on purpose, the handle and the hamburger are the
  primary affordance, and a `pointercancel` (system took the gesture) settles by position. On frames capped at 560 px (landscape, tablets) the strip is
  at the frame's edge, not the screen's, so it does not collide with the system gesture at all. Needs an on-device check.
* Keyboard: Esc closes; Up/Down/Home/End move through the menu, Enter activates; Tab is trapped in the drawer while open; `aria-expanded` on every
  hamburger, `role="navigation"` (a `<nav>`) on the menu, `aria-current="page"` on the active item, the closed drawer is `inert`.

## Tunable constants

`src/shell/drawer.js` `DRAWER`: `EDGE_STRIP_PX 24`, `OPEN_FRACTION 0.56`, `OPEN_MAX_PX 320`, `SCALE_OPEN 0.86`, `SLOP_PX 6`, `FLING_VELOCITY 520`,
`PROJECT_S 0.12`, `SETTLE_AT 0.5`, `RUBBER 0.3`, `SPRING_K 520`, `SPRING_ZETA 0.82`. `shell.css` tokens: `--card-r 28px`, `--card-veil`, `--peek`,
`--shell-accent` (violet; the logo orange is `#FE5031`), `--head-h`. `nav.js`: `PAGE_MS 300`. `pages.css`: the compact stage `42%`.
The frame cap (`min(100%, 560px)`) is in `shell.css`.

## Themes

The card is `--surface` (via `--card-bg`), the backdrop `--bg` (via `--shell-bg`), so every built-in theme and custom theme works. For the
built-in light palette only (no inline `--bg`), the shell uses the reference's soft grey gradient and a green peek card.

## Add a section

1. Add `{ id, label }` to `SECTIONS` in `sections.js` (and `HOME_OF` if it can play audio).
2. Add `<section data-section="id">` to `#shellPages` in `index.html` (the shell prepends the header + hamburger).
3. Add a hook in `main.js` `createShell({ hooks: { id: { mount(host), onShow(), onHide() } } })`; `mount` may be async and import lazily.

## Rename Booth

Change `BOOTH_LABEL` in `src/shell/sections.js`. The drawer, page title, walkthrough and placeholder all read it. (The owner has not approved
the name; "Booth" is a working name.)

## The FX component

`src/shell/booth.js` already mounts it: `const loadFxSection = () => import('../fx/section.js');` (lazy; fetched the first time the Booth is shown). `mountFxSection(container, deps) -> { unmount, onShow, onHide, onTrack, platter, controller, setAod }`; `deps` is built by `boothDeps()` in `main.js` (engine, storage, `host.*`, `blocked()` which names the radio / mixtape session that owns the engine, else null). `booth.js` also subscribes the handle to the AOD outline hook.

## Verification

`node --test` (unit), `python3 scripts/verify-shell.py [outdir]` (Chromium + touch via CDP; needs ffmpeg and `python3 serve.py 8321`).
`verify-canned-radio.py`, `verify-you-radio.py`, `verify-radio-layout.py` navigate with `to_section()` (hamburger -> drawer item).
