# Device library: the phone's own music, like VLC

In the Android app Runout scans the phone's audio library by itself (MediaStore), groups it into albums with the
existing Vinyl / CD rules, keeps it fresh, and plays the files. Everywhere else (web, desktop, every Node test) nothing
changes: the folder picker (`webkitdirectory` / File System Access) stays. Code: `src/device/**`, `src/library-model.js`,
`src/library-prefs.js`, `native/android/DeviceLibraryPlugin.java`, `scripts/apply-android-plugins.mjs`.

## 1. Decision: a small custom Capacitor plugin (option c)

Researched against the npm registry and the Capacitor 6.2 sources (generated template + `@capacitor/android` Java):

| Option | Finding | Verdict |
|---|---|---|
| (a) existing plugin | `@agorapulse/capacitor-mediastore@0.2.0` (MIT, last published 2023-08): peer `@capacitor/core ^5`, and its Java only *writes* pictures / videos / downloads (`MediaStore.Images/Video/Downloads` inserts); it never queries audio. `@capacitor-community/media` is photos and videos only. `npm search` for music / audio-library / mediastore plugins finds players, recorders and session plugins, nothing that lists device audio and returns bytes. | none exists |
| (b) `@capacitor/filesystem` | 6.0.4 `Filesystem.java` opens `content://` URIs via `getContentResolver().openInputStream` (line 161) but `readFile` has no offset/length and returns the WHOLE file as one base64 string: a 30 MB FLAC becomes a ~40 MB string through the bridge, and tags.js's head/tail windows would each cost a full read. It also cannot list MediaStore rows (title / artist / album / track / duration / genre). | not enough on its own |
| (c) custom plugin | ~400 lines of Java: `MediaStore.Audio` query via `ContentResolver`, byte-range reads (`openFileDescriptor` + positional `FileChannel.read`, base64 chunks), album art (`loadThumbnail` on API 29+, `MediaMetadataRetriever` fallback), permission through the Capacitor permission API, a change token + `ContentObserver`. | **chosen**: smallest option that does all of it, no third-party risk, no dependency to keep in step with Capacitor |

Evidence the Java is right, since no Android SDK runs here:

* compiled with `javac` against the real API 34 classes (`org.robolectric:android-all:14-robolectric-10818077`) plus the real
  Capacitor 6.2.0 / AndroidX jars (Maven Central + Google Maven): zero errors, zero warnings;
* the generated template was read first (MainActivity, manifest, `capacitor.plugins.json`, build.gradle, `registerPlugin` in
  `BridgeActivity`) and the patch anchors on exactly those;
* **CI compiled it for real**: Actions run 44719802715 (commit f1e63ee) ran the new step and `:app:compileDebugJavaWithJavac`
  and `assembleDebug` succeeded.

### Native API (`DeviceLibrary`, registered in `MainActivity` before `super.onCreate`)

| Method | Returns |
|---|---|
| `permissionStatus()` / `requestAccess()` | `{ state: 'granted'\|'prompt'\|'prompt-with-rationale'\|'denied', sdk }` (alias `audio` = READ_MEDIA_AUDIO on API 33+, `storage` = READ_EXTERNAL_STORAGE below) |
| `openSettings()` | opens this app's system settings page |
| `generation()` | `{ generation, count }`: `getGeneration` per volume on API 30+ plus count and newest `date_modified` (a two-column scan; the fallback below 30) |
| `signatures()` | `{ sig: [id, size, dateModified, ...] }`: every audio row, cheap |
| `records({ ids })` (max 800) | `{ items: [...] }` full rows: title, artist, album, albumArtist, genre, track / cdTrack / disc, year, durationMs, size, mime, modified, relativePath (API 29+) or `data`, volume, flags (music / ringtone / alarm / notification / podcast) |
| `read({ id, offset, length })` | `{ data: base64, bytes, size, eof }`, `length` capped at 4 MiB |
| `art({ id, size })` | `{ data: base64 JPEG, mime }` or `{ data: '' }` |
| `startObserving()` / `stopObserving()` + event `libraryChanged` | MediaStore `ContentObserver`, debounced 2 s |

Columns that need a newer API (`album_artist`, `genre`, `disc_number`, `cd_track_number` = API 30; `relative_path`, `volume_name` =
API 29) are only requested when `Build.VERSION.SDK_INT` allows, so API 22 to 28 phones do not crash on a missing column.

