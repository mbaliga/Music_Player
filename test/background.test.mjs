import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopDriver, installAudioResume, createMediaBridge, getPlaybackPlugin, startBackground, BG_INTERVAL_MS, IDLE_STOP_MS } from '../src/background.js';

function rig() {
  const listeners = new Map();
  const doc = { hidden: false, visibilityState: 'visible', addEventListener: (n, f) => listeners.set(n, f), removeEventListener: (n) => listeners.delete(n) };
  const q = { raf: null, ivs: new Map(), ivId: 0, steps: [], t: 1000, cancelled: 0 };
  const env = {
    doc, now: () => q.t,
    raf: (f) => { q.raf = f; return 1; }, caf: () => { q.raf = null; q.cancelled++; },
    setIv: (f, ms) => { q.ivs.set(++q.ivId, { f, ms }); return q.ivId; }, clearIv: (id) => q.ivs.delete(id),
  };
  const setHidden = (h) => { doc.hidden = h; doc.visibilityState = h ? 'hidden' : 'visible'; listeners.get('visibilitychange')?.(); };
  return { doc, q, env, setHidden, listeners };
}

test('loop driver: rAF while visible, a 250 ms timer while hidden, back to rAF on return; exactly one scheduler at a time', () => {
  const { q, env, setHidden } = rig();
  const steps = [];
  const d = createLoopDriver((t, bg) => steps.push([t, bg]), env);
  d.start();
  assert.equal(d.mode, 'raf'); assert.ok(q.raf); assert.equal(q.ivs.size, 0);
  q.raf(16); assert.deepEqual(steps.pop(), [16, false]); assert.ok(q.raf, 'rescheduled');
  setHidden(true);
  assert.equal(d.mode, 'timer'); assert.equal(q.raf, null, 'rAF cancelled'); assert.equal(q.ivs.size, 1);
  assert.equal([...q.ivs.values()][0].ms, BG_INTERVAL_MS);
  assert.deepEqual(steps.pop(), [1000, true], 'a step runs at once on hiding');
  const iv = [...q.ivs.values()][0].f;
  q.t = 1250; iv(); assert.deepEqual(steps.pop(), [1250, true]);
  setHidden(false);
  assert.equal(d.mode, 'raf'); assert.equal(q.ivs.size, 0, 'timer cleared'); assert.ok(q.raf);
  d.stop(); assert.equal(q.raf, null); assert.equal(d.mode, 'stopped');
});

test('loop driver: a throwing step does not end the loop; poke runs a step only while hidden and never re-enters', () => {
  const { q, env, setHidden } = rig();
  let n = 0, inside = 0, maxInside = 0;
  const d = createLoopDriver((t, bg) => { n++; inside++; maxInside = Math.max(maxInside, inside); try { if (n === 1) throw new Error('boom'); if (bg) d.poke(); } finally { inside--; } }, env);
  const log = console.error; console.error = () => {};
  try {
    d.start();
    q.raf(1);                                  // throws inside step
    assert.ok(q.raf, 'still scheduled after a throw');
    const before = n; d.poke(); assert.equal(n, before, 'poke is a no-op while visible');
    setHidden(true);                           // runs a hidden step that pokes itself: no re-entry
    assert.equal(maxInside, 1);
    const b2 = n; d.poke(); assert.equal(n, b2 + 1);
  } finally { console.error = log; }
});

