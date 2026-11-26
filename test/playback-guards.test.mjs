// Regression tests for the playback review (decode guard, long-file envelope, mono memory, tempo excerpt, formats, tape release / failure handling).
// The browser behaviour is proven by scripts/verify-real-playback.py; this pins the pure pieces and the MixtapeUI state handling in node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEnvelope, makeTempoFeed } from '../src/model.js';
import { loadFile, decodedBytes, DECODE_LIMITS, TooLongError } from '../src/track.js';
import { unsupportedReason, isSupported, UNSUPPORTED_TEXT } from '../src/formats.js';
import { estimateTempo } from '../src/fx/tempo.js';
import { MixtapeUI } from '../src/mixtape-ui.js';

// ── computeEnvelope: a 60-minute file is not a main-thread freeze ──────────────────────────────────────────────────────────
test('computeEnvelope reads a bounded number of samples on a long file and matches the full pass', () => {
  const sr = 44100, frames = sr * 3600;                     // 60 minutes
  let reads = 0;
  const get = (i) => { reads++; return Math.sin(i * 0.01) * (0.2 + 0.8 * Math.sin(i / 4e6) ** 2); };
  const t0 = performance.now();
  const e = computeEnvelope(get, frames, 1024);
  const ms = performance.now() - t0;
  assert.ok(reads <= 1024 * 520, 'reads bounded (' + reads + ')');
  assert.ok(ms < 250, 'fast (' + ms.toFixed(0) + ' ms)');
  assert.equal(e.length, 1024); assert.ok(Math.max(...e) === 1);
  // against the exhaustive RMS on a shorter signal: the same picture
  const n = 44100 * 20, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.02) * (0.1 + 0.9 * Math.abs(Math.sin(i / 90000)));
  const full = computeEnvelope((i) => x[i], n, 256, { maxPerBin: 1e9 }), fast = computeEnvelope((i) => x[i], n, 256);
  let worst = 0; for (let i = 0; i < 256; i++) worst = Math.max(worst, Math.abs(full[i] - fast[i]));
  assert.ok(worst < 0.03, 'decimated envelope within 0.03 of the exhaustive one (' + worst.toFixed(4) + ')');
});

test('computeEnvelope on short input is exactly the old exhaustive result (windows under 512 samples are read in full)', () => {
  const x = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 7));
  const a = computeEnvelope((i) => x[i], 4096, 16), b = computeEnvelope((i) => x[i], 4096, 16, { maxPerBin: 1e9 });
  assert.deepEqual([...a], [...b]);
});

// ── the Booth keeps a 60 s excerpt, not the whole PCM ──────────────────────────────────────────────────────────────────────
test('makeTempoFeed copies the window estimateTempo analyses; the tempo equals the full-PCM tempo and the feed is small', () => {
  const sr = 22050, secs = 200, frames = sr * secs;
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const beat = Math.round(sr * 60 / 128);
  for (let i = 0; i < frames; i++) { const ph = i % beat; const v = Math.exp(-ph / 600) * Math.sin(ph * 0.3); L[i] = v; R[i] = v * 0.9; }
  const feed = makeTempoFeed([L, R], frames, sr);
  assert.equal(feed.channels.length, 1); assert.equal(feed.frames, sr * 60); assert.ok(feed.channels[0].length * 4 < frames * 8 / 3);
  const full = estimateTempo([L, R], frames, sr), part = estimateTempo(feed.channels, feed.frames, feed.sampleRate);
  assert.ok(full && part); assert.equal(part.bpm, full.bpm);
  assert.equal(makeTempoFeed(null, 10, 44100), null);
  const short = makeTempoFeed([new Float32Array(1000)], 1000, 44100); assert.equal(short.frames, 1000);
});

// ── loadFile: size guard, mono stays mono, no duplicate ───────────────────────────────────────────────────────────────────────
const fakeCtx = (buf) => ({ sampleRate: 48000, decodeAudioData: async () => buf });
const abuf = (chs, len = 480, sr = 48000) => ({ numberOfChannels: chs, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c) => new Float32Array(len).fill(c + 1) });
const fakeFile = (name, size = 100) => ({ name, size, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }), arrayBuffer: async () => new ArrayBuffer(size) });