### Manifest and Play Store policy

The patch adds exactly two lines (and nothing else):

```xml
<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
```

`READ_MEDIA_AUDIO` is Android's narrow audio-only permission (API 33+; no photos / videos, no photo-picker detour). Below 33
the legacy storage read permission is the only way to read other apps' audio. There is **no `MANAGE_EXTERNAL_STORAGE`** (all
files access, which Play restricts to a short list of app types) and no `READ_MEDIA_IMAGES` / `VIDEO`. All bytes go through
`ContentResolver`, so scoped storage is respected. Play's data-safety form: audio files are read on device and never leave it.

## 2. JS bridge (`src/device/`)

* `native.js`: `resolveNative()` returns the plugin only when `window.Capacitor` says Android + native, else `null`.
* `device-file.js`: **`DeviceFile`**, a File-like object (`name size type lastModified slice() arrayBuffer()`; no `stream()`),
  and `DeviceBlob` from `slice()`. This is *exactly* what the app calls on a File: tags.js `fileReader` (`file.slice(a,b).arrayBuffer()`),
  track.js `loadFile` (`file.arrayBuffer()` then `decodeAudioData`), queue / mixtape preload (`loadFile`). Those modules are unchanged.
  Chunks are 1 MiB (`chunkBytes`, capped at 4 MiB), at most 3 native reads in flight and 6 MiB outstanding, through one limiter
  shared by every DeviceFile (scan tag reads + preload + decode cannot pile up). A failed chunk is retried once, then the read
  rejects with `DeviceReadError` and starts no more chunks; a short read (file changed) is an error, never silent truncation.
  The slice semantics match `Blob.slice` (negatives, NaN, clamping).
* `records.js`: MediaStore row -> library track. `id = d1-<_id>-<size>-<date_modified>` (base 36), `source:'device'`, `mediaId`,
  `uri` (`content://media/external/audio/media/<id>`), `folder`, `path = folder + file name` (so `albums.js` reads CD1 / Disc N
  from real folder names), title / artist / albumArtist / album / trackNo / discNo / year / genre / durationSec. `"<unknown>"`
  becomes empty (artist -> `Unknown Artist`, the bucket name the folder scan already uses; album -> '' so albums.js groups by folder).
  `track` packed as DTTT (1003 = disc 1 track 3) is unpacked; API 30+ `cd_track_number` / `disc_number` win.
* `source.js`: the scan pipeline (below). `status.js`: `scanStatus`, `describeStatus`, `mountScanCard`. `store.js`: IndexedDB `runout-device`.
* `index.js`: the **`deviceLibrary`** adapter and `installDeviceLibrary(library)`.

### Tag fallback: cost and justification

Only for rows where MediaStore has nothing for artist AND album (`needsTags`), in a background pass (2 at a time, after the scan
has already painted). Through the real tags.js on a DeviceFile an ID3 tag costs <= 3 native reads and transfers only the tag
(test: a 500 KB file with a 200-byte tag moved < 1 KB). For 1,000 untagged files that is ~2-3k small reads; at the expected few
ms per read (UNVERIFIED on a phone) that is well under a minute in the background. `prefs.parseUntagged = false` turns it off.
MediaStore already parses tags for the common case, which is why reading every file's head (10k files) is not done.

## 3. Scan pipeline and persistence

1. `generation()` equals the saved one and the index is non-empty: done (one cheap call).
2. `signatures()` -> `[id, size, modified]` for every row = the denominator (`total`). Diff against the index: **new** or
   **changed** rows are fetched, **deleted** rows dropped, unchanged rows untouched (a rescan after adding 3 songs fetches 3 rows).
3. Rows are fetched in batches of 400 via `records({ids})`, mapped, merged, and the page **yields** (`scheduler.yield()`, else
   `setTimeout 0`) after every batch. Progress `{ found, processed, total }` goes to `onProgress`, `onTracks(batch)`,
   `status`. 10,000 rows = 25 batches / 25 yields (tested through an injected scheduler).
4. Cancel (`AbortSignal`) keeps what was fetched, does not record the generation, and the next scan resumes with the remainder.
5. The result is persisted to IndexedDB (`runout-device`, metadata only, no audio) with the generation read BEFORE the scan, so
   a change during the scan is caught next time. Boot: `restore()` returns the persisted tracks (with live DeviceFiles: no
   "re-link" step for device tracks), the scan then refines.
