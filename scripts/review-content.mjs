#!/usr/bin/env node
// review-content.mjs — the MECHANICAL part of the canned-station quality pass (canned-review.md sections 1 and 2).
//
// REPORT ONLY. It never rewrites prose and never fails CI: it exits 0 whatever it finds (unless --strict). The pass/fail
// contract for the packs stays in scripts/check-content.mjs. Judgement calls (is this ad plausible, is it boring, can a
// reviewer tell the hosts apart) cannot be automated: the findings list the lines so a human can read them.
//
// Usage:
//   node scripts/review-content.mjs                         print the findings for every pack in content/stations
//   node scripts/review-content.mjs --md docs/CANNED_REVIEW_FINDINGS.md   also write the findings document
//   node scripts/review-content.mjs --strict                exit 1 if any finding exists (never used by CI)
//   node scripts/review-content.mjs file.json ...           review specific packs
//
// Checks (numbers are canned-review.md sections):
//   1.2 weight       no single banter/liner carries > 20% of its kind's weight
//   1.3 repeat       a host's first (or last) word starts/ends > 15% of their segments; stock sentence shapes
//   1.4 fact         digits, degrees, today/tonight/this morning/right now, weekdays, months, traffic, news, breaking, real cities
//   1.5 leak         stoplist brands, brand suffixes (Inc, Co., TM), call-sign-shaped words, real product categories in ads, game-radio tells
//   1.6 pg13         profanity (strong = finding, mild = noted)
//   1.7 flat         hosts without a flatDevice; per-host opener variety (the human test is still needed)
//   1.8 clock        minimum counts per kind for a 3-hour show without a banter repeating
//   2.1 callin       every callin carries tag `bit` and is voiced by listed hosts only
//   2.2 ad           every ad's opening line, for the "can you name a real company that sells it" human check
//   2.3 daypart      time-of-day claims in sign_on/sign_off when the pack's daypart is not a single value; time words everywhere else
//   2.4 songclaim    adjectives about music in segments that name the next/previous song
//   2.11 absence     hosts referring to each other's absence in real-time terms
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CLOCK_MINIMUMS = Object.freeze({ station_id: 6, liner: 12, transition: 10, banter: 8, ad: 4, skit: 2, callin: 2, dedication: 3, promo: 2, sign_on: 2, sign_off: 2, news: 1 });
export const CHECKS = Object.freeze([
  ['weight', '1.2 Weight sanity'], ['repeat', '1.3 Repetition scan'], ['fact', '1.4 Fact claims'], ['leak', '1.5 Real-world leakage'], ['pg13', '1.6 PG-13'],
  ['flat', '1.7 Flat-line test (setup)'], ['clock', '1.8 Clock fit'], ['callin', '2.1 Call-in skits'], ['ad', '2.2 Ads (human plausibility check)'],
  ['daypart', '2.3 Time-of-day claims'], ['songclaim', '2.4 Song-adjacent claims'], ['absence', '2.11 Host absence / traffic excuses'],
]);

