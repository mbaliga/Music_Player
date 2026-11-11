import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioManifest, audioUrl, chooseVoiceSource, preferTwinForAudio, captionTimeline, mimeFor, MAX_AUDIO_SEC } from '../../src/radio/canned/audio-pack.js';
import { createAudioBackend } from '../../src/radio/canned/audio.js';
import { loadPackFile } from '../support/canned-sim.mjs';
import { fakeTime } from '../radio-offline/helpers.mjs';

const manifest = (segs, o = {}) => ({ v: 1, station: 'tape-hiss-fm', codec: 'opus', bitrateKbps: 24, targetLufs: -19, segments: segs, ...o });
const seg = (id, o = {}) => ({ id, kind: 'banter', file: `${id}.opus`, durationSec: 12.5, sha256: 'x', bytes: 4000, lufs: -19, ...o });

test('manifest: the render-shows.py format parses; alt encodings are optional; the station must match', () => {
  const m = parseAudioManifest(manifest([seg('a'), seg('b', { alt: [{ file: 'b.m4a' }, { file: 'b.mp3', type: 'audio/mpeg' }] })]), 'tape-hiss-fm');
  assert.equal(m.ok, true); assert.equal(m.entries.size, 2);
  assert.deepEqual(m.entries.get('b').candidates.map((c) => c.file), ['b.opus', 'b.m4a', 'b.mp3']);
  assert.match(m.entries.get('a').candidates[0].type, /opus/);
  assert.match(m.entries.get('b').candidates[1].type, /mp4/);
  assert.equal(parseAudioManifest(manifest([seg('a')]), 'pirate-1400').ok, false);
  assert.equal(parseAudioManifest(JSON.stringify(manifest([seg('a')]))).ok, true);
});

