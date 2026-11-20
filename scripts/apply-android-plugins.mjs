#!/usr/bin/env node
// apply-android-plugins.mjs — patch the GENERATED Capacitor Android project (android/ is not committed;
// CI runs `cap add android`, then this, then `cap sync`) with Runout's own native plugins.
//
//   node scripts/apply-android-plugins.mjs [androidDir]        (default ./android)
//
// What it does (idempotent: run it twice, get the same tree):
//   1. copies native/android/*.java into app/src/main/java/<appId path>/ (retargeting the `package` line to appId)
//   2. adds the audio-library permissions to AndroidManifest.xml
//        READ_MEDIA_AUDIO (API 33+) and READ_EXTERNAL_STORAGE with maxSdkVersion=32. Nothing broader:
//        no MANAGE_EXTERNAL_STORAGE, no READ_MEDIA_IMAGES/VIDEO.
//   3. registers the plugin classes in MainActivity (custom, non-npm plugins are registered in code
//      BEFORE super.onCreate; they are not listed in capacitor.plugins.json, which only covers npm plugins)
//
// It FAILS LOUDLY (non-zero exit, message naming the anchor) if the generated project no longer looks like
// the template this was written against, so a Capacitor upgrade breaks CI visibly instead of shipping an
// APK with no device library.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGINS = ['DeviceLibraryPlugin'];

export const PERMISSION_LINES = [
  '<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
];

const permName = (line) => /android:name="([^"]+)"/.exec(line)[1];

export class AnchorError extends Error {}

export function patchManifest(xml) {
  if (!/<manifest[\s>]/.test(xml) || !xml.includes('</manifest>')) {
    throw new AnchorError('AndroidManifest.xml: <manifest> ... </manifest> anchors not found');
  }
  const missing = PERMISSION_LINES.filter((l) => !xml.includes(`android:name="${permName(l)}"`));
  if (!missing.length) return xml;
  const block = missing.map((l) => `    ${l}`).join('\n');
  return xml.replace('</manifest>', `${block}\n</manifest>`);
}

export function patchMainActivity(java, plugins = PLUGINS) {
  if (!/extends\s+BridgeActivity/.test(java)) throw new AnchorError('MainActivity.java: does not extend BridgeActivity');
  const todo = plugins.filter((p) => !java.includes(`registerPlugin(${p}.class)`));
  if (!todo.length) return java;
  const regs = todo.map((p) => `        registerPlugin(${p}.class);`).join('\n');
  let out = java;
  if (/void\s+onCreate\s*\(\s*Bundle\s+\w+\s*\)\s*\{/.test(out)) {
    // An onCreate already exists: register ahead of its super.onCreate call.
    if (!/super\.onCreate\(/.test(out)) throw new AnchorError('MainActivity.java: onCreate has no super.onCreate call');
    out = out.replace(/(\n[ \t]*)super\.onCreate\(/, `\n${regs}$1super.onCreate(`);
  } else {
    // The stock template: an empty class body.
    const empty = /public class MainActivity extends BridgeActivity\s*\{\s*\}/;
    if (!empty.test(out)) throw new AnchorError('MainActivity.java: expected the empty template body `public class MainActivity extends BridgeActivity {}` or an onCreate(Bundle)');
    out = out.replace(empty,
      `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n${regs}\n        super.onCreate(savedInstanceState);\n    }\n}`);
  }
  if (!/import\s+android\.os\.Bundle;/.test(out)) {
    if (!/import com\.getcapacitor\.BridgeActivity;/.test(out)) throw new AnchorError('MainActivity.java: BridgeActivity import not found');
    out = out.replace(/import com\.getcapacitor\.BridgeActivity;/, 'import android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;');
  }
  for (const p of todo) {
    if (!out.includes(`registerPlugin(${p}.class)`)) throw new AnchorError(`MainActivity.java: patch did not register ${p}`);
  }
  return out;
}

/** The checked-in Java declares package com.runout.app; retarget it to the appId the build uses. */
export function retargetPackage(java, appId) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) throw new AnchorError(`bad appId ${appId}`);
  if (!/^package\s+[\w.]+;/m.test(java)) throw new AnchorError('plugin source has no package line');
  return java.replace(/^package\s+[\w.]+;/m, `package ${appId};`);
}

export async function apply(androidDir, { appId, nativeDir } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  nativeDir = nativeDir || join(here, '..', 'native', 'android');
  if (!appId) appId = JSON.parse(await readFile(join(here, '..', 'capacitor.config.json'), 'utf8')).appId;
  const manifestPath = join(androidDir, 'app/src/main/AndroidManifest.xml');
  const pkgDir = join(androidDir, 'app/src/main/java', ...appId.split('.'));
  const mainPath = join(pkgDir, 'MainActivity.java');

  let manifest, main;
  try { manifest = await readFile(manifestPath, 'utf8'); } catch { throw new AnchorError(`not found: ${manifestPath} (did \`cap add android\` run?)`); }
  try { main = await readFile(mainPath, 'utf8'); } catch { throw new AnchorError(`not found: ${mainPath} (appId ${appId}; did \`cap add android\` run?)`); }

  // Compute every patch before writing anything, so a failed anchor leaves the tree untouched.
  const newManifest = patchManifest(manifest);
  const newMain = patchMainActivity(main);
  const sources = (await readdir(nativeDir)).filter((f) => f.endsWith('.java')).sort();
  for (const p of PLUGINS) if (!sources.includes(`${p}.java`)) throw new AnchorError(`native/android/${p}.java is missing`);
  const copies = [];
  for (const f of sources) copies.push([f, retargetPackage(await readFile(join(nativeDir, f), 'utf8'), appId)]);

  await mkdir(pkgDir, { recursive: true });
  for (const [f, src] of copies) await writeFile(join(pkgDir, f), src);
  await writeFile(manifestPath, newManifest);
  await writeFile(mainPath, newMain);
  return { appId, copied: copies.map(([f]) => f), manifestChanged: newManifest !== manifest, mainChanged: newMain !== main };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await apply(resolve(process.argv[2] || 'android'));
    console.log(`android plugins: ${r.copied.join(', ')} -> ${r.appId}; manifest ${r.manifestChanged ? 'patched' : 'already patched'}, MainActivity ${r.mainChanged ? 'patched' : 'already patched'}`);
  } catch (e) {
    console.error(`::error::apply-android-plugins failed: ${e.message}`);
    process.exit(1);
  }
}
