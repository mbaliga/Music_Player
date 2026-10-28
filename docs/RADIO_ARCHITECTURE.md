# Runout — AI Radio architecture ("You" Radio and "You City" Radio)

Status: PLAN (Workstream B). Nothing here is built. Scope: the AI-generated stations only. Real/public
stations are Workstream A and are out of scope except where they share the audio bus (section 4.4) and the
network policy (section 1.3).

Evidence labels used throughout:
- **[REPO]** read in this repo at the time of writing.
- **[SKILL]** taken from the `claude-api` skill's cached model table (dated 2026-10-06). Re-verify before committing money.
- **[UNVERIFIED]** I could not verify it. Treat as a hypothesis to be killed or confirmed by a spike. No vendor pricing or vendor API feature in this doc is verified.

---

## 0. Decisions needed first (read this if nothing else)

1. **Network policy.** Runout today makes zero network calls and has a locked decision "local-only library, no streaming, ever"
   plus a program rule of no telemetry/phoning home [REPO: README, HANDOFF "locked decisions", PORTING_PLAN §3 and I-1].
   AI radio cannot exist without network. It needs an explicit, scoped, opt-in exception (proposed wording in 1.3). Without that ruling, stop.
2. **Who pays for inference** (free quota, subscription, bring-your-own-key). Drives backend design (section 6). Default in 13.
3. **Spike before architecture hardens.** The live caller loop has three unverified make-or-break risks: echo cancellation inside a
   Capacitor WebView, background audio with the screen off, and end-to-end latency. Phase 1 (section 11) is a throwaway spike that answers them.
4. **The audio bus must sit next to the vinyl engine, not inside it** (section 4.4), and its fate is tied to the v0 feel gate: if
   `audio-engine.js` is replaced by native Oboe, the radio bus likely has to move native with it (risk R1).

---

## 1. Goals, non-goals, principles

### 1.1 Goals
- G1. A station that produces a show made only for this listener: RJ talk (intros, back-sells, weather/time/place chatter, jokes, station IDs) interleaved with songs from **the user's own library**.
- G2. A live **caller loop**, both directions: the listener calls the station, and the station "calls" the listener. Speech is transcribed and woven into the rest of the show.
- G3. Believable voice: a consistent persona with mood, rhythm and inflection, in two layers (writer-emitted expressive markup, plus a TTS engine that honors as much of it as it can).
- G4. Facts only from services. Graceful, in-character failure when a service is down.
- G5. Never dead air. The show degrades through music-only to nothing-new, never to silence or an error sound.
- G6. The app is **fully usable offline and without AI**. Radio is an optional module, lazy-loaded, never on the boot path.
- G7. Portable core: pure logic separated from platform glue, mirroring `model.js` (pure) vs `audio-engine.js` (swappable) [REPO].

### 1.2 Non-goals (v1)
- NG1. Streaming or generating commercial music. Songs come from the user's local files only.
- NG2. Voice cloning of any person. No cloning without that person's explicit consent; v1 ships stock/licensed voices only.
- NG3. Synthetic "other listeners" presented as real callers. If ever added, they must be labeled as synthetic.
- NG4. Scrubbing a radio song with the platter (the bus keeps the door open; see 4.4 `Deck`).
- NG5. Calendar, contacts, notifications, or any context that is not weather/time/coarse place/library in v1.
- NG6. Multi-language. English first.
- NG7. Background push ("the station calls you" while the app is closed). In v1 the station only calls while the app is open and the radio is on.

### 1.3 Proposed network/privacy exception (for owner ruling)
"Runout's AI Radio may make network calls to the Runout radio backend and nothing else. It is off by default; the first enable shows
what leaves the device. Music files and audio of the library never leave the device. Microphone audio leaves the device only during
a live call, only after a per-session tap, and is not stored. No analytics, no crash SDK, no third-party calls from the WebView."
This needs the same treatment as the TestFlight exception (PT:D-AD) [REPO: PORTING_PLAN]: README, store listing and `docs/store/privacy-policy.md`
must name it. The WebView CSP currently closed [REPO] gets exactly one `connect-src` origin, only while the feature flag is on.

---

## 2. The owner's three components, verified and extended

| # | Owner's component | Verdict | Extension |
|---|---|---|---|
| 1 | Model composing talk/RJ patter mixed with songs | Correct but it is **two** jobs plus a gate: Director (rundown), Writer (scripts), and a Grounding Verifier. Song choice is a third, deterministic on-device job. | 3, 5 |
| 2 | Context services (weather, location, traffic) | Correct, but these are not just inputs: they are the **fact base**. The writer may only state facts that carry an id and a pre-rendered phrase. Also needed: time/date/holiday/sunrise, listening history, library digest, station memory. | 3.1, 7 |
| 3 | Voice model with inflection, mood, rhythm | Correct, but it is **two layers**: (a) writer-emitted expressive markup in a vendor-neutral format; (b) a TTS adapter that translates to whatever the engine supports and degrades gracefully. Plus a fixed on-device "radio voice" processing chain so swapping TTS vendors does not change the station's identity. | 3.4, 4.3 |
| gap | Show director / rundown | Added as its own component. | 3.2, 5 |
| gap | Live caller loop | Added. STT, turn-taking, barge-in, echo, streaming TTS. | 8 |
| gap | Audio assembly | Added. Second bus beside the vinyl worklet. | 4 |
| gap | Backend proxy | Added. | 6 |
| gap | Permissions/privacy/safety/rights | Added. | 9, 12 |
| gap | Persona + memory | Added. | 7 |
| new | Injection surface | ID3 tags, caller speech, and fetched text are all untrusted input into an LLM. | 9.4 |
| new | Foreground/background audio | Radio is a screen-off product. WebView background audio is unproven. | R2 |
| new | Memory budget | The engine decodes a whole track to Float32 (about 85 MB for 4 min stereo at 44.1 kHz). Two decks plus decode-ahead is a real risk. | 4.5 |

---

## 3. Architecture

### 3.1 Component diagram

