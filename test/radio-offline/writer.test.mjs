import test from 'node:test';
import assert from 'node:assert/strict';
import { BANK, BANK_LINE_COUNT, KINDS } from '../../src/radio/offline/bank.js';
import { createTemplateWriter, ENTRY_META, SLOTS, estimateScriptSec } from '../../src/radio/offline/writer.js';
import { createOfflineContext, makeTrackFact, HOSTS } from '../../src/radio/offline/context.js';
import { speakable } from '../../src/radio/offline/pronounce.js';
import { emptyHistory, recordPlay } from '../../src/radio/offline/play-history.js';
import { validateScript } from '../../src/radio/core/schemas.js';
import { verifyScript, writerFacts } from '../../src/radio/core/grounding.js';
import { stripMarkup, templateResolver } from '../../src/radio/core/markup.js';
import { fakeLibrary } from './helpers.mjs';

const T = (iso) => Date.parse(iso);
const LOC = { lat: 47.6, lon: -122.3 };

async function snapshotAt(iso, { loc = LOC, tracks = [...fakeLibrary(30), { id: 'long1', title: 'The Long One', artist: 'June Parlor', album: 'Album Z', genre: 'Ambient', durationSec: 640, file: { lastModified: 1 } }], history } = {}) {
  let h = history;
  if (!h) { h = emptyHistory(); for (let i = 0; i < 5; i++) h = recordPlay(h, tracks[2].id, 1000 + i); for (let i = 0; i < 8; i++) h = recordPlay(h, tracks[3 + (i % 3)].id, 2000 + i); }
  const ctx = createOfflineContext({ getTracks: () => tracks, getHistory: () => h, getLocation: () => loc, utcOffsetMin: -480 });
  const s = await ctx.getSnapshot({ nowMs: T(iso) });
  return s;
}
const withTracks = (snap, prev, next) => {
  const extra = [];
  if (prev) extra.push(makeTrackFact('prev', prev, snap.takenAt));
  if (next) extra.push(makeTrackFact('next', next, snap.takenAt, { energy: next.__energy ?? null }));
  return { ...snap, facts: [...snap.facts, ...extra] };
};
const factsFor = (snap, atMs) => writerFacts(snap, snap.facts.map((f) => f.id), atMs);
const slotOf = (kind, purpose, id = 's1', budget = 30) => ({ slotId: id, kind, targetSec: 40, talk: { budgetSec: budget, purpose, factIds: [] } });

test('the bank is large, well-formed and covers every kind', () => {
  assert.ok(BANK_LINE_COUNT >= 150, `only ${BANK_LINE_COUNT} lines`);
  assert.equal(new Set(BANK.map((e) => e.id)).size, BANK.length, 'ids unique');
  for (const k of KINDS) assert.ok(BANK.filter((e) => e.kind === k).length >= 5, `kind ${k}`);
  for (const e of BANK) { assert.ok(ENTRY_META.get(e.id), e.id); assert.ok(e.emotion && Number.isFinite(e.energy) && Number.isFinite(e.pace)); assert.ok(e.pace >= 0.8 && e.pace <= 1.25); }
  // owner defaults: warm and wry, inoffensive, no artist trivia beyond metadata
  const text = BANK.map((e) => (e.lines ? e.lines.map((l) => l.text).join(' ') : e.text)).join('\n').toLowerCase();
  for (const bad of ['damn', 'hell', 'crap', 'sex', 'drunk', 'kill', 'die', 'hate', 'stupid', 'idiot', 'shut up', 'fuck', 'shit', 'born in', 'grew up', 'released in', 'recorded in', 'grammy', 'billboard', 'weather', 'traffic', 'rain', 'forecast']) assert.doesNotMatch(text, new RegExp(`\\b${bad}\\b`), `bank contains "${bad}"`);
  assert.ok(BANK.filter((e) => e.kind === 'sign_on').every((e) => /automated|computer-voiced/.test(e.text)), 'every sign-on discloses the automated host');
  assert.ok(BANK.filter((e) => e.emotion === 'wry' || e.emotion === 'deadpan').length >= 30, 'wry tone');
});

