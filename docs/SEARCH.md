# Global search (Workstream B)

One search across **songs, albums, artists, mixtapes and radio stations**. A full-screen overlay opens from anywhere; the core that ranks results is pure
JavaScript with no DOM, no storage and no network.

## Where it lives

| file | role |
|---|---|
| `src/search/fold.js` | text folding: lower case, NFKD, combining marks stripped (`Bjork` = `Björk`), `ß`/`ø`/`æ` specials, tokeniser, `within1` (edit distance 1, linear). |
| `src/search/index.js` | the core: `buildIndex`, `createIndexBuilder` (chunked), `replaceType`, `query`, `parseQuery`, `highlight`, `groupsOf`. |
| `src/search/adapters.js` | what the app has -> the index's records, plus drill-down lookups: `adaptLibrary`, `adaptMixtapes`, `adaptStations`, `buildSearchData`. |
| `src/search/recents.js` | recent searches: versioned, capped, never throws. |
| `src/search/directory.js` | the one network use: the internet radio directory, only on an explicit tap. |
| `src/search/actions.js` | the `searchActions` seam (below). |
| `src/search/view.js` | pure UI decisions: keyboard stepping, debounce, library fingerprint, range cleaning, shortcuts. |
| `src/search/ui.js`, `search.css` | the overlay (DOM). Lazy: fetched on the first open. |
| `src/search/wire.js` | creates the overlay lazily, binds Ctrl/Cmd+K and `/`. |
| `src/search/stations-bridge.js` | the single lazy door to radio code (saved stations, the flag, the canned index, host voices), so the boot path stays free of radio code. |
| `test/search-*.test.mjs`, `scripts/verify-search-settings.py` | unit tests; Playwright. |

## Using it

* **Open:** the magnifier in the drawer header (next to the logo), the magnifier in every page header, `Ctrl/Cmd+K`, or `/` when nothing is being typed. Opening
  closes the drawer. The Android back gesture closes the overlay (it pushes one history entry; on-device check, below).
* **Filter:** chips All / Songs / Albums / Artists / Mixtapes / Radio (with counts), or start the query with `type:artist` (also `song`, `album`, `mixtape`,
  `radio`; `in:` and `is:` work too). The empty state shows a one-line tip.
* **Empty query:** recent searches (tap to repeat, x to remove, Clear), then what you played / saved lately (favourite and recent stations).
* **Keyboard:** Up/Down/Home... move through the results, Enter runs the highlighted one (the top hit is pre-selected), Esc goes back from a drill-down and then
  closes, Tab stays inside. Roles: `combobox` (input, `aria-activedescendant`) + `listbox` / `option`; chips are a `radiogroup`; a polite live region says "N results".
* **Rows** are >= 56 px. A song plays, an album and an artist open a drill-down, a mixtape opens its player, a station starts.
* **Drill-down (inside the overlay):** *Artist* lists the artist's albums and songs with **Play all**. *Album* lists its songs with **Play album** and
  **Open in Albums**. **Add to mixtape** appears only when `addToMixtape` is bound (it is: the mixtape creator opens its editor on a new draft holding the songs).

## Matching and ranking

Every query token must match (AND). A token matches a field as: **exact word (4) > word prefix (3) > substring (2) > fuzzy (1)**. The class decides first;
inside a class the field breaks ties: **title (+30) > artist (+20) > album (+10) > other (0)** (other = genre, mixtape author's songs, station tagline, tags,
hosts, country). A whole-title match adds 60, a title that starts with the whole query 20, a title that contains it 10. Play count / recency adds at most 8 (log2 of
plays up to 5, plus 3 x e^(-days/30)), so it breaks ties but never beats a better match class. Stations carry a boost from the radio store (favourite 5,
recent 1, You Radio 3 when played).

* **Normalisation:** `fold()` lower-cases, decomposes (NFKD) and drops combining marks; `ß ø đ ð ł æ œ þ ı ħ ŧ` are expanded; fullwidth / ligature forms fold.
* **Non-Latin scripts** (CJK, kana, Hangul, Thai) have no word spaces, so those tokens match by plain substring.
* **Typos:** edit distance 1 (substitution, insertion, deletion, adjacent swap) on tokens of 4+ letters, also against the start of a longer word (typing).
  Only when the strict pass finds fewer than 3 results in total; the highlight then marks the whole near word and the list says "Showing close matches".
* **Ties:** score, then folded title, then input order. Same input -> same output.
* **Limits (hostile input):** query <= 200 chars, <= 8 tokens, tokens <= 64 chars, fields <= 240 chars, <= 100,000 docs per type, <= 100 tracks per mixtape
  indexed. No regular expression is built from user text. Junk records are skipped, never thrown on.

`query(index, text, { types, limit, now })` returns `{ songs, albums, artists, mixtapes, stations, counts, tokens, fuzzy, empty }`. Each result is a plain
object (`type`, `id`, `title`, `subtitle`, `detail?`, `score`, `ranges: { title, subtitle, detail? }`, plus type fields). `counts` are totals before the per-group cap
(5 per group in All, 50 when one type is chosen, or `limit`).

### Highlighting is text, never markup

Library, station and mixtape text is untrusted. The overlay builds every row with `textContent`, text nodes and `<mark>` elements created with
`createElement` (`segments()` in `view.js` turns text + ranges into pieces). The only `innerHTML` in the module is the static icon markup. Verified with
hostile titles (`<img src=x onerror=...>`, `"><script>...`) in the unit tests and in Chromium (nothing executes, no `<img>`/`<script>` exists in the overlay).

