import test from 'node:test';
import assert from 'node:assert/strict';
import { playFailText, isAccessError, shortTitle, LOST_ACCESS } from '../src/errtext.js';

test('native read failures become the Allow message with no file names or offsets', () => {
  const e = new Error('native read failed at 0 (+640044) of 01 x.wav: permission');
  assert.ok(isAccessError(e));
  assert.equal(playFailText('A very long title that goes on and on and on', e), LOST_ACCESS);
});
test('other errors are scrubbed and titles truncated', () => {
  const t = playFailText('A very long title that goes on and on and on', new Error('decode failed for 01 song.mp3 (+640044)'));
  assert.ok(!/\.mp3|640044/.test(t));
  assert.ok(t.length < 110);
  assert.equal(shortTitle('abc', 28), 'abc');
});
