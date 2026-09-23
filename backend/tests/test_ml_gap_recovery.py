"""Bounded audio-gap recovery regressions. Execute on the rented server only."""

from pathlib import Path
import json
import tempfile
import unittest
import wave
from unittest.mock import patch

from app import ml


class SpeechGapRecoveryTests(unittest.TestCase):
    def test_numpy_word_timings_produce_serializable_diagnostics(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("NumPy runtime needed for real faster-whisper scalar regression")
        transcript = [{"start": 0.0, "end": 1.0, "text": "До."},
                      {"start": 3.0, "end": 4.0, "text": "После."}]
        words = [{"start": np.float64(1.1), "end": np.float64(1.1), "text": " не", "probability": 0.9},
                 {"start": np.float64(1.1), "end": np.float64(2.0), "text": " отправлю", "probability": 0.9}]
        with patch.object(ml, "_transcribe", return_value=[{"words": words}]):
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
        payload = json.loads(json.dumps({"segments": observed, "warnings": warnings, "details": details}))
        self.assertEqual(payload["details"][0]["zero_duration_words"], 1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.audio = Path(self.temp.name) / "audio.wav"
        with wave.open(str(self.audio), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 16000 * 30)

    def test_silent_gap_and_overlapping_diarization_do_not_trigger_recovery(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "Первое."},
                      {"start": 5.0, "end": 6.0, "text": "Второе."}]
        # Overlapping tracks must not double-count 1.1 seconds as 2.2 seconds.
        turns = [(1.0, 2.1, "A"), (1.0, 2.1, "B")]
        with patch.object(ml, "_transcribe") as asr:
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, turns)
        asr.assert_not_called()
        self.assertEqual(observed, transcript)
        self.assertEqual(warnings, [])
        self.assertEqual(details, [])

    def test_crop_offsets_words_and_preserves_low_probability_particles(self):
        transcript = [{"start": 10.0, "end": 11.0, "text": "Начало."},
                      {"start": 15.0, "end": 16.0, "text": "Конец."}]
        words = [{"start": 4.0, "end": 4.8, "text": " Старое", "probability": 1.0},
                 {"start": 5.4, "end": 6.0, "text": " по", "probability": 0.2},
                 {"start": 6.0, "end": 7.0, "text": " смете", "probability": 0.9},
                 {"start": 6.0, "end": 7.0, "text": " смете", "probability": 0.9},
                 {"start": 9.2, "end": 9.8, "text": " новое", "probability": 1.0}]

        def recover(path):
            with wave.open(path, "rb") as wav:
                self.assertEqual(wav.getnframes() / wav.getframerate(), 14.0)
            return [{"start": 4.8, "end": 9.2, "text": "ignored surrounding text", "words": words}]

        with patch.object(ml, "_transcribe", side_effect=recover) as asr:
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
        asr.assert_called_once()
        self.assertEqual(len(observed), 3)
        recovered = observed[1]
        self.assertEqual(recovered["text"], "по смете")
        self.assertAlmostEqual(recovered["words"][0]["start"], 11.4)
        self.assertEqual(recovered["words"][1]["end"], 13.0)
        self.assertEqual(len(recovered["words"]), 2)
        self.assertEqual(transcript[0]["text"], "Начало.")
        self.assertEqual(details[0]["status"], "recovered")
        self.assertAlmostEqual(details[0]["mean_word_probability"], 0.55)
        self.assertTrue(any("needs review" in message for message in warnings))

    def test_low_mean_confidence_rejects_entire_candidate(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "До."},
                      {"start": 3.0, "end": 4.0, "text": "После."}]
        candidate = [{"words": [{"start": 1.1, "end": 2.0, "text": " сомнительно", "probability": 0.1},
                                {"start": 2.0, "end": 2.9, "text": " целиком", "probability": 0.3}]}]
        with patch.object(ml, "_transcribe", return_value=candidate):
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
        self.assertEqual(observed, transcript)
        self.assertEqual(details[0]["status"], "insufficient_confidence")
        self.assertTrue(warnings)

    def test_missing_confidence_is_reported_and_maximum_three_crops_are_run(self):
        transcript = [{"start": float(start), "end": float(start + 1), "text": str(start)}
                      for start in (0, 3, 6, 9, 12, 15)]
        with patch.object(ml, "_transcribe", return_value=[]) as asr:
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
        self.assertEqual(asr.call_count, 3)
        self.assertEqual(len(details), 3)
        self.assertEqual(observed, transcript)

        candidate = [{"words": [{"start": 1.1, "end": 2.9, "text": " найдены слова"}]}]
        with patch.object(ml, "_transcribe", return_value=candidate):
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript[:2], [(0.0, 30.0, "A")])
        self.assertEqual(observed[1]["text"], "найдены слова")
        self.assertFalse(details[0]["confidence_complete"])
        self.assertTrue(any("confidence unavailable" in message for message in warnings))

    def test_failed_recovery_preserves_first_pass_and_records_review_warning(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "До."},
                      {"start": 3.0, "end": 4.0, "text": "После."}]
        with patch.object(ml, "_transcribe", side_effect=RuntimeError("decoder unavailable")):
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
        self.assertEqual(observed, transcript)
        self.assertEqual(details[0]["status"], "failed")
        self.assertIn("decoder unavailable", details[0]["error"])
        self.assertTrue(warnings)

    def test_internal_zero_duration_negation_is_preserved_with_warning(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "До."},
                      {"start": 3.0, "end": 4.0, "text": "После."}]
        words = [{"start": 1.1, "end": 1.1, "text": " не", "probability": 0.9},
                 {"start": 1.1, "end": 2.0, "text": " отправлю", "probability": 0.9}]
        with patch.object(ml, "_transcribe", return_value=[{"words": words}]):
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
        self.assertEqual(observed[1]["text"], "не отправлю")
        self.assertEqual(details[0]["zero_duration_words"], 1)
        self.assertTrue(any("zero-duration" in warning for warning in warnings))

    def test_boundary_crossing_negation_rejects_entire_phrase(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "До."},
                      {"start": 3.0, "end": 4.0, "text": "После."}]
        words = [{"start": 0.9, "end": 1.2, "text": " не", "probability": 0.9},
                 {"start": 1.2, "end": 2.0, "text": " отправлю", "probability": 0.9}]
        with patch.object(ml, "_transcribe", return_value=[{"words": words}]):
            observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
        self.assertEqual(observed, transcript)
        self.assertEqual(details[0]["status"], "boundary_ambiguity")
        self.assertEqual(details[0]["accepted_words"], [])

    def test_invalid_and_boundary_crossing_words_are_not_inserted(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "До."},
                      {"start": 3.0, "end": 4.0, "text": "После."}]
        for words in ([{"start": 0.9, "end": 1.2, "text": " пересекает начало"},
                       {"start": 2.9, "end": 3.1, "text": " пересекает конец"}],
                      [{"start": float("nan"), "end": 2.0, "text": " invalid"}]):
            with self.subTest(words=words):
                with patch.object(ml, "_transcribe", return_value=[{"words": words}]):
                    observed, warnings, details = ml._recover_asr_gaps(str(self.audio), transcript, [(0.0, 30.0, "A")])
                self.assertEqual(observed, transcript)
                self.assertNotEqual(details[0]["status"], "recovered")


if __name__ == "__main__":
    unittest.main()