test('every template renders, validates, and passes the grounding verifier with the facts it declares', async () => {
  const snaps = [await snapshotAt('2026-12-25T18:05:00Z'), await snapshotAt('2026-12-25T18:05:00Z', { history: emptyHistory() }), await snapshotAt('2026-06-21T10:00:00Z', { loc: { lat: 78.2, lon: 15.6 } })]; // returning listener / first time / midnight sun
  const tracks = fakeLibrary(30);
  const atMs = T('2026-12-25T18:05:00Z');
  let n = 0;
  for (const e of BANK) {
    let exercised = false;
    for (const snap of snaps) {
      const atMs = Date.parse(snap.takenAt);
      const w = createTemplateWriter({ seed: 9, bank: [e, ...BANK.filter((x) => x.kind === 'filler').slice(0, 1)] });
      const kind = e.kind;
      const slot = kind === 'sign_on' || kind === 'sign_off' || kind === 'station_id' ? { slotId: 's', kind, targetSec: 20, talk: { budgetSec: 20, purpose: kind, factIds: [] } } : kind === 'song_intro' ? slotOf('talk_over_intro', 'intro') : kind === 'back_sell' ? slotOf('back_sell', 'back_sell', 's', 20) : slotOf('talk_break', { time_check: 'time', trivia: 'trivia', you_moment: 'you', sun: 'sun', holiday: 'holiday', banter: 'banter', filler: 'chat' }[kind]);
      const tone = e.tone === 'low' ? 0.2 : e.tone === 'high' ? 0.9 : null;
      const f2 = withTracks(snap, tracks[0], tracks[1]);
      f2.facts = f2.facts.map((f) => (f.id === 'trk.next' ? { ...f, value: { ...f.value, energy: tone } } : f));
      const script = await w.write({ slot, facts: factsFor(f2, atMs), persona: f2.memory.persona, brief: { daypart: (e.parts && e.parts[0]) || 'evening' } });
      assert.deepEqual(validateScript(script), { ok: true, errors: [] }, e.id);
      const text = script.utterances.map((u) => u.text).join(' | ');
      assert.doesNotMatch(text, /\[[A-Za-z_]+\]/, `unresolved slot in ${e.id}: ${text}`);
      assert.doesNotMatch(text, /\{[^{}]*\|[^{}]*\}/, `unexpanded choice in ${e.id}`);
      const v = verifyScript(script, f2, { atMs });
      assert.equal(v.ok, true, `${e.id} ${JSON.stringify(v.problems)} :: ${text}`);
      if (w.usedIds().includes(e.id)) exercised = true;
    }
    assert.ok(exercised, `${e.id} was never selectable with the full fact set (dead line?)`);
    n++;
  }
  assert.equal(n, BANK.length);
});

