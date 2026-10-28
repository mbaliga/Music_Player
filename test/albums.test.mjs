// albums.test.mjs — Vinyl/CD classification and album grouping (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discNumberFromLabel, stripDiscLabel, classifyAlbum, foldersOf,
  groupTracks, shelfItems, KIND_CD, KIND_VINYL,
} from '../src/albums.js';

test('disc labels: accepted forms', () => {
  for (const [s, n] of [
    ['CD1', 1], ['cd2', 2], ['CD 1', 1], ['Cd-3', 3], ['Disc 2', 2], ['disc2', 2],
    ['Disk_1', 1], ['Album [CD1]', 1], ['Album (Disc 2)', 2], ['Album - CD 02', 2],
    ['Disc 1 of 2', 1], ['Album CD2', 2], ['CD.4', 4],
  ]) assert.equal(discNumberFromLabel(s), n, s);
});

test('disc labels: things that are NOT labels', () => {
  for (const s of ['CD', 'Discovery', 'Disco 2', 'ACD1', 'CD123', 'Disc', 'Abbey Road', '', 'CD0', 'Record 2'])
    assert.equal(discNumberFromLabel(s), null, s);
  assert.equal(discNumberFromLabel(undefined), null);
});

test('stripDiscLabel removes the label and its debris', () => {
  assert.equal(stripDiscLabel('The Wall [CD1]'), 'The Wall');
  assert.equal(stripDiscLabel('The Wall (Disc 2)'), 'The Wall');
  assert.equal(stripDiscLabel('The Wall - CD 2'), 'The Wall');
  assert.equal(stripDiscLabel('The Wall CD2'), 'The Wall');
  assert.equal(stripDiscLabel('The Wall'), 'The Wall');
});

test('classifyAlbum: tag, then deepest folder, else vinyl', () => {
  assert.deepEqual(classifyAlbum({ album: 'Blue' }), { kind: KIND_VINYL, disc: null });
  assert.deepEqual(classifyAlbum({ album: 'Blue CD2' }), { kind: KIND_CD, disc: 2 });
  assert.deepEqual(classifyAlbum({ album: 'Blue', folders: ['Music', 'Joni', 'Blue Disc 1'] }), { kind: KIND_CD, disc: 1 });
  // tag beats folder; deeper folder beats shallower
  assert.equal(classifyAlbum({ album: 'X CD1', folders: ['X CD2'] }).disc, 1);
  assert.equal(classifyAlbum({ folders: ['A CD1', 'sub CD2'] }).disc, 2);
  assert.deepEqual(classifyAlbum(), { kind: KIND_VINYL, disc: null });
});

test('foldersOf drops the file name and handles both separators', () => {
  assert.deepEqual(foldersOf('Music/A/B CD1/01.mp3'), ['Music', 'A', 'B CD1']);
  assert.deepEqual(foldersOf('C:\\m\\a\\x.mp3'), ['C:', 'm', 'a']);
  assert.deepEqual(foldersOf('x.mp3'), []);
  assert.deepEqual(foldersOf(undefined), []);
});

const T = (title, o = {}) => ({ title, artist: 'A', album: 'Blue', path: `A/Blue/${title}.mp3`, ...o });

test('groupTracks: plain album is one vinyl, tracks naturally ordered', () => {
  const g = groupTracks([T('10 j'), T('2 b'), T('1 a')]);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, KIND_VINYL);
  assert.deepEqual(g[0].tracks.map((t) => t.title), ['1 a', '2 b', '10 j']);
});

test('groupTracks: CD1/CD2 tags merge into one multi-disc CD album', () => {
  const g = groupTracks([
    T('1', { album: 'Wall CD2', path: 'x/Wall CD2/1.mp3' }),
    T('1', { album: 'Wall CD1', path: 'x/Wall CD1/1.mp3' }),
    T('2', { album: 'Wall CD1', path: 'x/Wall CD1/2.mp3' }),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, KIND_CD);
  assert.equal(g[0].title, 'Wall');
  assert.deepEqual(g[0].discs.map((d) => [d.number, d.tracks.length]), [[1, 2], [2, 1]]);
  const shelf = shelfItems(g);
  assert.deepEqual(shelf.map((s) => s.label), ['Wall · CD 1', 'Wall · CD 2']);
  assert.ok(shelf.every((s) => s.kind === KIND_CD));
  assert.notEqual(shelf[0].id, shelf[1].id);
});

test('groupTracks: untagged tracks use the folder; folder label makes a CD', () => {
  const g = groupTracks([
    { title: 'a', artist: 'Z', path: 'Z/Live Disc 2/a.mp3' },
    { title: 'b', artist: 'Z', path: 'Z/Live Disc 2/b.mp3' },
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].title, 'Live');
  assert.equal(g[0].kind, KIND_CD);
  assert.equal(g[0].discs[0].number, 2);
  assert.equal(shelfItems(g)[0].label, 'Live'); // single disc present: no suffix
});

test('groupTracks: an unlabelled track in a CD album joins the lowest disc', () => {
  const g = groupTracks([
    T('a', { album: 'Set CD2' }), T('b', { album: 'Set' }),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, KIND_CD);
  assert.deepEqual(g[0].discs.map((d) => [d.number, d.tracks.length]), [[2, 2]]);
});

test('groupTracks: same album title by different artists stays separate; albumArtist wins', () => {
  const g = groupTracks([
    T('a', { artist: 'P' }), T('b', { artist: 'Q' }),
    T('c', { artist: 'R', albumArtist: 'P' }),
  ]);
  assert.equal(g.length, 2);
  assert.equal(g.find((x) => x.artist === 'P').tracks.length, 2);
});

test('groupTracks/shelfItems: empty and vinyl-only', () => {
  assert.deepEqual(groupTracks([]), []);
  assert.deepEqual(shelfItems([]), []);
  const s = shelfItems(groupTracks([T('a')]));
  assert.equal(s[0].kind, KIND_VINYL);
  assert.equal(s[0].disc, null);
});
