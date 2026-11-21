# Mixtapes (workstream D)

A mixtape is a custom playlist drawn as a real cassette: it has a **tape length**, **two sides** with their own
capacity, an **auto-reverse** latch, and the owner's cassette look (37 styles, 4 pens, inks, wear, gloss).
Songs are always the user's own library tracks. While a tape plays you see the mixtape **name only** (tap the
cassette to reveal the current side's song list).

Files

| What | Where |
|---|---|
| Pure model (v4, caps, sides, JSON, migration) | `src/mixtape.js` |
| Picker search core (index, album groups, virtual window) | `src/mixtape-pick.js` |
| Suggested tapes (pure generators) | `src/mixtape-suggest.js` |
| Transport state machine (sides, AUTO, flip, wind) | `src/cassette/transport.js` |
| DOM glue: shelf, player host, import/export, persistence | `src/mixtape-ui.js` |
| Editor (frame, Tape + Style tabs, back of the case) | `src/cassette/editor.js` |
| Editor song tabs (Add, Tracks) | `src/cassette/editor-songs.js` |
| Player skins (Deck, Player) with the AUTO and FLIP keys | `src/cassette/players.js`, `player-skins.js` |
| Tests | `test/mixtape*.test.mjs`, `test/cassette-transport.test.mjs` |
| Browser verification | `scripts/verify-mixtapes.py` |

## Model v4

```jsonc
{ "version": 4, "name": "Road Trip", "author": "me",
  "cfg": { "style": "brass", "pen": "marker", "wear": 0.2, "gloss": 0.5, "slots": { "ink": "#1f4fd8" },
           "text": { "subtitle": "", "note": "", "side": "A" } },
  "tape": { "length": "C60" },            // C30 | C60 | C90
  "autoReverse": true,
  "sides": { "A": [ref, ...], "B": [ref, ...] } }
// ref = { title, artist, album, id?, dur? }   dur = a duration hint in whole seconds
```

* `m.tracks` is kept in memory as the derived flat list (A then B) so the resolver and queue code keep working.
  It is **not** serialized. `m.sides` is the source of truth and the only place edits write (`withSides`).
* Storage key is unchanged (`runout.mixtapes`, collection `{version: 4, mixtapes: [...]}`).
* Readers accept v1..v4. v1/v2 map the old placeholder styles/fonts to the nearest new ones; a v1-v3 single list
  becomes **side A on a C60** (a C90 when it does not fit). If even a C90 side A cannot hold it, side A is filled to
  its caps and the rest is kept on side B past its caps (flagged over capacity): **a song is never dropped by a
  migration**. The pre-migration blob is still backed up once (`runout.mixtapes.v3.backup` etc.); a blob from a
  newer version than the app is backed up and never overwritten.
* Parsers never throw; hostile data (bad tape ids, NaN / negative / huge durations, non-objects) is clamped or
  skipped, and titles are only ever rendered through text nodes.

### Caps (the owner asked for fixed maxima)

| Tape | Per side | Both sides |
|---|---|---|
| C30 | 15:00 | 30 min |
| C60 | 30:00 | 60 min |
| C90 | 45:00 | 90 min |

* Tolerance is **0 seconds**: a song is added only if `used + duration <= capacity`. Exactly full is allowed, one
  second over is refused (never squeezed).
* A hard maximum of **20 songs per side** (40 per tape), checked before time.
* Durations are rounded **up** to whole seconds when stored (a tape is never over-filled by a rounding error).
* **Unknown durations** (folder-scanned MP3s without a container duration) count as a conservative **4:00** and are
  shown with `~`. The real duration is learned (a) from the library when it becomes known
  (`withDurations`, on editor open / re-link) and (b) from the decoded track while playing
  (`withRefDuration`, saved automatically). A learned duration can push a side over its cap: the side is flagged
  "Over capacity", nothing is removed, and adds to it are refused until it fits.