test('manifest: junk never throws; unsafe paths and absurd durations are dropped', () => {
  for (const j of [null, undefined, 5, '{', '[]', {}, { segments: 'x' }, { v: 1, segments: [null, 4, {}, { id: 'a' }] }]) { assert.doesNotThrow(() => parseAudioManifest(j)); assert.equal(parseAudioManifest(j).ok, false); }
  const m = parseAudioManifest(manifest([
    seg('ok'), seg('up', { file: '../../etc/passwd' }), seg('abs', { file: '/x.opus' }), seg('url', { file: 'https://evil.example/x.opus' }), seg('proto', { file: '//evil.example/x.opus' }),
    seg('q', { file: 'x.opus?cache=1' }), seg('bs', { file: 'a\\b.opus' }), seg('long', { durationSec: MAX_AUDIO_SEC + 1 }), seg('zero', { durationSec: 0 }), seg('nan', { durationSec: 'x' }),
    seg('altbad', { alt: [{ file: '../x.m4a' }, { file: 'altbad.m4a' }] }),
  ]));
  assert.deepEqual([...m.entries.keys()].sort(), ['altbad', 'ok']);
  assert.deepEqual(m.entries.get('altbad').candidates.map((c) => c.file), ['altbad.opus', 'altbad.m4a']);
  assert.ok(m.errors.length >= 8);
  assert.equal(audioUrl('audio/', 'tape-hiss-fm', 'a b.opus'), 'audio/tape-hiss-fm/a%20b.opus');
  assert.equal(mimeFor('x.m4a'), 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(mimeFor('x.bin'), '');
});

test('voice source selection: audio when the exact segment has a recording, else system speech, else none; failures demote to TTS', () => {
  const entry = { id: 'a', candidates: [{ file: 'a.opus', type: 'audio/ogg' }], durationSec: 5 };
  const S = (o) => chooseVoiceSource({ ttsAvailable: true, segmentId: 'a', ...o });
  assert.equal(S({ entry }), 'audio');
  assert.equal(S({ entry: null }), 'tts');
  assert.equal(S({ entry, audioDisabled: true }), 'tts');
  assert.equal(S({ entry, failedIds: new Set(['a']) }), 'tts');
  assert.equal(S({ entry, failedIds: new Set(['b']) }), 'audio');
  assert.equal(S({ entry, failedIds: new Set(['a']), ttsAvailable: false }), 'none');
  assert.equal(S({ entry: null, ttsAvailable: false }), 'none');
  assert.equal(chooseVoiceSource(), 'none');
});

test('audio-pack mode swaps a slot unit for its recorded twin; plain units and packs without the twin recording are unchanged', () => {
  const pack = loadPackFile('tape-hiss-fm');
  const u = pack.units.find((x) => x.slots.length);
  const entries = new Map([[u.twins[0].id, {}]]);
  assert.equal(preferTwinForAudio({ entries, unit: u }), true);
  assert.equal(preferTwinForAudio({ entries, unit: u, slotsInAudioMode: 'tts' }), false);
  assert.equal(preferTwinForAudio({ entries, unit: u, audioDisabled: true }), false);
  assert.equal(preferTwinForAudio({ entries: new Map(), unit: u }), false);
  assert.equal(preferTwinForAudio({ entries: new Map([['other', {}]]), unit: u }), false);
  assert.equal(preferTwinForAudio({ entries, unit: pack.units.find((x) => !x.slots.length) }), false);
  assert.equal(preferTwinForAudio({}), false);
});

test('caption timeline: lines are spread over the measured duration by words and pauses, in order', () => {
  const lines = [{ host: 'a', text: 'one two three four', pauseAfterMs: 500 }, { host: 'b', text: 'five six' }, { host: 'a', text: 'seven eight nine ten eleven twelve', pauseAfterMs: 0 }];
  const tl = captionTimeline(lines, 20);
  assert.equal(tl.length, 3); assert.equal(tl[0].atSec, 0);
  assert.ok(tl[1].atSec > tl[0].atSec && tl[2].atSec > tl[1].atSec && tl[2].atSec < 20);
  assert.deepEqual(tl.map((x) => x.host), ['a', 'b', 'a']);
  assert.deepEqual(captionTimeline([], 5), []); assert.deepEqual(captionTimeline(null, 5), []);
  assert.doesNotThrow(() => captionTimeline([{ text: 'x' }, null, { text: 5 }], NaN));
});

// ── the <audio> backend ──────────────────────────────────────────────────────
class FakeAudioEl {
  constructor(script, canPlay) { this.script = script; this.canPlay = canPlay; this.attrs = {}; this.paused = true; FakeAudioEl.made.push(this); }
  canPlayType(t) { return this.canPlay(t); }
  removeAttribute(k) { delete this.attrs[k]; }
  load() {}
  pause() { this.paused = true; }
  play() { const mode = this.script(this.src); this.paused = false; if (mode === 'reject') return Promise.reject(new Error('NotSupported')); if (mode === 'error') { Promise.resolve().then(() => this.onerror && this.onerror()); return Promise.resolve(); } if (mode === 'ok') { Promise.resolve().then(() => { this.onplaying && this.onplaying(); }); return Promise.resolve(); } return Promise.resolve(); /* 'hang' */ }
  finish() { this.onended && this.onended(); }
}
FakeAudioEl.made = [];
const mk = (time, script, canPlay = () => 'maybe') => { FakeAudioEl.made.length = 0; return createAudioBackend({ createAudio: () => new FakeAudioEl(script, canPlay), timers: time.timers }); };
const cands = [{ url: 'audio/x/a.opus', type: 'audio/ogg; codecs="opus"' }, { url: 'audio/x/a.m4a', type: 'audio/mp4; codecs="mp4a.40.2"' }];

test('audio backend: plays the first candidate, reports start and the natural end', async () => {
  const time = fakeTime(); const a = mk(time, () => 'ok');
  let started = 0;
  const p = a.play({ candidates: cands, durationSec: 5, onStart: () => started++ });
  await time.flush(); await time.flush();
  assert.equal(started, 1);
  FakeAudioEl.made[0].finish();
  const r = await p;
  assert.equal(r.ok, true); assert.equal(r.candidate.url, 'audio/x/a.opus'); assert.equal(FakeAudioEl.made.length, 1);
});

test('audio backend: an Opus the WebView cannot play falls through to the .m4a the manifest names; a load error does too', async () => {
  const time = fakeTime();
  let a = mk(time, () => 'ok', (t) => (/opus/.test(t) ? '' : 'probably'));
  let p = a.play({ candidates: cands, durationSec: 5 });
  await time.flush(); await time.flush(); FakeAudioEl.made.at(-1).finish();
  let r = await p;
  assert.equal(r.ok, true); assert.equal(r.candidate.url, 'audio/x/a.m4a');
  a = mk(time, (src) => (/opus/.test(src) ? 'error' : 'ok'));
  p = a.play({ candidates: cands, durationSec: 5 });
  await time.flush(); await time.flush(); await time.flush(); FakeAudioEl.made.at(-1).finish();
  r = await p;
  assert.equal(r.ok, true); assert.equal(r.candidate.url, 'audio/x/a.m4a'); assert.equal(r.tried, 2);
});

test('audio backend: every decode/load failure settles with a reason, never throws, never hangs', async () => {
  const time = fakeTime();
  let r = await mk(time, () => 'error').play({ candidates: cands, durationSec: 5 });
  assert.equal(r.ok, false); assert.match(r.reason, /load_failed/);
  r = await mk(time, () => 'reject').play({ candidates: cands, durationSec: 5 });
  assert.equal(r.ok, false);
  r = await mk(time, () => 'ok', () => '').play({ candidates: cands, durationSec: 5 });
  assert.deepEqual([r.ok, r.reason], [false, 'unsupported']);
  r = await mk(time, () => 'ok').play({ candidates: [], durationSec: 5 });
  assert.equal(r.ok, false);
  // never starts: the start timeout moves on, then fails
  const a = mk(time, () => 'hang');
  const p = a.play({ candidates: cands, durationSec: 5 });
  await time.advance(8000); await time.advance(8000);
  r = await p;
  assert.equal(r.ok, false);
  // starts and then dies mid-play
  const b = mk(time, () => 'ok');
  const p2 = b.play({ candidates: cands, durationSec: 5 });
  await time.flush(); await time.flush(); FakeAudioEl.made.at(-1).onerror();
  assert.equal((await p2).reason, 'error_mid_play');
  // a createAudio that throws
  assert.equal((await createAudioBackend({ createAudio: () => { throw new Error('no audio'); }, timers: time.timers }).play({ candidates: cands })).ok, false);
});

test('audio backend: cancel settles the pending play; a stalled end is assumed after 1.5x the duration', async () => {
  const time = fakeTime();
  const a = mk(time, () => 'ok');
  const p = a.play({ candidates: cands, durationSec: 4 });
  await time.flush(); await time.flush();
  a.cancel();
  assert.equal((await p).reason, 'cancelled');
  const b = mk(time, () => 'ok');
  const p2 = b.play({ candidates: cands, durationSec: 4 });
  await time.flush(); await time.flush();
  await time.advance(11000);
  const r = await p2;
  assert.deepEqual([r.ok, r.assumed], [true, true]);
});
