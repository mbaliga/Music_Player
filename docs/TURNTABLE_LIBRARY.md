# Turntable library (zoom-out view)

The owner's vinyl-player prototype has a zoom-out **library**: a coverflow of album covers edge to edge, the album title and meta, and the track list below. This is that view as a stand-alone component. The player stage (disc, arm, camera, audio) is separate (`src/turntable/{geometry,camera,...}.js`); this component only needs to be told what to show, and tells the stage what the user did.

Files: `src/turntable/library.js` (component), `library-layout.js` (pure: layout, geometry, motion maths, adapter), `covers.js` (painted covers, cover-art URLs, canvas cache), `library.css` (loaded by the component itself via a `<link>` next to the module; `deps.injectCss:false` if the page links it). Tests: `test/turntable-library*.test.mjs`. Browser check: `scripts/verify-turntable-library.py` (harness page `test/support/turntable-library.html`).

## API

```js
import { mountTurntableLibrary, albumsToCoverflow, builtinTestPressing } from './turntable/library.js';
const lib = mountTurntableLibrary(container, deps);   // container: a positioned element; the library fills it (position:absolute; inset:0)
```
`deps` is optional: `{document, window, raf, caf, now, matchMedia, dpr, loadImage(url)->Promise<img>, testPressing()->album, injectCss, cssUrl}`.

| method | |
|---|---|
| `setAlbums(albums)` | Album objects (below). `[]` / junk -> the built-in test pressing (empty state). Keeps the focused album if its id is still present, else clamps. Never fires `focus`. Revokes object URLs minted by `coverBlobUrl` that are no longer listed. |
| `setNowPlaying({albumId, trackIndex})` / `null` | Marks the row with the glowing dot (only while that album is the displayed one). |
| `focus(index, {animate})` | Programmatic focus; animates by default. Never fires `focus` (no echo loops). |
| `getFocus()` | Index of the album in the centre (rounded while moving). |
| `setOpacity(o)` | 0..1. **Inert below 0.5** (`pointer-events:none`, `inert`, `aria-hidden`); `visibility:hidden` at ~0. Coming back from 0 resets the track-list scroll so the cover is where the disc expects it. Drive it with `sm(.42,.6,z)`. |
| `show()` / `hide()` | `hide()`: `visibility:hidden` + inert + aria-hidden (out of the accessibility tree and the focus order, loop stopped; layout kept so `getSlotRect` still works). Initial state is shown at opacity 0. |
| `getSlotRect()` | `DOMRect` of the invisible `.tl-slot` at the centre-cover position. A real element in the scrolling content, so it follows the track-list scroll and window resizes. **Mid-swipe it stays at the slot centre** (as in the prototype: the disc does not chase the moving cover). It is valid at any opacity, also while hidden. |
| `layout({width, height, portrait})` | Sets the CSS variables from `libraryLayout()`. Until the first call the container is measured (ResizeObserver). Call on resize. |
| `on(event, fn)` -> `off()` | Events below. |
| `destroy()` | Removes the DOM, cancels the loop, frees canvases, revokes tracked URLs. API calls afterwards are no-ops. |