const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|weekday)s?\b/i;
const MONTHS = /\b(january|february|march|april|june|july|august|september|october|november|december)\b/i; // "may" is too common a word to grep
const FACT_WORDS = [
  ['today', /\btoday\b/i], ['tonight', /\btonight\b/i], ['this morning', /\bthis (?:morning|afternoon|evening)\b/i], ['right now', /\bright now\b/i],
  ['yesterday/tomorrow', /\b(?:yesterday|tomorrow)\b/i], ['weekday', WEEKDAYS], ['month', MONTHS], ['traffic', /\btraffic\b/i],
  ['news', /\bnews\b/i], ['breaking', /\bbreaking\b/i], ['degrees', /\b(?:degrees?|celsius|fahrenheit|forecast|rain(?:ing)? (?:today|tonight))\b/i],
  ['digits', /\d/],
];
const TIME_WORDS = /\b(?:good (?:morning|afternoon|evening|night)|this (?:morning|afternoon|evening)|tonight|morning|afternoon|evening|midnight|dawn|dusk|sunrise|sunset|breakfast|bedtime|late night|after dark|o'clock)\b/i;
const SHAPES = [
  [/^you know what\b/i, '"You know what..."'], [/^here'?s the thing\b/i, '"Here\'s the thing..."'], [/if you'?re just (?:joining|tuning)/i, '"If you\'re just joining us..."'],
  [/^(?:ladies and gentlemen|folks)\b/i, '"Ladies and gentlemen / Folks..."'], [/^(?:welcome back|we'?re back)\b/i, '"Welcome back / We\'re back"'],
  [/^(?:coming up|up next)\b/i, '"Coming up / Up next"'], [/^listen\b/i, '"Listen..."'], [/^(?:okay|ok|alright|all right)\b/i, '"Okay / Alright..."'], [/^(?:well|so)\b[, ]/i, '"Well, / So,"'],
];
const ABSENCE = /\b(?:is|was|'s) (?:late|stuck|missing|running late|not here|away|out sick|still asleep)\b|\bstuck in\b|\bbe back\b|\bisn'?t here\b|\bhasn'?t (?:shown|arrived)\b/i;
const NAMES_SONG = /\{(?:prevTitle|nextTitle|prevArtist|nextArtist)\}|\b(?:this (?:song|track|one|record)|that (?:song|track|one|record)|next (?:song|track|up|one))\b/i;

const words = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'iu');
const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** -> { id, name, counts, findings: { checkId: [{ seg, line?, kind?, text?, note }] } }. Pure. Never throws on a valid pack. */
export function reviewPack(doc, stoplist = {}) {
  const st = doc.station, segs = doc.segments;
  const out = Object.fromEntries(CHECKS.map(([id]) => [id, []]));
  const add = (check, f) => out[check].push(f);
  const hostIds = new Set(st.hosts.map((h) => h.id));
  const hostName = Object.fromEntries(st.hosts.map((h) => [h.id, h.name]));
  const lineList = (s) => s.lines.map((l, i) => ({ s, i, l }));
  const all = segs.flatMap(lineList);
  const slotted = (s) => (s.usesSlots || []).length > 0;

  // 1.2 weight sanity
  for (const kind of ['banter', 'liner']) {
    const ks = segs.filter((s) => s.kind === kind && !s.fallbackOf);
    const total = ks.reduce((a, s) => a + s.weight, 0);
    for (const s of ks) if (total > 0 && s.weight / total > 0.2) add('weight', { seg: s.id, kind, note: `weight ${s.weight} of ${total} (${Math.round((100 * s.weight) / total)}% of ${kind} weight)` });
  }
  const cnt = {};
  for (const s of segs) cnt[s.kind] = (cnt[s.kind] || 0) + 1;

  // 1.3 repetition: first / last word per host (lines spoken by that host, first line of each segment), and stock shapes
  for (const h of st.hosts) {
    const mine = segs.filter((s) => s.lines[0] && s.lines[0].host === h.id && !s.fallbackOf);
    if (mine.length >= 8) {
      for (const [label, pick] of [['first word', (t) => words(t)[0]], ['last word', (t) => words(t).slice(-1)[0]]]) {
        const by = new Map();
        for (const s of mine) { const w = pick(label === 'first word' ? s.lines[0].text : s.lines[s.lines.length - 1].text); if (!w) continue; (by.get(w) || by.set(w, []).get(w)).push(s.id); }
        for (const [w, ids] of by) if (ids.length / mine.length > 0.15 && ids.length >= 3) add('repeat', { seg: ids.join(', '), note: `${h.name} (${h.id}): ${label} "${w}" in ${ids.length} of ${mine.length} segments (${Math.round((100 * ids.length) / mine.length)}%)` });
      }
    }
  }
  for (const [re, label] of SHAPES) {
    const hits = all.filter(({ i, l }) => i === 0 && re.test(l.text));
    const byHost = new Map();
    for (const x of hits) (byHost.get(x.l.host) || byHost.set(x.l.host, []).get(x.l.host)).push(x);
    for (const [hid, xs] of byHost) if (xs.length >= 4) add('repeat', { seg: xs.map((x) => x.s.id).join(', '), note: `${hostName[hid]} opens ${xs.length} segments with the shape ${label}` });
  }

  // 1.4 fact claims (the station's own dial number inside a station_id / jingle / sign_on / sign_off is allowed)
  const dialRe = new RegExp(esc(String(st.dial)).replace(/\\\./g, '[. ]?'));
  for (const { s, i, l } of all) {
    for (const [label, re] of FACT_WORDS) {
      if (!re.test(l.text)) continue;
      if (label === 'digits' && ['station_id', 'jingle', 'sign_on', 'sign_off', 'liner', 'promo'].includes(s.kind) && dialRe.test(l.text.replace(/\{[^}]*\}/g, ''))) continue;
      if (label === 'news' && s.kind === 'news') continue; // station-internal news is the pack's format
      add('fact', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: label });
    }
    for (const c of stoplist.realCities || []) if (wordRe(c).test(l.text)) add('fact', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `real city "${c}"` });
  }

  // 1.5 real-world leakage
  const brandRes = (stoplist.brands || []).map((b) => [b, wordRe(b)]);
  const suffixRes = (stoplist.brandSuffixPatterns || []).map((p) => { try { return new RegExp(p, 'u'); } catch { return null; } }).filter(Boolean);
  const call = stoplist.callSignPattern ? new RegExp(stoplist.callSignPattern) : null;
  const catRes = (stoplist.realProductCategoriesForAds || []).map((c) => [c, wordRe(c)]);
  const tellRes = (stoplist.gameRadioTells || []).map((c) => [c, wordRe(c)]);
  for (const { s, i, l } of all) {
    for (const [b, re] of brandRes) if (re.test(l.text)) add('leak', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `stoplist brand "${b}"` });
    for (const re of suffixRes) { const m = l.text.match(re); if (m) add('leak', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `brand-suffix pattern "${m[0]}"` }); }
    const own = new Set([...hostIds, ...String(st.name).toLowerCase().split(/[^a-z0-9]+/), ...st.hosts.flatMap((h) => h.name.toLowerCase().split(/[^a-z0-9]+/))]);
    if (call) { const m = l.text.replace(/\{[^}]*\}/g, '').match(call); if (m && !own.has(m[0].toLowerCase().replace(/-(fm|am)$/, ''))) add('leak', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `looks like a real call sign: "${m[0]}"` }); }
    if (s.kind === 'ad') for (const [c, re] of catRes) if (re.test(l.text)) add('leak', { seg: s.id, line: i + 1, kind: 'ad', text: clip(l.text), note: `real product category in an ad: "${c}"` });
    for (const [c, re] of tellRes) if (re.test(l.text)) add('leak', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `game-radio tell "${c}"` });
  }

  // 1.6 PG-13
  for (const { s, i, l } of all) {
    for (const w of stoplist.profanityStrong || []) if (wordRe(w).test(l.text)) add('pg13', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `strong word "${w}"` });
    for (const w of stoplist.profanityMild || []) if (wordRe(w).test(l.text)) add('pg13', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `mild word "${w}" (allowed in PG-13, listed for awareness)` });
  }

  // 1.7 flat device: the field the reviewer recommends, plus a mechanical proxy (opener variety per host)
  for (const h of st.hosts.filter((x) => x.role === 'host' || x.role === 'co-host')) {
    if (!h.flatDevice) add('flat', { seg: `host:${h.id}`, note: `${h.name} has no "flatDevice" field (canned-review.md 4: one sentence naming the structural habit visible in text alone)` });
    const mine = segs.filter((s) => s.lines[0] && s.lines[0].host === h.id && !s.fallbackOf);
    const firsts = new Set(mine.map((s) => words(s.lines[0].text).slice(0, 2).join(' ')));
    if (mine.length >= 8) add('flat', { seg: `host:${h.id}`, note: `${h.name}: ${mine.length} openers, ${firsts.size} distinct two-word openings (information only; the attribution test needs a human reader)` });
  }

  // 1.8 clock fit
  const shortfalls = [];
  for (const [k, min] of Object.entries(CLOCK_MINIMUMS)) {
    const have = k === 'news' ? segs.filter((s) => s.kind === 'news' && !s.fallbackOf).length : segs.filter((s) => s.kind === k && !s.fallbackOf).length;
    if (have < min) shortfalls.push(`${k}: ${have} of ${min}`);
  }
  for (const f of shortfalls) add('clock', { seg: 'pack', note: `below the minimum for a 3-hour show: ${f}` });
  const slotFreeRoot = segs.filter((s) => !s.fallbackOf).length;
  if (slotFreeRoot < 54) add('clock', { seg: 'pack', note: `only ${slotFreeRoot} distinct (non-twin) segments; the reviewer's floor is about 54` });
  out.clock.unshift({ seg: 'pack', note: `kinds (distinct units): ${Object.entries(cnt).map(([k, n]) => `${k}=${segs.filter((s) => s.kind === k && !s.fallbackOf).length}`).join(' ')}`, info: true });

  // 2.1 call-ins
  for (const s of segs.filter((x) => x.kind === 'callin')) {
    const tags = s.tags || [];
    if (!tags.includes('bit')) add('callin', { seg: s.id, kind: 'callin', note: 'callin without tag "bit" (captions would not label it a scripted bit)' });
    const unlisted = [...new Set(s.lines.map((l) => l.host))].filter((h) => !hostIds.has(h));
    if (unlisted.length) add('callin', { seg: s.id, kind: 'callin', note: `voiced by unlisted host(s): ${unlisted.join(', ')}` });
    const roles = new Set(s.lines.map((l) => (st.hosts.find((h) => h.id === l.host) || {}).role));
    if (!roles.has('host') && !roles.has('co-host')) add('callin', { seg: s.id, kind: 'callin', note: 'no host or co-host speaks in this call-in' });
  }

  // 2.2 ads: list them all for the human plausibility check
  for (const s of segs.filter((x) => x.kind === 'ad' && !x.fallbackOf)) add('ad', { seg: s.id, kind: 'ad', text: clip(s.lines[0].text, 170), note: 'product: can you name a real company that sells it?' });

  // 2.3 time-of-day claims
  const single = st.daypart.length === 1 && st.daypart[0] !== 'any';
  for (const s of segs) {
    for (const [i, l] of s.lines.entries()) {
      if (!TIME_WORDS.test(l.text)) continue;
      const bookend = s.kind === 'sign_on' || s.kind === 'sign_off';
      if (bookend && !single) add('daypart', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `time-of-day claim in a ${s.kind} of a pack whose daypart is [${st.daypart.join(', ')}] (allowed only when it is a single value)` });
      else if (!bookend) add('daypart', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `time-of-day word "${(l.text.match(TIME_WORDS) || [''])[0]}" (the pack plays at any hour)` });
    }
  }

  // 2.4 song-adjacent claims
  for (const s of segs.filter((x) => !x.fallbackOf || slotted(segs.find((y) => y.id === x.fallbackOf) || {}))) {
    const names = s.lines.some((l) => NAMES_SONG.test(l.text));
    if (!names) continue;
    for (const [i, l] of s.lines.entries()) for (const w of stoplist.songAdjacentClaimWords || []) if (wordRe(w).test(l.text)) add('songclaim', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: `"${w}" in a segment that names the song` });
  }

  // 2.11 absence
  for (const { s, i, l } of all) if (ABSENCE.test(l.text) && /\b(?:he|she|they|[A-Z][a-z]+)\b/.test(l.text)) add('absence', { seg: s.id, line: i + 1, kind: s.kind, text: clip(l.text), note: 'a host or character described as late / stuck / away (fine if station-internal fiction; "stuck in traffic" is a traffic claim)' });

  return { id: st.id, name: st.name, dial: st.dial, daypart: st.daypart, counts: cnt, findings: out };
}

