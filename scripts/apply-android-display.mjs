#!/usr/bin/env node
// apply-android-display.mjs — patch the GENERATED Capacitor Android project with the DeviceDisplay plugin (Device mode: keep the screen
// on, AOD brightness, preferred refresh rate). android/ is not committed; CI runs `cap add android`, then this, then `cap sync`.
//
//   node scripts/apply-android-display.mjs [androidDir]        (default ./android)
//
//   1. copies native/android-display/DeviceDisplayPlugin.java into app/src/main/java/<appId path>/ (package line retargeted to appId)
//   2. registers it in MainActivity (custom, non-npm plugins are registered in code BEFORE super.onCreate; capacitor.plugins.json only
//      lists npm plugins, so it is deliberately not touched)
//   No manifest change: FLAG_KEEP_SCREEN_ON, screenBrightness and preferredRefreshRate need no permission.
//
// Idempotent. Coexists with scripts/apply-android-plugins.mjs (device library) in either order: it handles the stock empty MainActivity and
// one that already has an onCreate that registers other plugins. FAILS LOUDLY (exit 1, `::error::` line naming the anchor) if the generated
// project no longer matches, so a Capacitor upgrade breaks CI visibly instead of shipping an APK without the plugin.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN = 'DeviceDisplayPlugin';
export class AnchorError extends Error {}

export function patchMainActivity(java, plugin = PLUGIN) {
  if (!/extends\s+BridgeActivity/.test(java)) throw new AnchorError('MainActivity.java: does not extend BridgeActivity');
  if (java.includes(`registerPlugin(${plugin}.class)`)) return java;
  const reg = `        registerPlugin(${plugin}.class);`;
  let out = java;
  if (/void\s+onCreate\s*\(\s*Bundle\s+\w+\s*\)\s*\{/.test(out)) {
    if (!/super\.onCreate\(/.test(out)) throw new AnchorError('MainActivity.java: onCreate has no super.onCreate call');
    out = out.replace(/(\n[ \t]*)super\.onCreate\(/, `\n${reg}$1super.onCreate(`);
  } else {
    const empty = /public class MainActivity extends BridgeActivity\s*\{\s*\}/;
    if (!empty.test(out)) throw new AnchorError('MainActivity.java: expected the empty template body `public class MainActivity extends BridgeActivity {}` or an onCreate(Bundle)');
    out = out.replace(empty, `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n${reg}\n        super.onCreate(savedInstanceState);\n    }\n}`);
  }
  if (!/import\s+android\.os\.Bundle;/.test(out)) {
    if (!/import com\.getcapacitor\.BridgeActivity;/.test(out)) throw new AnchorError('MainActivity.java: BridgeActivity import not found');
    out = out.replace(/import com\.getcapacitor\.BridgeActivity;/, 'import android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;');
  }
  if (!out.includes(`registerPlugin(${plugin}.class)`)) throw new AnchorError(`MainActivity.java: patch did not register ${plugin}`);
  return out;
}

export function retargetPackage(java, appId) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) throw new AnchorError(`bad appId ${appId}`);
  if (!/^package\s+[\w.]+;/m.test(java)) throw new AnchorError('plugin source has no package line');
  return java.replace(/^package\s+[\w.]+;/m, `package ${appId};`);
}

export async function apply(androidDir, { appId, nativeDir } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  nativeDir = nativeDir || join(here, '..', 'native', 'android-display');
  if (!appId) appId = JSON.parse(await readFile(join(here, '..', 'capacitor.config.json'), 'utf8')).appId;
  const pkgDir = join(androidDir, 'app/src/main/java', ...appId.split('.'));
  const mainPath = join(pkgDir, 'MainActivity.java');
  let main;
  try { main = await readFile(mainPath, 'utf8'); } catch { throw new AnchorError(`not found: ${mainPath} (appId ${appId}; did \`cap add android\` run?)`); }
  let src;
  try { src = await readFile(join(nativeDir, `${PLUGIN}.java`), 'utf8'); } catch { throw new AnchorError(`native/android-display/${PLUGIN}.java is missing`); }
  const newMain = patchMainActivity(main);          // every patch computed before anything is written
  const newSrc = retargetPackage(src, appId);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, `${PLUGIN}.java`), newSrc);
  await writeFile(mainPath, newMain);
  return { appId, mainChanged: newMain !== main };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await apply(resolve(process.argv[2] || 'android'));
    console.log(`android display: ${PLUGIN} -> ${r.appId}; MainActivity ${r.mainChanged ? 'patched' : 'already patched'}`);
  } catch (e) {
    console.error(`::error::apply-android-display failed: ${e.message}`);
    process.exit(1);
  }
}