test('every fact-slot is backed by a factRef: stripping the refs makes the verifier object', async () => {
  const snap = await snapshotAt('2026-12-25T18:05:00Z');
  const tracks = fakeLibrary(30);
  const full = withTracks(snap, tracks[0], tracks[1]);
  const atMs = T('2026-12-25T18:05:00Z');
  let withFacts = 0;
  for (const e of BANK) {
    const need = ENTRY_META.get(e.id).names.flatMap((n) => SLOTS[n].facts);
    const w = createTemplateWriter({ seed: 4, bank: [e, BANK.find((x) => x.kind === 'filler')] });
    const kind = e.kind;
    const slot = ['sign_on', 'sign_off', 'station_id'].includes(kind) ? { slotId: 's', kind, targetSec: 20, talk: { budgetSec: 20, purpose: kind } } : kind === 'song_intro' ? slotOf('talk_over_intro', 'intro') : kind === 'back_sell' ? slotOf('back_sell', 'back_sell', 's', 20) : slotOf('talk_break', { time_check: 'time', trivia: 'trivia', you_moment: 'you', sun: 'sun', holiday: 'holiday', banter: 'banter', filler: 'chat' }[kind]);
    const tone = e.tone === 'low' ? 0.2 : e.tone === 'high' ? 0.9 : null;
    const f2 = { ...full, facts: full.facts.map((f) => (f.id === 'trk.next' ? { ...f, value: { ...f.value, energy: tone } } : f)) };
    const script = await w.write({ slot, facts: factsFor(f2, atMs), persona: f2.memory.persona, brief: { daypart: (e.parts && e.parts[0]) || 'evening' } });
    const usedRefs = new Set(script.utterances.flatMap((u) => u.factRefs));
    if (!w.usedIds().includes(e.id)) continue; // not selectable in this fact set (covered by the previous test)
    for (const id of new Set(need)) assert.ok(usedRefs.has(id), `${e.id} reads ${id} but does not cite it`);
    const CHECKABLE = ['lib.counts', 'lib.recent', 'lib.longest', 'lib.artist', 'hist.top', 'hist.total', 'trk.next', 'trk.prev', 'holiday.today', 'sun.rise', 'sun.set', 'sun.polar'];
    if (need.some((id) => CHECKABLE.includes(id)) && !e.lines) { // lowercase-only facts (genre, season) and weekdays are not checkable by the verifier
      withFacts++;
      const stripped = { ...script, utterances: script.utterances.map((u) => ({ ...u, factRefs: [] })) };
      assert.equal(verifyScript(stripped, f2, { atMs }).ok, false, `${e.id}: claims are not tied to factRefs`);
    }
  }
  assert.ok(withFacts >= 60, `only ${withFacts} fact-bearing templates exercised`);
});

test('verifier passes over thousands of seeded scripts across moods, dayparts, facts and hostile track names', async () => {
  const HOSTILE = [
    { title: 'Purple Rain', artist: 'Prince Cover Band' }, { title: 'Stormy Weather', artist: 'The Delays' }, { title: 'Call 555 010 9999', artist: 'Phone Home' },
    { title: 'Track 03', artist: 'Unknown Artist' }, { title: '01 - Heat_Wave [Remastered 2011].mp3', artist: 'Martha' }, { title: 'Sunset Boulevard', artist: 'Golden Hour Trio' },
    { title: 'Traffic Jam', artist: 'The Commuters' }, { title: '99 Problems', artist: 'Jay & Co.' }, { title: '1999', artist: 'The Nineteens' }, { title: 'Ünïcödé Ñoño', artist: 'Björk-ish' },
    { title: 'a'.repeat(200), artist: 'z'.repeat(200) }, { title: 'feat. & + % # @', artist: '??' }, { title: 'Twenty One Pilots Song', artist: 'Seven Nation' }, { title: 'x', artist: 'y' }, { title: 'Ольга', artist: '東京' }, { title: 'Björk Medley', artist: 'Sigur Rós' },
    { title: 'Dawn Chorus', artist: 'Morning Birds' }, { title: 'www.example.com', artist: 'me@example.com' }, { title: '40.7128, -74.0060', artist: 'Coordinates' }, { title: '123 Main Street', artist: 'Address Band' },
  ];
  const scenarios = [
    ['2026-11-04T18:05:00Z', LOC], ['2026-12-25T03:00:00Z', LOC], ['2026-06-21T10:00:00Z', { lat: 78.2, lon: 15.6 }], ['2026-10-31T05:00:00Z', null], ['2026-01-01T08:30:00Z', null], ['2026-03-10T21:59:59Z', { lat: -33.9, lon: 151.2 }],
  ];
  const dayparts = ['early_morning', 'morning', 'midday', 'afternoon', 'evening', 'late_night'];
  const specs = [
    ['sign_on', 'sign_on'], ['station_id', 'station_id'], ['sign_off', 'sign_off'], ['talk_over_intro', 'intro'], ['back_sell', 'back_sell'],
    ['talk_break', 'time'], ['talk_break', 'trivia'], ['talk_break', 'you'], ['talk_break', 'sun'], ['talk_break', 'holiday'], ['talk_break', 'banter'], ['talk_break', 'chat'], ['talk_break', 'weird'],
  ];
  let count = 0, canned = 0;
  for (const [si, [iso, loc]] of scenarios.entries()) {
    const tracks = [...fakeLibrary(25), ...HOSTILE.map((h, i) => ({ id: `h${i}`, ...h, album: i % 3 ? `Album ${i}` : 'Unknown Album', genre: i % 2 ? 'Rock' : '', durationSec: 200, file: { lastModified: 1 + i } }))];
    const snap0 = await snapshotAt(iso, { loc, tracks });
    const atMs = T(iso);
    for (let k = 0; k < 8; k++) {
      const w = createTemplateWriter({ seed: si * 100 + k });
      for (let i = 0; i < 60; i++) {
        const [kind, purpose] = specs[(i + k) % specs.length];
        const prev = tracks[(i * 7 + k) % tracks.length], next = tracks[(i * 11 + 3) % tracks.length];
        const snap = withTracks(snap0, i % 5 === 0 ? null : prev, i % 7 === 0 ? null : { ...next, __energy: [null, 0.2, 0.9, 0.5][i % 4] });
        snap.facts = snap.facts.map((f) => (f.id === 'trk.next' ? { ...f, value: { ...f.value, energy: [null, 0.2, 0.9, 0.5][i % 4] } } : f));
        const slot = { slotId: `s${i}`, kind, targetSec: 40, talk: { budgetSec: [6, 10, 20, 30, 40][i % 5], purpose, factIds: [] } };
        const script = await w.write({ slot, facts: factsFor(snap, atMs), persona: snap.memory.persona, brief: { daypart: dayparts[(i + si) % 6] } });
        assert.deepEqual(validateScript(script), { ok: true, errors: [] });
        const v = verifyScript(script, snap, { atMs });
        if (!v.ok) assert.fail(`scenario ${si} seed ${k} i ${i} (${kind}/${purpose}): ${JSON.stringify(v.problems)} :: ${script.utterances.map((u) => u.text).join(' | ')}`);
        count++;
      }
    }
  }
  assert.ok(count >= 2800, `only ${count} scripts`);
});