* Pure API: `sideDuration`, `sideInfo`, `remaining`, `canAdd(m, side, track) -> {ok, reason, code}`, `tryAdd`,
  `addTrack`, `addMany -> {mixtape, added, skipped[]}`, `removeFromSide`, `moveInSide`, `moveAcross`, `autoFill`
  (fill a side with the rest of a pool), `fillTape`, `canResize`, `tapeSeconds`, `fmtDur`.
  `canAdd` reasons are sentences ("Side A has 2:10 left; this song is 3:45.").
* Per-side tape position: `locate(m, side, progress, durations)` / `sideProgress(...)`. Each side has its own
  0..1 position; side B is **not** a mirror of side A.

## Transport state machine (`src/cassette/transport.js`)

`reduce(state, event) -> { state, actions }`, no DOM or timers. State: `side`, `auto`, `phase`
(`stopped | playing | paused | flip | end`), `n {A,B}` (playable counts), `pos {A,B}` (each side's own position).

| Event | Behaviour |
|---|---|
| `play` / `toggle` | stopped: start the side at its own position (a side left at its end restarts from the top); paused: resume; `flip` phase: refuse with "FLIP TAPE"; `end` phase: refuse with "REWIND"; empty side: "EMPTY SIDE" |
| `pause`, `stop` | playing: brake; second press (paused / stopped / end): rewind the side to its top |
| `flip` | stops playback, flips to the other side (`flipAnim` manual), positions of both sides are kept |
| `setAuto {on}` | latches AUTO, persists it, re-plans the gapless run; never auto-flips a tape already parked at "Flip tape" |
| `changed {side,index}` | the real playback moved; **A to B while the run covers both** is the auto-reverse (`flipAnim` auto) |
| `sideEnd` | side A with songs on B: AUTO on -> reverse and start B (`start` action), AUTO off -> phase `flip` ("Flip tape", waits for FLIP). Side B (or A with nothing on B): phase `end`, offers rewind |
| `windEdge start` | rewinding past the start of a side stops there (never crosses to the other side) |
| `windEdge end` | winding off the end is a side end |
| `seek`, `progress` | remember the side's own position |

`runMode(state)` says which songs the gapless queue may cover: **`both`** (AUTO on, on side A, side B not empty: A
then B as one continuous run) or just the current side. The host (`mixtape-ui.js`) masks `queue.playable` with it,
so the existing gapless queue (`queue.js`) ends the run at the end of side A when AUTO is off.

### Player

* Both skins carry a **Side A/B indicator**, a latching **AUTO** key (lamp lit when engaged) and a **FLIP** key.
  Deck: a side panel right of the cassette window. Player: the cassette glyph on the LCD becomes the SIDE letter,
  and AUTO / FLIP are the first row of the right-hand key block (plus/minus/eject/power moved down one row and are
  slightly shorter).
* AUTO is stored per mixtape (`autoReverse`) and as the default for new tapes (`runout.cassette.auto`).
* FLIP animates a short 3D `rotateY` of the cassette (edge-on at the half: the new side's label and reel packs are
  drawn there, so the full reel that was on the right comes round to the left). Instant with
  `prefers-reduced-motion`.
* "Click" chip: a soft key click, **off by default** (`runout.cassette.clicks`). Haptic ticks follow the existing
  Haptics chip (`runout.cassette.haptics`).
* Tap the cassette: the **current side's** songs; a Side A / Side B tab switches the list (tapping a song on the
  other side flips and plays it).
* Wind keys (hold rew/ff) are per side. The deck message `FLIP TAPE` / `END` blinks on the deck's side panel and
  the Player's LCD.

## Editor (phone-first, 360x780)

Header (Back, title, Play, Save), live cassette preview (tap to flip it A/B; the label reads Side A / Side B) with a
capacity gauge per side (`A 21:40 / 30:00`, `7 songs, 13 left`; tap a gauge to select that side), and four tabs:

* **Tape**: title, line on the label, made by; tape length C30/C60/C90 (a shrink that would drop songs is refused
  with the reason); the auto-reverse switch; Duplicate / Export JSON / Delete.
