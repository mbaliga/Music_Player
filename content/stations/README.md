# Canned radio stations (offline "You Radio")

When the phone is offline, You Radio falls back to these hand-written shows. Each file is one
fictional station: hosts, callers and cast, plus a pool of talk segments. The app plays the
user's own songs between segments, so the content never names real songs or artists.

## Schema (v1)

- `station`: `id`, `name`, `tagline`, `dial`, `vibe`, `daypart[]`, `contentRating`, `hosts[]`.
  Each host has `id`, `name`, `role` (`host`, `co-host`, `caller`, `cast`), a `persona`, and
  `voice` hints (`genderHint`, `ageHint`, `accent`, `style`, `rate`, `pitch` in 0.8-1.3).
- `segments[]`: `id`, `kind`, `hosts[]` (speaking order), `lines[]` (`host`, `text`,
  optional `direction`, `pauseAfterMs`), `estSec`, `tags[]`, `usesSlots[]`, `fallbackOf`, `weight`.

Kinds: `sign_on station_id jingle banter monologue ad news skit callin dedication liner promo
transition sign_off`. A `jingle` is speakable text (the app cannot sing).

## Slots

Only `{prevTitle} {prevArtist} {nextTitle} {nextArtist} {album}`, filled from the user's library
at runtime. Every segment that uses a slot has a slot-free twin whose `fallbackOf` names it; use
the twin when metadata is missing.

## Tags

- `gag:<name>` marks a running gag; `seq:<n>` orders its beats and `payoff` marks the beat that
  resolves it. Play lower `seq` first; hold `payoff` until earlier beats have aired.
- Other tags are moods or dayparts (`night`, `psa`, `news`, `ad`) or the host/caller featured.

## Rules

Original fictional content only, PG-13, no real brands, people or places, no real-world news,
weather, traffic, time or date, and nothing asserted about the listener. Text is plain speakable
prose; performance cues go in `direction`.

Validate with `node scripts/check-content.mjs`.

## Files in this folder

- `<station-id>.json`: the packs (the only files the app and `build:web` treat as stations).
- `index.json`: GENERATED list the Radio tab's dial renders from (name, dial, tagline, vibe, daypart, hosts, minutes), copied from the packs. After editing a pack's header (a rename!) run `node scripts/stations-index.mjs`; the tests fail while it is stale.
- `_stoplist.json`: SEED stoplist for `node scripts/review-content.mjs` (report-only mechanical review, findings in `docs/CANNED_REVIEW_FINDINGS.md`). Not shipped.
- Pre-rendered voices (none yet) go to `content/audio/<station-id>/manifest.json` + `<segment>.opus` (from `scripts/render-shows.py`); `build:web` ships them to `www/audio/`. Never commit models; commit audio only when the owner decides to.

