// patch-manifest.test.mjs — pins the desktop-mode manifest patch run by android.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchManifest } from '../scripts/patch-android-manifest.mjs';

const manifest = (attrs = '', extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <activity ${attrs} android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>${extra}
        </activity>
        <activity android:name=".Other" />
    </application>
</manifest>`;

const mainTag = (xml) => xml.match(/<activity\b[^>]*MainActivity[^>]*>/)[0];
const cc = (xml) => mainTag(xml).match(/android:configChanges="([^"]*)"/)[1].split('|');
const count = (xml, re) => (xml.match(re) || []).length;

test('Capacitor-style manifest: resizeable, configChanges union, layout added once', () => {
  const attrs = 'android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"';
  const { xml } = patchManifest(manifest(attrs));
  assert.match(mainTag(xml), /android:resizeableActivity="true"/);
  for (const c of ['orientation', 'screenSize', 'smallestScreenSize', 'screenLayout', 'density']) assert.ok(cc(xml).includes(c), c);
  assert.equal(count(xml, /<layout\b/g), 1);
  assert.match(xml, /android:minWidth="360dp"/);
  assert.match(xml, /android:defaultWidth="640dp"/);
  // the other activity is untouched
  assert.match(xml, /<activity android:name="\.Other" \/>/);
});

test('second run is idempotent', () => {
  const once = patchManifest(manifest('android:configChanges="orientation"')).xml;
  const twice = patchManifest(once).xml;
  assert.equal(twice, once);
  assert.equal(count(twice, /<layout\b/g), 1);
});

test('existing configChanges are kept and merged without duplicates', () => {
  const { xml } = patchManifest(manifest('android:configChanges="keyboard|locale|screenSize"'));
  const list = cc(xml);
  assert.deepEqual(list.slice(0, 3), ['keyboard', 'locale', 'screenSize']);
  assert.equal(new Set(list).size, list.length);
  assert.ok(list.includes('density'));
});

test('missing configChanges and resizeableActivity=false are set', () => {
  const { xml } = patchManifest(manifest('android:resizeableActivity="false"'));
  assert.match(mainTag(xml), /android:resizeableActivity="true"/);
  assert.doesNotMatch(mainTag(xml), /resizeableActivity="false"/);
  assert.equal(cc(xml).length, 5);
});

test('screenOrientation warns and is left unchanged', () => {
  const { xml, notes } = patchManifest(manifest('android:screenOrientation="portrait"'));
  assert.ok(notes.some((n) => /WARNING.*screenOrientation/.test(n)));
  assert.match(mainTag(xml), /android:screenOrientation="portrait"/);
  const clean = patchManifest(manifest());
  assert.ok(!clean.notes.some((n) => /WARNING/.test(n)));
});

test('an existing layout element is not duplicated', () => {
  const { xml } = patchManifest(manifest('', '\n            <layout android:defaultWidth="1dp" />'));
  assert.equal(count(xml, /<layout\b/g), 1);
  assert.match(xml, /defaultWidth="1dp"/);
});

test('throws when there is no MAIN activity', () => {
  const xml = '<manifest><application><activity android:name=".A" /></application></manifest>';
  assert.throws(() => patchManifest(xml), /main activity/);
});
