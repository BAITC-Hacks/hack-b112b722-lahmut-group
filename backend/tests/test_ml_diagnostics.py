"""Diagnostic metadata regressions; run only on the rented test server."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

from app import ml


CONTEXT = {"id": "diagnostics", "participants": []}
RAW = [{"start": 1.0, "end": 2.0, "text": "Пришлю отчёт.", "words": [
    {"start": 1.0, "end": 1.2, "text": "Пришлю", "probability": 0.98},
    {"start": 1.2, "end": 2.0, "text": " отчёт.", "probability": 0.97}]}]


class DiagnosticMetadataTests(unittest.TestCase):
    def test_checkpoint_diagnostics_preserve_default_speech_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            audio = root / "input.wav"
            (root / "config.yaml").write_text("test placeholder")
            with wave.open(str(audio), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\0\0" * 32000)

            def diarize(path, **kwargs):
                if "diagnostics" in kwargs:
                    kwargs["diagnostics"].update({"selected": "exclusive",
                        "exclusive": [(0.0, 2.0, "A")],
                        "regular": [(0.0, 2.0, "A"), (1.7, 2.0, "B")]})
                return [(0.0, 2.0, "A")]

            with patch.dict(os.environ, {"DIARIZATION_MODEL_PATH": temp}), \
                 patch.object(ml.importlib.util, "find_spec", return_value=object()), \
                 patch.object(ml, "_convert_audio", side_effect=shutil.copyfile), \
                 patch.object(ml, "_transcribe", side_effect=lambda _: copy.deepcopy(RAW)), \
                 patch.object(ml, "_diarize", side_effect=diarize) as inference, \
                 patch.object(ml.time, "monotonic", return_value=100.0):
                baseline = ml._speech_checkpoint(str(audio), CONTEXT, lambda _: None)
                self.assertNotIn("diagnostics", baseline)
                self.assertEqual(inference.call_args.kwargs, {})
                observed = ml._speech_checkpoint(str(audio), CONTEXT, lambda _: None, diagnostics=True)

            diagnostics = observed.pop("diagnostics")
            self.assertEqual(observed, baseline)
            self.assertEqual(diagnostics["asr_segments"], RAW)
            self.assertEqual(diagnostics["asr_segments"][0]["words"][0]["probability"], 0.98)
            self.assertEqual(diagnostics["timestamp_origin"], "excerpt_audio")
            self.assertEqual(diagnostics["timestamp_unit"], "seconds")
            self.assertEqual(diagnostics["diarization"]["selected"], "exclusive")
            self.assertEqual(len(diagnostics["diarization"]["exclusive"]), 1)
            self.assertEqual(len(diagnostics["diarization"]["regular"]), 2)

    def test_runner_offsets_raw_words_and_both_annotations_once(self):
        path = Path(__file__).resolve().parents[2] / "scripts" / "run_ml_checkpoint.py"
        spec = importlib.util.spec_from_file_location("checkpoint_diagnostics_test", path)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        raw = copy.deepcopy(RAW)
        raw[0]["words"][1]["end"] = raw[0]["words"][1]["start"]
        speech = {"segments": [{"id": "s1", "start_ms": 1000, "end_ms": 2000,
                               "speaker_id": "A", "text": "Пришлю отчёт."}],
                  "warnings": [], "turns": [(0.0, 2.0, "A")], "audio_seconds": 10.0,
                  "timings": {}, "diagnostics": {"timestamp_origin": "excerpt_audio",
                      "timestamp_unit": "seconds", "asr_segments": raw,
                      "diarization": {"selected": "exclusive", "exclusive": [(0.0, 2.0, "A")],
                                      "regular": [(0.0, 2.0, "A"), (1.7, 2.0, "B")]}}}
        with tempfile.TemporaryDirectory() as temp:
            audio, output = Path(temp) / "input.wav", Path(temp) / "report.json"
            audio.write_bytes(b"test input hashed by runner")
            argv = [str(path), str(audio), "--output", str(output), "--seconds", "10",
                    "--offset", "120.125", "--min-speakers", "1", "--diagnostics",
                    "--occurred-at", "2026-09-23"]
            with patch.object(sys, "argv", argv), patch.object(runner.subprocess, "run"), \
                 patch.object(runner, "_versions", return_value={}), \
                 patch.object(runner, "_model_revisions", return_value={}), \
                 patch.object(runner.ml, "_speech_checkpoint", return_value=copy.deepcopy(speech)) as checkpoint:
                self.assertEqual(runner.main(), 0)
            self.assertTrue(checkpoint.call_args.kwargs["diagnostics"])
            report = json.loads(output.read_text())
        self.assertEqual(report["segments"][0]["start_ms"], 121125)
        self.assertEqual(report["turns"][0]["start_ms"], 120125)
        diagnostics = report["diagnostics"]
        self.assertEqual(diagnostics["timestamp_origin"], "original_audio")
        self.assertEqual(diagnostics["timestamp_unit"], "seconds")
        self.assertEqual(diagnostics["asr_segments"][0]["start"], 121.125)
        word = diagnostics["asr_segments"][0]["words"][1]
        self.assertAlmostEqual(word["start"], 121.325)
        self.assertEqual(word["start"], word["end"])
        self.assertEqual(word["probability"], 0.97)
        self.assertEqual(diagnostics["diarization"]["exclusive"][0]["start"], 120.125)
        self.assertAlmostEqual(diagnostics["diarization"]["regular"][1]["start"], 121.825)

    def test_process_audio_does_not_return_internal_diagnostics(self):
        speech = {"segments": [{"id": "s1"}], "warnings": ["review"],
                  "diagnostics": {"asr_segments": RAW}}
        expected = {"segments": speech["segments"], "summary": "Summary", "actions": [], "warnings": ["review"]}
        with patch.object(ml, "_speech_checkpoint", return_value=speech), \
             patch.object(ml, "_extract", return_value=expected) as extract:
            result = ml.process_audio("unused.wav", CONTEXT, lambda _: None)
        self.assertEqual(result, expected)
        self.assertNotIn("diagnostics", result)
        extract.assert_called_once_with(speech["segments"], CONTEXT, speech["warnings"])


if __name__ == "__main__":
    unittest.main()