## Data sources

| kind | read from | notes |
|---|---|---|
| songs, albums, artists | `LibraryManager` (`library.tracks`, `library.albums()`) | tolerant of other shapes (array, `{tracks}`, `getTracks()`); the device library's merged read model arrives through the same `tracks`. File handles never reach the index. Re-linkable songs show a "Re-link" tag. |
| mixtapes | `MixtapeUI.list` (the flat `tracks`, side A then B) | name, author and the songs on it; a tape found through a song says which one ("has ..."). |
| radio | `runout.radio.v1` favourites and recents, the canned stations index, You Radio and the AI style cards | the canned index is a **local asset** (`stations/index.json`), no network. You Radio and the five AI style cards appear only when the `radio.ai` flag is on; the style cards are shown **disabled "Coming soon"** and can never start. |

The index is rebuilt when the library fingerprint changes (`library.onChange`); mixtapes and stations are cheap and are refreshed on every open. Above 1,500 songs the
songs/albums/artists are indexed in idle-time chunks (`requestIdleCallback`, fallback `setTimeout`), the index is queryable while it builds ("Indexing your library... 40%").

## Network use (the only one)

Typing makes **no** request. At the bottom of a typed query the overlay shows **Search the internet radio directory for "..."**. Only a tap on it calls the existing Radio
Browser search (`discoverServers` + `searchStations` from `src/radio.js`, HTTPS streams only, HLS and failing stations dropped, 20 results). Offline (`navigator.onLine`
false) it makes no request and says so in a plain note. The latest tap wins; closing the overlay or editing the query cancels a pending one. Tapping a result starts the station through the normal radio flow.
Everything else in search is offline.

## The `searchActions` seam (`src/search/actions.js`)

Search shows results; the app binds what they do with `bindSearchActions({...})` (main.js: `searchActionsImpl()`). Each function returns `Promise<boolean>` and never throws.
`searchActions.has(name)` tells the UI whether a seam is bound, so an action with no behaviour yet is hidden, not broken.

| function | today (main.js) | seam for |
|---|---|---|
| `playTrack(id)` | finds the song's album on the coverflow list, loads it like a tap on a track (CD albums open the CD view) and plays that track | T1/T2: if the coverflow gains a direct `playTrack`, call it here |
| `openAlbum(id)` | `tlib.focus(index)` + `stage.dispatch({type:'zoomTo', z:1})` (the zoom-out library) | T1/T2 (this is their API as of the pull) |
| `openArtist(name)` | focuses the artist's first album in the library | an artist filter on Albums, when one exists |
| `openMixtape(id)` | goes to Mixtapes and `MixtapeUI.startPlayback(m)` | D's mixtape player/creator entry |
| `playStation(station)` | ensures Radio is mounted (without switching to it) and calls `RadioUI.play(station)`; accepts a Station object or `"type|id"` | - |
| `playTracks(ids)` | artist "Play all": the songs as one queue on the vinyl player | - |
| `addToMixtape(trackIds)` | opens the mixtape editor on a new unsaved draft holding these library songs (bound by Workstream D: `MixtapeUI.startFrom`) | the overlay shows "Add to mixtape" in album and artist drill-downs only while this is bound |

## Settings tie-ins

`privacy.rememberSearches` (Settings, default on). Off: nothing is saved and the stored list is cleared. Recent searches: `runout.search.recents.v1`, `{ v: 1, items: [...] }`,
at most 8, each 2-80 characters, deduplicated ignoring case and accents.

## Measurements

Node 22, one core, generated 20,000 songs + 1,500 albums + 400 artists (`test/search-core.test.mjs`, "20k tracks"):

* chunked build: about 160-190 ms in 22 chunks of 1,000; the worst chunk 9-26 ms (so one idle slice never blocks a frame by more than that on this machine).
* query (best of 5, ms): `love` 7, `silver moon` 5, `artist 12` 6, `gld` 4, `velvet ghost 4` 4, a typo (`nepn`, fuzzy pass) 15, `a` 3, `type:artist artist` 0.3, no match 6.
  All well under the 30 ms goal; the test's own budget is a generous 150 ms (CI machines vary). In Chromium on the same machine the numbers are in the same range
  (see the report); a phone will be slower: **20k-track latency on the RedMagic is an on-device check**.
* memory: bounded by the caps above; roughly 1 KB of folded text and tokens per song.

## Verification

`node --test` (search core, adapters, recents, directory, view helpers) and `python3 scripts/verify-search-settings.py [outdir]` (Chromium with touch emulation at 360x780 and 412x915, scale 2; needs the dev server on 8321 and ffmpeg). Screenshots: `docs/screenshots/search-settings/` (drawer, recents, results in every group, chip filter, hostile titles, no results, directory offline note, artist and album drill-downs). In Chromium on the build machine: index of 20,000 songs 134 ms in 21 chunks (worst chunk 8 ms), queries 3-10 ms, page heap 42 MB with the app loaded.

## On-device checks (not done here)

* keyboard / IME with the overlay on Android (Gboard composition: the query is not run while composing, then once on `compositionend`); the field uses `enterkeyhint=search`.
* 20k-track search latency and the chunked build on the phone (jank while the library scan runs in the background).
* the system back gesture closing the overlay (`history.pushState`) and not the app; interaction with the card edge gesture.
* a very long result list scrolling while audio plays.