* **Add**: persistent search over the whole library (title, artist, album; diacritic- and case-insensitive; tokens
  ANDed), results grouped by album, tap a song to add it to the selected side (A/B toggle with time left), **Add
  album** (adds as many as fit and says how many were skipped and why), browse by album when the field is empty
  (tap an album to open it), **Select** mode with a bottom "Add N" bar, "already on tape" marks (a song already on
  the tape is not added twice), refusal toasts with the reason. The list is **virtualised** (fixed 58 px rows, only
  the visible window is in the DOM) so 5,000+ tracks stay light.
* **Tracks**: the selected side's list with a tape meter (a segment per song, hatched when estimated), per-row
  duration and running time, drag the grip to reorder (touch + mouse), or focus the grip and use Up/Down, or the
  menu (Move up/down, Move to side X, Play from here, Remove); swipe a row left to remove (with Undo); "Fill side X
  with the rest" (the rest of the albums already on the tape). Needs-re-link states and the Re-link button work as
  before.
* **Style**: 37 cassette types, pen, ink, wear, gloss, label note.

Save / discard guard / delete / export / duplicate are kept. 44 px targets, labelled controls, keyboard
(Esc closes menus, then asks to discard), `aria-live` announcements, `prefers-reduced-motion` honoured.

### Seams

* `startMixtapeFrom({ trackIds: [...], name? })` (exported from `src/mixtape-ui.js`): opens the editor on a NEW
  unsaved **draft** that already holds those library tracks (split across the sides by time, caps honoured; the
  editor says how many did not fit). Returns `false` when the Mixtapes UI is not up. For the global search's
  "add to mixtape". It never saves by itself.
* **Search**: the picker runs on the global search core (`src/search/index.js`, typo-tolerant, diacritic-insensitive) through
  the thin adapter `src/mixtape-search.js` (`globalSearch`), which keeps the picker's own `{ buildIndex, query, browse }`
  shape: results are mapped back to library tracks and grouped by album (album order inside a group, ranked groups
  first); an empty query browses by album; if the global core ever throws the built-in search (`defaultSearch` in
  `src/mixtape-pick.js`) answers instead. Going back to the built-in search is one line in `editor.js`
  (`createPicker(l, { search: globalSearch })` -> `createPicker(l)`).
* **Search -> mixtape**: `main.js` binds `searchActions.addToMixtape(ids)` to `MixtapeUI.startFrom({ trackIds })`
  (goes to Mixtapes, opens the editor on an unsaved draft). That is the only edit outside the section's own files.
* **Durations**: tracks carry `durationSec`; when the device library supplies reliable durations (MediaStore) every
  new ref gets an exact `dur` and the 4:00 estimate never appears. Library tracks may also carry `year` and
  `added` (ms): the suggested-tape generators use them when present.

## Suggested tapes

An optional, small, dismissible row on the Mixtapes page (above the stack) of auto-generated drafts, built by pure
deterministic functions (`suggestTapes(library, { history, dismissed })`, tests with fixtures) that respect the tape
caps (the draft is cut to what a C90 holds, sides split as evenly as the order allows, smallest tape that holds it,
style and pen chosen from a hash of the suggestion id). At most 5, one of each kind first:

| Kind | Source | Needs |
|---|---|---|
| Fresh Finds (`recent`) | newest files first | `track.added` or `file.lastModified` |
| On Repeat (`played`) | most played | the local play history (`runout.radio.offline.history.v1`, read defensively) |
| `<Genre>` (`genre`, top two) | genre tag | `track.genre`, at least 5 songs |
| The 1990s (`decade`) | decade with most songs | `track.year` |
| Long player (`long`) | album with the most playing time | an album with 5+ songs |

A generator with no data returns nothing. Tapping a suggestion opens it in the editor as a **draft**
(never auto-saved). Each chip has a small x to dismiss it, and the row has a Hide button.

**Setting keys for the Settings page** (all `localStorage`, strings):