6. Non-audio MIME rows are skipped and remembered (not refetched). Rescans: manual (toolbar Scan), `libraryChanged` observer,
   app resume (`visibilitychange` / `focus`, throttled to 30 s, only when `prefs.rescanOnResume`, and it re-checks permission
   so granting in Settings and coming back just works).

### Permission flow (never loops)

`needs-permission` -> card "Runout plays the music on your phone. Allow access to your audio files." + **Allow** (the only thing
that ever asks the OS; nothing prompts at boot). Refused once (`prompt-with-rationale`) -> card with Allow again. Refused with
"don't ask again" (`denied`) -> **blocked**: `requestPermission()` makes no further OS call; the card says to open settings and
the button calls `openSettings()`. Returning from Settings is picked up on resume.

## 4. Read model (for search B and mixtape picker D)

`LibraryManager` (src/library.js) gained a small, additive source registry. Existing exports, `tracks`, `albums()`, `restore()`,
`scan()`, `relink()` behave as before (folder code paths only touch folder tracks; `library.tracks` is now the merged list).

```js
library.registerSource(src)          // src = { name, isAvailable(), tracks(), onChange(fn), restore?(), scan?() }
library.getSource('device')
library.getTracks()                  // merged, filtered, deduped; same objects as library.tracks
library.getAlbums(sort)              // == albums(sort): shelf items { id, kind:'vinyl'|'cd', album (label), artist, genre, coverUrl, color, hue, tracks }
library.getArtists()                 // [{ name, albumCount, trackCount, albums:[shelfId] }]   (album-artist level, like the shelf)
library.getGenres()                  // [{ name, trackCount, albumCount }]   (blank genre skipped)
library.getAlbumArt(item, size)      // item.coverUrl, else MediaStore art as an object URL (async, cached) or null
library.onChange(fn)                 // fn(mergedTracks) after a scan batch, a pref change or a restore; returns unsubscribe
```

A track (`library.getTracks()[i]`): `{ id, title, artist, albumArtist, album, path, genre, trackNo?, discNo?, durationSec?, size,
file, hue, color, coverUrl }` plus, for device tracks, `source:'device', mediaId, uri, folder, year, mime, modified, volume,
kind:'music'|'podcast'|..., needsTags`. `file` is always playable (a DeviceFile) for device tracks. `trackSource(t)` = `'device'|'folder'`.

Pure helpers in **`src/library-model.js`** (stable, DOM-free): `filterDeviceTracks(tracks, prefs)`, `folderMatches`,
`mergeSources(extraLists, folder)`, `deriveArtists(shelf)`, `deriveGenres(tracks)`, `contentKey(t)`, `folderOfTrack(t)`, `trackSource(t)`.
Merge rules: device tracks are deduped by id; a folder-scan track is dropped when a device track already stands for it (same id,
or same title / artist / album / size); two real copies of a song inside one source are never collapsed (as before).

Filters (device tracks only; a folder you picked yourself is never filtered), applied at read time so pref changes are instant and
never touch the native layer: ringtone / alarm / notification flags always hidden; `includeFolders` (when non-empty) must match;
`excludeFolders` must not match (case-insensitive, whole path segments, multi-segment allowed: `Android/media/com.whatsapp`);
a known duration below `minDurationSec` is hidden (unknown duration is kept).

### Prefs: `src/library-prefs.js`

```js
import { libraryPrefs, DEFAULT_PREFS, clearLibraryCache } from './library-prefs.js';
libraryPrefs.get()  libraryPrefs.set(patch)  libraryPrefs.subscribe((prefs, changedKeys) => ..)  libraryPrefs.reset()
```
`sources {folder, device}`, `minDurationSec` (30), `excludeFolders` (WhatsApp Audio, WhatsApp Voice Notes, Ringtones, Notifications,
Alarms, Recordings, Voice Recorder, Call recordings, Podcasts), `includeFolders` ([]), `rescanOnResume` (true), `parseUntagged` (true).
Versioned localStorage envelope (`runout.library.prefs`, v1), never throws, invalid fields repaired individually. `clearLibraryCache()`
wipes the device index, the folder index and saved folder handles (not prefs). Note: Workstream B's Settings store
(`runout.settings.v1`) is separate; the Settings page should call `libraryPrefs.set` / `subscribe` for the library section.

### UI hooks for the library view (T2)

