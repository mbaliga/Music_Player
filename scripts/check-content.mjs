#!/usr/bin/env node
// check-content.mjs — validates canned radio station files (content/stations/*.json, schema v1).
// Usage: node scripts/check-content.mjs [file.json ...]   (default: every content/stations/*.json)
// Exits 1 on any error. Prints a per-station summary (segments per kind, minutes).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SLOTS = new Set(['prevTitle', 'prevArtist', 'nextTitle', 'nextArtist', 'album']);
const KINDS = new Set(['sign_on', 'station_id', 'jingle', 'banter', 'monologue', 'ad', 'news', 'skit', 'callin', 'dedication', 'liner', 'promo', 'transition', 'sign_off']);
const DAYPARTS = new Set(['night', 'morning', 'day', 'evening', 'any']);
const WPS = 2.6, TOL = 0.35;
const BANNED = [
  [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, 'emoji'],
  [/https?:\/\/|www\.|\.com\b|\.net\b|\.org\b/i, 'url'],
  [/\[[^\]]*\]|\*[^*]+\*|\([^)]*(laugh|sigh|pause|beat|music|sfx)[^)]*\)/i, 'stage direction in text'],
  [/\{(?!(prevTitle|prevArtist|nextTitle|nextArtist|album)\})[^}]*\}/, 'unknown slot'],
];

const dir = 'content/stations';
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(dir).filter(f => f.endsWith('.json')).map(f => join(dir, f));
let errors = 0;
const err = (f, msg) => { errors++; console.error(`${f}: ${msg}`); };
const words = t => t.split(/\s+/).filter(Boolean).length;

for (const f of files) {
  let doc;
  try { doc = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { err(f, 'invalid JSON: ' + e.message); continue; }
  if (doc.v !== 1) err(f, 'v must be 1');
  const st = doc.station || {};
  for (const k of ['id', 'name', 'tagline', 'dial', 'vibe', 'contentRating']) if (typeof st[k] !== 'string' || !st[k]) err(f, `station.${k} missing`);
  if (!Array.isArray(st.daypart) || !st.daypart.length || st.daypart.some(d => !DAYPARTS.has(d))) err(f, 'station.daypart invalid');
  const hosts = new Map();
  for (const h of st.hosts || []) {
    if (!h.id || hosts.has(h.id)) err(f, `host id missing/duplicate: ${h.id}`);
    hosts.set(h.id, h);
    for (const k of ['name', 'role', 'persona']) if (!h[k]) err(f, `host ${h.id}.${k} missing`);
    const v = h.voice || {};
    if (!['female', 'male', 'neutral'].includes(v.genderHint)) err(f, `host ${h.id} genderHint`);
    if (!['young', 'adult', 'older'].includes(v.ageHint)) err(f, `host ${h.id} ageHint`);
    if (!v.accent || !v.style) err(f, `host ${h.id} accent/style`);
    for (const k of ['rate', 'pitch']) if (!(v[k] >= 0.8 && v[k] <= 1.3)) err(f, `host ${h.id} ${k} out of 0.8-1.3`);
  }
  const ids = new Set();
  const segs = doc.segments || [];
  for (const s of segs) { if (ids.has(s.id)) err(f, `duplicate segment id ${s.id}`); ids.add(s.id); }
  const kinds = {}; let total = 0, slotSegs = 0, standalone = 0;
  const fallbackTargets = new Set();
  for (const s of segs) {
    const where = `${f} [${s.id}]`;
    if (!KINDS.has(s.kind)) err(where, `bad kind ${s.kind}`);
    kinds[s.kind] = (kinds[s.kind] || 0) + 1;
    if (!Array.isArray(s.lines) || !s.lines.length) { err(where, 'no lines'); continue; }
    const used = new Set();
    for (const l of s.lines) {
      if (!hosts.has(l.host)) err(where, `unknown host ${l.host}`);
      if (!s.hosts.includes(l.host)) err(where, `line host ${l.host} not in segment hosts`);
      if (typeof l.text !== 'string' || !l.text.trim()) err(where, 'empty text');
      for (const [re, name] of BANNED) if (re.test(l.text)) err(where, `${name}: "${l.text.slice(0, 60)}"`);
      for (const [, slot] of (l.text || '').matchAll(/\{(\w+)\}/g)) { if (!SLOTS.has(slot)) err(where, `bad slot ${slot}`); used.add(slot); }
      if (l.pauseAfterMs != null && !(l.pauseAfterMs >= 0 && l.pauseAfterMs <= 5000)) err(where, 'pauseAfterMs out of range');
    }
    for (const h of s.hosts) if (!hosts.has(h)) err(where, `segment host ${h} unknown`);
    const declared = new Set(s.usesSlots || []);
    if ([...used].some(x => !declared.has(x)) || [...declared].some(x => !used.has(x))) err(where, 'usesSlots does not match text');
    if (s.fallbackOf != null) {
      if (!ids.has(s.fallbackOf)) err(where, `fallbackOf ${s.fallbackOf} does not resolve`);
      else fallbackTargets.add(s.fallbackOf);
      if (used.size) err(where, 'fallback segment uses slots');
    }
    const est = s.lines.reduce((n, l) => n + words(l.text), 0) / WPS;
    if (!(s.estSec >= est * (1 - TOL) && s.estSec <= est * (1 + TOL))) err(where, `estSec ${s.estSec} vs ~${est.toFixed(1)}`);
    if (!Array.isArray(s.tags)) err(where, 'tags must be an array');
    if (typeof s.weight !== 'number' || s.weight <= 0) err(where, 'weight must be > 0');
    total += s.estSec;
    if (used.size) slotSegs++; else standalone++;
  }
  for (const s of segs) if ((s.usesSlots || []).length && !fallbackTargets.has(s.id)) err(`${f} [${s.id}]`, 'slot segment has no fallback variant');
  console.log(`${st.id}: ${segs.length} segments, ${(total / 60).toFixed(1)} min, ${slotSegs} slot / ${standalone} slot-free`);
  console.log('  ' + Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(' '));
}
if (errors) { console.error(`\n${errors} error(s)`); process.exit(1); }
console.log('OK');
