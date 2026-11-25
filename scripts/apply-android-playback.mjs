#!/usr/bin/env node
// apply-android-playback.mjs — patch the GENERATED Capacitor Android project with Runout's background playback, hardware-Back fallback and
// gesture-exclusion glue, and with the app-level manifest / theme settings. android/ is not committed; CI runs `cap add android`, then this
// (after apply-android-plugins.mjs and apply-android-display.mjs), then `cap sync`.
//
//   node scripts/apply-android-playback.mjs [androidDir]        (default ./android)
//
//   1. copies native/android-playback/*.java (MediaPlaybackService, DevicePlaybackPlugin, RunoutHost) into app/src/main/java/<appId path>/
//      (package line retargeted to appId) and writes res/drawable/ic_stat_runout.xml (the notification's small icon)
//   2. AndroidManifest.xml
//        - FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK, POST_NOTIFICATIONS (runtime-requested on API 33+, denial tolerated), WAKE_LOCK
//        - <service MediaPlaybackService exported=false foregroundServiceType=mediaPlayback>
//        - <application android:allowBackup="false">, MainActivity android:windowSoftInputMode="adjustResize"
//   3. res/values/styles.xml: black status bar, navigation bar and window background, dark system-bar icons off (no white flash behind the app)
//   4. MainActivity: registerPlugin(DevicePlaybackPlugin.class) before super.onCreate and RunoutHost.install(this) after it
//
// Idempotent. Coexists with apply-android-plugins.mjs / apply-android-display.mjs in either order. FAILS LOUDLY (exit 1, `::error::` line
// naming the anchor) if the generated project no longer matches, so a Capacitor upgrade breaks CI visibly instead of shipping a silent app.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN = 'DevicePlaybackPlugin';
export const SOURCES = ['MediaPlaybackService.java', 'DevicePlaybackPlugin.java', 'RunoutHost.java'];
export const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
];
export const THEME_ITEMS = [
  ['android:statusBarColor', '@android:color/black'],
  ['android:navigationBarColor', '@android:color/black'],
  ['android:windowBackground', '@android:color/black'],
  ['android:windowLightStatusBar', 'false'],
  ['android:windowLightNavigationBar', 'false'],
];
export const STAT_ICON = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"
        android:pathData="M12,2a10,10 0 1,0 0.001,0zM12,9.5a2.5,2.5 0 1,1 -0.001,0zM12,4.5a7.5,7.5 0 1,0 0.001,0z" />
</vector>
`;

export class AnchorError extends Error {}

export function patchManifest(xml, appId) {
  if (!/<manifest[\s>]/.test(xml) || !xml.includes('</manifest>')) throw new AnchorError('AndroidManifest.xml: <manifest> ... </manifest> anchors not found');
  if (!/<application[\s>]/.test(xml) || !xml.includes('</application>')) throw new AnchorError('AndroidManifest.xml: <application> ... </application> anchors not found');
  let out = xml;

  // <application android:allowBackup="false">
  const app = /<application\b[^>]*>/.exec(out)[0];
  let newApp = app;
  if (/android:allowBackup="[^"]*"/.test(app)) newApp = app.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
  else newApp = app.replace('<application', '<application\n        android:allowBackup="false"');
  out = out.replace(app, newApp);

  // MainActivity android:windowSoftInputMode="adjustResize"
  const act = [...out.matchAll(/<activity\b[^>]*>/g)].map((m) => m[0]).find((a) => /android:name="[^"]*MainActivity"/.test(a));
  if (!act) throw new AnchorError('AndroidManifest.xml: the MainActivity <activity> element was not found');
  let newAct = act;
  if (/android:windowSoftInputMode="[^"]*"/.test(act)) newAct = act.replace(/android:windowSoftInputMode="[^"]*"/, 'android:windowSoftInputMode="adjustResize"');
  else newAct = act.replace('<activity', '<activity\n            android:windowSoftInputMode="adjustResize"');
  out = out.replace(act, newAct);

  // the foreground service
  if (!/android:name="[^"]*\.MediaPlaybackService"/.test(out)) {
    const svc = `        <service\n            android:name="${appId}.MediaPlaybackService"\n            android:exported="false"\n            android:foregroundServiceType="mediaPlayback" />\n`;
    out = out.replace("</application>", `\n${svc}    </application>`);
  }

  // permissions
  const missing = PERMISSIONS.filter((p) => !out.includes(`android:name="${p}"`));
  if (missing.length) out = out.replace('</manifest>', `${missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n')}\n</manifest>`);
  return out;
}

export function patchStyles(xml) {
  if (!/<resources[\s>]/.test(xml) || !xml.includes('</resources>')) throw new AnchorError('styles.xml: <resources> anchors not found');
  const styleRe = (name) => new RegExp(`(<style\\s+name="${name.replace('.', '\\.')}"[^>]*>)([\\s\\S]*?)(</style>)`);
  if (!styleRe('AppTheme.NoActionBar').test(xml)) throw new AnchorError('styles.xml: style AppTheme.NoActionBar not found (the theme BridgeActivity switches to after launch)');
  let out = xml;
  for (const name of ['AppTheme', 'AppTheme.NoActionBar']) {
    const re = styleRe(name);
    if (!re.test(out)) continue;
    out = out.replace(re, (_m, open, body, close) => {
      const add = THEME_ITEMS.filter(([n]) => !body.includes(`name="${n}"`)).map(([n, v]) => `        <item name="${n}">${v}</item>\n`).join('');
      if (!add) return _m;
      return `${open}${body.replace(/\s*$/, '\n')}${add}    ${close}`;
    });
  }
  return out;
}