test('loadFile: a mono file is ONE channel (no duplicated plane), copy:false aliases the decoded buffer', async () => {
  const b = abuf(1);
  const t = await loadFile(fakeFile('a.mp3'), fakeCtx(b), { copy: false, durationSec: 1 });
  assert.equal(t.channels.length, 1); assert.equal(t.frames, 480); assert.equal(t.name, 'a');
  const t2 = await loadFile(fakeFile('s.flac'), fakeCtx(abuf(2)), { durationSec: 1 });
  assert.equal(t2.channels.length, 2);
});

test('loadFile refuses a file whose decoded size is over the limit BEFORE decoding (known duration) and after it (unknown)', async () => {
  let decoded = 0;
  const ctx = { sampleRate: 48000, decodeAudioData: async () => { decoded++; return abuf(2, 10, 48000); } };
  assert.ok(decodedBytes(30 * 60, 48000, 2) > DECODE_LIMITS.maxBytes);
  await assert.rejects(loadFile(fakeFile('mix.mp3'), ctx, { durationSec: 30 * 60 }), (e) => e instanceof TooLongError && e.tooLong && /too long to load/.test(e.message));
  assert.equal(decoded, 0, 'nothing was decoded');
  const longBuf = { numberOfChannels: 2, length: 48000 * 700, sampleRate: 48000, duration: 700, getChannelData: () => new Float32Array(1) };
  await assert.rejects(loadFile(fakeFile('unknown.mp3'), { sampleRate: 48000, decodeAudioData: async () => longBuf }, {}), /too long/);
  const ok = await loadFile(fakeFile('six.mp3'), ctx, { durationSec: 360, copy: false });   // 6 min stereo 48 kHz = 138 MB: loads
  assert.equal(ok.frames, 10);
  assert.equal(decoded, 1);
});

// ── unsupported formats ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('formats: wma / amr / midi / ape / dsd / alac are marked, mp3 m4a(aac) flac ogg opus wav are not', () => {
  for (const n of ['a.wma', 'b.AMR', 'c.mid', 'd.ape', 'e.dsf', 'f.dff', 'g.wv', 'h.mka']) assert.equal(unsupportedReason({ path: 'M/' + n }), UNSUPPORTED_TEXT, n);
  assert.equal(unsupportedReason({ path: 'M/x.m4a', codec: 'alac' }), UNSUPPORTED_TEXT);
  assert.equal(unsupportedReason({ name: 'x.m4a', mime: 'audio/x-ms-wma' }), UNSUPPORTED_TEXT);
  for (const n of ['a.mp3', 'b.m4a', 'c.flac', 'd.ogg', 'e.opus', 'f.wav', 'g.aac']) assert.ok(isSupported({ path: n }), n);
  assert.equal(unsupportedReason(null), '');
});