test('anti-repeat: within a session no line returns until its kind is spent, then only the older half', async () => {
  const snap = await snapshotAt('2026-12-25T18:05:00Z');
  const atMs = T('2026-12-25T18:05:00Z');
  const facts = factsFor(snap, atMs);
  const w = createTemplateWriter({ seed: 77 });
  const kindOf = new Map(BANK.map((e) => [e.id, e.kind]));
  const seqs = new Map();
  for (let i = 0; i < 300; i++) {
    const s = await w.write({ slot: slotOf('talk_break', 'trivia', `s${i}`, 14), facts, persona: snap.memory.persona, brief: { daypart: 'evening' } });
    assert.ok(s.utterances.length >= 1);
  }
  const used = w.usedIds();
  for (const id of used) { const k = kindOf.get(id); if (!seqs.has(k)) seqs.set(k, []); seqs.get(k).push(id); }
  assert.ok(seqs.get('trivia').length > 100);
  for (const [k, seq] of seqs) {
    const pool = new Set(seq).size;
    const spacing = Math.max(1, Math.floor(pool / 2) - 1);
    for (let i = 0; i < seq.length; i++) {
      const j = seq.lastIndexOf(seq[i], i - 1);
      if (i > 0 && j >= 0) assert.ok(i - j > Math.min(spacing, pool - 1) || pool <= 2, `${k}: ${seq[i]} repeated after only ${i - j} (pool ${pool})`);
    }
    // the first `pool` picks are all distinct (nothing repeats before the kind is exhausted)
    assert.equal(new Set(seq.slice(0, pool)).size, Math.min(pool, seq.length), `${k} repeated before exhaustion`);
  }
});