```
 DEVICE (Capacitor WebView; Android first)                         BACKEND (stateless proxy)        VENDORS
 ┌────────────────────────────────────────────────────────┐        ┌───────────────────────┐
 │ PORTABLE / PURE  (src/radio/core/*, no DOM, node:test)  │        │ auth + quota + limits │
 │  context-snapshot  normalize+TTL+mentionable filter     │        │ context aggregator    │──► weather/place/traffic APIs
 │  library-digest    shortlist builder, track cues        │  HTTPS │  (geohash cache)      │
 │  director-client   rundown validate/repair              │◄──────►│ LLM gateway           │──► Claude (Haiku/Sonnet class)
 │  show-clock        rolling-horizon state machine        │  + WS  │  (prompt cache,       │
 │  scheduler         slot -> timeline (talk-over, ducking)│        │   schema, streaming)  │
 │  song-selector     constraints -> track ids (local)     │        │ STT/TTS relay or      │──► STT vendor
 │  grounding         factRef verifier, expiry             │        │  ephemeral tokens     │──► TTS vendor
 │  markup            expressive script parse + degrade    │        │ no audio at rest      │
 │  turn-taking       call state machine (VAD events in)   │        └───────────────────────┘
 │  persona+memory    station bible, show log (storage IF) │
 ├────────────────────────────────────────────────────────┤
 │ ADAPTERS  (interfaces in core; impls per platform/vendor)│
 │  ContextProvider  Geolocation, clock, battery(no)        │
 │  MicSource        getUserMedia | native AEC plugin       │
 │  SttAdapter       streaming transcript events            │
 │  TtsAdapter       text+style -> PCM chunks (streaming)   │
 │  LlmAdapter       backend client (stream, schema)        │
 │  Store            localStorage/IDB | file                │
 ├────────────────────────────────────────────────────────┤
 │ PLATFORM-SPECIFIC  (src/radio/web/*)                     │
 │  program-bus       Web Audio graph (section 4)           │
 │  decks A/B         Deck interface (decoded | worklet)    │
 │  voice-player      worklet ring buffer for streaming TTS │
 │  radio-voice FX    EQ/comp/room + phone-line filter      │
 │  mic+AEC, permissions, foreground service, MediaSession  │
 └──────────────┬─────────────────────────────────────────┘
                │ shares AudioContext + master out
 ┌──────────────▼──────────────┐
 │ EXISTING: audio-engine.js +  │  vinyl worklet (scrub). Untouched by radio logic.
 │ worklet.js (swappable)       │  Needs one small additive hook: attach to a shared ctx/output node.
 └─────────────────────────────┘
```

