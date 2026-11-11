# Runout — Play Console answer sheet

> Only the **deltas** from `Personal-Tracker/store/HOUSE_DEFAULTS.md`.

| | |
|---|---|
| applicationId | `com.runout.app` (from `capacitor.config.json`) |
| Version | **No versionCode exists yet.** The Capacitor Android wrapper has not been versioned. Set `versionCode = 1` before the first upload. |
| Category | **Music & Audio** |
| Tags | vinyl, turntable, scrub, audio, instrument |
| Contact email | `runout@asystemofcells.com` |
| Website | `https://asystemofcells.com/runout` |
| Privacy policy | `https://asystemofcells.com/runout/privacy` |

> **Status: v0, the feel gate.** The project's own stated purpose for this milestone
> is answering one go/no-go question: does a hand-scrub feel like it is on the
> sound? Shipping to a store before that is answered would be premature. This sheet
> exists so the listing is not the thing standing in the way when it is.

## The technical risk that decides whether this can ship at all

Runout's low-latency path depends on `SharedArrayBuffer`, which requires
**cross-origin isolation** (the `COOP` and `COEP` headers). In a Capacitor WebView
the app is served from a local scheme, not an HTTP origin you control headers on,
and if isolation is unavailable the app **degrades to the `postMessage` fallback**,
which is exactly the path the latency gate says is not good enough.

**Verify on a real device, in a release build, before committing to a store
release.** Have the app report which path it took, and check it. If it falls back,
the honest options are a native audio path instead of the WebView one, or not
shipping to the store yet. Do not ship the fallback and describe it with the
sub-thirty-millisecond claim; that claim is in the listing copy and must be true.

## Deltas from the house defaults

### Data safety
**No data collected. No data shared.**

| Question | Answer |
|---|---|
| Collect or share any user data? | **No** |
| Encrypted in transit? | Yes (nothing is transmitted) |
| Deletion? | Users can delete data in the app |

### Permissions
The Capacitor wrapper's manifest has not been audited for this listing.

**Before submitting, dump the merged manifest and remove anything Capacitor added
that the app does not use.** Capacitor and its plugins commonly contribute
`INTERNET`, and sometimes network-state or storage permissions, whether or not the
app needs them. An unused `INTERNET` permission undermines the "nothing is
uploaded" claim in the listing for no benefit.

```sh
./gradlew :app:assembleRelease
aapt2 dump permissions app/build/outputs/apk/release/*.apk
```

Expected final set: **audio file access for the drop-in feature, and nothing else.**
Use the system file picker (SAF) rather than a broad media permission if you can;
it needs no permission at all.

### Content rating
- Category `Utility, Productivity, Communication, or Other`. Expected **Everyone**.

### Copyright — worth getting right in the listing
The app bundles a **synthesised** test pressing and no copyrighted audio, which is
the correct choice and is stated in the listing. Keep it that way, and **do not use
recognisable commercial music in any screenshot, video or promotional asset.**

## F-Droid
- ⛔ **Blocked: no `LICENSE` file** (`CONSTELLATION.md` §2, D-I).

## Pre-submit checklist

- [ ] Answer the v0 feel gate first. This is the project's own stated ordering.
- [ ] Verify `SharedArrayBuffer` isolation on a real device in a release build.
- [ ] Set a `versionCode`.
- [ ] Audit and trim the merged Capacitor manifest.
- [ ] Add a `LICENSE` file.
- [ ] Screenshots: the disc mid-scrub with the needle placed, and the groove banding
      showing a real dynamic arc.