test('audio resume: statechange and visibilitychange resume a suspended context, never a running or closed one', () => {
  const { doc, listeners } = rig();
  const ctxL = new Map();
  let resumed = 0;
  const ctx = { state: 'suspended', resume: () => { resumed++; return Promise.resolve(); }, addEventListener: (n, f) => ctxL.set(n, f), removeEventListener: (n) => ctxL.delete(n) };
  const off = installAudioResume({ getCtx: () => ctx, doc });
  ctxL.get('statechange')(); assert.equal(resumed, 1);
  listeners.get('visibilitychange')(); assert.equal(resumed, 2);
  ctx.state = 'running'; ctxL.get('statechange')(); assert.equal(resumed, 2);
  ctx.state = 'closed'; listeners.get('visibilitychange')(); assert.equal(resumed, 2);
  ctx.state = 'interrupted'; ctx.resume = () => Promise.reject(new Error('needs a gesture')); assert.doesNotThrow(() => ctxL.get('statechange')());
  off(); assert.equal(ctxL.size, 0); assert.equal(listeners.size, 0);
  assert.doesNotThrow(() => installAudioResume({ getCtx: () => null, doc: null }));
});

test('getPlaybackPlugin: null on the web, the registered proxy (cached) in the native shell', () => {
  assert.equal(getPlaybackPlugin({}), null);
  assert.equal(getPlaybackPlugin({ Capacitor: { isNativePlatform: () => false } }), null);
  assert.equal(getPlaybackPlugin({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => false } }), null);
  let reg = 0; const proxy = {};
  const win = { Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === 'DevicePlayback', registerPlugin: (n) => { reg++; assert.equal(n, 'DevicePlayback'); return proxy; } } };
  assert.equal(getPlaybackPlugin(win), proxy); assert.equal(getPlaybackPlugin(win), proxy); assert.equal(reg, 1);
});

