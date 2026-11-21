# Settings (Workstream B)

A fifth section, **Settings** (last in the drawer, with a simple gear), replaces the tiny gear popover. It is a page of collapsible groups.
Search is described in `docs/SEARCH.md`.

## Files

| file | role |
|---|---|
| `src/settings/settings.js` | PURE: the schema (`FIELDS`), defaults, validators, `migrate`, the store (`createSettingsStore`): `get / set / reset / refresh / subscribe`. Storage injected. |
| `src/settings/apply.js` | PURE decisions (`planAppearance`) + two small DOM writers (`applyPlan`, `installMotionOverride`). |
| `src/settings/wire.js` | `initSettings()`: called once by `main.js` before first paint; applies theme, accent, text size, motion. |
| `src/settings/controls.js` | the shared controls (`h`, `seg` segmented choice, `sw` switch, `range` slider), also used by the Device mode sheet. |
| `src/settings/page.js`, `settings.css` | the Settings section (DOM, lazy) and the tone / text-size / motion / accent-follow-up CSS. |
| `src/theme.js` | unchanged parser + custom-theme vars, plus accent helpers (`ACCENT_PRESETS`, `resolveAccent`, `accentVars`, `onAccent`, `contrastRatio`) and `builtinThemeTemplate` / `exportThemeText`. |
| `test/settings-*.test.mjs` | schema, migration, mirroring, apply plan, accent / contrast maths. |

## Storage: `runout.settings.v1`

One versioned blob, `{ v: 1, appearance: { theme, accent, textSize, reduceMotion }, haptics, playback: { defaultRpm, audiophile }, radio: { aiStations }, privacy: { rememberSearches } }`.
Unknown keys are dropped, bad values fall back to the default per field, a different version reads as "no blob" (defaults + old keys), every storage call is try/caught.

Three preferences already had keys that other code reads directly. They stay in step by **write-through** (a change here also writes the old key) and **read-through**
(on load and when the Settings page opens, the old key is read back):

| setting | old key | notes |
|---|---|---|
| `appearance.theme` | `runout.theme` (`dark`/`light`) | an old `dark` was the OLED black palette, so it migrates to `oled`; `dark` and `oled` both write `dark` to the old key; if the old key says light while the blob says dark (or the reverse) the old key wins. |
| `haptics` | `runout.cassette.haptics` (`1`/`0`) | MixtapeUI reads it; main.js also sets `state.mixtapes.haptics` live. |
| `radio.aiStations` | `runout.flag.radio.ai` (`1` or absent) | **the old key is authoritative**: the radio panel's own toggle writes it directly, so `refresh()` reads it back. The flag module and `RadioUI` are unchanged. |

The old turntable layout key (`runout.layout.v2`) is not migrated: T1/T2's single stage replaced the compact / utilitarian / cinematic modes, so the **layout row is hidden** (`deps.layouts` is `[]`; pass options to bring it back).
Other keys keep their owners: `runout.customTheme` (theme.js), `runout.tt.speed` (turntable), `runout.fx.v1` (FX), `runout.library.prefs` (L), `runout.devicemode.v1` (Device mode; it already reads `haptics` and `appearance` from this blob).

## Groups

* **Appearance** - **Theme**: Dark (soft, `data-tone="soft"`: `#14141a` / `#1d1d26`), OLED black (the original palette, default for existing installs), Light. **Accent colour**: Violet (default, `#8E7BFF`), Logo orange `#FE5031`,
  Teal, Blue, Green, Pink, Amber, or any `#rrggbb` you type (validated). It sets `--violet`, `--violet-glow` (alpha .28 dark / .18 light) and `--on-accent` (white or near-black, whichever contrasts better) on the root;
  the few hard-coded violet gradients (speed buttons, brake) now follow `--violet`. **Live preview card.** **Text size** (small .92 / default / large 1.14, a layout-safe `zoom` on Settings, Search, the menu and Radio; the turntable,
  cassettes and Booth keep their drawn size). **Reduce motion**: Follow system / Reduce always (answers the `prefers-reduced-motion` query for scripts, adds a CSS rule; it never forces motion on). **Custom theme**: Import JSON...
  (the existing overlay: paste, then the **mandatory plain-text preview** of exactly what you pasted, Apply is disabled for anything that does not validate), Export... (the stored theme, or the built-in palette as a valid starting template), Copy, Reset. **Haptics**.
