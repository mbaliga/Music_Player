import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchMainActivity, retargetPackage, apply, AnchorError } from '../scripts/apply-android-display.mjs';

const fx = (n) => readFile(new URL(`./fixtures/android-template/${n}`, import.meta.url), 'utf8');

test('stock template: registers before super.onCreate, adds the Bundle import, idempotent', async () => {
  const out = patchMainActivity(await fx('MainActivity.stock.java'));
  assert.match(out, /import android\.os\.Bundle;/);
  assert.ok(out.indexOf('registerPlugin(DeviceDisplayPlugin.class)') < out.indexOf('super.onCreate'));
  assert.equal(patchMainActivity(out), out);
});
test('coexists with the device library patch (already has onCreate), keeps its lines', async () => {
  const out = patchMainActivity(await fx('MainActivity.withplugins.java'));
  assert.match(out, /registerPlugin\(DeviceLibraryPlugin\.class\)/);
  assert.ok(out.indexOf('DeviceDisplayPlugin') < out.indexOf('super.onCreate'));
  assert.equal(patchMainActivity(out), out);
});
test('fails loudly when an anchor is missing', () => {
  assert.throws(() => patchMainActivity('public class MainActivity {}'), AnchorError);
  assert.throws(() => patchMainActivity('import com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity { int x; }'), /expected the empty template body/);
  assert.throws(() => patchMainActivity('public class MainActivity extends BridgeActivity { public void onCreate(Bundle b) { } }'), /super\.onCreate/);
  assert.throws(() => retargetPackage('class X {}', 'com.runout.app'), /package line/);
  assert.throws(() => retargetPackage('package a.b;', 'Bad App'), /bad appId/);
});
test('apply() writes the plugin + MainActivity into a fake project, retargets the package; missing project fails', async () => {
  const d = await mkdtemp(join(tmpdir(), 'dm-'));
  try {
    await assert.rejects(apply(d, { appId: 'com.example.x' }), /not found/);
    const pkg = join(d, 'app/src/main/java/com/example/x'); await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'MainActivity.java'), (await fx('MainActivity.stock.java')).replace('com.runout.app', 'com.example.x'));
    const r = await apply(d, { appId: 'com.example.x' }); assert.equal(r.mainChanged, true);
    assert.match(await readFile(join(pkg, 'DeviceDisplayPlugin.java'), 'utf8'), /^package com\.example\.x;/m);
    assert.equal((await apply(d, { appId: 'com.example.x' })).mainChanged, false);
  } finally { await rm(d, { recursive: true, force: true }); }
});
test('the Java source declares the plugin name the JS bridge uses and no permissions are needed', async () => {
  const j = await readFile(new URL('../native/android-display/DeviceDisplayPlugin.java', import.meta.url), 'utf8');
  assert.match(j, /@CapacitorPlugin\(name = "DeviceDisplay"\)/);
  for (const m of ['keepAwake', 'setBrightness', 'setPreferredRefreshRate', 'getInfo']) assert.match(j, new RegExp(`public void ${m}\\(`));
  assert.doesNotMatch(j, /android\.permission|PowerManager|newWakeLock/);
});
