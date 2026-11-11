// Runs the stdlib-only Python unit tests for scripts/render-shows.py (pure parts: voice
// assignment, pause/loudness maths, cache keys, manifest determinism). Skips cleanly when
// python3 is absent. Needs no ffmpeg, no TTS engine, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']);
const havePython = !probe.error && probe.status === 0;

test('render-shows.py pure-part unit tests', { skip: havePython ? false : 'python3 >= 3.8 not available' }, () => {
  const r = spawnSync('python3', ['-I', path.join(root, 'test/python/test_render_shows.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('render-shows.py dry-run plans the fixture without engines or ffmpeg', { skip: havePython ? false : 'python3 not available' }, () => {
  const r = spawnSync('python3', ['-I', path.join(root, 'scripts/render-shows.py'), '--dry-run',
    '--stations', path.join(root, 'test/fixtures/render/stations'),
    '--voices', path.join(root, 'test/fixtures/render/voices.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 to render, 1 slotted skipped/);
});
