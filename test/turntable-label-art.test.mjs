// label-art.js: the record label comes from the album (its own art, else generated from its seed / title / artist). A fake 2D context records the calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paintLabel, LABEL_R } from '../src/turntable/label-art.js';

function fakeCanvas(size = 868) {
  const calls = [];
  const grad = { addColorStop() {} };
  const g = new Proxy({}, {
    get: (t, k) => {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 12 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      return (...a) => { calls.push([k, ...a]); };
    },
    set: (t, k, v) => { calls.push(['set:' + k, v]); return true; },
  });
  return { width: size, height: size, getContext: () => g, calls };
}

test('generated label: the album title and artist are painted as canvas text, never the DOM', () => {
  const c = fakeCanvas();
  paintLabel(c, { album: { title: 'Heat Wave', artist: 'The Dials', coverSeed: 1234 } });
  const texts = c.calls.filter((x) => x[0] === 'fillText').map((x) => x[1]);
  assert.ok(texts.includes('HEAT WAVE') && texts.includes('The Dials'), texts.join('|'));
  assert.ok(c.calls.some((x) => x[0] === 'clip'), 'clipped to the circular label');
});

test('own art: the image is cropped to a centred square and fills the label circle (no generated text)', () => {
  const c = fakeCanvas();
  paintLabel(c, { album: { title: 'T', artist: 'A', coverSeed: 1 }, image: { naturalWidth: 600, naturalHeight: 400 } });
  const d = c.calls.find((x) => x[0] === 'drawImage');
  assert.ok(d, 'drawImage called');
  assert.deepEqual(d.slice(2, 6), [100, 0, 400, 400]);                 // centred square crop of a 600 x 400 image
  assert.deepEqual(d.slice(6), [-LABEL_R, -LABEL_R, LABEL_R * 2, LABEL_R * 2]);
  assert.equal(c.calls.filter((x) => x[0] === 'fillText').length, 0);
});

test('a long title still fits: the text is shrunk / ellipsised, and a missing album does not throw', () => {
  const c = fakeCanvas();
  paintLabel(c, { album: { title: 'x'.repeat(200), artist: 'y'.repeat(200), coverSeed: 5 } });
  const texts = c.calls.filter((x) => x[0] === 'fillText');
  for (const t of texts) assert.ok(String(t[1]).length * 12 <= 400, 'fits the label chord');
  assert.doesNotThrow(() => paintLabel(fakeCanvas(), {}));
});