// ── MixtapeUI: pause / release / closing (F9) and a failed song (F4) ─────────────────────────────────────────────────────
function tapeUI(over = {}) {
  const calls = [];
  const ui = Object.create(MixtapeUI.prototype);
  ui.d = { setPaused: (v) => calls.push(['setPaused', v]), dropNext: () => calls.push(['dropNext']), playFile: async () => { throw new Error('boom'); }, ...over };
  ui.root = { classList: { add() {}, remove() {}, contains: () => false } };
  ui.pl = { destroy() { calls.push(['destroy']); } };
  ui._windCancel = () => {}; ui._fillList = () => {}; ui._dispatch = (e) => { calls.push(['dispatch', e.type]); return []; }; ui._q = () => [];
  ui.msg = { textContent: '', classList: { remove() {}, add() {} } };
  return { ui, calls };
}
test('releaseEngine on a PAUSED tape lifts the platter brake (the new album must not start braked and silent)', () => {
  const { ui, calls } = tapeUI();
  ui.play = { paused: true, ended: false, tok: 0 };
  ui.releaseEngine();
  assert.deepEqual(calls.find((c) => c[0] === 'setPaused'), ['setPaused', false]);
  assert.equal(ui.play.paused, false); assert.equal(ui.play.released, true);
  const { ui: u2, calls: c2 } = tapeUI(); u2.play = { paused: false, ended: false, tok: 0 }; u2.releaseEngine();
  assert.ok(!c2.some((c) => c[0] === 'setPaused'), 'no brake call when it was not paused');
});
test('closing the player does NOT resume a paused tape', () => {
  const { ui, calls } = tapeUI();
  ui.play = { paused: true, ended: false }; ui._closePlayer();
  assert.equal(ui.play.paused, true); assert.ok(!calls.some((c) => c[0] === 'setPaused'));
});
test('a song that cannot be decoded: the next playable song is tried; with none left a manual jump keeps the audible index, a natural advance ends the side', async () => {
  const mk = (files, tried) => {
    const t = tapeUI({ playFile: async (f) => { tried.push(f); if (f.startsWith('bad')) throw new Error('decode'); return { frames: 100, channels: null, nch: 2 }; } });
    t.ui.play = { idx: 0, loading: false, ended: false, paused: false, files, tok: 0, q: { playable: files.map(Boolean), cur: 0 }, mix: { tracks: files.map((f, i) => ({ title: 'T' + i })) } };
    t.ui._playable = (from, dir) => { for (let i = from; i >= 0 && i < files.length; i += dir) if (files[i]) return i; return -1; };
    return t;
  };
  let tried = []; let { ui } = mk(['ok0', 'bad1', 'bad2', 'ok3'], tried);
  await ui._goto(1);
  assert.deepEqual(tried, ['bad1', 'bad2', 'ok3']); assert.equal(ui.play.idx, 3, 'ended on the song that is audible');
  tried = []; ({ ui } = mk(['ok0', 'bad1', 'bad2'], tried));
  await ui._goto(1);
  assert.equal(ui.play.idx, 0, 'manual jump into nothing playable: back on the loaded song'); assert.equal(ui.play.loading, false);
  tried = []; let c; ({ ui, calls: c } = mk(['ok0', 'bad1'], tried));
  await ui._goto(1, 0, { natural: true });
  assert.equal(ui.play.ended, true); assert.ok(c.some((x) => x[0] === 'dispatch' && x[1] === 'sideEnd'));
});

// ── review 6f15b2c: a tape with nothing playable must not hold the engine; a new tape ends the old one ───────────────────
test('startPlayback with no playable track leaves the tape ENDED + released (engineOwner would otherwise say "mixtape" forever)', async () => {
  const { ui, calls } = tapeUI({ getLibraryTracks: () => [], closeLibrary() {}, relink: null });
  ui.listPanel = { classList: { add() {}, remove() {} } }; ui.root.classList = { add() {}, remove() {}, contains: () => false };
  ui._mountSkin = () => {}; ui._applyRunMode = () => {}; ui._sideDurations = function () { const p = this.play; p.sideDurs = { A: [], B: [] }; };
  ui._dropQueued = () => {}; ui._showMsg = () => {};
  ui.play = null;
  const m = { id: 'm1', autoReverse: true, sides: { A: [0], B: [] }, tracks: [{ title: 'Gone', artist: 'X', dur: 100 }] };
  await ui.startPlayback(m, 0);
  assert.equal(ui.play.ended, true); assert.equal(ui.play.released, true);
  assert.ok(!calls.some((c) => c[0] === 'dispatch' && c[1] === 'play'), 'never starts');
});
test('startPlayback releases a tape that was already in the deck first', async () => {
  const { ui, calls } = tapeUI({ getLibraryTracks: () => [], closeLibrary() {} });
  ui.listPanel = { classList: { add() {}, remove() {} } };
  ui._mountSkin = () => {}; ui._applyRunMode = () => {}; ui._sideDurations = function () { const p = this.play; p.sideDurs = { A: [], B: [] }; };
  ui._dropQueued = () => {}; ui._showMsg = () => {};
  const old = { paused: false, ended: false, tok: 0 };
  ui.play = old;
  await ui.startPlayback({ id: 'm2', autoReverse: true, sides: { A: [0], B: [] }, tracks: [{ title: 'Gone', artist: 'X', dur: 100 }] }, 0);
  assert.equal(old.released, true); assert.equal(old.ended, true);
  assert.ok(calls.some((c) => c[0] === 'dropNext'));
});
