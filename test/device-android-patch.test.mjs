// The CI patch script against a fixture mirroring the generated Capacitor 6 template (and, when a real
// generated android/ exists locally, against that too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { patchManifest, patchMainActivity, retargetPackage, apply, AnchorError, PERMISSION_LINES } from '../scripts/apply-android-plugins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures/android-template');
const SCRIPT = join(here, '../scripts/apply-android-plugins.mjs');
const exists = (p) => access(p).then(() => true, () => false);

async function copyOf(src) {
  const d = await mkdtemp(join(tmpdir(), 'runout-android-'));
  await cp(src, d, { recursive: true });
  return d;
}
const MAIN = 'app/src/main/java/com/runout/app/MainActivity.java';
const MANIFEST = 'app/src/main/AndroidManifest.xml';

for (const [label, srcDir] of [['fixture', FIX], ['generated android/', resolve(here, '../android')]]) {
  test(`patch script on the ${label}: patches, copies the plugin, is idempotent`, async (t) => {
    if (!(await exists(join(srcDir, MAIN)))) return t.skip('no such tree here');
    const d = await copyOf(srcDir);
    try {
      const r1 = await apply(d, { appId: 'com.runout.app' });
      assert.deepEqual(r1.copied, ['DeviceLibraryPlugin.java']);
      const manifest = await readFile(join(d, MANIFEST), 'utf8');
      assert.match(manifest, /READ_MEDIA_AUDIO/);
      assert.match(manifest, /READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/);
      assert.doesNotMatch(manifest, /MANAGE_EXTERNAL_STORAGE|READ_MEDIA_IMAGES|READ_MEDIA_VIDEO/);
      const main = await readFile(join(d, MAIN), 'utf8');
      assert.match(main, /registerPlugin\(DeviceLibraryPlugin\.class\);\s*super\.onCreate/);
      assert.match(main, /import android\.os\.Bundle;/);
      const plugin = await readFile(join(d, 'app/src/main/java/com/runout/app/DeviceLibraryPlugin.java'), 'utf8');
      assert.match(plugin, /^package com\.runout\.app;/m);
      // second run: no changes at all
      const r2 = await apply(d, { appId: 'com.runout.app' });
      assert.equal(r2.manifestChanged, false);
      assert.equal(r2.mainChanged, false);
      assert.equal(await readFile(join(d, MAIN), 'utf8'), main);
      assert.equal(await readFile(join(d, MANIFEST), 'utf8'), manifest);
      assert.equal((manifest.match(/READ_MEDIA_AUDIO/g) || []).length, 1);
    } finally { await rm(d, { recursive: true, force: true }); }
  });
}

test('fails loudly when an anchor is missing', async () => {
  assert.throws(() => patchManifest('<application/>'), AnchorError);
  assert.throws(() => patchMainActivity('public class MainActivity {}'), /BridgeActivity/);
  assert.throws(() => patchMainActivity('public class MainActivity extends BridgeActivity { int x; }'), /expected the empty template/);
  assert.throws(() => retargetPackage('class A {}', 'com.x.y'), /no package line/);
  assert.throws(() => retargetPackage('package a.b;', 'Bad AppId'), /bad appId/);
});

test('CLI exits non-zero with a clear message on a broken tree, leaving it untouched', async () => {
  const d = await copyOf(FIX);
  try {
    await writeFile(join(d, MAIN), 'package com.runout.app;\npublic class MainActivity extends BridgeActivity { void other() {} }\n');
    const before = await readFile(join(d, MANIFEST), 'utf8');
    let failed = false;
    try { execFileSync('node', [SCRIPT, d], { stdio: 'pipe' }); } catch (e) {
      failed = true;
      assert.notEqual(e.status, 0);
      assert.match(String(e.stderr), /apply-android-plugins failed: MainActivity\.java/);
    }
    assert.ok(failed);
    assert.equal(await readFile(join(d, MANIFEST), 'utf8'), before);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('CLI missing project dir says to run cap add android', async () => {
  assert.throws(() => execFileSync('node', [SCRIPT, '/nonexistent-android'], { stdio: 'pipe' }), (e) => /cap add android/.test(String(e.stderr)));
});

test('patches an existing onCreate in place', () => {
  const src = 'package a;\nimport com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;\npublic class MainActivity extends BridgeActivity {\n  @Override\n  public void onCreate(Bundle b) {\n    super.onCreate(b);\n  }\n}\n';
  const out = patchMainActivity(src);
  assert.match(out, /registerPlugin\(DeviceLibraryPlugin\.class\);\n\s*super\.onCreate\(b\)/);
  assert.equal(patchMainActivity(out), out);
});

test('permission lines are exactly the narrow audio set', () => {
  assert.equal(PERMISSION_LINES.length, 2);
});