export function patchMainActivity(java, plugin = PLUGIN) {
  if (!/extends\s+BridgeActivity/.test(java)) throw new AnchorError('MainActivity.java: does not extend BridgeActivity');
  let out = java;
  if (!out.includes(`registerPlugin(${plugin}.class)`)) {
    const reg = `        registerPlugin(${plugin}.class);`;
    if (/void\s+onCreate\s*\(\s*Bundle\s+\w+\s*\)\s*\{/.test(out)) {
      if (!/super\.onCreate\(/.test(out)) throw new AnchorError('MainActivity.java: onCreate has no super.onCreate call');
      out = out.replace(/(\n[ \t]*)super\.onCreate\(/, `\n${reg}$1super.onCreate(`);
    } else {
      const empty = /public class MainActivity extends BridgeActivity\s*\{\s*\}/;
      if (!empty.test(out)) throw new AnchorError('MainActivity.java: expected the empty template body `public class MainActivity extends BridgeActivity {}` or an onCreate(Bundle)');
      out = out.replace(empty, `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n${reg}\n        super.onCreate(savedInstanceState);\n    }\n}`);
    }
  }
  if (!out.includes('RunoutHost.install(this)')) {
    if (!/\n[ \t]*super\.onCreate\([^)]*\);/.test(out)) throw new AnchorError('MainActivity.java: no super.onCreate(...) statement to follow');
    out = out.replace(/(\n[ \t]*)(super\.onCreate\([^)]*\);)/, '$1$2$1RunoutHost.install(this);');
  }
  if (!/import\s+android\.os\.Bundle;/.test(out)) {
    if (!/import com\.getcapacitor\.BridgeActivity;/.test(out)) throw new AnchorError('MainActivity.java: BridgeActivity import not found');
    out = out.replace(/import com\.getcapacitor\.BridgeActivity;/, 'import android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;');
  }
  if (!out.includes(`registerPlugin(${plugin}.class)`) || !out.includes('RunoutHost.install(this)')) throw new AnchorError(`MainActivity.java: patch did not register ${plugin}`);
  return out;
}

export function retargetPackage(java, appId) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) throw new AnchorError(`bad appId ${appId}`);
  if (!/^package\s+[\w.]+;/m.test(java)) throw new AnchorError('plugin source has no package line');
  // the sources name each other by simple name (same package); only the package line and the literal action strings carry the appId
  return java.replace(/^package\s+[\w.]+;/m, `package ${appId};`).replace(/"com\.runout\.app\.playback\./g, `"${appId}.playback.`);
}

export async function apply(androidDir, { appId, nativeDir } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  nativeDir = nativeDir || join(here, '..', 'native', 'android-playback');
  if (!appId) appId = JSON.parse(await readFile(join(here, '..', 'capacitor.config.json'), 'utf8')).appId;
  const main = join(androidDir, 'app/src/main');
  const pkgDir = join(main, 'java', ...appId.split('.'));
  const read = async (p, what) => { try { return await readFile(p, 'utf8'); } catch { throw new AnchorError(`not found: ${p} (${what}; did \`cap add android\` run?)`); } };
  const manifest = await read(join(main, 'AndroidManifest.xml'), 'manifest');
  const styles = await read(join(main, 'res/values/styles.xml'), 'styles');
  const activity = await read(join(pkgDir, 'MainActivity.java'), `MainActivity, appId ${appId}`);

  // Compute every patch before writing anything, so a failed anchor leaves the tree untouched.
  const newManifest = patchManifest(manifest, appId);
  const newStyles = patchStyles(styles);
  const newActivity = patchMainActivity(activity);
  const have = new Set((await readdir(nativeDir)).filter((f) => f.endsWith('.java')));
  for (const f of SOURCES) if (!have.has(f)) throw new AnchorError(`native/android-playback/${f} is missing`);
  const copies = [];
  for (const f of SOURCES) copies.push([f, retargetPackage(await readFile(join(nativeDir, f), 'utf8'), appId)]);

  await mkdir(pkgDir, { recursive: true });
  for (const [f, src] of copies) await writeFile(join(pkgDir, f), src);
  await mkdir(join(main, 'res/drawable'), { recursive: true });
  await writeFile(join(main, 'res/drawable/ic_stat_runout.xml'), STAT_ICON);
  await writeFile(join(main, 'AndroidManifest.xml'), newManifest);
  await writeFile(join(main, 'res/values/styles.xml'), newStyles);
  await writeFile(join(pkgDir, 'MainActivity.java'), newActivity);
  return { appId, copied: copies.map(([f]) => f), manifestChanged: newManifest !== manifest, stylesChanged: newStyles !== styles, mainChanged: newActivity !== activity };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await apply(resolve(process.argv[2] || 'android'));
    console.log(`android playback: ${r.copied.join(', ')} -> ${r.appId}; manifest ${r.manifestChanged ? 'patched' : 'already patched'}, styles ${r.stylesChanged ? 'patched' : 'already patched'}, MainActivity ${r.mainChanged ? 'patched' : 'already patched'}`);
  } catch (e) {
    console.error(`::error::apply-android-playback failed: ${e.message}`);
    process.exit(1);
  }
}
