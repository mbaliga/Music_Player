// SPIKE P1 -- THROWAWAY. Patches a freshly generated Capacitor Android project (after `cap add android`)
// for the radio background-audio spike. Idempotent; fails loudly if an anchor is missing so CI shows it.
//   node spike/radio-p1/android/apply-spike.mjs <androidDir>
// Exports pure helpers so the string surgery is unit-tested against a fixture manifest.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.WAKE_LOCK',
  'android.permission.POST_NOTIFICATIONS',
];
const SERVICE_XML = '<service android:name=".SpikeForegroundService" android:exported="false" android:foregroundServiceType="mediaPlayback" />';

export function patchManifest(xml) {
  let out = xml;
  if (!/<manifest[\s>]/.test(out) || !out.includes('</application>')) throw new Error('AndroidManifest anchors not found (<manifest>, </application>)');
  const missing = PERMISSIONS.filter((p) => !out.includes(`android:name="${p}"`));
  if (missing.length) {
    const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
    out = out.replace('</manifest>', `${lines}\n</manifest>`);
  }
  if (!out.includes('.SpikeForegroundService')) out = out.replace('</application>', `        ${SERVICE_XML}\n    </application>`);
  return out;
}

export function patchMainActivity(java) {
  if (java.includes('SpikeBackgroundPlugin')) return java;
  if (!/extends\s+BridgeActivity/.test(java)) throw new Error('MainActivity does not extend BridgeActivity');
  // Capacitor 6: custom plugins are registered before super.onCreate.
  return java
    .replace(/import com\.getcapacitor\.BridgeActivity;/, 'import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;')
    .replace(/public class MainActivity extends BridgeActivity\s*\{\s*\}/,
      'public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(SpikeBackgroundPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n}');
}

/** The checked-in Java declares package com.runout.app; retarget it to whatever appId the build uses. */
export function retargetPackage(java, appId) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) throw new Error(`bad appId ${appId}`);
  return java.replace(/^package\s+[\w.]+;/m, `package ${appId};`);
}

async function main(androidDir, appId) {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(androidDir, 'app/src/main/AndroidManifest.xml');
  await writeFile(manifestPath, patchManifest(await readFile(manifestPath, 'utf8')));
  const pkgDir = join(androidDir, 'app/src/main/java', ...appId.split('.'));
  await mkdir(pkgDir, { recursive: true });
  for (const f of ['SpikeForegroundService.java', 'SpikeBackgroundPlugin.java']) {
    await writeFile(join(pkgDir, f), retargetPackage(await readFile(join(here, 'java', f), 'utf8'), appId));
  }
  const mainPath = join(pkgDir, 'MainActivity.java');
  const patched = patchMainActivity(await readFile(mainPath, 'utf8'));
  if (!patched.includes('registerPlugin(SpikeBackgroundPlugin.class)')) throw new Error('MainActivity patch did not apply (template changed?)');
  await writeFile(mainPath, patched);
  console.log(`radio spike: patched manifest + MainActivity, copied service + plugin into ${appId}`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = JSON.parse(await readFile(resolve('capacitor.config.json'), 'utf8'));
  await main(resolve(process.argv[2] || 'android'), cfg.appId);
}