**Additive (not in the T1 contract):** `setFilter('all'|'vinyl'|'cd')`, `setSort('artist'|'album'|'genre'|'colour')` (sync the chips with the app's persisted state; silent), `el` (the root). `focus` events carry the album id as a second argument: `fn(index, albumId)`.

### Events
- `focus(index, albumId)` — the coverflow **settled** on a different album than the last settled one (swipe, flick, wheel, keyboard, tap on a neighbour). Once per settle, not per frame; a drag that returns to the same album fires nothing; programmatic `focus()` / `setAlbums` are silent.
- `selectTrack(albumId, trackIndex)` — tap / Enter on a row. `trackIndex` indexes `album.tracks`.
- `tapCover(albumId)` — tap on the centre cover, or Enter on the flow. (Tap on a neighbour just focuses it.)
- `scan`, `filter('all'|'vinyl'|'cd')`, `sort('artist'|'album'|'genre'|'colour')` — toolbar. **The component does not filter or sort**: the app re-supplies `setAlbums(...)` (`LibraryManager.albums(sort)` then filter by `kind`).

### Album objects
`{id, title, artist, kind:'vinyl'|'cd', coverUrl?, coverSeed, tracks:[{title, durationSec|null, id?}], meta?, coverSpec?}`.
`meta` is an extra string in the sub line; `coverSpec:{hue:[h0,h1], style:0..4, idx?}` overrides the seed-derived painted cover (the harness uses it to reproduce the prototype's five covers).

### Pure helpers (library-layout.js)
- `albumsToCoverflow(items)` takes `shelfItems(groupTracks(...))` (src/albums.js) **or** `LibraryManager.albums()` rows. One entry per shelf item, in the order given: a multi-disc CD is one entry per disc (`"Title · CD 2"`), tracks in the order albums.js decided, `durationSec` or `null`, `kind` from the existing label rule (CDx/Disc x = CD, everything else vinyl), `coverSeed = hashSeed(artist + '\0' + baseTitle)` (discs of one set share art), `coverUrl` from the item or its first track. Unique ids; placeholders for missing titles/artists; never throws.
- `builtinTestPressing({tracks?, durationSec?})` -> `{id:'builtin:test-pressing', title:'Test pressing', artist:'Runout', kind:'vinyl', builtin:true, tracks}`; one track unless the app passes its own sub-tracks. `isBuiltinAlbum(a)`.
- `libraryLayout`, `coverPose`, `visibleRange`, `dragFocus`, `flingTarget`, `easeStep`, `keyStep`, `formatDuration` (null -> em dash), `clipText`.

### Cover art (covers.js)
`coverBlobUrl(bytes, mime)` (tags.js `meta.cover.data/mime`) -> tracked object URL (mime sniffed from the bytes); `revokeCoverUrl(url)`, `revokeAllCoverUrls()`. Only URLs minted here are ever revoked by the component (URLs from `library.js`'s own `createObjectURL` belong to the Albums grid; the component never revokes those). `downscaleCoverUrl(url, 512)` is an optional async re-encode for huge artwork. Whatever the source, the component draws the image **centre-cropped into a canvas of at most 512 px** (`coverPixelSize`: multiple of 64, up to 2x device pixels), so a full-size decoded bitmap is not kept per album. Covers without art are painted: the prototype's five styles (rings, waves, arch, grid, diagonal) from the seed; title stacked by word at the top, artist as the footer line (the prototype printed BALIGA).

## Layout (the prototype's formulas, `libraryLayout`)
Portrait: `cs = round(w*.62)`; landscape: `cs = round(h*.44)`. `ct = round(cs*.64)` (room above the cover for the disc to hover; the toolbar lives here), `fh = ct + cs + round(cs*.07)`, `f1 = clamp(w/(portrait?26:70), 11, 16)`, `f2 = f1*.88`, `mh = round(f1*4.4)`, `pad = round(w*.07)`, `rh = max(44, round(clamp(f1*3.1, 34, 48)))` (the only deviation: the prototype's 34..48 is clamped up to a 44 px touch target; it changes 360 wide: 43 -> 44 and 320 wide: 38 -> 44, nothing at 412+).

| viewport | cs | ct | fh | mh | f1 | f2 | pad | rh |
|---|---|---|---|---|---|---|---|---|
| 1241x561 | 247 | 158 | 422 | 70 | 16 | 14.1 | 87 | 48 |
| 561x1241 | 348 | 223 | 595 | 70 | 16 | 14.1 | 39 | 48 |
| 582x1162 | 361 | 231 | 617 | 70 | 16 | 14.1 | 41 | 48 |
| 360x780 | 223 | 143 | 382 | 61 | 13.85 | 12.2 | 25 | 44 (proto 43) |
| 412x915 | 255 | 163 | 436 | 70 | 15.85 | 13.9 | 29 | 48 |
| 320x640 | 198 | 127 | 339 | 54 | 12.31 | 10.8 | 22 | 44 (proto 38) |

Landscape shows the cover, the title and about one row (scroll for more); portrait shows the list from ~60% down. The row is `height: var(--rh)` plus a 1 px border (content-box, as the prototype), so rows are `rh + 1`.

Coverflow (`coverPose`, ported): neighbour distance `cs*.62` (also the drag scale), further covers `+cs*.30` each; `rotateY(∓56deg)`, `scale(.8)` and 50% darkening at |offset| >= 1 (an overlay at `shade` opacity instead of `filter:brightness`), `perspective(800px)`, invisible beyond |offset| 3.2.

Toolbar: one row (landscape) or two (portrait under 700 px), `tbH` = rows x 44; the first row starts 44 px in from the left (the hamburger); chips are 44 px tall hit targets around a 26 px pill; width < 400 uses a short "Scan" label and drops the "Sort" caption. Empty state hides the filter and sort chips and shows "Scan your music folder to fill the shelf" (also a scan button) under the toolbar.

## Behaviour / tunables (`LIB_KNOBS`)
Drag follows the finger (`dx / (cs*.62)` albums), release flings to `round(focus + v*0.1 s)` (at most 5 albums), then eases (`min(1, dt*11)`), settling within .003. Horizontal wheel / shift+wheel moves the target and snaps after 120 ms; ctrl+wheel is left to the zoom. Keys on the flow: arrows, Home/End, PageUp/PageDown, Enter. Rows: arrows, Home/End, Enter/Space. Roles: flow = `listbox` of `option`s (`aria-activedescendant`, `aria-posinset/setsize`), rows = `listbox`/`option`, toolbar = `toolbar` with `aria-pressed` chips. `prefers-reduced-motion`: no easing (jump to the target). The loop (rAF) runs only while something moves. A second pointer down on the flow cancels a drag (T1's pinch).

Virtualisation: a pool of 9 cover nodes (`k % 9`), only indices within about +-3.2 of the focus are bound; painted canvases live in an LRU of 20; track rows are pooled and capped at 500 per album; strings reaching the DOM are clipped to 200 chars (CSS ellipsis on top). All library text goes through `textContent` / `setAttribute`.

## Not verified here (needs the device)
Swipe feel and momentum with a real finger (`flingGainS`, `easeRate`, `dragSlopPx`), vertical pan vs horizontal swipe disambiguation on the WebView, frame rate with the player canvas running underneath, memory with hundreds of real embedded covers, the pinch hand-off with T1's two-pointer gesture, the safe-area inset on a notched phone, and the toolbar position against the real hamburger / drawer strip.