export function summarize(r) {
  return Object.fromEntries(CHECKS.map(([id]) => [id, r.findings[id].filter((f) => !f.info).length]));
}

function mdEscape(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

export function renderMarkdown(results, { generatedBy = 'node scripts/review-content.mjs --md docs/CANNED_REVIEW_FINDINGS.md' } = {}) {
  const L = [];
  L.push('# Canned stations: mechanical review findings', '');
  L.push(`Generated by \`${generatedBy}\` from \`scripts/review-content.mjs\` and the seed stoplist \`content/stations/_stoplist.json\`. **Report only**: nothing was rewritten and nothing fails CI. The pass/fail contract is still \`node scripts/check-content.mjs\` (all six packs pass). The writers' prose was not touched. A finding is a line for a human to read, not a verdict: many are fine (a station-internal "tonight" in a night-only pack, a fictional ad that mentions a "car wash").`, '');
  L.push('Procedure and defect list: the owner\'s `canned-review.md` (sections 1 and 2). Checks run: ' + CHECKS.map(([, t]) => t).join('; ') + '.', '');
  L.push('## Summary (findings per pack per check)', '');
  L.push(`| Check | ${results.map((r) => r.id).join(' | ')} |`, `|---|${results.map(() => '---:').join('|')}|`);
  for (const [id, title] of CHECKS) L.push(`| ${title} | ${results.map((r) => summarize(r)[id]).join(' | ')} |`);
  L.push('');
  L.push('## Owner decisions (not applied)', '');
  L.push('Per the brief the reviewer\'s renames were **not** applied. The dial reads every name from the pack JSON, so each is a one-line content change plus `node scripts/stations-index.mjs` (the index test fails until it is regenerated).', '');
  L.push('| Pack (current name) | Reviewer suggestion | Why (canned-review.md section 2) |', '|---|---|---|');
  L.push('| Pirate 1400 (`pirate-1400`) | Carrier Wave, or The Unlicensed. Keep the format and the 1400; change the surface. | Defect 5: "Pirate" plus a dial plus an unreliable host is the game-radio trope. |');
  L.push('| Sunbelt Soul 1060 (`sunbelt-soul-1060`) | Sunbelt 1060 AM, or Slow Current 1060 | Defect 6: "Soul" implies a genre the user\'s library may not have; canned talk must be song-agnostic. |');
  L.push('| Kilo-Hertz Rock 102.7 (`kilo-hertz-rock-102-7`) | Kilohertz; host persona "loud", not "rock" | Defect 7: same genre problem, and a rock host over a jazz library is comedy nobody ordered. |');
  L.push('', 'Other open decisions: (a) the three suggested renames above; (b) the `bit` tag: no pack tags its call-ins (see 2.1 below), so captions label every `callin` "bit" in the app regardless; (c) a `flatDevice` field per host (no pack has one); (d) whether to add the zero-line silent `liner` units the reviewer suggests (the validator rejects empty `lines`, so that needs a schema decision; the runner already treats a unit without spoken text as silence); (e) name + dial collisions with real stations (defect 8) were NOT searched.', '');
  L.push('## Not done (cannot be done mechanically or offline)', '');
  L.push('- No web search was made, by design: the stoplist is a **seed** of generic terms and brand-suffix patterns. A one-off human search of real station names and of the game-radio stations the reviewer names must still be done, and the result added to `_stoplist.json`.');
  L.push('- Real artist / song names (defect: compare against the owner\'s own library metadata) were not checked; the owner has to supply that list.');
  L.push('- The flat-line attribution test (1.7), plausibility of ads (2.2), PG-13 innuendo, "is it boring" and the 3-hour transcript read-through need a human. The 3-hour simulated run is automated (`test/radio-canned/long-show.test.mjs`), but reading a transcript is still the real review.', '');
  for (const r of results) {
    L.push(`## ${r.name} (\`${r.id}\`, dial ${r.dial}, daypart ${r.daypart.join('/')})`, '');
    L.push(`Segments by kind: ${Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', ')}.`, '');
    for (const [id, title] of CHECKS) {
      const fs = r.findings[id];
      const real = fs.filter((f) => !f.info);
      L.push(`### ${r.id}: ${title} (${real.length})`, '');
      if (!fs.length) { L.push('No findings.', ''); continue; }
      for (const f of fs) {
        const where = f.line ? `\`${f.seg}\` line ${f.line}${f.kind ? ` (${f.kind})` : ''}` : `\`${f.seg}\``;
        L.push(`- ${where}: ${mdEscape(f.note)}${f.text ? `. "${mdEscape(f.text)}"` : ''}`);
      }
      L.push('');
    }
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

export function loadStoplist(path = join(root, 'content/stations/_stoplist.json')) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function reviewFiles(files, stoplist) {
  return files.map((f) => reviewPack(JSON.parse(readFileSync(f, 'utf8')), stoplist));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const mdAt = argv.indexOf('--md');
  const mdPath = mdAt >= 0 ? argv[mdAt + 1] : null;
  const strict = argv.includes('--strict');
  const given = argv.filter((a, i) => !a.startsWith('--') && !(mdAt >= 0 && i === mdAt + 1));
  const dir = join(root, 'content/stations');
  const files = given.length ? given : readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'index.json').sort().map((f) => join(dir, f));
  const results = reviewFiles(files, loadStoplist());
  let total = 0;
  for (const r of results) {
    const s = summarize(r);
    total += Object.values(s).reduce((a, b) => a + b, 0);
    console.log(`${r.id}: ${CHECKS.map(([id]) => `${id}=${s[id]}`).join(' ')}`);
  }
  if (mdPath) { writeFileSync(mdPath, renderMarkdown(results, { generatedBy: `node scripts/review-content.mjs --md ${mdPath}` })); console.log(`wrote ${mdPath}`); }
  console.log('(report only: nothing was changed and nothing failed)');
  if (strict && total) process.exit(1);
}
