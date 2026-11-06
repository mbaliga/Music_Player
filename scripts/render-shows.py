#!/usr/bin/env python3
"""Pre-render canned radio shows (content/stations/*.json) to audio files.

    python3 scripts/render-shows.py --dry-run
    python3 scripts/render-shows.py --out render-out --only tape-hiss-fm
    python3 scripts/render-shows.py --only tape-hiss-fm/th-sign-on-1,fixture-fm

Everything at import time is standard library only (the pure parts are unit
tested in CI without Python packages). The TTS engines (`piper-tts`,
`kokoro-onnx`, `numpy`) are imported lazily, only when a line really has to be
synthesised. ffmpeg/ffprobe must be on PATH for real renders.

Pipeline per segment
  1. per line: synthesise raw speech  -> cache/raw/<key>.wav   (engine native rate)
  2. per line: resample to the working rate, apply pitch tweak, gain and the
     voice's own treatment (e.g. phone EQ for a caller)
  3. concatenate lines with pauses from pauseAfterMs (pure stdlib `wave`)
  4. station treatment (AM band-limit, lo-fi ...) -> loudness to LUFS target
     -> sample-peak limiter -> mono Opus (or AAC) with bit-exact flags
  5. measure the encoded file (duration, sha256, size, integrated loudness)
  6. write <out>/<station>/<segment>.opus and <out>/<station>/manifest.json

Segments that use runtime slots ({prevTitle} ...) cannot be pre-rendered and are
skipped (their slot-free twin, `fallbackOf`, is rendered).

Determinism: Piper's VITS model injects random noise, so two cold synthesis runs
of the same text differ. Output is therefore deterministic *given the cache*:
raw lines are synthesised once, keyed by content hash, and every later stage
(ffmpeg, libopus, manifest) is bit-exact. Commit nothing from the cache.
"""
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SCHEMA = 1
WORK_RATE = 24000

DEFAULT_TARGETS = {
    "lufs": -19.0,          # integrated loudness target for speech (EBU R128 scale)
    "truePeakDb": -2.0,     # sample-peak ceiling applied by the limiter
    "codec": "opus",        # opus | aac
    "bitrateKbps": 24,
    "opusApplication": "voip",
    "defaultPauseMs": 250,  # when a line has no pauseAfterMs
    "minGapMs": 80,         # floor between lines of one segment
    "maxPauseMs": 5000,
}

# ---------------------------------------------------------------- pure parts


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def merge_targets(cfg_targets):
    t = dict(DEFAULT_TARGETS)
    t.update(cfg_targets or {})
    return t


def resolve_voice(cfg, station_id, host):
    """Resolve the final voice settings for one host of one station.

    `host` is the station.hosts[] entry (id, role, voice hints). Lookup order for the
    assignment: "<station>/<host>" then "<host>" in cfg["hosts"]. Missing -> ValueError.
    Returned dict: engine, voiceId, speed, pitch, gainDb, treatment (name or None), lang.
    speed defaults to the content's rate hint (so the writers' pacing survives),
    pitch defaults to 1.0 (pitch hints are NOT auto-applied: pick a different voice).
    """
    hosts = (cfg or {}).get("hosts", {})
    hid = host["id"]
    a = hosts.get("%s/%s" % (station_id, hid), hosts.get(hid))
    if a is None:
        raise ValueError("no voice assignment for host %r in station %r" % (hid, station_id))
    for req in ("engine", "voiceId"):
        if not a.get(req):
            raise ValueError("assignment for %s/%s lacks %r" % (station_id, hid, req))
    hint = (host.get("voice") or {})
    speed = a.get("speed", hint.get("rate", 1.0))
    role_cfg = (cfg.get("roles") or {}).get(host.get("role"), {})
    return {
        "engine": a["engine"],
        "voiceId": a["voiceId"],
        "speed": round(clamp(float(speed), 0.5, 2.0), 4),
        "pitch": round(clamp(float(a.get("pitch", 1.0)), 0.7, 1.4), 4),
        "gainDb": round(clamp(float(a.get("gainDb", 0.0)), -24.0, 24.0), 3),
        "treatment": a.get("treatment", role_cfg.get("treatment")),
        "lang": a.get("lang"),
    }