* **Library** - driven by `libraryPrefs` (`src/library-prefs.js`): sources (phone library when available, folder picker), hide songs shorter than N seconds, folders to leave out / only include, rescan on resume, read tags from files,
  **Scan now**, **Clear library cache**, **Reset library options** (the destructive ones ask for a second tap). The device scan card (`deviceLibrary.mountScanCard`) is shown when the native plugin is available.
* **Playback** - default speed 33 1/3 / 45 / 78 (applied now; at boot only when the turntable has no remembered speed of its own), **Audiophile mode** (the old diamond button, now persisted), and an **Advanced** line with *Open Deck details*
  (fine speed, rate / position / wear, feel knobs, latency, load a file and the build id stay in the Deck details sheet on Albums: nothing moved, nothing lost). Gapless / crossfade have no user setting today, so none is shown.
* **Radio** - **AI stations (experimental)** (the existing `radio.ai` flag, same key), a note on pre-written shows, host voices (chosen per show in "Cast and voices"; *Reset host voices* clears the saved choices),
  *Clear favourites* / *Clear recents* (two taps).
* **Booth** - the light ring and latch live in the Booth's own menu; this group says so and shows the ring's current state (read-only through `loadFx`). TODO (FX owner): expose a public settings API so the switch can live here.
* **Device mode** - a button that opens the Device mode options sheet (`src/devicemode/sheet.js`); a data-driven group built from its `SPEC` can replace it.
* **Privacy & about** - what leaves the phone (nothing by default; only the internet radio streams and, when you tap it, the directory), **Remember my searches**, the tour, the PolyForm Noncommercial 1.0.0 summary, the logo and build id, the document names
  (plain text, not fetched).

## Verification

`node --test test/settings-*.test.mjs` and `python3 scripts/verify-search-settings.py` (the Settings half: every group, light / dark / OLED, accent live, text size, reduce motion, custom theme import with the preview step, export, reload persistence, old-key migration). Screenshots: `docs/screenshots/search-settings/settings-*.png`.

## Colour precedence

1. a custom JSON theme (`runout.customTheme`): its own light and dark sets supply every colour, the accent included (the Settings page says so);
2. the accent colour;
3. the built-in palette for the chosen theme.

The drawer's moon / sun button is a shortcut for Light <-> the dark tone you last used. The `<meta name="theme-color">` follows (`#000000`, `#14141a`, `#ebebf2`, or the custom theme's background).

## Changes the owner should know about

* The gear popover and its footer button are gone; the drawer footer keeps three labelled buttons: Help (tour), Audiophile and Theme.
* Copy is user-facing: no file names, no docs sentences. Privacy & about says what stays on the phone, what the network is for, the version and the licence. Theme explains that the player surfaces stay dark in every theme.
* Walkthrough text now says five sections and points at Settings.
* Default theme for a fresh install is **OLED black** (what the app looked like), so "Dark" is the new softer option. Say so if you would rather default to Dark.
* Haptics default **on** (the platter's gap buzz was always on; the cassette buzz was off and now follows the same switch).
* The Settings page, the search overlay and the Settings lock face (`src/devicemode/default-faces.js`, nothing live while locked) were added; `test/shell-sections.test.mjs` now lists five sections.

## Adding a setting

1. Add a row to `FIELDS` in `settings.js` (type `enum`, `bool`, `rpm` or `accent`); 2. add a control in `page.js`; 3. subscribe in `main.js` (`installSettingsAndSearch`) if the app must react. If an old key must stay in
step, add a `LEGACY` entry (read + write, optionally `authoritative`). Tests: `test/settings-core.test.mjs`.