test('anti-repeat across shows: ids from recent shows are de-preferred', async () => {
  const snap = await snapshotAt('2026-12-25T18:05:00Z');
  const atMs = T('2026-12-25T18:05:00Z');
  const facts = factsFor(snap, atMs);
  const a = createTemplateWriter({ seed: 1 });
  for (let i = 0; i < 6; i++) await a.write({ slot: slotOf('talk_break', 'trivia', `a${i}`, 14), facts, persona: snap.memory.persona });
  const recent = a.usedIds();
  const trivia = recent.filter((id) => id.startsWith('trivia.'));
  const b = createTemplateWriter({ seed: 1, recentIds: () => recent });
  const c = createTemplateWriter({ seed: 1 });
  let hitsB = 0, hitsC = 0;
  for (let i = 0; i < 6; i++) {
    await b.write({ slot: slotOf('talk_break', 'trivia', `a${i}`, 14), facts, persona: snap.memory.persona });
    await c.write({ slot: slotOf('talk_break', 'trivia', `a${i}`, 14), facts, persona: snap.memory.persona });
  }
  hitsB = b.usedIds().filter((id) => trivia.includes(id)).length; hitsC = c.usedIds().filter((id) => trivia.includes(id)).length;
  assert.ok(hitsB < hitsC, `recent-show memory had no effect (${hitsB} vs ${hitsC})`);
});

test('determinism: same seed and call sequence give identical scripts; different seeds differ', async () => {
  const snap = await snapshotAt('2026-11-04T18:05:00Z');
  const atMs = T('2026-11-04T18:05:00Z');
  const facts = factsFor(withTracks(snap, fakeLibrary(3)[0], fakeLibrary(3)[1]), atMs);
  const run = async (seed) => {
    const w = createTemplateWriter({ seed });
    const out = [];
    for (let i = 0; i < 30; i++) out.push(await w.write({ slot: slotOf(i % 3 ? 'talk_break' : 'talk_over_intro', i % 3 ? ['trivia', 'time', 'banter'][i % 3] : 'intro', `d${i}`), facts, persona: snap.memory.persona, brief: { daypart: 'evening' } }));
    return JSON.stringify(out);
  };
  assert.equal(await run(5), await run(5));
  assert.notEqual(await run(5), await run(6));
});

test('output hygiene: speakable text has no digits or braces, hosts alternate, pauses and styles are valid', async () => {
  const snap = await snapshotAt('2026-12-25T18:05:00Z');
  const atMs = T('2026-12-25T18:05:00Z');
  const tracks = fakeLibrary(30);
  const facts = factsFor(withTracks(snap, tracks[0], tracks[1]), atMs);
  const w = createTemplateWriter({ seed: 3 });
  const parts = { hour: 18, minute: 5, daypart: 'evening', weekday: 'Friday', month: 12, day: 25 };
  const resolve = templateResolver(parts);
  const speakers = new Set();
  for (let i = 0; i < 120; i++) {
    const kind = ['talk_break', 'back_sell', 'talk_over_intro', 'sign_on'][i % 4];
    const s = await w.write({ slot: slotOf(kind, ['trivia', 'time', 'sun', 'you', 'banter'][i % 5], `h${i}`, 30), facts, persona: snap.memory.persona, brief: { daypart: 'evening' } });
    for (const u of s.utterances) {
      speakers.add(u.speaker);
      const plain = stripMarkup(u.text, { templates: resolve });
      assert.doesNotMatch(speakable(plain), /[\d{}\[\]<>]/, `speech text: ${plain}`);
      assert.ok(u.style.pace >= 0.8 && u.style.pace <= 1.25 && u.style.energy >= 0 && u.style.energy <= 1);
      assert.ok(u.pauseAfterMs >= 0 && u.pauseAfterMs <= 2000);
      assert.ok(u.text.length <= 400);
    }
  }
  assert.deepEqual([...speakers].sort(), ['a', 'b']);
});

test('time-of-day words are late-bound tokens, never baked in: the same script is right at any air time', async () => {
  const snap = await snapshotAt('2026-11-04T18:05:00Z');
  const w = createTemplateWriter({ seed: 8, bank: BANK.filter((e) => e.kind === 'time_check') });
  const facts = factsFor(snap, T('2026-11-04T18:05:00Z'));
  const s = await w.write({ slot: slotOf('talk_break', 'time', 't', 10), facts, persona: snap.memory.persona });
  const u = s.utterances.find((x) => x.templates && x.templates.length);
  assert.ok(u, 'a time check uses tokens');
  assert.match(u.text, /\{\{(time\.spoken|time\.daypart|date\.spoken)\}\}/);
  const a = stripMarkup(u.text, { templates: templateResolver({ hour: 7, minute: 45, daypart: 'morning', weekday: 'Monday', month: 1, day: 5 }) });
  const b = stripMarkup(u.text, { templates: templateResolver({ hour: 21, minute: 0, daypart: 'evening', weekday: 'Monday', month: 1, day: 5 }) });
  assert.notEqual(a, b);
});

