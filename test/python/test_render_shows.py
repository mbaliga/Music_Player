"""Unit tests for the pure parts of scripts/render-shows.py (stdlib only; no TTS, no ffmpeg)."""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("render_shows", ROOT / "scripts" / "render-shows.py")
rs = importlib.util.module_from_spec(spec)
sys.modules["render_shows"] = rs
spec.loader.exec_module(rs)

HOST = {"id": "wren", "role": "host", "voice": {"rate": 0.92, "pitch": 0.95}}
CFG = {
    "roles": {"caller": {"treatment": "phone"}},
    "hosts": {
        "wren": {"engine": "kokoro", "voiceId": "af_nicole"},
        "s1/wren": {"engine": "piper", "voiceId": "x", "speed": 1.1, "pitch": 0.9, "gainDb": -3},
    },
}
T = rs.merge_targets({})


class Resolve(unittest.TestCase):
    def test_station_specific_beats_generic(self):
        v = rs.resolve_voice(CFG, "s1", HOST)
        self.assertEqual((v["engine"], v["voiceId"], v["speed"], v["pitch"], v["gainDb"]), ("piper", "x", 1.1, 0.9, -3.0))

    def test_generic_and_hint_rate_default(self):
        v = rs.resolve_voice(CFG, "other", HOST)
        self.assertEqual(v["voiceId"], "af_nicole")
        self.assertEqual(v["speed"], 0.92)   # from the content rate hint
        self.assertEqual(v["pitch"], 1.0)    # pitch hint is NOT auto-applied

    def test_role_treatment_default(self):
        v = rs.resolve_voice(CFG, "other", dict(HOST, role="caller"))
        self.assertEqual(v["treatment"], "phone")

    def test_missing_assignment_raises(self):
        with self.assertRaises(ValueError):
            rs.resolve_voice(CFG, "s", {"id": "nobody"})

    def test_clamps(self):
        c = {"hosts": {"h": {"engine": "e", "voiceId": "v", "speed": 9, "pitch": 0.1, "gainDb": 99}}}
        v = rs.resolve_voice(c, "s", {"id": "h"})
        self.assertEqual((v["speed"], v["pitch"], v["gainDb"]), (2.0, 0.7, 24.0))


class Maths(unittest.TestCase):
    def test_pause(self):
        self.assertEqual(rs.pause_ms({"pauseAfterMs": 600}, T), 600)
        self.assertEqual(rs.pause_ms({}, T), T["defaultPauseMs"])
        self.assertEqual(rs.pause_ms({"pauseAfterMs": 0}, T), T["minGapMs"])
        self.assertEqual(rs.pause_ms({"pauseAfterMs": 99999}, T), T["maxPauseMs"])
        self.assertEqual(rs.pause_ms({"pauseAfterMs": True}, T), T["defaultPauseMs"])

    def test_pause_frames_and_concat(self):
        self.assertEqual(rs.pause_frames(500, 24000), 12000)
        a, b = b"\x01\x00" * 10, b"\x02\x00" * 5
        out = rs.concat_pcm([(a, 500), (b, 900)], 24000)  # trailing pause dropped
        self.assertEqual(len(out), 2 * (10 + 12000 + 5))

    def test_gain(self):
        self.assertAlmostEqual(rs.gain_to_target(-25.0, -19.0), 6.0)
        self.assertAlmostEqual(rs.gain_to_target(-12.0, -19.0), -7.0)
        self.assertIsNone(rs.gain_to_target(None, -19.0))
        self.assertIsNone(rs.gain_to_target(float("-inf"), -19.0))
        self.assertEqual(rs.gain_to_target(-80.0, -19.0), 30.0)  # clamp
        self.assertAlmostEqual(rs.db_to_lin(-6.0206), 0.5, places=3)

    def test_pitch_filter(self):
        self.assertIsNone(rs.pitch_filter(1.0))
        self.assertEqual(rs.pitch_filter(0.9), "asetrate=21600,aresample=24000,atempo=1.111111")

    def test_size_maths(self):
        self.assertAlmostEqual(rs.mb_per_hour(10_800_000, 3600), 10.8)
        self.assertEqual(rs.mb_per_hour(1, 0), 0.0)
        self.assertEqual(rs.estimate_bytes(10, T), int(10 * 24000 / 8 * 1.03))


class Selection(unittest.TestCase):
    def test_only(self):
        self.assertTrue(rs.select([], "a", "x"))
        self.assertTrue(rs.select(["a"], "a", "x"))
        self.assertTrue(rs.select(["a/x"], "a", "x"))
        self.assertFalse(rs.select(["a/y"], "a", "x"))
        self.assertFalse(rs.select(["b"], "a", "x"))

    def test_slotted(self):
        self.assertTrue(rs.is_slotted({"usesSlots": ["prevTitle"], "lines": []}))
        self.assertTrue(rs.is_slotted({"usesSlots": [], "lines": [{"text": "That was {prevTitle}."}]}))
        self.assertFalse(rs.is_slotted({"usesSlots": [], "lines": [{"text": "Plain."}]}))


class Determinism(unittest.TestCase):
    def specs(self, gain=0.0):
        return [{"raw": "r1", "pitch": 1.0, "gainDb": gain, "vf": "", "pauseMs": 80}]

    def test_keys_stable_and_sensitive(self):
        k1 = rs.segment_key(self.specs(), ["", None], T)
        self.assertEqual(k1, rs.segment_key(self.specs(), ["", None], dict(T)))
        self.assertNotEqual(k1, rs.segment_key(self.specs(1.0), ["", None], T))
        self.assertNotEqual(k1, rs.segment_key(self.specs(), ["lowpass=f=3000", None], T))
        self.assertNotEqual(k1, rs.segment_key(self.specs(), ["", None], dict(T, bitrateKbps=16)))
        a = rs.raw_key("piper", "v1", "x", 1.0, "hi", None)
        self.assertEqual(a, rs.raw_key("piper", "v1", "x", 1.0, "hi", None))
        self.assertNotEqual(a, rs.raw_key("piper", "v1", "x", 1.0, "hi!", None))

    def test_manifest_order_independent(self):
        e1 = {"id": "b", "file": "b.opus", "durationSec": 1.0, "sha256": "1", "bytes": 1}
        e2 = {"id": "a", "file": "a.opus", "durationSec": 2.0, "sha256": "2", "bytes": 2}
        m1 = rs.dump_manifest(rs.build_manifest("s", [e1, e2], T))
        m2 = rs.dump_manifest(rs.build_manifest("s", [e2, e1], T))
        self.assertEqual(m1, m2)
        self.assertEqual([s["id"] for s in json.loads(m1)["segments"]], ["a", "b"])


class Plan(unittest.TestCase):
    def test_fixture_plan(self):
        st = rs.load_stations(ROOT / "test" / "fixtures" / "render" / "stations")[0]
        cfg = json.loads((ROOT / "test" / "fixtures" / "render" / "voices.json").read_text())
        sid, voices, todo, skipped, errors = rs.plan_station(st, cfg, rs.merge_targets(cfg["targets"]), [])
        self.assertEqual(sid, "fixture-fm")
        self.assertEqual(errors, [])
        self.assertEqual([s["id"] for s in todo], ["fx-sign-on", "fx-callin", "fx-liner"])
        self.assertEqual(skipped, ["fx-liner-slot"])
        self.assertEqual(voices["bo"]["treatment"], "phone")
        self.assertEqual(voices["alex"]["speed"], 0.95)


if __name__ == "__main__":
    unittest.main()
