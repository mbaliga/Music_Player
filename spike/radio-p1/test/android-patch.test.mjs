import test from 'node:test';
import assert from 'node:assert/strict';
import { patchManifest, patchMainActivity, retargetPackage, PERMISSIONS } from '../android/apply-spike.mjs';

// APPROXIMATION of the Capacitor 6 template (written from memory; the real one is generated in CI by `cap add android`).
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity android:name=".MainActivity" android:exported="true"></activity>
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`;
const MAIN = `package com.runout.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

test('manifest: adds all permissions and the mediaPlayback service, keeps existing content', () => {
  const x = patchManifest(MANIFEST);
  for (const p of PERMISSIONS) assert.ok(x.includes(`android:name="${p}"`), p);
  assert.ok(x.includes('android:foregroundServiceType="mediaPlayback"'));
  assert.ok(x.includes('android.permission.INTERNET'));
  assert.ok(x.indexOf('.SpikeForegroundService') < x.indexOf('</application>'));
});
test('manifest: idempotent', () => { const a = patchManifest(MANIFEST); assert.equal(patchManifest(a), a); });
test('manifest: fails loudly on a template it does not understand', () => assert.throws(() => patchManifest('<foo/>'), /anchors/));
test('MainActivity: registers the plugin before super.onCreate; idempotent; rejects non-Bridge activity', () => {
  const j = patchMainActivity(MAIN);
  assert.ok(j.indexOf('registerPlugin(SpikeBackgroundPlugin.class)') < j.indexOf('super.onCreate'));
  assert.ok(j.includes('import android.os.Bundle;'));
  assert.equal(patchMainActivity(j), j);
  assert.throws(() => patchMainActivity('public class MainActivity {}'), /BridgeActivity/);
});

test('retargetPackage rewrites the package line only, rejects bad ids', () => {
  assert.match(retargetPackage('package com.runout.app;\n\npublic class X {}', 'com.runout.radiospike'), /^package com\.runout\.radiospike;/);
  assert.throws(() => retargetPackage('package a.b;', 'Bad Id'), /bad appId/);
});