test('unsafe names switch to nameless lines instead of risking a claim; no facts at all still produces a valid line', async () => {
  const tracks = [{ id: 'p', title: 'Purple Rain', artist: 'Unknown Artist', album: '', file: {} }, { id: 'q', title: 'Track 05', artist: 'Mara Quill', file: {} }];
  const snap0 = await snapshotAt('2026-11-04T18:05:00Z', { tracks: [...fakeLibrary(10), ...tracks] });
  const atMs = T('2026-11-04T18:05:00Z');
  const snap = withTracks(snap0, tracks[1], tracks[0]);
  const w = createTemplateWriter({ seed: 2 });
  for (let i = 0; i < 25; i++) {
    const s = await w.write({ slot: slotOf('talk_over_intro', 'intro', `u${i}`, 10), facts: factsFor(snap, atMs), persona: snap.memory.persona });
    assert.doesNotMatch(s.utterances.map((u) => u.text).join(' '), /Purple|Rain/);
    assert.equal(verifyScript(s, snap, { atMs }).ok, true);
  }
  const bare = createTemplateWriter({ seed: 1 });
  const s = await bare.write({ slot: { slotId: 'z', kind: 'talk_break', targetSec: 30, talk: {} }, facts: [], persona: {} });
  assert.deepEqual(validateScript(s), { ok: true, errors: [] });
  const bad = await bare.write({ slot: { slotId: 'y', kind: 'weather_hit', targetSec: 30, talk: { purpose: 'weather', budgetSec: 30 } }, facts: [], persona: {} });
  assert.equal(verifyScript(bad, snap0, { atMs }).ok, true, 'a weather slot with no facts never talks weather');
});

test('scripts fit their slot budget (talk-over-intro lines are short)', async () => {
  const snap = await snapshotAt('2026-11-04T18:05:00Z');
  const atMs = T('2026-11-04T18:05:00Z');
  const tracks = fakeLibrary(10);
  const facts = factsFor(withTracks(snap, tracks[0], tracks[1]), atMs);
  const w = createTemplateWriter({ seed: 6 });
  for (let i = 0; i < 80; i++) {
    const s = await w.write({ slot: slotOf('talk_over_intro', 'intro', `o${i}`, 10), facts, persona: snap.memory.persona });
    assert.ok(estimateScriptSec(s) <= 10 * 1.4, `${estimateScriptSec(s)}s: ${s.utterances.map((u) => u.text).join(' ')}`);
    const b = await w.write({ slot: slotOf('talk_break', ['time', 'trivia', 'banter', 'you'][i % 4], `b${i}`, 30), facts, persona: snap.memory.persona, brief: { daypart: 'evening' } });
    assert.ok(estimateScriptSec(b) <= 30 * 1.35, `${estimateScriptSec(b)}s: ${b.utterances.map((u) => u.text).join(' ')}`);
  }
});

test('hosts are the persona names and sign-on always says it is an automated host', async () => {
  assert.deepEqual(HOSTS, { a: 'Casey', b: 'Jo' });
  const snap = await snapshotAt('2026-11-04T18:05:00Z');
  const atMs = T('2026-11-04T18:05:00Z');
  for (let seed = 0; seed < 40; seed++) {
    const w = createTemplateWriter({ seed });
    const s = await w.write({ slot: { slotId: 'on', kind: 'sign_on', targetSec: 20, talk: { budgetSec: 14, purpose: 'sign_on', factIds: [] } }, facts: factsFor(snap, atMs), persona: snap.memory.persona, brief: { daypart: 'evening' } });
    assert.match(s.utterances.map((u) => u.text).join(' '), /automated host|computer-voiced/i);
  }
});
