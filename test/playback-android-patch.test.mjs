import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchManifest, patchStyles, patchMainActivity, retargetPackage, apply, AnchorError, PERMISSIONS, THEME_ITEMS } from '../scripts/apply-android-playback.mjs';
import { apply as applyDisplay } from '../scripts/apply-android-display.mjs';
import { apply as applyPlugins } from '../scripts/apply-android-plugins.mjs';

const fxUrl = (n) => new URL(`./fixtures/android-template/${n}`, import.meta.url);
const fx = (n) => readFile(fxUrl(n), 'utf8');
const src = (n) => readFile(new URL(`../native/android-playback/${n}`, import.meta.url), 'utf8');

test('manifest: permissions, the mediaPlayback service (not exported), allowBackup=false, adjustResize; idempotent', async () => {
  const out = patchManifest(await fx('app/src/main/AndroidManifest.xml'), 'com.runout.app');
  for (const p of PERMISSIONS) assert.ok(out.includes(`android:name="${p}"`), p);
  assert.match(out, /<service[^>]*android:name="com\.runout\.app\.MediaPlaybackService"[^>]*android:exported="false"[^>]*android:foregroundServiceType="mediaPlayback"/);
  assert.match(out, /android:allowBackup="false"/); assert.doesNotMatch(out, /allowBackup="true"/);
  assert.match(out, /<activity[^>]*android:windowSoftInputMode="adjustResize"/);
  assert.equal(patchManifest(out, 'com.runout.app'), out);
  assert.equal((out.match(/MediaPlaybackService/g) || []).length, 1);
});

test('manifest: fails loudly when an anchor is gone', () => {
  assert.throws(() => patchManifest('<manifest></manifest>', 'a.b'), AnchorError);
  assert.throws(() => patchManifest('<manifest><application></application></manifest>', 'a.b'), /MainActivity/);
});

test('styles: black bars and window on AppTheme and AppTheme.NoActionBar, never the splash theme; idempotent; no duplicate items', async () => {
  const out = patchStyles(await fx('app/src/main/res/values/styles.xml'));
  const block = (n) => new RegExp(`<style name="${n.replace('.', '\\.')}"[\\s\\S]*?</style>`).exec(out)[0];
  for (const n of ['AppTheme', 'AppTheme.NoActionBar']) for (const [k, v] of THEME_ITEMS) assert.ok(block(n).includes(`<item name="${k}">${v}</item>`), `${n} ${k}`);
  assert.doesNotMatch(block('AppTheme.NoActionBarLaunch'), /statusBarColor/);
  assert.equal(patchStyles(out), out);
  const pre = (await fx('app/src/main/res/values/styles.xml')).replace('<item name="windowNoTitle">', '<item name="android:statusBarColor">@android:color/black</item><item name="windowNoTitle">');
  assert.equal((patchStyles(pre).match(/android:statusBarColor/g) || []).length, 2, 'an existing item is kept, not duplicated');
  assert.throws(() => patchStyles('<resources></resources>'), /AppTheme\.NoActionBar/);
});

test('MainActivity: registers the plugin before super.onCreate and installs the host after it; coexists with the other two patches in any order', async () => {
  const out = patchMainActivity(await fx('MainActivity.stock.java'));
  assert.ok(out.indexOf('registerPlugin(DevicePlaybackPlugin.class)') < out.indexOf('super.onCreate'));
  assert.ok(out.indexOf('super.onCreate') < out.indexOf('RunoutHost.install(this)'));
  assert.match(out, /import android\.os\.Bundle;/);
  assert.equal(patchMainActivity(out), out);
  const both = patchMainActivity(await fx('MainActivity.withplugins.java'));
  assert.match(both, /registerPlugin\(DeviceLibraryPlugin\.class\)/);
  assert.equal((both.match(/RunoutHost\.install/g) || []).length, 1);
});

test('MainActivity: fails loudly without an anchor', () => {
  assert.throws(() => patchMainActivity('public class MainActivity {}'), AnchorError);
  assert.throws(() => patchMainActivity('import com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity { int x; }'), /empty template body/);
  assert.throws(() => retargetPackage('class X {}', 'com.runout.app'), /package line/);
  assert.throws(() => retargetPackage('package a.b;', 'Bad App'), /bad appId/);
});

