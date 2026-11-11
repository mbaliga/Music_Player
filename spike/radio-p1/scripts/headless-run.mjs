// SPIKE P1 -- THROWAWAY. Drives web/index.html in headless Chromium (Playwright) with FAKE media devices.
//   node spike/radio-p1/scripts/headless-run.mjs [outfile.json]
// Needs playwright + a chromium (PLAYWRIGHT_BROWSERS_PATH). In this sandbox: /opt/node-tools/node_modules/playwright
// and /opt/pw-browsers. What this CAN show: the harness runs end to end, constraints are accepted, the
// pipeline's own timing overhead, the browser's reported AudioContext numbers. What it CANNOT show:
// anything acoustic -- the fake mic is not coupled to any speaker, so echo/AEC and real latency are NOT measured.
import http from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utterance, noise } from '../lib/synth.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright';
const { chromium } = require(pwPath);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const body = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// WAV the fake mic will loop: 3 utterances separated by silence (48 kHz mono PCM16).
function wav(f32, sr) {
  const b = Buffer.alloc(44 + f32.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + f32.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(f32.length * 2, 40);
  f32.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return b;
}
const dir = await mkdtemp(join(tmpdir(), 'p1-'));
const u = utterance(48000, { leadMs: 600, speechMs: 1200, trailMs: 1400, seed: 4 });
const wavPath = join(dir, 'mic.wav');
await writeFile(wavPath, wav(u.samples, 48000));

const silentPath = join(dir, 'quiet.wav'); // -60 dBFS noise, NOT digital silence (digital silence makes the noise floor -180 dB and the metrics degenerate)
await writeFile(silentPath, wav(noise(48000, 6000, -60, 5), 48000));
const out = { runAt: new Date().toISOString(), conditions: 'headless Chromium, fake media device (looped synthetic WAV or -60 dBFS noise), NO acoustic coupling, sandbox VM (not a phone)', checks: {} };

async function session(wavFile, fn) {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wavFile}`, '--autoplay-policy=no-user-gesture-required'] });
  out.browser = browser.version();
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { out.checks.pageErrors = [...(out.checks.pageErrors || []), String(e)]; });
  await page.goto(`http://localhost:${port}/spike/radio-p1/web/index.html`);
  await page.waitForFunction(() => window.__spike);
  try { await fn(page); } finally { await browser.close(); }
}

// Session A: quiet-noise (-60 dBFS) fake mic. NULL CONTROL for the echo harness (nothing is coupled, so the verdict must be clean),
// plus POSITIVE CONTROLS using an in-page simulated echo path (proves the harness detects a known echo; says nothing about AEC).
await session(silentPath, async (page) => {
  out.checks.env = await page.evaluate(() => window.__spike.probeEnv());
  out.checks.echoNullControl = await page.evaluate(() => window.__spike.runEcho({ playSec: 3 }));
  out.checks.echoPositiveControls = [];
  for (const sim of [{ delayMs: 60, gainDb: -20, noiseDb: -60 }, { delayMs: 120, gainDb: -35, noiseDb: -60 }, { delayMs: 60, gainDb: -50, noiseDb: -60 }]) {
    const rows = await page.evaluate((s) => window.__spike.runEcho({ sim: s, playSec: 3 }), sim);
    out.checks.echoPositiveControls.push({ truth: sim, measured: rows[0].metrics, verdict: rows[0].verdict });
  }
  await page.evaluate(() => window.__spike.startBg());
  await page.waitForTimeout(12000);
  out.checks.background = await page.evaluate(async () => { await window.__spike.stopBg(); return window.__spike.RESULTS.background; });
});

// Session B: speech-like fake mic. Live turns: real getUserMedia -> worklet -> VAD -> FAKE stages -> WebAudio playback.
await session(wavPath, async (page) => {
  await page.fill('#turns', '5');
  const rep = await page.evaluate(() => window.__spike.runLive());
  out.checks.live = { rows: rep.rows.map((r) => ({ id: r.id, p50: r.p50, p95: r.p95, n: r.n, provenance: r.provenance })), total: rep.total, allStagesMeasured: rep.allStagesMeasured };
});
server.close();

const target = process.argv[2];
if (target) await writeFile(target, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
