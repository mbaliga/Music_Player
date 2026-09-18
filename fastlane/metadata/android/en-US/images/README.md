# images/

Sizes and check commands: `Personal-Tracker/store/ASSET_SPECS.md`.

## Needed, none present yet

- `icon.png` 512x512 no alpha · `featureGraphic.png` 1024x500 no alpha
- `phoneScreenshots/` — 2 to 8, 1080x1920, no alpha.

## Shoot these

1. The disc mid-scrub, with a finger on it and the needle placed. A still disc
   photographs as a picture of a record; a scrub in progress photographs as an
   instrument.
2. The groove banding across a real dynamic arc, so the shape of the music is
   visible.

**Use the bundled synthesised pressing, or your own audio.** Do not put recognisable
commercial music, an album title or cover art in any store asset. The app is careful
about this and the listing says so.

```sh
adb exec-out screencap -p > shot.png
magick shot.png -background black -alpha remove -alpha off phoneScreenshots/01.png
```