test('apply(): all three patch scripts on one fake project in either order give the same tree; the sources are retargeted', async () => {
  const mk = async () => {
    const d = await mkdtemp(join(tmpdir(), 'pb-'));
    await cp(fxUrl('app'), join(d, 'app'), { recursive: true });
    return d;
  };
  const a = await mk(), b = await mk();
  try {
    const id = { appId: 'com.example.x' };
    for (const d of [a, b]) {  // retarget the fixture to the other appId
      const pkg = join(d, 'app/src/main/java/com/runout/app'), to = join(d, 'app/src/main/java/com/example/x');
      await mkdir(to, { recursive: true });
      await writeFile(join(to, 'MainActivity.java'), (await readFile(join(pkg, 'MainActivity.java'), 'utf8')).replace('com.runout.app', 'com.example.x'));
    }
    await applyPlugins(a, id); await applyDisplay(a, id); const r = await apply(a, id);
    await apply(b, id); await applyDisplay(b, id); await applyPlugins(b, id);
    assert.equal(r.mainChanged, true);
    const main = (d) => readFile(join(d, 'app/src/main/java/com/example/x/MainActivity.java'), 'utf8');
    const ma = await main(a), mb = await main(b);
    for (const m of [ma, mb]) {
      for (const p of ['DeviceLibraryPlugin', 'DeviceDisplayPlugin', 'DevicePlaybackPlugin']) assert.equal((m.match(new RegExp(`registerPlugin\\(${p}\\.class\\)`, 'g')) || []).length, 1, p);
      assert.equal((m.match(/RunoutHost\.install/g) || []).length, 1);
      assert.ok(m.indexOf('registerPlugin(DevicePlaybackPlugin') < m.indexOf('super.onCreate'));
    }
    for (const f of ['MediaPlaybackService', 'DevicePlaybackPlugin', 'RunoutHost']) assert.match(await readFile(join(a, `app/src/main/java/com/example/x/${f}.java`), 'utf8'), /^package com\.example\.x;/m);
    assert.match(await readFile(join(a, 'app/src/main/java/com/example/x/MediaPlaybackService.java'), 'utf8'), /"com\.example\.x\.playback\.START"/);
    assert.match(await readFile(join(a, 'app/src/main/res/drawable/ic_stat_runout.xml'), 'utf8'), /<vector/);
    assert.equal((await apply(a, id)).mainChanged, false);
    assert.equal((await apply(a, id)).manifestChanged, false);
  } finally { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); }
});

test('Java sources: the plugin name the JS bridge uses, the service type, the events and the focus / noisy / wake-lock handling', async () => {
  const plugin = await src('DevicePlaybackPlugin.java'), svc = await src('MediaPlaybackService.java'), host = await src('RunoutHost.java');
  assert.match(plugin, /name = "DevicePlayback"/);
  for (const m of ['start', 'stop', 'setMetadata', 'setState', 'requestNotificationPermission', 'setPosition']) assert.match(plugin, new RegExp(`public void ${m}\\(`));
  assert.match(plugin, /notifyListeners\("seek"/); assert.match(plugin, /BitmapFactory\.decodeByteArray/);
  assert.match(svc, /ACTION_SEEK_TO/); assert.match(svc, /onSeekTo\(long/); assert.match(svc, /METADATA_KEY_ALBUM_ART/); assert.match(svc, /METADATA_KEY_DURATION/); assert.match(svc, /setLargeIcon/);
  for (const ev of ['play', 'pause', 'next', 'previous', 'duck', 'stopped']) assert.ok(svc.includes(`"${ev}"`), `event ${ev}`);
  assert.match(svc, /FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK/);
  for (const k of ['AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK', 'AUDIOFOCUS_LOSS_TRANSIENT', 'AUDIOFOCUS_LOSS', 'ACTION_AUDIO_BECOMING_NOISY', 'PARTIAL_WAKE_LOCK', 'MediaSession', 'Notification.MediaStyle']) assert.ok(svc.includes(k), k);
  assert.match(svc, /promote\(buildNotification\(playing\)\)/, 'startForeground is reached on every start command');
  assert.match(host, /setSystemGestureExclusionRects/); assert.match(host, /MAX_TALL_DP = 200/); assert.match(host, /__runoutBack/); assert.match(host, /moveTaskToBack/);
  assert.doesNotMatch(host, /\bfinish\(\)/, 'Back never exits a music player');
  assert.doesNotMatch(plugin + svc, /androidx\.media/, 'platform classes only');
});

test('the CI workflow runs the patch scripts before cap sync, the app plugin is a dependency and the web background colour is black', async () => {
  const wf = await readFile(new URL('../.github/workflows/android.yml', import.meta.url), 'utf8');
  const iPlay = wf.indexOf('apply-android-playback.mjs'), iSync = wf.indexOf('cap sync android'), iInstall = wf.indexOf('npm ci');
  assert.ok(iInstall > 0 && iInstall < wf.indexOf('cap add android'), 'npm ci (@capacitor/app) comes before the platform is added');
  assert.ok(iPlay > 0 && iPlay < iSync);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.dependencies['@capacitor/app'], /^\^6/);
  const cfg = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.backgroundColor, '#000000');
});