```js
import { deviceLibrary } from './device/index.js';
deviceLibrary.isAvailable()              // true only in the Android app: label the toolbar button "Scan phone" instead of "Scan music folder"
deviceLibrary.status.get() / .subscribe  // { phase, found, processed, total, trackCount, ... } (DOM-free scanStatus)
deviceLibrary.mountScanCard(container)   // the permission / progress / blocked / error card; hides itself when there is nothing to say
```
`src/main.js` already calls `installDeviceLibrary(library)` once and routes the toolbar's `scan` event to the device scan on Android
(permission first, never a folder picker there).

## 5. Testing

* `npm test`: `test/device-file.test.mjs` (chunking, offsets, slice edge cases, concurrency + byte caps, mid-read errors, retry,
  short reads, tags.js through a DeviceFile), `device-records`, `device-source` (permission flows, scan, incremental add / update /
  remove, cancel + resume, 10k records with injected-scheduler yields, persistence, tag pass cost, observer, resume throttling),
  `device-library` (registry, filters, dedupe, prefs, read model), `library-prefs`, `device-android-patch` (the CI script against a
  committed fixture of the generated template, and against a real `android/` when present). Fake native backend:
  `test/support/fake-device-native.mjs`.
* `python3 scripts/verify-device-library.py [outdir]`: Playwright; the real app in Chromium with a mocked `window.Capacitor`
  (screenshots in `docs/screenshots/device-library/`): permission card, scan progress, albums (incl. CD1/CD2), blocked state with the
  settings hook, play a device track through DeviceFile -> `decodeAudioData` -> the engine, persisted index.
* CI (`android.yml`): `node scripts/apply-android-plugins.mjs android` after `cap add android`, before `cap sync`; the debug APK build is the Java compile check.
  The script fails with `::error::apply-android-plugins failed: ...` naming the missing anchor.

## 5b. Integration (Workstream I)

* The Albums library toolbar button reads **Scan phone** on native Android (`mountTurntableLibrary(..., { scanLabel })` / `lib.setScanLabel()`); the web keeps **Scan music folder**.
* Both sources produce the same extra track fields for the mixtape suggestions and search: `year`, `added` (epoch ms: device `date_modified` seconds x 1000, folder `file.lastModified`), `genre`, exact `durationSec` (device: MediaStore `duration`; folder: tags / MP3 frame header). Device rows stored before `added` existed get it from `modified` on load. Tests: `test/library-fields.test.mjs`.
* The device source reads tags with `readTags(file, { duration: false })` (MediaStore already has the duration; one native read less per file).

## 6. NOT verified (no phone here)

On-device checks to do: the permission prompt on API 33+ (READ_MEDIA_AUDIO) and on API <= 32 (READ_EXTERNAL_STORAGE), including
"Deny" then "Allow", "Don't allow" twice, and granting from Settings; scan time on a ~5k-track phone and the memory / jank during
it; `DeviceFile` read speed (1 MiB base64 chunks over the Capacitor bridge) and decode of a ~30 MB FLAC and a 3 h file; playback
start latency; MediaStore oddities: SD-card / secondary volume names and `relative_path`, cloud-backed / pending files
(`IS_PENDING`), `<unknown>` handling per manufacturer (Samsung / Xiaomi custom MediaProviders), numeric genres, files with no
`duration`; `loadThumbnail` art (API 29+) and the `MediaMetadataRetriever` fallback (API < 29); `ContentObserver` firing on a
file added by another app; rescan on resume; behaviour when the app is killed mid-scan; Play pre-launch report; Android 14 partial
media access does not apply to audio (only images / videos), but check Android 14+ "Allow all" vs the narrow audio prompt.
Also unverified: the Capacitor bridge's tolerance of ~1.4 MB result strings on very old WebViews (lower `chunkBytes` if reads fail).

## 7. Risks

* Base64 over the bridge costs ~33% and a JS decode loop: playback start of a very large file is slower than a native player's.
  If it proves slow, the next step is a `WebViewLocalServer` / intercept route serving `content://` ranges (no base64).
* `READ_EXTERNAL_STORAGE` on API <= 32 shows the broad "photos, media and files" wording; that is Android's wording.
* A cross-source duplicate that the content key cannot match (retagged copy) shows twice; harmless.
* Device track ids change when the file is modified (by design: `_id + size + date_modified`); mixtape refs then fall back to tag matching, as for folder tracks.