| Key | Meaning |
|---|---|
| `runout.mixtapes.suggest` | `'0'` hides the Suggested row; anything else (default) shows it |
| `runout.mixtapes.suggest.dismissed` | JSON array of dismissed suggestion ids; clear it to bring them back |
| `runout.cassette.auto` | `'0'` / `'1'`: AUTO default for new tapes |
| `runout.cassette.clicks` | `'1'` enables the key click (default off) |
| `runout.cassette.haptics` | `'1'` enables key vibration (existing) |

The row re-reads these every time the Mixtapes section is shown (`refresh()`), so a Settings page only needs to
write the key.

## Screenshots

`docs/screenshots/mixtapes/` (360x780 unless named otherwise, half size): the editor's Tape / Add / Tracks / Style
tabs, the refusal toast, drag-to-reorder, a suggestion opened as a draft, the shelf (stack, spines, suggestions),
the Deck and Player skins with AUTO on / off, the flip mid-turn, "FLIP TAPE", and the 20-song cap on a 5,000-track
library.

## Verification

`node --test` covers the model (caps for each tape length, exactly-full / one-second-over, 20th/21st song, unknown
durations, learning durations, moving across sides, migration from v1/v2/v3, hostile data), the transport (every
transition), the picker (diacritics, grouping, 5,000 tracks, virtual window) and the suggested tapes (caps
respected, deterministic, defensive).

`python3 serve.py 8537` then `python3 scripts/verify-mixtapes.py [outdir]` drives the real UI with a generated
tagged FLAC library at 360x780 and 412x915: v3 migration, suggestions, create a tape end to end (search, add from
three albums, hit the cap and read the refusal, switch to B, reorder by keyboard and by drag, remove + undo, style,
save), the stack/spines with side info, persistence across a reload, real-audio playback with AUTO on (side B
continues, the side indicator flips) and AUTO off (stops with "FLIP TAPE", FLIP then Play starts B), and a
5,000-track picker. Screenshots land in `outdir/shots`.

### Not verified here (needs the RedMagic)

* Drag-reorder feel with a real finger (touch-action, scroll vs drag, haptics).
* Flip animation frame rate (3D transform of a large SVG) and the AUTO/FLIP key feel.
* 5,000-track picker scrolling on the device's WebView.
* Haptic ticks (`navigator.vibrate`) and the optional key click through the phone's speaker.
* Real device-library durations once the MediaStore scan lands (estimates `~` should disappear). Folder-scanned MP3s now get a length from their first frame (Xing / VBRI count, else a CBR estimate) when they have no TLEN frame, so the `~` estimates are mostly gone there too (a VBR file without a Xing header is still an estimate).

## Full-screen task pages (phone)

Everything that holds a task is a page, not a floating window. The mixtape editor (`.ed-ov > .ed`) fills the viewport (`position:absolute; inset:0`,
`env(safe-area-inset-*)` padding; no 430 px card any more): header (Back, title, Play, Save), the live cassette preview, a sticky 48 px tab bar
(Tape / Add / Tracks / Style) and a scrolling body. Tape and Style show a **hero** preview (cassette across the width, capped at 34 dvh, gauges
in two columns under it); Add and Tracks use the **compact** preview beside the gauges so the search field and list get the height. Landscape
phones (`max-height:560px`) put the preview and gauges in a left column and the tabs and body on the right. Leaving with unsaved changes opens a small
confirmation (Save / Keep editing / Discard); that stays a dialog on purpose. The same `@media (max-width:700px), (max-height:520px)` rule makes the
import / export / custom-theme paste flow (`.theme-overlay`, with a Back header), Search (`.search-ov`), Deck details (`.tt-sheet`) and the Device mode
sheet (`.dm-sheet`, Done in the header) full-screen. Tablets and desktop keep the cards. The editor and importer are still refused while locked
(`allowsGesture('editor')`), and untrusted text still goes through text nodes. `scripts/verify-mixtapes.py` `run_layout` asserts the geometry at
360x780, 412x915 and 915x412.
