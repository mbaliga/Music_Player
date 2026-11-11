#!/usr/bin/env node
// stations-index.mjs — build content/stations/index.json from the pack files, so the Radio tab's dial can list the stations
// without loading all six packs. Everything in it is COPIED from the packs (name, dial, tagline, vibe, daypart, hosts), so a
// rename in a pack is a rename on the dial after one `node scripts/stations-index.mjs`. test/radio-canned/ fails when the
// committed index is out of date. Usage: node scripts/stations-index.mjs [--check]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_DIR = join(root, 'content', 'stations');

export const isPackFile = (f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'index.json';

/** -> { v:1, stations:[...] } (deterministic: sorted by id, no timestamps) */
export function buildStationsIndex(dir = PACK_DIR, audioDir = join(root, 'content', 'audio')) {
  const stations = [];
  for (const f of readdirSync(dir).filter(isPackFile).sort()) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const st = doc.station;
    const roots = doc.segments.filter((s) => !s.fallbackOf);
    stations.push({
      id: st.id, file: f, name: st.name, dial: st.dial, tagline: st.tagline, vibe: st.vibe, daypart: st.daypart, contentRating: st.contentRating,
      hosts: st.hosts.map((h) => ({ id: h.id, name: h.name, role: h.role })),
      // true only when a pre-rendered voice pack for this station exists at build time (content/audio/<id>/manifest.json)
      ...(existsSync(join(audioDir, st.id, 'manifest.json')) ? { audio: true } : {}),
      segments: doc.segments.length, minutes: Math.round(roots.reduce((a, s) => a + (s.estSec || 0), 0) / 60),
    });
  }
  return { v: 1, stations };
}

export const serializeIndex = (idx) => JSON.stringify(idx, null, 2) + '\n';

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const out = join(PACK_DIR, 'index.json');
  const text = serializeIndex(buildStationsIndex());
  if (process.argv.includes('--check')) {
    let cur = ''; try { cur = readFileSync(out, 'utf8'); } catch { /* */ }
    if (cur !== text) { console.error('content/stations/index.json is out of date: run node scripts/stations-index.mjs'); process.exit(1); }
    console.log('stations index is up to date');
  } else { writeFileSync(out, text); console.log(`wrote ${out} (${JSON.parse(text).stations.length} stations)`); }
}