function fakePlugin({ failStart = 0 } = {}) {
  const calls = [], ls = {};
  return {
    calls, ls,
    addListener: async (n, f) => { ls[n] = f; return { remove: () => delete ls[n] }; },
    requestNotificationPermission: async () => { calls.push(['perm']); return { granted: false }; },   // denied: tolerated
    start: async () => { calls.push(['start']); if (failStart-- > 0) throw new Error('not allowed'); },
    stop: async () => { calls.push(['stop']); },
    setMetadata: async (m) => { calls.push(['meta', m]); },
    setState: async (s) => { calls.push(['state', s.playing]); },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const album = (over = {}) => ({ album: { title: 'Song', sub: 'Vinyl · track 1 of 9', playing: true, canNext: true, ...over } });

test('media bridge: first play asks for notifications once (denial tolerated), then starts the service; metadata + state only on change', async () => {
  const plugin = fakePlugin();
  const acts = [];
  const b = createMediaBridge({ plugin, actions: { toggle: (s) => acts.push(['toggle', s]), next: (s) => acts.push(['next', s]), prev: (s) => acts.push(['prev', s]), stop: () => acts.push(['stop']) }, getMeta: () => ({ artist: 'Band', album: 'LP' }), env: { doc: { hidden: false } } });
  await flush();
  b.sync(album()); await flush();
  const names = plugin.calls.map((c) => c[0]);
  assert.deepEqual(names, ['meta', 'state', 'perm', 'start']);
  assert.deepEqual(plugin.calls[0][1], { title: 'Song', artist: 'Band', album: 'LP' });
  plugin.calls.length = 0;
  b.sync(album()); b.sync(album()); await flush();
  assert.equal(plugin.calls.length, 0, 'unchanged picture: nothing sent');
  b.sync(album({ title: 'Next song' })); await flush();
  assert.deepEqual(plugin.calls.map((c) => c[0]), ['meta', 'state']);
  plugin.calls.length = 0;
  b.sync(album({ title: 'Next song', playing: false })); await flush();
  assert.deepEqual(plugin.calls, [['state', false]], 'pause = state only');
  assert.ok(!plugin.calls.some((c) => c[0] === 'perm'));
});

test('media bridge: never starts the service from a hidden page; starts it once visible; retries a refused start a few times only', async () => {
  const doc = { hidden: true };
  const plugin = fakePlugin({ failStart: 99 });
  const b = createMediaBridge({ plugin, actions: {}, env: { doc } });
  b.sync(album()); await flush();
  assert.ok(!plugin.calls.some((c) => c[0] === 'start'), 'hidden: no start');
  doc.hidden = false;
  for (let i = 0; i < 8; i++) { b.sync(album()); await flush(); }
  assert.equal(plugin.calls.filter((c) => c[0] === 'start').length, 3, 'bounded retries');
  assert.equal(plugin.calls.filter((c) => c[0] === 'perm').length, 1, 'permission asked only once');
});

test('media bridge: media buttons call the app transport (play resumes the last source, pause on radio stops it, duck follows focus)', async () => {
  const plugin = fakePlugin();
  const acts = []; const ducks = [];
  const b = createMediaBridge({ plugin, duck: (on) => ducks.push(on), actions: { toggle: (s) => acts.push(['toggle', s]), next: (s) => acts.push(['next', s]), prev: (s) => acts.push(['prev', s]), stop: () => acts.push(['stop']) }, env: { doc: { hidden: false } } });
  await flush();
  b.sync(album()); await flush();
  plugin.ls.pause(); assert.deepEqual(acts.pop(), ['toggle', 'album']);
  plugin.ls.play(); assert.equal(acts.length, 0, 'play while playing: nothing');
  plugin.ls.next(); assert.deepEqual(acts.pop(), ['next', 'album']);
  plugin.ls.previous(); assert.deepEqual(acts.pop(), ['prev', 'album']);
  b.sync({}); await flush();                                 // paused from the bar: the source vanished from the picture
  plugin.ls.play(); assert.deepEqual(acts.pop(), ['toggle', 'album'], 'resumes the source that was playing');
  plugin.ls.duck({ on: true }); plugin.ls.duck({ on: false }); assert.deepEqual(ducks, [true, false]);
  b.sync({ radio: { title: 'KEXP', sub: 'Radio · on air' } }); await flush();
  plugin.ls.pause(); assert.deepEqual(acts.pop(), ['stop']);
  plugin.ls.next(); assert.equal(acts.length, 0, 'no next on radio');
  plugin.ls.stopped(); b.sync(album()); await flush();      // the service went away: the next play starts it again
  assert.ok(plugin.calls.filter((c) => c[0] === 'start').length >= 2);
});

test('media bridge: after a minute of nothing playing the service is stopped', async () => {
  let t = 0;
  const plugin = fakePlugin();
  const b = createMediaBridge({ plugin, actions: {}, env: { doc: { hidden: false }, now: () => t } });
  b.sync(album()); await flush();
  b.sync({}); t = 1000; b.sync({}); await flush();
  assert.ok(!plugin.calls.some((c) => c[0] === 'stop'));
  t = IDLE_STOP_MS + 2000; b.sync({}); await flush();
  assert.ok(plugin.calls.some((c) => c[0] === 'stop'));
});

test('web: navigator.mediaSession carries metadata, state and the action handlers; no plugin calls', () => {
  const handlers = {};
  const ms = { metadata: null, playbackState: 'none', setActionHandler: (a, f) => { handlers[a] = f; } };
  const acts = [];
  const b = createMediaBridge({ plugin: null, actions: { toggle: (s) => acts.push(s) }, getMeta: () => ({ artist: 'A', album: 'B' }), env: { doc: { hidden: false }, nav: { mediaSession: ms }, MediaMetadata: class { constructor(m) { Object.assign(this, m); } } } });
  b.sync(album());
  assert.equal(ms.metadata.title, 'Song'); assert.equal(ms.metadata.artist, 'A'); assert.equal(ms.playbackState, 'playing');
  handlers.pause(); assert.deepEqual(acts, ['album']);
  b.sync({}); assert.equal(ms.playbackState, 'paused');
  assert.deepEqual(Object.keys(handlers).sort(), ['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto']);
});

test('startBackground wires the engine edge to a poke and starts the driver; no-ops without a native plugin', () => {
  const { q, doc, setHidden } = rig();
  const steps = [];
  const engine = { ctx: null, onPlaybackEdge: null };
  const saved = { document: globalThis.document };
  globalThis.document = doc;
  const raf = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = (f) => { q.raf = f; return 1; };
  try {
    const s = startBackground({ step: (t, bg) => steps.push(bg), engine, actions: {}, win: {}, doc });
    assert.equal(s.driver.mode, 'raf');
    setHidden(true); steps.length = 0;
    engine.onPlaybackEdge('ended'); assert.deepEqual(steps, [true], 'the audio thread poked a hidden step');
    assert.doesNotThrow(() => s.sync({})); assert.doesNotThrow(() => s.poke());
    s.driver.stop();
  } finally { globalThis.requestAnimationFrame = raf; globalThis.document = saved.document; }
});

test('media bridge: fgs-denied tells the user once and lets the next sync start the service again', async () => {
  const plugin = fakePlugin();
  const notes = [];
  const b = createMediaBridge({ plugin, notice: (t) => notes.push(t), actions: {}, env: { doc: { hidden: false } } });
  await flush();
  b.sync(album()); await flush();
  const starts = () => plugin.calls.filter((c) => c[0] === 'start').length;
  assert.equal(starts(), 1);
  plugin.ls['fgs-denied'](); await flush();
  assert.equal(notes.length, 1);
  b.sync(album()); await flush();
  assert.equal(starts(), 2, 'retried on the next sync');
});

// ── the sleep timer's clock ──
import { createSleepDriver } from '../src/background.js';
import { createSleep as createSleepModel } from '../src/sleep.js';
test('sleep driver: its own interval runs only while a timer exists, ticks on visibility, and expires with the page hidden', () => {
  const ivs = new Map(); let nid = 0; const listeners = {};
  const env = { doc: { hidden: true, addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: (n) => { delete listeners[n]; } }, setIv: (f) => { ivs.set(++nid, f); return nid; }, clearIv: (id) => ivs.delete(id) };
  let t = 0, expired = 0;
  const sleep = createSleepModel({ now: () => t, isPlaying: () => true, onExpire: () => { expired++; } });
  const d = createSleepDriver(sleep, { env });
  assert.equal(d.running, false); assert.equal(ivs.size, 0);
  sleep.start(5);
  assert.equal(d.running, true); assert.equal(ivs.size, 1); assert.ok(listeners.visibilitychange);
  t = 299_000; [...ivs.values()][0]();                    // a timer tick while hidden: nothing yet
  assert.equal(expired, 0);
  t = 301_000; listeners.visibilitychange();             // coming back after a throttled sleep: expires at once
  assert.equal(expired, 1); assert.equal(d.running, false); assert.equal(ivs.size, 0); assert.equal(listeners.visibilitychange, undefined);
  d.destroy();
});

// ── notification rationale ──
test('media bridge + rationale: the service starts at once; "Allow" goes on to the OS dialog, once; a re-send follows a grant', async () => {
  const plugin = fakePlugin(); const asked = [];
  plugin.checkPermissions = async () => ({ notifications: 'prompt' });
  plugin.requestNotificationPermission = async () => { plugin.calls.push(['perm']); return { granted: true }; };
  const b = createMediaBridge({ plugin, actions: {}, rationale: async () => { asked.push(1); return true; }, env: { doc: { hidden: false } } });
  await flush(); b.sync(album()); await flush(); await flush();
  assert.deepEqual(plugin.calls.map((c) => c[0]), ['meta', 'state', 'start', 'perm'], 'start first, the question after (never delays the audio)');
  assert.equal(asked.length, 1);
  plugin.calls.length = 0;
  b.sync(album()); await flush();
  assert.deepEqual(plugin.calls.map((c) => c[0]), ['meta', 'state'], 'a grant makes the bridge send the picture again');
  b.sync(album({ title: 'Two' })); b.sync(album({ title: 'Three' })); await flush();
  assert.equal(asked.length, 1, 'asked once');
});

test('media bridge + rationale: "Not now" never reaches the OS dialog; already granted / denied states are not asked about', async () => {
  for (const [state, rat, wantPerm, wantAsk] of [['prompt', false, 0, 1], ['granted', true, 0, 0], ['denied', true, 0, 0]]) {
    const plugin = fakePlugin(); let asked = 0;
    plugin.checkPermissions = async () => ({ notifications: state });
    const b = createMediaBridge({ plugin, actions: {}, rationale: async () => { asked++; return rat; }, env: { doc: { hidden: false } } });
    b.sync(album()); await flush(); await flush();
    assert.equal(plugin.calls.filter((c) => c[0] === 'perm').length, wantPerm, state);
    assert.equal(asked, wantAsk, state);
    assert.ok(plugin.calls.some((c) => c[0] === 'start'), 'playback service runs whatever the answer');
  }
});

test('media bridge + rationale: a failing rationale or permission call is tolerated', async () => {
  const plugin = fakePlugin(); plugin.checkPermissions = async () => { throw new Error('x'); };
  const b = createMediaBridge({ plugin, actions: {}, rationale: async () => { throw new Error('ui'); }, env: { doc: { hidden: false } } });
  b.sync(album()); await flush(); await flush();
  assert.ok(plugin.calls.some((c) => c[0] === 'start'));
  assert.ok(!plugin.calls.some((c) => c[0] === 'perm'));
});

// ── seek bar + artwork ──
const pos = (over = {}) => ({ positionSec: 10, durationSec: 200, seekable: true, ...over });

test('native: position is sent on track / state change and on drift only, never every tick; radio (no position) hides the bar', async () => {
  const plugin = fakePlugin(); plugin.setPosition = async (p) => { plugin.calls.push(['pos', p]); };
  let p = pos(); let radio = false;
  const b = createMediaBridge({ plugin, actions: {}, getPosition: () => (radio ? null : p), env: { doc: { hidden: false }, now: () => 0 } });
  const tick = async (src) => { b.sync(src); await flush(); };
  await flush();
  await tick(album());
  assert.deepEqual(plugin.calls.filter((c) => c[0] === 'pos'), [['pos', { positionMs: 10000, durationMs: 200000, seekable: true }]]);
  plugin.calls.length = 0;
  for (let i = 0; i < 5; i++) await tick(album());
  assert.equal(plugin.calls.filter((c) => c[0] === 'pos').length, 0, 'unchanged: nothing sent');
  p = pos({ positionSec: 90 }); await tick(album());                       // a jump (scrub / seek) beyond the extrapolation
  assert.equal(plugin.calls.filter((c) => c[0] === 'pos').length, 1);
  plugin.calls.length = 0;
  await tick(album({ playing: false }));                                    // pause: the OS must freeze the bar
  assert.equal(plugin.calls.filter((c) => c[0] === 'pos').length, 1);
  plugin.calls.length = 0;
  radio = true; await tick(album()); await tick(album());
  assert.deepEqual(plugin.calls.filter((c) => c[0] === 'pos'), [['pos', { positionMs: -1, durationMs: 0, seekable: false }]], 'once');
});

test('native: the seek event moves an ALBUM; radio / tapes ignore it; the playhead is resent afterwards', async () => {
  const plugin = fakePlugin(); plugin.setPosition = async (p) => { plugin.calls.push(['pos', p]); };
  const seeks = [];
  const b = createMediaBridge({ plugin, actions: { seek: (s, t) => seeks.push([s, t]) }, getPosition: () => pos(), env: { doc: { hidden: false }, now: () => 0 } });
  await flush(); b.sync(album()); await flush();
  plugin.ls.seek({ positionMs: 61500 }); await flush();
  assert.deepEqual(seeks, [['album', 61.5]]);
  plugin.calls.length = 0; b.sync(album()); await flush();
  assert.equal(plugin.calls.filter((c) => c[0] === 'pos').length, 1, 'resent after a seek');
  plugin.ls.seek({ positionMs: NaN }); plugin.ls.seek({}); await flush(); assert.equal(seeks.length, 1, 'junk ignored');
  const b2 = createMediaBridge({ plugin: fakePlugin(), actions: { seek: (s, t) => seeks.push([s, t]) }, env: { doc: { hidden: false } } });
  b2.sync({ mixtape: { title: 'T', sub: 's', playing: true } }); b2.handlers.seek(5); assert.equal(seeks.length, 1, 'a tape has no seek');
});

test('web: mediaSession gets setPositionState and a seekto handler that seeks an album', () => {
  const handlers = {}; const states = [];
  const ms = { metadata: null, playbackState: 'none', setActionHandler: (a, f) => { handlers[a] = f; }, setPositionState: (s) => states.push(s) };
  const seeks = [];
  const b = createMediaBridge({ plugin: null, actions: { seek: (s, t) => seeks.push([s, t]) }, getPosition: () => pos({ positionSec: 30 }), env: { doc: { hidden: false }, nav: { mediaSession: ms }, now: () => 0, MediaMetadata: class { constructor(m) { Object.assign(this, m); } } } });
  b.sync(album());
  assert.deepEqual(states, [{ duration: 200, playbackRate: 1, position: 30 }]);
  handlers.seekto({ seekTime: 75 }); assert.deepEqual(seeks, [['album', 75]]);
  handlers.seekforward({ seekOffset: 15 }); assert.deepEqual(seeks.at(-1), ['album', 45]);
  handlers.seekbackward({}); assert.deepEqual(seeks.at(-1), ['album', 20]);
  handlers.seekto({}); assert.equal(seeks.length, 3);
});

test('artwork: native gets base64 once converted (resent on arrival, attached at once for the same album); the web mediaSession gets the url', async () => {
  const plugin = fakePlugin(); let resolveArt;
  const cache = new Map();
  const artwork = { peek: (u) => cache.get(u), get: (u) => new Promise((r) => { resolveArt = () => { cache.set(u, 'QUJD'); r('QUJD'); }; }) };
  let meta = { artist: 'A', album: 'B', artworkUrl: 'blob:cover1' };
  const b = createMediaBridge({ plugin, actions: {}, getMeta: () => meta, artwork, env: { doc: { hidden: false } } });
  await flush(); b.sync(album()); await flush();
  const first = plugin.calls.find((c) => c[0] === 'meta')[1];
  assert.equal(first.artwork, undefined, 'not converted yet: text first');
  resolveArt(); await flush();
  plugin.calls.length = 0; b.sync(album()); await flush();
  assert.equal(plugin.calls.find((c) => c[0] === 'meta')[1].artwork, 'QUJD', 'resent with the art once it exists');
  plugin.calls.length = 0; b.sync(album({ title: 'Next song' })); await flush();
  assert.equal(plugin.calls.find((c) => c[0] === 'meta')[1].artwork, 'QUJD', 'the next track of the same album carries it straight away');
  meta = { artist: 'A', album: 'B', artworkUrl: '' }; plugin.calls.length = 0; b.sync(album({ title: 'Third' })); await flush();
  assert.equal(plugin.calls.find((c) => c[0] === 'meta')[1].artwork, undefined, 'no cover: no stale art');
  // web
  const ms = { metadata: null, playbackState: 'none', setActionHandler() {} };
  const w = createMediaBridge({ plugin: null, actions: {}, getMeta: () => ({ artist: 'A', album: 'B', artworkUrl: 'blob:cover1' }), env: { doc: { hidden: false }, nav: { mediaSession: ms }, MediaMetadata: class { constructor(m) { Object.assign(this, m); } } } });
  w.sync(album());
  assert.deepEqual(ms.metadata.artwork, [{ src: 'blob:cover1', sizes: '512x512' }]);
});