def station_treatment(cfg, station_id):
    return ((cfg.get("stations") or {}).get(station_id) or {}).get("treatment")


def pause_ms(line, targets):
    """Silence after a line: pauseAfterMs (default if absent), clamped, floored by minGapMs."""
    p = line.get("pauseAfterMs")
    if p is None or isinstance(p, bool) or not isinstance(p, (int, float)):
        p = targets["defaultPauseMs"]
    return int(clamp(max(p, targets["minGapMs"]), 0, targets["maxPauseMs"]))


def pause_frames(ms, rate):
    return int(round(ms * rate / 1000.0))


def pitch_filter(pitch, rate=WORK_RATE):
    """ffmpeg filter that shifts pitch by factor `pitch` while keeping duration
    (resample trick: change the rate, bring it back, undo the tempo change)."""
    if abs(pitch - 1.0) < 1e-4:
        return None
    return "asetrate=%d,aresample=%d,atempo=%.6f" % (round(rate * pitch), rate, 1.0 / pitch)


def gain_to_target(measured_lufs, target_lufs, max_abs_db=30.0):
    """dB of gain to bring a measured integrated loudness to the target.
    Returns None when the signal is silent/unmeasurable."""
    if measured_lufs is None or not math.isfinite(measured_lufs):
        return None
    return clamp(target_lufs - measured_lufs, -max_abs_db, max_abs_db)


def db_to_lin(db):
    return 10.0 ** (db / 20.0)


def is_slotted(seg):
    if seg.get("usesSlots"):
        return True
    return any(re.search(r"\{[A-Za-z]+\}", l.get("text", "")) for l in seg.get("lines", []))


def raw_key(engine, engine_ver, voice_id, speed, text, lang):
    return sha256_text(canonical({"s": SCHEMA, "e": engine, "ev": engine_ver, "v": voice_id,
                                  "sp": speed, "t": text, "l": lang}))


def segment_key(line_specs, st_filters, targets):
    """line_specs: list of dicts {raw, pitch, gainDb, filters, pauseMs}. Changes in any of
    these (or targets/encoder settings) re-encode that segment; unchanged ones are skipped."""
    t = {k: targets[k] for k in ("lufs", "truePeakDb", "codec", "bitrateKbps", "opusApplication")}
    return sha256_text(canonical({"s": SCHEMA, "lines": line_specs, "st": st_filters, "t": t}))


def build_manifest(station_id, entries, targets):
    """Deterministic: sorted by segment id, no timestamps, no absolute paths."""
    segs = sorted(entries, key=lambda e: e["id"])
    return {
        "v": SCHEMA,
        "station": station_id,
        "codec": targets["codec"],
        "bitrateKbps": targets["bitrateKbps"],
        "targetLufs": targets["lufs"],
        "segments": segs,
    }