Boundary rules (match the repo's model/engine split):
- `src/radio/core/` has zero browser globals, like `model.js`. It takes a clock, a store, and adapters by injection. It is what `npm test` covers.
- Vendor and platform specifics live only behind the adapter interfaces. Swapping TTS vendor, STT vendor, or the whole mic stack must not touch `core/`.
- `model.js`, `worklet.js`, `control-layout.js` are not edited by radio work. `audio-engine.js` gets one additive change (4.4), coordinated with Workstream A.
- Radio is loaded by dynamic `import()` only when a radio station is selected and the feature flag is on.

### 3.2 Pipeline roles

| Role | Runs | What it does | Model class (suggestion) |
|---|---|---|---|
| Context Snapshot builder | device + backend | Collects facts, normalizes, stamps `asOf`/`ttl`, drops anything not "mentionable" | no LLM |
| Director | backend (LLM) | Plans a rolling rundown: slot kinds, themes, mood arc, song *constraints*, talk time budgets | Sonnet-class |
| Song Selector | device | Turns constraints into actual track ids from the user's library | no LLM |
| Writer | backend (LLM) | Writes script-with-markup per talk slot, tagging `factRefs` | Sonnet-class (Haiku-class for short links) |
| Grounding Verifier | device (and backend) | Rejects/repairs scripts whose claims are not backed by `factRefs` | no LLM (rules); optional LLM judge offline in tests only |
| TTS Adapter | backend relay or direct | Script -> audio chunks | vendor |
| Scheduler/Bus | device | Aligns voice to song cues, ducks, crossfades, watches for dead air | no LLM |
| Caller Brain | backend (LLM) | Low-latency conversational turns during a call | Haiku-class |

Model ids and the facts I can state [SKILL, cached 2026-10-06, re-verify]: `claude-haiku-5-5` ($0.10 in / $0.50 out per MTok for prompts up
to 100K), `claude-sonnet-5-5` ($2 / $10), `claude-opus-5-5` ($4 / $20). Opus-class is not justified for this workload. Implementation
notes from the same source that bite this design:
- `temperature`/`top_p`/`top_k` are rejected (400) on these models, so **variety must come from the prompt** (a per-show "seed pack": theme, running gag, mood arc), not sampling.
- Thinking: Sonnet 5.5 cannot be sent `thinking: disabled`; use low effort or `between_tools`. Haiku 5.5 accepts disabled only at effort `high` or below. For the caller loop use the lowest effort that holds quality and measure TTFT in the spike.
- Use structured outputs (`output_config.format`) for Rundown and Script so the contracts in section 3.3 are enforced server-side, and stream the Script so TTS can start before the model finishes.
- Check `stop_reason == "refusal"` (safety classifiers can decline); a refusal on a talk slot falls back to a canned link or a plain song, never an error.
- Cache the stable prefix (station bible + persona + schema) with prompt caching; the volatile context goes after the breakpoint.
- Priority Tier is listed as unsupported for Sonnet 5.5 and Opus 5.5 [SKILL]; do not promise a latency SLA from the provider. [UNVERIFIED for Haiku 5.5.]

### 3.3 Data contracts

All objects carry `schemaVersion`. JSON Schema draft 2020-12, abbreviated (strings that are free text have `maxLength`).
These are the contract between Director/Writer (LLM output) and the device, so they are validated on the device too (never trust the proxy).

**ContextSnapshot** (what the backend/device assemble; the only source of facts)

```json
{
  "$id": "runout/context-snapshot/1",
  "type": "object",
  "required": ["schemaVersion", "snapshotId", "takenAt", "time", "facts", "listener", "libraryDigest", "memory"],
  "properties": {
    "schemaVersion": {"const": 1},
    "snapshotId": {"type": "string"},
    "takenAt": {"type": "string", "format": "date-time"},
    "time": {
      "type": "object",
      "required": ["tz", "localISO", "daypart", "weekday"],
      "properties": {
        "tz": {"type": "string"}, "localISO": {"type": "string"},
        "daypart": {"enum": ["early_morning","morning","midday","afternoon","evening","late_night"]},
        "weekday": {"type": "string"}, "holiday": {"type": ["string","null"]}
      }
    },
    "place": {
      "type": ["object","null"],
      "description": "Coarse only. Rounded to ~city level before leaving the device. Null if permission denied.",
      "properties": {
        "label": {"type": "string"}, "region": {"type": "string"}, "country": {"type": "string"},
        "geohash": {"type": "string", "maxLength": 5}
      }
    },
    "facts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "kind", "value", "say", "asOf", "ttlSec", "source", "mentionable"],
        "properties": {
          "id": {"type": "string", "description": "e.g. wx.now, wx.next6h, sun.set, traffic.commute, place.fact.3"},
          "kind": {"enum": ["weather","forecast","sun","traffic","place","holiday","listening","library","custom"]},
          "value": {"description": "Structured machine value used by the verifier"},
          "say": {"type": "string", "maxLength": 160, "description": "Pre-rendered phrase the writer should copy: 'about 18 degrees and drizzling'. Grounding by construction."},
          "asOf": {"type": "string", "format": "date-time"},
          "ttlSec": {"type": "integer"},
          "source": {"type": "string"},
          "mentionable": {"type": "boolean", "description": "False = may shape tone but must never be named on air"}
        }
      }
    },
    "serviceStatus": {
      "type": "object",
      "description": "Per service: ok | stale | down | denied. Writer is told what it must NOT talk about.",
      "additionalProperties": {"enum": ["ok","stale","down","denied"]}
    },
    "listener": {
      "type": "object",
      "properties": {
        "displayName": {"type": ["string","null"]},
        "namedPlaces": {"type": "array", "items": {"type": "object", "properties": {"label": {"enum": ["home","work","custom"]}, "name": {"type": "string"}}}},
        "sessionContext": {"enum": ["unknown","commute","focus","workout","home"], "description": "Only if user set it; never inferred from sensors in v1"}
      }
    },
    "libraryDigest": {
      "type": "object",
      "description": "On-device shortlist, not the whole library. Metadata only, treated as untrusted text.",
      "required": ["candidates"],
      "properties": {
        "candidates": {
          "type": "array", "maxItems": 60,
          "items": {
            "type": "object", "required": ["trackId","title","artist"],
            "properties": {
              "trackId": {"type": "string"}, "title": {"type": "string", "maxLength": 120},
              "artist": {"type": "string", "maxLength": 120}, "album": {"type": "string", "maxLength": 120},
              "genre": {"type": "string"}, "durationSec": {"type": "number"},
              "cues": {"$ref": "#/$defs/trackCues"},
              "lastPlayedAgoSec": {"type": ["number","null"]}, "playCount": {"type": "integer"}
            }
          }
        },
        "excludeTrackIds": {"type": "array", "items": {"type": "string"}}
      }
    },
    "memory": {"$ref": "runout/station-memory/1"}
  },
  "$defs": {
    "trackCues": {
      "type": "object",
      "description": "Derived on device (Worker) from the existing RMS envelope [REPO model.js] at import time. Heuristic, may be absent.",
      "properties": {
        "introEndSec": {"type": ["number","null"]}, "outroStartSec": {"type": ["number","null"]},
        "loudnessGainDb": {"type": "number"}, "confidence": {"enum": ["low","med","high"]}
      }
    }
  }
}
```

**Rundown** (Director output; rolling, about 6–8 slots ahead, regenerated/extended every slot)

```json
{
  "$id": "runout/rundown/1", "type": "object",
  "required": ["schemaVersion", "rundownId", "snapshotId", "horizonSec", "showSeed", "slots"],
  "properties": {
    "schemaVersion": {"const": 1}, "rundownId": {"type": "string"}, "snapshotId": {"type": "string"},
    "horizonSec": {"type": "number"},
    "showSeed": {
      "type": "object",
      "properties": {
        "theme": {"type": "string", "maxLength": 80}, "moodArc": {"type": "array", "items": {"type": "string"}},
        "runningGag": {"type": ["string","null"]}, "callbackFromMemory": {"type": ["string","null"]}
      }
    },
    "slots": {
      "type": "array", "maxItems": 12,
      "items": {
        "type": "object", "required": ["slotId","kind","targetSec"],
        "properties": {
          "slotId": {"type": "string"},
          "kind": {"enum": ["sign_on","station_id","song","talk_break","talk_over_intro","back_sell","weather_hit","place_hit","traffic_hit","caller_open","caller_invite","sign_off"]},
          "targetSec": {"type": "number", "description": "Planned air duration of this slot"},
          "song": {
            "type": "object",
            "properties": {
              "constraints": {"type": "object", "properties": {"mood": {"type": "string"}, "energy": {"type": "number", "minimum": 0, "maximum": 1}, "genres": {"type": "array", "items": {"type": "string"}}, "artistsAnyOf": {"type": "array", "items": {"type": "string"}}}},
              "trackIdHint": {"type": ["string","null"], "description": "Must be one of libraryDigest candidates, else ignored"}
            }
          },
          "talk": {
            "type": "object",
            "properties": {
              "budgetSec": {"type": "number"}, "purpose": {"type": "string", "maxLength": 200},
              "factIds": {"type": "array", "items": {"type": "string"}, "description": "Facts the writer may use for this slot"},
              "mode": {"enum": ["over_intro","between_songs","cold"]}, "mood": {"type": "string"}
            }
          },
          "mustAirBy": {"type": ["string","null"], "format": "date-time"},
          "skippable": {"type": "boolean"}
        }
      }
    }
  }
}
```

**Script** (Writer output for one talk slot; the expressive-markup layer)

```json
{
  "$id": "runout/script/1", "type": "object",
  "required": ["schemaVersion", "slotId", "utterances"],
  "properties": {
    "schemaVersion": {"const": 1}, "slotId": {"type": "string"},
    "utterances": {
      "type": "array", "minItems": 1, "maxItems": 12,
      "items": {
        "type": "object", "required": ["id","text","style"],
        "properties": {
          "id": {"type": "string"},
          "text": {"type": "string", "maxLength": 400,
                   "description": "Plain speech. Inline markers only: {pause:400} {breath} {laugh} {sfx:name} {em}word{/em}. Punctuation carries rhythm; it survives every TTS engine."},
          "style": {
            "type": "object", "required": ["emotion","energy","pace"],
            "properties": {
              "emotion": {"enum": ["warm","wry","hype","hushed","wistful","deadpan","playful","serious"]},
              "energy": {"type": "number", "minimum": 0, "maximum": 1},
              "pace": {"type": "number", "minimum": 0.8, "maximum": 1.25},
              "pitchSemitones": {"type": "number", "minimum": -2, "maximum": 2},
              "direction": {"type": "string", "maxLength": 80, "description": "Free-text acting note for engines that accept natural-language direction"}
            }
          },
          "pauseAfterMs": {"type": "integer", "minimum": 0, "maximum": 2000},
          "factRefs": {"type": "array", "items": {"type": "string"}, "description": "Every fact id the sentence relies on. Verifier enforces."},
          "droppable": {"type": "boolean", "description": "Can be cut if talk overruns its intro window"},
          "expiresAt": {"type": ["string","null"], "format": "date-time", "description": "Derived by device from factRefs ttl; do not trust writer value"},
          "templates": {"type": "array", "items": {"enum": ["time.spoken","time.daypart","date.spoken"]}, "description": "Late-bound tokens resolved at TTS render time, e.g. {{time.spoken}}"}
        }
      }
    },
    "claimedTrackIds": {"type": "array", "items": {"type": "string"}, "description": "Tracks the script names; must match the planned slot neighbors"}
  }
}
```

**CallerTurn** (one exchange in a live call; also what gets woven back into the show)

```json
{
  "$id": "runout/caller-turn/1", "type": "object",
  "required": ["schemaVersion","callId","turn","direction","startedAt"],
  "properties": {
    "schemaVersion": {"const": 1}, "callId": {"type": "string"}, "turn": {"type": "integer"},
    "direction": {"enum": ["listener_calls_station","station_calls_listener"]},
    "startedAt": {"type": "string", "format": "date-time"},
    "listener": {
      "type": "object",
      "properties": {
        "transcript": {"type": "string"}, "sttConfidence": {"type": "number"},
        "bargedIn": {"type": "boolean"}, "durationMs": {"type": "integer"},
        "audioRetained": {"type": "boolean", "description": "Default false. Clip replay on air is opt-in."}
      }
    },
    "host": {
      "type": "object",
      "properties": {"script": {"$ref": "runout/script/1"}, "interrupted": {"type": "boolean"}, "spokenCharsBeforeInterrupt": {"type": "integer"}}
    },
    "actions": {
      "type": "array", "description": "The ONLY side effects a call can cause. Resolved on device.",
      "items": {"oneOf": [
        {"type": "object", "properties": {"type": {"const": "request_song"}, "query": {"type": "string"}, "dedication": {"type": ["string","null"]}}},
        {"type": "object", "properties": {"type": {"const": "note_for_show"}, "text": {"type": "string", "maxLength": 200}}},
        {"type": "object", "properties": {"type": {"const": "end_call"}}}
      ]}
    },
    "safety": {"enum": ["ok","distress","abuse","off_topic"]}
  }
}
```

**StationMemory** (on device; sent as a compact summary, never the raw log)

```json
{
  "$id": "runout/station-memory/1", "type": "object",
  "properties": {
    "schemaVersion": {"const": 1},
    "persona": {"type": "object", "properties": {"stationName": {"type": "string"}, "rjName": {"type": "string"}, "voiceId": {"type": "string"}, "tone": {"type": "object"}, "banned": {"type": "array", "items": {"type": "string"}}}},
    "recentShows": {"type": "array", "maxItems": 7, "items": {"type": "object", "properties": {"date": {"type": "string"}, "themes": {"type": "array", "items": {"type": "string"}}, "lines": {"type": "array", "items": {"type": "string"}, "description": "Short signature lines used, to avoid repeats"}, "trackIds": {"type": "array", "items": {"type": "string"}}}}},
    "listenerNotes": {"type": "array", "maxItems": 20, "items": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 160}, "source": {"enum": ["caller","user_set"]}, "at": {"type": "string"}, "expiresAt": {"type": "string"}}}}
  }
}
```

### 3.4 Voice: two layers

- **Layer 1, the writer** (vendor-neutral): per-utterance `style` (emotion, energy, pace, pitch, direction) + inline markers + punctuation-as-rhythm. The writer is told the rhythm rule: short sentences for hype, fragments and em-dashes for wry, ellipses sparingly for hush. Punctuation is the one layer every engine honors.
- **Layer 2, the TTS adapter**: declares `capabilities()` = which of {SSML prosody, named styles, natural-language direction, inline audio tags, none} it supports. The adapter maps `style` to the richest supported form and degrades the rest to plain text. A golden test per adapter checks the mapping output (valid SSML, no leaked markers).
- **Station voice chain** (on device, vendor-independent): fixed EQ/compression/room so a vendor swap keeps the station's identity.
- Persona drift guard: a single voice id per persona, versioned. Changing it is a user-visible "new host" event.
- Which vendor honors which expressive features is [UNVERIFIED]; the voice bake-off (Phase 1b) measures it.

---

## 4. Audio assembly

### 4.1 What exists [REPO]
`AudioEngine.load()` decodes a whole track to planar Float32 into one buffer, creates a new `AudioWorkletNode('runout-processor')`, and connects it straight to `ctx.destination`. One deck, one spiral, rate-driven read loop, no crossfade, no gapless. HANDOFF lists gapless/queue as v2 and "requires cross-fade in the worklet".

### 4.2 Graph

```
 Deck A ─► gainA ─┐
                  ├─► musicBus(gain=duck) ─┐
 Deck B ─► gainB ─┘                        │
                                           ├─► program(sum) ─► limiter ─► ctx.destination
 voice-player(worklet ring buf) ─► radioVoiceFX ─► voiceGain ─┤
 stingers/sfx (buffer sources) ───────────────────────────────┤
 phoneFX (bandpass 300-3400, soft clip, noise floor) ◄── optional insert on voice during a call / replayed caller clips
```
Voice always at the top of priority; the limiter is the only thing allowed to touch the sum.

### 4.3 Scheduling rules
- **Everything on the audio clock** (`ctx.currentTime`), scheduled ahead; the main thread only decides, it never triggers in real time.
- **Talk-over-intro:** the device knows the TTS audio duration D once synthesized, and the song's `cues.introEndSec` (heuristic from the RMS envelope; `confidence` low means do not talk over, use between-songs mode). Start voice at `songStart + max(0, introEnd - D - hitMargin)`. If `D > introEnd`, the Scheduler trims `droppable` utterances (from the end), else pre-rolls the voice over the previous song's outro, else falls back to between-songs.
- **Ducking:** schedule `musicBus` gain with `linearRampToValueAtTime`: duck about 250 ms before voice start, release about 400 ms after voice end; depth tuned by ear (start at roughly -12 to -16 dB) [tuning value, not measured].
- **Crossfade:** equal-power between decks; default overlap 0 for album-faithful, selectable "radio" style 2–4 s starting at `outroStartSec`.
- **Loudness:** per-track `loudnessGainDb` from the offline envelope pass, so songs from a quiet and a loud album do not jump. Approximate (RMS, not K-weighted LUFS).
- **Time budget to words:** Writer gets `budgetSec`; neutral pace is about 2.5 words/s [rule of thumb, calibrate per voice]. Device measures actual D and feeds the ratio back so the Writer's next budget is calibrated.
- **Late-bound tokens** (`{{time.spoken}}`) are resolved at TTS render time (at most 1–2 slots before airing), never at script time.
- **Expiry at air time:** each utterance has `expiresAt` from its facts' TTL; the Scheduler skips or swaps to a non-time-sensitive variant if it would air stale.

### 4.4 Relationship to the vinyl engine (decision)
- Add one **additive** hook to `audio-engine.js`: `init({ctx, output})` / an `attach(ctx, outputNode)` so the engine can connect to the program bus instead of `ctx.destination` when radio is active, and a way to construct a second instance. Default path unchanged. **This touches a file Workstream A is also editing; coordinate through the owner before merging.**
- Define a `Deck` interface in the bus: `{ load(trackRef), start(atCtxTime), stop(), setGain(), positionSec, onEnded, cues }`. Two implementations:
  - `DecodedDeck` (v1): decodes a file to an `AudioBuffer` and plays via `AudioBufferSourceNode` (no scrub).
  - `VinylDeck` (later): wraps `AudioEngine`/worklet so the platter works on the live radio song. Gated on the v0 feel gate and the memory risk (4.5).
- Real stations (Workstream A) should enter the same bus as another source (`MediaElementAudioSourceNode`), so tuning between stations is a crossfade and there is one master output, one limiter, one MediaSession. Needs agreement with A on a shared `Station` interface (open question 12).
- **Native-engine risk (R1):** if the v0 gate fails and `audio-engine.js` goes to Oboe, radio decks in Web Audio and the vinyl in native would be two separate output paths; ducking and crossfading across them become OS-mixer-level and sloppy. The bus must then move native too. Mitigation: keep scheduling logic in `core/` (portable) and treat Web Audio as one implementation.

### 4.5 Pre-generation and memory
- Keep decoded audio to at most **2 songs + the voice**: decode the next song roughly 30–60 s before it is needed, and release the previous. About 85 MB per 4-minute stereo Float32 song at 44.1 kHz [computed], so three resident songs is already a problem in a WebView [R3, UNVERIFIED on the RedMagic]. Alternative: stream the *next* song via a `MediaElement` source (no full decode) and decode only when a `VinylDeck` is needed.
- Voice is small (about 100 KB/s at 24 kHz 16-bit mono PCM [computed]; keep compressed until needed).

### 4.6 Dead air: the fallback ladder
The bus has a watchdog on the "ready queue" (next song loaded; next talk audio rendered or not).
1. Next element ready: normal.
2. Talk not ready by T-8 s before its slot: air the next song with no talk (the slot is simply dropped from the rundown; no apology).
3. Next song not decoded: play a local stinger/evergreen filler segment (pre-rendered, shipped or generated at first enable).
4. Nothing ready: crossfade to any already-decoded library track. Silence is never the output.
5. Network lost: stay in loop 2–4; surface a small "offline, music only" badge, not speech.

---

## 5. Show clock: what is pre-generated vs live

A show is a **rolling rundown**, not a script. Songs are the latency hiding: a 3.5-minute song gives about 200 s to prepare the next break, an order of magnitude more than any generation step needs.

| Stage | When | Lead time target before air | Notes |
|---|---|---|---|
| Cold start | on tap | 0 s | First sound is a local station-ID stinger then the user's own song immediately. First RJ line arrives 20–40 s later [target]. |
| Context snapshot | session start, refresh each slot | n/a | Weather/place cached by geohash on backend; per-fact TTL |
| Rundown | every slot completes | horizon 6–8 slots (about 25–30 min) | Regenerated incrementally; invalidated early by live events |
| Song selection | when slot enters horizon | 3 slots | On device, deterministic, no repeats |
| Script (Writer) | per talk slot | 2 slots | Streams; verified before TTS |
| TTS render | per talk slot | at least 1 slot, minimum buffer 90 s | Rendered to compressed audio and held |
| Song decode | per song | 30–60 s | Memory cap 4.5 |
| Live: caller | any time | 0 | Preempts the rundown at the next safe point (end of utterance or song boundary) |
| Live: alert | service push | 0 | Only from services (e.g. severe weather fact). Same insertion rule as caller |
| Late-bound tokens | TTS render | 1–2 slots | time.spoken etc. |

Typical hour pattern (Director may vary it by daypart and mood): sign-on/ID, song, song with talk-over-intro, song, break (weather/place/chat), song, song, caller invite, ID. Roughly 70–75% music by time is a starting default (tunable).

Rundown repair on the device: `director-client` validates schema, drops unknown `trackIdHint`s, fixes total duration, enforces "no two talk breaks adjacent unless a caller", "first slot is music or a pre-rendered ID", and never trusts the model's own arithmetic.

---

## 6. Backend proxy

Requirements: no vendor keys in the APK; caching; rate limits; keep audio at rest at zero. [REPO: the CI program rules say no listener/server/key material in CI (R5) and disjoint directories (R1), so the backend should not live inside this repo's CI path. Default: a separate repo.]

- **Shape:** a stateless HTTP + WebSocket service. Endpoints (illustrative): `POST /v1/context` (aggregate weather/place/traffic/etc.), `POST /v1/rundown`, `POST /v1/script` (SSE stream), `POST /v1/tts` (stream), `WS /v1/call` (full-duplex call relay), `POST /v1/tokens` (short-lived scoped tokens for direct-to-vendor streaming if the extra hop costs too much latency; trade-off: vendor sees the client IP).
- **Auth:** anonymous per-install identity plus platform integrity attestation (Play Integrity on Android, App Attest on iOS) [UNVERIFIED details], per-install quota counters, kill switch. If a user brings their own key (dev builds), it is stored in the platform keystore and sent only over TLS; this is not "a key in the APK".
- **Caching:** weather/forecast/place facts keyed by geohash5 + hour; persona/prefix prompt cached at the LLM; common stingers/backchannel clips cached per voice. TTS output for deterministic evergreen lines is cached and shipped on device.
- **Limits:** per-install and global token buckets; per-call max duration (default 3 min) and per-turn max (about 30–45 s of listener speech); hard monthly spend ceiling with graceful in-character "the station's on a break" degradation.
- **Observability:** the client sends no telemetry (policy 1.3). Server logs hold request metadata and stage timings with no transcripts or audio by default; retention stated in the privacy policy. Vendor data-retention terms for each STT/TTS/LLM provider must be checked and disclosed [UNVERIFIED].
- **Hosting:** any small serverless/edge or container service. WebSocket duration limits and cold-start behavior vary by host [UNVERIFIED]; the spike picks one.

---

## 7. Context services, persona, memory

### 7.1 Context sources (v1 vs later)
| Source | v1 | Notes |
|---|---|---|
| Clock/timezone/daypart/weekday | yes | On device; no network |
| Holidays | yes | Static table by country/region, no network |
| Sunrise/sunset | yes | Computed locally from coarse lat/lon |
| Weather + short forecast | yes | Candidates: Open-Meteo, NWS (US only), MET Norway. Terms for a commercial app differ per provider [UNVERIFIED]; check before shipping. |
| Coarse place label | yes | Reverse-geocode on backend from geohash5; permission: coarse location, "while in use" |
| Place facts (You City) | yes, limited | e.g. Wikipedia/Wikivoyage geosearch. Attribution (CC BY-SA) required [UNVERIFIED terms]; facts stored with source and said with hedging. |
| Traffic / commute | defer | Commercial APIs only; ToS about derived spoken content is [UNVERIFIED]. v1.5: user-named Home/Work travel-time estimate. |
| Local news | defer | Licensing of headline use is [UNVERIFIED]; default off. |
| Listening history, library digest | yes | On device |
| Calendar/contacts/notifications | no (NG5) | |

### 7.2 "You" vs "You City"
Same engine, different context bundle and persona:
- **You Radio:** centers the listener: time of day, their library, their listening history, their own notes, light weather.
- **You City Radio:** centers the place: weather, sun, place facts, holidays, (later) transit/events, with the library as the soundtrack. Without location permission it must degrade to an obvious, honest "tell me where you are" prompt, not guesses.

### 7.3 Persona and memory
- **Station bible** (static, versioned, cached at the LLM): station name, RJ name/voice, tone dials (warmth, wit, formality), signature phrases, banned phrases/topics, what the RJ does not know ("I can't see you").
- **Memory:** `StationMemory` (3.3) lives only on device; recent shows' themes and signature lines (to avoid repeats and enable callbacks), plus short `listenerNotes` from callers. Each note has an expiry. The user can view, edit, and delete all of it in Settings ("Forget everything"). A compact summary, not the log, goes to the Writer.
- **Continuity rule:** the RJ may refer to memory only through `callbackFromMemory` chosen by the Director, so references are deliberate and rare, not creepy.

---

## 8. Live caller loop

### 8.1 Modes
- **Listener calls station:** a Call button -> hold-music bed ("you're on hold") while the session connects -> RJ picks up.
- **Station calls listener:** an incoming-call UI (ring + accept/decline) triggered by a `caller_invite` slot. Declining is silent and in-character on the next break. Only while the app is open (NG7).

### 8.2 Pipeline
```
 mic ─► AEC/NS ─► VAD ─► streaming STT ─► endpointing ─► Caller Brain (LLM, streaming)
                                            │                       │
                                            └─ interim transcripts   ▼
                                              (speculative start)  sentence chunker ─► streaming TTS ─► voice-player ─► bus
```
- Music bus during a call: duck hard to a bed (-20 to -25 dB) or pause. This is radio-authentic and sharply reduces the echo problem.
- The RJ voice is clean studio; the phone-line filter is an optional "feel" insert and is mandatory only on replayed caller clips (see 8.6).

### 8.3 Latency budget (target = end of listener speech to first audible RJ audio)
These are **budget targets for the spike to confirm or kill, not measurements**.

| # | Stage | p50 target (ms) | Plausible range | Mitigation |
|---|---|---|---|---|
| 1 | VAD endpointing hangover | 300 | 200–500 | Tunable; semantic endpointing only if it pays for itself |
| 2 | STT finalization after endpoint | 150 | 80–300 | Streaming STT already holds near-final text |
| 3 | Uplink + proxy hop | 80 | 40–150 | Keep WS open; or direct-to-vendor tokens |
| 4 | LLM first token | 450 | 300–800 | Cached prefix, small prompt, lowest effort; speculative start on stable interim |
| 5 | First speakable chunk (to first clause) | 200 | 100–350 | Chunk at first clause/comma, not sentence end |
| 6 | TTS time-to-first-byte | 250 | 150–450 | Streaming TTS, warm connection |
| 7 | Downlink + decode + jitter buffer | 100 | 60–200 | Small adaptive buffer |
| 8 | Output device latency | 40 | 12–80 | Existing estimate showed 12 ms reported on the RedMagic (self-reported) [REPO HANDOFF] |
| | **Sum (p50)** | **~1,570** | **~1,100–2,900** | Goal: p50 <= 1.6 s, p95 <= 2.5 s |

Masking: if stage 1–5 exceeds about 900 ms, play a short pre-rendered backchannel ("mm", "oh—", "right") from a local cache of about 20 clips per voice, at most once per few turns. Radio call-ins are tolerant of a beat of delay; do not chase below about 1 s at the cost of accuracy.

### 8.4 Turn-taking and barge-in
- State machine in `core/turn-taking`: `IDLE -> LISTENING -> THINKING -> SPEAKING -> (LISTENING | INTERRUPTED)`. VAD events and timestamps are inputs; it is pure and unit-testable with scripted event sequences.
- **Barge-in:** on VAD onset during SPEAKING, immediately duck the RJ voice (about -18 dB over 80 ms). If speech persists beyond about 300 ms, cancel TTS and LLM generation, record `spokenCharsBeforeInterrupt`, and go to LISTENING. If it was a cough, restore.
- The host controls pacing: 30–45 s max listener turn, 3 min max call, polite wrap-up line at 80% of the cap.
- **Half-duplex fallback:** push-to-talk, or "mic closed while the RJ speaks", whenever echo is not under control.

### 8.5 Echo cancellation (the biggest unknown)
- Whether `getUserMedia({echoCancellation:true})` inside the Android WebView cancels audio played by the same page's Web Audio output reliably on the RedMagic is **[UNVERIFIED]**; browser AEC is built for WebRTC-style playback and may not reference an arbitrary Web Audio graph.
- Options, in order of preference: (1) browser AEC if the spike proves it; (2) headphones detected -> full-duplex, speaker -> half-duplex or push-to-talk; (3) a small Capacitor plugin capturing via the platform voice-communication path (Android `AudioRecord` with the voice-communication source and communication mode, which engages platform AEC where the device provides it [UNVERIFIED per-device]); iOS equivalent is the voice-chat audio session mode [UNVERIFIED in WKWebView].
- Because the music bus is ducked or paused during calls, echo is the RJ's own voice only.

### 8.6 Weaving the call into the show
- Transcript -> `note_for_show` actions -> `listenerNotes` (expiring) -> the next Writer pass uses them via `callbackFromMemory` or a dedicated `caller_open` back-reference ("earlier, someone on the line said...").
- `request_song` is resolved on device against the library (never invented): if no match, the RJ says it is not in the crate; the Director picks a near match.
- **Audio retention default: none.** Transcript only, and only with the listener's opt-in toggle. Replaying the listener's own clip on air is a separate explicit opt-in; if enabled it goes through the phone-line filter.

### 8.7 Speech-to-speech alternative
A vendor "realtime" speech-to-speech API [UNVERIFIED which exist and how they behave] would shorten the loop, but couples the voice, the persona and the grounding to the vendor and removes our verifier from the path. Recommendation: **cascaded STT -> Claude -> TTS** as the architecture (we control persona, grounding and actions), with a realtime API only as a latency comparator in the spike.

---

## 9. Privacy, safety, rights

### 9.1 Permissions
| Permission | When requested | Scope | Denied behavior |
|---|---|---|---|
| Network (policy exception) | enabling Radio | backend origin only | Radio disabled; rest of app unchanged |
| Location | first You City / weather | coarse, while-in-use, rounded before leaving device | You Radio without weather; City prompts for a typed city |
| Microphone | first Call tap, per session | only while a call is live; visible "ON AIR / mic live" indicator | Calling disabled; show unaffected |
| Notifications | not in v1 | | |

### 9.2 What personal context may be mentioned
Allowlist by default: time/daypart, weather, coarse place label, user-named places by their own label, track metadata from the library, listener notes the listener spoke or typed. Never mentioned on air: precise coordinates/addresses, contacts, anything inferred about health/relationships/finance, other people's names from ID3 tags unless in the artist field. A post-generation filter rejects scripts with coordinates, street-address patterns, phone/email patterns, or `mentionable:false` fact text; failure -> regenerate once -> fallback to a canned link.

### 9.3 Disclosure and voice rights
- A persistent "AI host" label in the Radio UI; the first sign-on of each session includes a short spoken or text disclosure. Synthetic-audio transparency obligations (for example under EU rules) may apply [UNVERIFIED; check with counsel before store release].
- No voice cloning of anyone. Stock/licensed voices only, with the license terms confirmed for in-app commercial use per vendor [UNVERIFIED].
- No synthetic "listeners" presented as real (NG3).
- Store listings: AI-generated content and microphone use must be declared per store policy [UNVERIFIED specifics]; `docs/store/privacy-policy.md` must be updated with the exception in 1.3.

### 9.4 Prompt injection and untrusted input
Untrusted: ID3 tags/filenames, caller speech, any fetched text (place facts, news). Mitigations: untrusted text is placed in clearly delimited data fields and the system prompt says it is data; output is schema-constrained; the only side effects possible are the three `actions` and they are resolved on device against local state; the verifier and PII filter run on the device after the model, not before; no tool gives the model network or file access.

### 9.5 Caller safety
If the safety classifier (a field in the Caller Brain output plus a lightweight device-side keyword net) flags `distress`, the RJ drops the bit and responds plainly and kindly, offers to stop the show or provide a local-resources prompt [wording and region resources need owner/legal review], and does not log the content to memory unless the listener asked. Abuse -> one warning, then end call.

### 9.6 Music rights
Only the listener's own local files are played; the AI never generates, streams, or alters music; no recording of the program output is offered. Talk about songs uses library metadata only by default. **Song lore** (anecdotes about the artist/track from the model's own knowledge) is a hallucination risk and is **off by default**; if enabled it must use hedged phrasing and never numbers/dates. Playing the user's files publicly (a "broadcast") is not a feature.

---

## 10. Grounding, failure modes, fallbacks

### 10.1 Grounding by construction
1. The Writer only sees facts as `{id, say, value}`; it is told to copy `say`, not compute.
2. Every utterance lists `factRefs`. The verifier checks: every number/unit/proper-noun in `text` appears in a referenced fact's `say`/`value` after normalization (numerals vs spelled numbers, rounding rules), and no referenced fact is stale at air time.
3. Services reported `down|stale|denied` are named in `serviceStatus`; the Writer is told it must not mention them. If the Director asks for a `weather_hit` and weather is down, the slot is converted to chat without facts.
4. Failure = regenerate once with the verifier's diagnostics, else swap in a canned link.

### 10.2 Failure matrix
| Failure | Detection | Behavior |
|---|---|---|
| Offline / backend down | request fail | Music-only (ladder 4.6); cached "pressing" if present (section 11, P7) |
| LLM refusal / timeout / invalid JSON | stop_reason, timer, schema | Retry once; else drop slot (never expose error) |
| Hallucinated track id | not in digest | Ignore hint; selector picks |
| Verifier rejects claim | factRef check | Regenerate once; else canned link |
| TTS slow / stall | no first byte in 2.5 s | Drop slot; on-device TTS fallback only if voice-quality gap is acceptable [UNVERIFIED] |
| Talk longer than intro window | duration check | Trim `droppable`; else pre-roll; else between-songs |
| Stale air-time facts | `expiresAt` | Skip/swap variant |
| Mic denied / no AEC / bluetooth switch | permission, route change | Disable calls or push-to-talk |
| STT garbage (low confidence) | confidence + empty | RJ asks to repeat once; then graceful exit |
| Call drops mid-turn | WS close | RJ line "we lost you"; return to show |
| Quota/spend ceiling | 429 | In-character "on a break", music-only |
| Memory pressure | decode failure, `onTrimMemory` [UNVERIFIED hook] | Drop decode-ahead, stay on current deck |
| Background suspension | AudioContext state change | Re-resume on foreground; foreground service (R2) |

---

## 11. Phased build plan

Rule: nothing in this plan changes behavior when Radio is off. Each milestone ends green on `npm test`.

**P0. Contracts and skeleton (about 1 week).** `src/radio/core/` with the 5 schemas + validators, `show-clock`, `scheduler`, `grounding`, `markup`, `turn-taking`, `memory`, fake adapters; feature flag; no network. *Exit:* all core tests pass in CI; Radio absent from the boot path (verified by a bundle test).

**P1. Spikes (time-box 2 weeks, throwaway code, results in a written note).**
- **S1 Caller loop:** web page + minimal proxy + one STT + Claude Haiku-class + one TTS. *Exit:* p50 end-of-speech to first audio <= 2.0 s and p95 <= 3.0 s over Wi-Fi and LTE on the RedMagic 11 Pro (30 turns each); AEC verdict recorded (browser AEC works on speaker yes/no; headphone mode works); barge-in works within 300 ms; if AEC fails, decide on plugin vs headphone-only.
- **S2 Background audio:** a 30-minute Web Audio program with the screen off and the app backgrounded in the Capacitor WebView, with a foreground service and MediaSession. *Exit:* no gap > 250 ms.
- **S3 Voice bake-off:** 3–4 TTS candidates against a fixed rubric on a fixed script set (naturalness, expressive-markup fidelity, TTFB, cost per 1k characters, license for in-app commercial use). *Exit:* one primary and one fallback chosen.
- **S4 Memory/decoding:** two decks plus decode-ahead on a 20-track library on the device. *Exit:* no OOM, no glitch; decides `DecodedDeck` vs `MediaElement` for the next song.
- **Kill criteria:** if S1 cannot reach p95 <= 3.0 s with half-duplex, ship the show without the live caller (Phase 2 still stands) and keep the caller as a later "voice message" feature.

**P2. You Radio, no caller (about 3–4 weeks).** Backend v0 (auth, quota, rundown, script, TTS), Director/Writer/verifier, program bus with decks A/B, ducking, crossfade, dead-air ladder, station bible, minimal Radio UI, AI label. Context: time/date/holiday/sun/library only. *Exit:* a 45-minute unattended show with zero audible dead air on-device; every script passes the verifier; cost per hour measured and below an owner-approved ceiling; offline start = music only and the app otherwise unchanged.

**P3. Context services and You City (about 2–3 weeks).** Weather, coarse place, place facts; permissions flow; serviceStatus handling. *Exit:* fixtures for each failure in 10.2 pass; no fabricated facts in 20 reviewed shows.

**P4. Live caller (about 3–4 weeks).** Productionize S1: turn-taking, barge-in, phone-line FX, hold bed, station-calls-you UI, actions, safety. *Exit:* latency budget table met at p50 on-device, loopback-measured end-to-end (like the existing §3 loopback plan [REPO]); 50-call soak without a stuck state.

**P5. Persona and memory (about 2 weeks).** Callbacks, anti-repeat, listener notes, view/forget UI. *Exit:* 7-day dogfood, repeat-line rate below an agreed threshold.

**P6. Hardening and release gate (about 2 weeks).** Store/privacy compliance, rate-limit/spend tests, fault-injection suite, accessibility (captions of the RJ speech on screen).

**P7. Offline "pressings" (optional, after P6).** Pre-render a 30–60 minute show on Wi-Fi/charging and save it as a record you can play later with no network; fits the vinyl metaphor and gives a true offline AI mode.

Ordering vs the rest of the program: P0 and P1 do not depend on the v0 feel gate. P2 should wait for the gate result because of R1.

---

## 12. Cost, latency, offline

- **Cost drivers (formula, not prices):** hourly cost ≈ LLM(tokens_in × p_in + tokens_out × p_out per call × ~12 calls/hour with cached prefix) + TTS(spoken characters per hour, ≈ 5–7k) + STT(minutes of listener speech) + egress. From the cached table [SKILL], writer LLM cost per hour is likely small (cents) relative to TTS/STT; TTS vendor pricing is [UNVERIFIED] and likely dominates. P1 and P2 must **measure** tokens and characters per show and publish a measured cost per hour; no price in this document should be used for a business decision.
- **Latency:** show generation is non-interactive (seconds of slack); only the caller loop is latency-critical (8.3).
- **Offline:** three levels. (1) AI off: app exactly as today. (2) Network lost mid-show: ladder 4.6, cached stingers, music only. (3) Saved pressings (P7). The first-run experience never blocks on network.

---

## 13. Testing a non-deterministic show

| Layer | Technique |
|---|---|
| Pure core | `node:test`, no dependencies, matching the repo's suite [REPO]. Table-driven tests for show-clock, scheduler, turn-taking (scripted VAD event streams), markup parse/degrade, memory expiry |
| Fixtures | Versioned ContextSnapshot fixtures: rainy commute, heatwave, midnight, no location, weather down, stale traffic, empty library, 5-track library, hostile ID3 tags, long artist names |
| Golden rundowns | Property tests instead of text diffs: durations sum within tolerance; no repeated track; every `trackId` exists; first slot is music or ID; no adjacent talk; talk budgets obey caps; no `mentionable:false` text |
| LLM calls | Record/replay "cassettes" for CI (deterministic). Live runs are nightly/manual because temperature cannot be pinned on these models [SKILL] and they cost money |
| Grounding | Mutation tests: take a good script, perturb a number, expect the verifier to fail; plus a labeled set of known-hallucination scripts |
| Quality evals | Rubric-based LLM-judge on a fixed prompt set (persona consistency, tone, no invented facts, rhythm), checked against a small human-labeled sample before the judge is trusted |
| Injection | Corpus of hostile ID3 tags and caller utterances; assert no out-of-schema action and no policy-violating speech |
| Audio assembly | `OfflineAudioContext` renders a full scheduled timeline; assert ducking envelope, no gap > 250 ms (dead-air detector), true peak < 0 dBFS, voice start lands within tolerance of `introEnd` |
| Latency harness | Scripted 16 kHz WAV utterances fed through a fake `MicSource`; every stage emits timestamps (t0 speech end ... t7 first audio out); report p50/p95/max over N=30 per network condition; a throttled-network profile; final acoustic delay measured with the loopback method already planned for the vinyl gate [REPO] |
| Fault injection | Kill network, slow TTS, 429, malformed JSON, mid-stream disconnect, permission revoked, route change, memory squeeze; each asserts the matching row of 10.2 |
| Cost | Token/character accounting per simulated hour; test fails if over budget |
| Human | A short listening checklist per release (does it sound like one host, is the talk over intro on time, does the call feel natural) |

---

## 14. Candidate providers and recommendation

Nothing in this table is verified live. Vendor features, pricing, latency and licenses change; the spikes verify them.

| Component | Candidates | Trade-offs | Recommendation |
|---|---|---|---|
| Writer/Director LLM | Claude Sonnet 5.5 [SKILL] | Strong structured output, streaming, prompt caching; no sampling controls | Sonnet-class for rundown and scripts; verify latency in spike |
| Caller Brain LLM | Claude Haiku 5.5 [SKILL] | Cheapest and fastest of the family; must verify TTFT, quality at low effort | Haiku-class; fall back to Sonnet-class if banter quality is flat |
| STT | Cloud streaming STT (several vendors); on-device (platform recognizer, small Whisper-family, streaming open models) | Cloud: best accuracy and lowest device cost, privacy cost; on-device: private/offline, accuracy and latency vary by device, packaging heavy | Cloud streaming for v1 behind `SttAdapter`; evaluate one on-device model in S1 as the offline/privacy option |
| TTS | Cloud neural TTS (several vendors, some with styles/SSML/direction tags); open-weight local engines; platform TTS | Cloud: quality + expressiveness, per-character cost, license limits; local: free/offline but quality and size trade-offs; platform TTS: universal, flat delivery | Pick via S3; use platform/local TTS as degraded fallback |
| Speech-to-speech realtime | Vendor realtime APIs | Fewest hops; couples persona, grounding and actions to the vendor | Latency comparator only |
| Backend host | Edge/serverless vs small container | WS limits, cold starts, cost | Decide in S1 |
| Weather | Open-Meteo, NWS, MET Norway | Terms/coverage/commercial use differ | Pick by terms check; wrap behind `ContextProvider` |
| Mic/AEC | Browser AEC; native plugin; headphones-only | See 8.5 | Decide in S1 |

I know of no first-party Anthropic STT/TTS product; the speech layers are third-party [UNVERIFIED].

---

## 15. Open questions for the owner (each with my recommended default)

1. **Network exception (1.3):** approve a scoped, opt-in exception to "no network, no streaming"? *Default: yes, as worded in 1.3.* Also amends the locked decision "local-only library, no streaming, ever" for the radio features (Workstream A's real stations hit the same lock).
2. **Who pays:** free quota, subscription, or bring-your-own-key? *Default: BYO key in dev builds now; decide the paid model before any store release.*
3. **Persona and voice:** one house host or a choice of two? Name and tone? *Default: two selectable hosts, English, warm-wry, stock/licensed voices only, no cloning.*
4. **Live caller on speaker:** require headphones for full-duplex, or ship push-to-talk on speaker? *Default: full-duplex on headphones, push-to-talk on speaker, until S1 proves AEC.*
5. **Library data to cloud:** may a shortlist of about 60 candidate tracks (title/artist/album/genre) be sent to the backend per planning call? *Default: yes with the first-enable consent text; no file names or paths, never audio.*
6. **Song lore (trivia):** allow the RJ to say things about artists/songs beyond metadata? *Default: off.*
7. **Audio retention:** keep caller transcripts? replay caller clips on air? *Default: transcript off unless toggled; clips never unless toggled.*
8. **Location precision and You City scope:** coarse city-level only, with weather and place facts; traffic and news deferred? *Default: yes.*
9. **Station calls you while the app is closed:** push-initiated calls? *Default: no (NG7).*
10. **Background/lock-screen play:** required for radio? *Default: required; S2 gates the whole feature.*
11. **Backend home:** separate repo and deploy account, or a directory here? *Default: separate repo (CI program rules R1/R5).*
12. **Shared `Station` interface with Workstream A and one program bus for real + AI stations?** *Default: yes; one "dial" with real stations, You, and You City, one master output.*
13. **If the v0 feel gate fails and the engine goes native Oboe:** should the radio bus follow it native? *Default: yes, and keep `core/` portable so only the bus implementation moves.*
14. **Spend ceiling per user-hour** that the owner is willing to underwrite for the spike and the alpha. *Default: set after P2 measurement; until then a hard dev cap.*
