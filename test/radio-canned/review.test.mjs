import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewPack, summarize, renderMarkdown, loadStoplist, CHECKS, CLOCK_MINIMUMS } from '../../scripts/review-content.mjs';
import { STATION_IDS } from '../support/canned-sim.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stop = loadStoplist();
const raw = (id) => JSON.parse(readFileSync(resolve(root, 'content/stations', `${id}.json`), 'utf8'));

const seg = (id, kind, host, text, o = {}) => ({ id, kind, hosts: [host], lines: [{ host, text }], estSec: Math.max(2, Math.round(text.split(/\s+/).length / 2.6)), tags: [], usesSlots: [], fallbackOf: null, weight: 1, ...o });
const mini = (segments, daypart = ['any']) => ({ v: 1, station: { id: 't', name: 'Test FM', tagline: 't', dial: '99.9', vibe: 'v', daypart, contentRating: 'PG-13', hosts: [
  { id: 'a', name: 'Alex', role: 'host', persona: 'p', voice: { genderHint: 'male', ageHint: 'adult', accent: 'neutral-US', style: 's', rate: 1, pitch: 1 } },
  { id: 'b', name: 'Bea', role: 'co-host', persona: 'p', voice: { genderHint: 'female', ageHint: 'adult', accent: 'neutral-US', style: 's', rate: 1, pitch: 1 } }] }, segments });

test('the stoplist is a flagged seed with the sections the review reads, and carries no real station names', () => {
  assert.equal(stop.seed, true); assert.match(stop._doc, /SEED/);
  for (const k of ['brandSuffixPatterns', 'brands', 'realProductCategoriesForAds', 'gameRadioTells', 'profanityStrong', 'realCities', 'songAdjacentClaimWords']) assert.ok(Array.isArray(stop[k]) && stop[k].length, k);
  for (const p of stop.brandSuffixPatterns) assert.doesNotThrow(() => new RegExp(p, 'u'));
});

test('each mechanical check fires on a synthetic pack built to trip it', () => {
  const doc = mini([
    seg('s1', 'sign_on', 'a', 'Good morning, it is tonight at 9 o\'clock on Monday in London.'),
    seg('s2', 'banter', 'a', 'You know what, the weather today is bad.', { weight: 100 }),
    seg('s3', 'banter', 'a', 'You know what, traffic is breaking news right now.'),
    seg('s4', 'banter', 'a', 'You know what, Acme Widgets Inc is great.'),
    seg('s5', 'banter', 'a', 'You know what, shit happens.'),
    seg('s6', 'banter', 'a', 'You know what, Bea is stuck in traffic.'),
    seg('s7', 'ad', 'b', 'Try the new smartphone from Google, the best phone.'),
    seg('s8', 'callin', 'a', 'A caller rings in.'),
    seg('s9', 'transition', 'a', 'That was {prevTitle}, a classic. Next, {nextTitle}.', { usesSlots: ['prevTitle', 'nextTitle'] }),
    seg('s10', 'liner', 'a', 'Call us at KQXZ-FM.'),
  ]);
  const r = reviewPack(doc, stop);
  const has = (check, re) => r.findings[check].some((f) => re.test(`${f.note} ${f.text || ''}`));
  assert.ok(has('weight', /weight 100/), 'weight');
  assert.ok(has('repeat', /first word "you"|"You know what/), 'repeat');
  for (const re of [/digits/, /tonight|today/, /weekday/, /traffic/, /news/, /breaking/, /right now/, /real city "london"/]) assert.ok(has('fact', re), String(re));
  assert.ok(has('leak', /brand-suffix pattern "Inc"/), 'suffix'); assert.ok(has('leak', /stoplist brand "google"/), 'brand');
  assert.ok(has('leak', /real product category in an ad: "smartphone"/), 'category'); assert.ok(has('leak', /call sign/), 'call sign');
  assert.ok(has('pg13', /strong word "shit"/), 'pg13');
  assert.ok(has('flat', /no "flatDevice"/), 'flat');
  assert.ok(has('clock', /below the minimum.*station_id/), 'clock');
  assert.ok(has('callin', /without tag "bit"/), 'callin bit');
  assert.ok(has('ad', /product:/), 'ad list');
  assert.ok(has('daypart', /sign_on.*\[any\]/), 'daypart on a pack that plays any time');
  assert.ok(has('songclaim', /"classic"/), 'song claim');
  assert.ok(has('absence', /late|stuck/), 'absence');
  // a single-daypart pack may say "good morning" in its sign-on
  const single = reviewPack(mini([seg('s1', 'sign_on', 'a', 'Good morning, everyone.')], ['morning']), stop);
  assert.equal(single.findings.daypart.filter((f) => f.kind === 'sign_on').length, 0);
  // listed hosts only, bit tag accepted
  const bit = reviewPack(mini([{ ...seg('c', 'callin', 'a', 'Hello caller.'), tags: ['bit'] }]), stop);
  assert.equal(bit.findings.callin.length, 0);
  assert.equal(CLOCK_MINIMUMS.station_id, 6);
});

test('the review runs on all six real packs, reports without failing (exit 0), and the findings document covers every pack and check', () => {
  const run = spawnSync(process.execPath, ['scripts/review-content.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  for (const id of STATION_IDS) assert.match(run.stdout, new RegExp(`${id}: weight=`));
  assert.match(run.stdout, /report only/);
  const results = STATION_IDS.map((id) => reviewPack(raw(id), stop));
  const md = renderMarkdown(results);
  for (const id of STATION_IDS) for (const [, title] of CHECKS) assert.match(md, new RegExp(`### ${id}: ${title.replace(/[()]/g, '\\$&')} \\(\\d+\\)`));
  for (const r of results) assert.ok(Object.values(summarize(r)).every((n) => Number.isInteger(n)));
  // the committed document exists and is about these packs; renames are listed as owner decisions, not applied
  const doc = readFileSync(resolve(root, 'docs/CANNED_REVIEW_FINDINGS.md'), 'utf8');
  for (const id of STATION_IDS) assert.ok(doc.includes(`\`${id}\``));
  assert.match(doc, /Owner decisions \(not applied\)/);
  assert.match(doc, /Carrier Wave/); assert.match(doc, /Slow Current/); assert.match(doc, /Kilohertz/);
  // and nothing was renamed
  assert.deepEqual(STATION_IDS.map((id) => raw(id).station.name), ['Static City 98.1', 'Kilo-Hertz Rock 102.7', 'Meridian 91.5', 'Tape Hiss FM', 'Sunbelt Soul 1060 AM', 'Pirate 1400']);
  // --strict exists for people, never for CI: it exits 1 because there ARE findings
  assert.equal(spawnSync(process.execPath, ['scripts/review-content.mjs', '--strict'], { cwd: root, encoding: 'utf8' }).status, 1);
});

test('review findings are deterministic', () => {
  const a = renderMarkdown(STATION_IDS.map((id) => reviewPack(raw(id), stop)));
  const b = renderMarkdown(STATION_IDS.map((id) => reviewPack(raw(id), stop)));
  assert.equal(a, b);
  assert.ok(existsSync(resolve(root, 'content/stations/_stoplist.json')));
});