def dump_manifest(m):
    return json.dumps(m, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def select(only, station_id, seg_id):
    """--only filters: tokens 'station' or 'station/segment' (comma separated / repeated)."""
    if not only:
        return True
    for tok in only:
        if tok == station_id or tok == "%s/%s" % (station_id, seg_id):
            return True
    return False


def estimate_bytes(sec, targets):
    return int(sec * targets["bitrateKbps"] * 1000 / 8 * 1.03)  # ~3% container overhead (estimate)


def estimate_seconds(seg, rate_by_host):
    """Rough speaking time for dry runs: ~15 chars/s at speed 1.0 plus pauses."""
    t = 0.0
    for l in seg.get("lines", []):
        sp = rate_by_host.get(l.get("host"), 1.0) or 1.0
        t += len(l.get("text", "")) / 15.0 / sp + (l.get("pauseAfterMs") or 250) / 1000.0
    return t


def mb_per_hour(total_bytes, total_sec):
    return (total_bytes / 1e6) / (total_sec / 3600.0) if total_sec > 0 else 0.0


def concat_pcm(parts, rate):
    """parts: list of (bytes int16 mono, pause_ms). Trailing pause of the last part is dropped.
    Returns bytes."""
    out = []
    for i, (pcm, pms) in enumerate(parts):
        out.append(pcm)
        if i < len(parts) - 1:
            out.append(b"\x00\x00" * pause_frames(pms, rate))
    return b"".join(out)


# ----------------------------------------------------------------- ffmpeg io


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def ff(*args):
    return run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error"] + list(args))


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "expected mono 16-bit"
        return w.readframes(w.getnframes()), w.getframerate()


def write_wav(path, pcm, rate):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def measure_lufs(path):
    """Integrated loudness via ffmpeg loudnorm (analysis only). None if silent."""
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-af",
                        "loudnorm=I=-19:TP=-2:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr, re.S)
    if not m:
        return None
    try:
        v = float(json.loads(m.group(0))["input_i"])
    except (ValueError, KeyError):
        return None
    return v if math.isfinite(v) else None


def probe_duration(path):
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(p.stdout.decode().strip())


def treatment_chain(cfg, name):
    """-> (filters string or '', noise dict or None)."""
    if not name:
        return "", None
    t = (cfg.get("treatments") or {}).get(name)
    if t is None:
        raise ValueError("unknown treatment %r" % name)
    return t.get("filters", ""), t.get("noise")


# ------------------------------------------------------------------- engines


class Engines:
    """Lazy engine registry. Layout under voices_dir:
         piper/<voice>.onnx(+.onnx.json)      voiceId 'en_GB-cori-medium' or '...#<speakerId>'
         kokoro/model.onnx, kokoro/voices/<name>.bin
           voiceId 'af_heart' or blend 'af_heart:0.6+af_nicole:0.4'
    """

    def __init__(self, voices_dir):
        self.dir = Path(voices_dir)
        self._piper = {}
        self._kokoro = None
        self._kvoices = {}

    def version(self, engine):
        try:
            from importlib.metadata import version
            return {"piper": "piper-tts-" + version("piper-tts"),
                    "kokoro": "kokoro-onnx-" + version("kokoro-onnx")}[engine]
        except Exception:
            return engine + "-unknown"

    def synth(self, engine, voice_id, speed, text, lang):
        """-> (int16 mono PCM bytes, sample_rate)"""
        if engine == "piper":
            return self._piper_synth(voice_id, speed, text)
        if engine == "kokoro":
            return self._kokoro_synth(voice_id, speed, text, lang)
        raise ValueError("unknown engine %r" % engine)

    def _piper_synth(self, voice_id, speed, text):
        from piper import PiperVoice, SynthesisConfig
        name, _, sid = voice_id.partition("#")
        if name not in self._piper:
            self._piper[name] = PiperVoice.load(str(self.dir / "piper" / (name + ".onnx")))
        v = self._piper[name]
        cfg = SynthesisConfig(speaker_id=int(sid) if sid else None, length_scale=1.0 / speed)
        pcm = b"".join(c.audio_int16_bytes for c in v.synthesize(text, cfg))
        return pcm, v.config.sample_rate

    def _kokoro_style(self, voice_id):
        import numpy as np
        if voice_id in self._kvoices:
            return self._kvoices[voice_id]
        acc = None
        for part in voice_id.split("+"):
            n, _, w = part.partition(":")
            a = np.fromfile(str(self.dir / "kokoro" / "voices" / (n + ".bin")), dtype=np.float32).reshape(-1, 1, 256)
            a = a * (float(w) if w else 1.0)
            acc = a if acc is None else acc + a
        self._kvoices[voice_id] = acc
        return acc

    def _kokoro_synth(self, voice_id, speed, text, lang):
        import numpy as np
        if self._kokoro is None:
            from kokoro_onnx import Kokoro
            kd = self.dir / "kokoro"
            model = kd / "model.onnx"
            # voices arg is only used when no style array is passed; give it an empty npz-free path
            self._kokoro = Kokoro(str(model), str(self._voices_npz(kd)))
        if lang is None:
            lang = "en-gb" if voice_id[:1] == "b" else "en-us"
        a, sr = self._kokoro.create(text, voice=self._kokoro_style(voice_id), speed=speed, lang=lang)
        pcm = (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        return pcm, sr

    @staticmethod
    def _voices_npz(kd):
        import numpy as np
        p = kd / "voices.npz"
        if not p.exists():
            d = {f.stem: np.fromfile(str(f), dtype=np.float32).reshape(-1, 1, 256)
                 for f in sorted((kd / "voices").glob("*.bin"))}
            np.savez(str(p), **d)
        return p


# ------------------------------------------------------------------- driver


def load_stations(stations_dir):
    out = []
    for f in sorted(Path(stations_dir).glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if isinstance(d, dict) and "station" in d and "segments" in d:
            out.append(d)
    return out


def plan_station(st, cfg, targets, only):
    """Resolve voices for a station and list the segments to render/skip. Pure."""
    sid = st["station"]["id"]
    hosts = {h["id"]: h for h in st["station"]["hosts"]}
    voices = {}
    errors = []
    for hid, h in hosts.items():
        try:
            voices[hid] = resolve_voice(cfg, sid, h)
        except ValueError as e:
            errors.append(str(e))
    todo, skipped = [], []
    for seg in st["segments"]:
        if not select(only, sid, seg["id"]):
            continue
        if is_slotted(seg):
            skipped.append(seg["id"])
        else:
            todo.append(seg)
    return sid, voices, todo, skipped, errors


def render_segment(seg, sid, voices, cfg, targets, engines, cache, out_dir, force, tmp, log):
    line_specs, raws = [], []
    st_name = station_treatment(cfg, sid)
    st_filters, st_noise = treatment_chain(cfg, st_name)
    for l in seg["lines"]:
        v = voices[l["host"]]
        ver = engines.version(v["engine"]) if engines else "dry"
        rk = raw_key(v["engine"], ver, v["voiceId"], v["speed"], l["text"], v["lang"])
        vf, _ = treatment_chain(cfg, v["treatment"])
        line_specs.append({"raw": rk, "pitch": v["pitch"], "gainDb": v["gainDb"], "vf": vf,
                           "pauseMs": pause_ms(l, targets)})
        raws.append((rk, v, l))
    skey = segment_key(line_specs, [st_filters, st_noise], targets)
    ext = "opus" if targets["codec"] == "opus" else "m4a"
    dest = Path(out_dir) / sid / ("%s.%s" % (seg["id"], ext))
    prev = cache.get("segments", {}).get(sid + "/" + seg["id"])
    if not force and prev and prev["key"] == skey and dest.exists():
        return dict(prev["entry"]), "cached"

    # 1-3: lines -> one working wav
    parts = []
    for i, (rk, v, l) in enumerate(raws):
        rawp = cache["dir"] / "raw" / (rk + ".wav")
        if not rawp.exists():
            pcm, sr = engines.synth(v["engine"], v["voiceId"], v["speed"], l["text"], v["lang"])
            rawp.parent.mkdir(parents=True, exist_ok=True)
            write_wav(rawp.with_suffix(".tmp"), pcm, sr)
            os.replace(rawp.with_suffix(".tmp"), rawp)
            log("    synth %-8s %-22s %3d chars" % (v["engine"], v["voiceId"][:22], len(l["text"])))
        chain = ["aresample=%d" % WORK_RATE]
        pf = pitch_filter(v["pitch"])
        if pf:
            chain.append(pf)
        if line_specs[i]["vf"]:
            chain.append(line_specs[i]["vf"])
        chain.append("volume=%sdB" % v["gainDb"])
        lp = Path(tmp) / ("line%03d.wav" % i)
        ff("-i", str(rawp), "-af", ",".join(chain), "-ac", "1", "-ar", str(WORK_RATE), "-c:a", "pcm_s16le", str(lp))
        pcm, _ = read_wav(lp)
        parts.append((pcm, line_specs[i]["pauseMs"]))
    work = Path(tmp) / "work.wav"
    joined = concat_pcm(parts, WORK_RATE)
    write_wav(work, joined, WORK_RATE)
    dur = len(joined) / 2 / WORK_RATE

    # 4a: station treatment (+ optional deterministic noise bed)
    treated = Path(tmp) / "treated.wav"
    if st_filters or st_noise:
        fc = "[0:a]%s[v]" % (st_filters or "anull")
        if st_noise:
            fc += ";anoisesrc=d=%.3f:c=%s:r=%d:a=%s:seed=7,%s[n];[v][n]amix=inputs=2:duration=first:normalize=0[o]" % (
                dur, st_noise.get("color", "pink"), WORK_RATE, st_noise.get("amp", 0.003),
                st_noise.get("filters", "anull"))
        else:
            fc = fc.replace("[v]", "[o]")
        ff("-i", str(work), "-filter_complex", fc, "-map", "[o]", "-ac", "1", "-ar", str(WORK_RATE),
           "-c:a", "pcm_s16le", str(treated))
    else:
        treated = work
    # 4b: loudness gain from measurement, then limiter, then encode (bit-exact)
    g = gain_to_target(measure_lufs(treated), targets["lufs"])
    lim = "alimiter=limit=%.4f:level=disabled:attack=5:release=50" % db_to_lin(targets["truePeakDb"])
    af = ("volume=%.3fdB," % g if g is not None else "") + lim
    enc = ["-i", str(treated), "-af", af, "-ac", "1", "-map_metadata", "-1",
           "-fflags", "+bitexact", "-flags:a", "+bitexact"]
    if targets["codec"] == "opus":
        enc += ["-c:a", "libopus", "-b:a", "%dk" % targets["bitrateKbps"], "-vbr", "on",
                "-application", targets["opusApplication"], "-ar", str(WORK_RATE)]
    else:
        enc += ["-c:a", "aac", "-b:a", "%dk" % targets["bitrateKbps"], "-movflags", "+faststart"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    ff(*(enc + [str(dest)]))
    data = dest.read_bytes()
    lufs = measure_lufs(dest)
    entry = {
        "id": seg["id"], "kind": seg.get("kind"), "file": "%s.%s" % (seg["id"], ext),
        "durationSec": round(probe_duration(dest), 3),
        "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
        "lufs": round(lufs, 1) if lufs is not None else None,
    }
    cache.setdefault("segments", {})[sid + "/" + seg["id"]] = {"key": skey, "entry": entry}
    return entry, "rendered"


def main(argv=None):
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--stations", default=str(root / "content" / "stations"))
    ap.add_argument("--voices", default=str(root / "content" / "voices.json"), help="voice assignment file")
    ap.add_argument("--models", default=os.environ.get("RUNOUT_VOICES_DIR", str(Path.home() / ".cache" / "runout-voices")),
                    help="engine model directory (piper/, kokoro/); env RUNOUT_VOICES_DIR")
    ap.add_argument("--out", default=str(root / "render-out"))
    ap.add_argument("--cache", default=str(root / ".render-cache"))
    ap.add_argument("--only", action="append", default=[], help="station or station/segment (repeat or comma-separate)")
    ap.add_argument("--dry-run", action="store_true", help="plan + estimates; no synthesis, no ffmpeg")
    ap.add_argument("--force", action="store_true", help="re-encode every segment (raw lines stay cached)")
    ap.add_argument("--bitrate", type=int, help="override kbps")
    ap.add_argument("--codec", choices=["opus", "aac"])
    a = ap.parse_args(argv)
    only = [t for x in a.only for t in x.split(",") if t]

    cfg = json.loads(Path(a.voices).read_text(encoding="utf-8"))
    targets = merge_targets(cfg.get("targets"))
    if a.bitrate:
        targets["bitrateKbps"] = a.bitrate
    if a.codec:
        targets["codec"] = a.codec
    stations = load_stations(a.stations)
    if not stations:
        print("no stations found in", a.stations, file=sys.stderr)
        return 1
    if not a.dry_run:
        for tool in ("ffmpeg", "ffprobe"):
            if not shutil.which(tool):
                print("%s not found on PATH" % tool, file=sys.stderr)
                return 2

    cache_dir = Path(a.cache)
    cache = {"dir": cache_dir, "segments": {}}
    idx = cache_dir / "segments.json"
    if idx.exists() and not a.dry_run:
        try:
            cache["segments"] = json.loads(idx.read_text())
        except ValueError:
            pass
    engines = None if a.dry_run else Engines(a.models)
    log = lambda s: print(s, flush=True)
    tot = {"sec": 0.0, "bytes": 0, "segs": 0, "cached": 0, "skipped": 0}
    rc = 0
    for st in stations:
        sid, voices, todo, skipped, errors = plan_station(st, cfg, targets, only)
        if only and not todo and not skipped:
            continue
        log("== %s: %d to render, %d slotted skipped" % (sid, len(todo), len(skipped)))
        for e in errors:
            print("  ERROR:", e, file=sys.stderr)
            rc = 1
        if errors:
            continue
        tot["skipped"] += len(skipped)
        entries = []
        if a.dry_run:
            rates = {h: v["speed"] for h, v in voices.items()}
            for seg in todo:
                sec = estimate_seconds(seg, rates)
                chars = sum(len(l["text"]) for l in seg["lines"])
                tot["sec"] += sec
                tot["bytes"] += estimate_bytes(sec, targets)
                tot["segs"] += 1
                log("  %-28s %-11s %2d lines %5d chars ~%5.1fs" % (seg["id"], seg.get("kind"), len(seg["lines"]), chars, sec))
            for hid, v in sorted(voices.items()):
                log("  voice %-10s -> %s:%s speed %.2f pitch %.2f gain %+.1f dB treatment %s" % (
                    hid, v["engine"], v["voiceId"], v["speed"], v["pitch"], v["gainDb"], v["treatment"]))
            continue
        for seg in todo:
            with tempfile.TemporaryDirectory(prefix="runout-render-") as tmp:
                try:
                    r = render_segment(seg, sid, voices, cfg, targets, engines, cache,
                                       a.out, a.force, tmp, log)
                except subprocess.CalledProcessError as e:
                    print("  FAIL %s: %s" % (seg["id"], (e.stderr or b"").decode()[-300:]), file=sys.stderr)
                    rc = 1
                    continue
            entry, how = r if isinstance(r, tuple) else (r, "rendered")
            entries.append(entry)
            tot["segs"] += 1
            tot["sec"] += entry["durationSec"]
            tot["bytes"] += entry["bytes"]
            tot["cached"] += how == "cached"
            log("  %-8s %-28s %6.1fs %7d B %s LUFS" % (how, seg["id"], entry["durationSec"], entry["bytes"], entry["lufs"]))
        if entries:
            # manifest merges with prior entries for segments not selected this run
            mpath = Path(a.out) / sid / "manifest.json"
            old = {}
            if mpath.exists():
                try:
                    old = {e["id"]: e for e in json.loads(mpath.read_text())["segments"]}
                except (ValueError, KeyError):
                    old = {}
            old.update({e["id"]: e for e in entries})
            mpath.parent.mkdir(parents=True, exist_ok=True)
            mpath.write_text(dump_manifest(build_manifest(sid, list(old.values()), targets)), encoding="utf-8")
    if not a.dry_run:
        cache_dir.mkdir(parents=True, exist_ok=True)
        idx.write_text(canonical(cache["segments"]), encoding="utf-8")
    hrs = tot["sec"] / 3600.0
    log("-- %s: %d segments (%d cached), %d slotted skipped, %.1f min speech, %.1f MB, %.1f MB/hour @ %d kbps %s" % (
        "estimate (dry run)" if a.dry_run else "total", tot["segs"], tot["cached"], tot["skipped"],
        tot["sec"] / 60.0, tot["bytes"] / 1e6, mb_per_hour(tot["bytes"], tot["sec"]),
        targets["bitrateKbps"], targets["codec"]))
    return rc


if __name__ == "__main__":
    sys.exit(main())
