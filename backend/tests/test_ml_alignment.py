"""Alignment regressions from the real GPU meeting reports.

Run on the rented server, like the other ML tests.
"""

import unittest

from app import ml


CONTEXT = {"id": "alignment-regression", "participants": []}


class AlignmentRegressionTests(unittest.TestCase):
    def test_zero_duration_word_inside_turn_retains_speaker_and_timing_warning(self):
        # Meeting 1: the word «не» was emitted at 214.720–214.720.
        segments, warnings = ml._align(
            [{"start": 214.720, "end": 214.720, "text": "не"}],
            [(214.377, 214.799, "SPEAKER_03")], CONTEXT,
        )
        self.assertEqual(segments[0]["speaker_id"], "SPEAKER_03")
        self.assertEqual((segments[0]["start_ms"], segments[0]["end_ms"]), (214720, 214720))
        self.assertTrue(any("zero-duration" in warning for warning in warnings))
        self.assertFalse(any("could not be aligned" in warning for warning in warnings))

    def test_zero_duration_words_merge_without_losing_the_timing_warning(self):
        # Meeting 2: «На этой неделе» had zero duration inside a clear S04 turn.
        transcript = [{"start": 86.4, "end": 87.0, "text": "совещание. На этой неделе зафиксируйте",
            "words": [{"start": 86.4, "end": 86.58, "text": "совещание."},
                      {"start": 86.58, "end": 86.58, "text": " На этой неделе"},
                      {"start": 86.58, "end": 87.0, "text": " зафиксируйте"}]}]
        segments, warnings = ml._align(transcript, [(84.676, 90.447, "SPEAKER_04")], CONTEXT)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], transcript[0]["text"])
        self.assertEqual(segments[0]["speaker_id"], "SPEAKER_04")
        self.assertTrue(any("zero-duration" in warning for warning in warnings))
        self.assertTrue(all(warning.endswith("segment 1.") for warning in warnings))

    def test_zero_duration_at_speaker_boundary_remains_ambiguous(self):
        segments, warnings = ml._align(
            [{"start": 1.0, "end": 1.0, "text": "Да"}],
            [(0.0, 1.0, "A"), (1.0, 2.0, "B")], CONTEXT,
        )
        self.assertEqual(segments[0]["speaker_id"], "")
        self.assertTrue(any("uncertain" in warning for warning in warnings))
        self.assertTrue(any("zero-duration" in warning for warning in warnings))

    def test_zero_duration_in_silence_is_not_assigned_to_nearest_turn(self):
        segments, warnings = ml._align(
            [{"start": 1.5, "end": 1.5, "text": "Да"}],
            [(0.0, 1.0, "A"), (2.0, 3.0, "A")], CONTEXT,
        )
        self.assertEqual(segments[0]["speaker_id"], "")
        self.assertTrue(any("could not be aligned" in warning for warning in warnings))

    def test_low_coverage_warning_refers_to_actual_merged_segment(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "Первое слово",
            "words": [{"start": 0.0, "end": 0.2, "text": "Первое"},
                      {"start": 0.2, "end": 1.0, "text": " слово"}]}]
        segments, warnings = ml._align(transcript, [(0.0, 0.3, "A")], CONTEXT)
        self.assertEqual(len(segments), 1)
        self.assertIn("Low diarization coverage for transcript segment 1.", warnings)
        self.assertTrue(all(warning.endswith("segment 1.") for warning in warnings))

    def test_uncertain_word_stays_flagged_when_merged_with_confident_words(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "Первое слово",
            "words": [{"start": 0.0, "end": 0.2, "text": "Первое"},
                      {"start": 0.2, "end": 1.0, "text": " слово"}]}]
        segments, warnings = ml._align(transcript, [(0.0, 0.7, "A"), (0.7, 1.0, "B")], CONTEXT)
        self.assertEqual(len(segments), 1)
        self.assertIn("Speaker attribution is uncertain for transcript segment 1.", warnings)
        self.assertTrue(all(warning.endswith("segment 1.") for warning in warnings))


if __name__ == "__main__":
    unittest.main()
