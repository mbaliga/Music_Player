#!/usr/bin/env node
// check-content.mjs — validates canned radio station files (content/stations/*.json, schema v1).
// Usage: node scripts/check-content.mjs [file.json ...]   (default: every content/stations/*.json except _-prefixed data files)
// Exits 1 on any error. Prints a per-station summary (segments per kind, minutes).
// The rules live in src/radio/canned/pack.js (the app validates a pack with the same code before airing it).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validatePackDoc } from '../src/radio/canned/pack.js';
import { packFileError } from './stations-index.mjs';

const dir = 'content/stations';
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'index.json').map(f => join(dir, f));
let errors = 0;
const err = (f, msg) => { errors++; console.error(`${f}: ${msg}`); };

for (const f of files) {
  let doc;
  try { doc = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { err(f, 'invalid JSON: ' + e.message); continue; }
  const idErr = packFileError(f, doc);
  if (idErr) err(f, idErr.slice(f.length + 2));
  const { errors: errs, stats } = validatePackDoc(doc);
  for (const e of errs) err(e.id ? `${f} [${e.id}]` : f, e.msg);
  console.log(`${stats.id}: ${stats.segments} segments, ${(stats.totalSec / 60).toFixed(1)} min, ${stats.slotSegs} slot / ${stats.standalone} slot-free`);
  console.log('  ' + Object.entries(stats.kinds).map(([k, n]) => `${k}=${n}`).join(' '));
}
if (errors) { console.error(`\n${errors} error(s)`); process.exit(1); }
console.log('OK');
