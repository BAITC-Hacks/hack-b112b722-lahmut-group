"""Contract tests for the local adapter; inference engines are intentionally mocked."""

import os
import unittest
from unittest.mock import patch

from app import ml


CONTEXT = {"id": "meeting-1", "title": "Planning", "occurred_at": "2026-09-23",
           "timezone": "Asia/Almaty", "participants": []}


class LocalMLTests(unittest.TestCase):
    def test_text_import_groups_speaker_lines_and_has_zero_timestamps(self):
        text = "Dana: I will send the report by 2026-09-25.\nwith the final numbers\nLee: Agreed."
        observed = []

        def extract(segments, context):
            return {"summary": "Dana will send the report.", "actions": [{
                "title": "Send the report", "assignee": "Dana", "due_text": "by 2026-09-25",
                "due_date": "2026-09-25", "evidence_segment_ids": [segments[0]["id"]]}]}

        with patch.object(ml, "_ollama_extract", side_effect=extract):
            result = ml.process_text(text, CONTEXT, observed.append)
        self.assertEqual(observed, ["extracting"])
        self.assertEqual([s["speaker_id"] for s in result["segments"]], ["Dana", "Lee"])
        self.assertTrue(all(s["start_ms"] == s["end_ms"] == 0 for s in result["segments"]))
        self.assertIn("final numbers", result["segments"][0]["text"])
        action = result["actions"][0]
        self.assertEqual(action["due_date"], "2026-09-25")
        self.assertEqual(action["assignee"], "Dana")
        self.assertEqual(action["review_reasons"], [])
        self.assertEqual(action["status"], "open")

    def test_unverified_assignee_and_relative_date_are_marked_for_review(self):
        segments = ml._text_segments("Dana: Please send the draft tomorrow.", CONTEXT)
        raw = {"summary": "Draft requested.", "actions": [{"title": "Send the draft", "assignee": "Lee",
               "due_text": "tomorrow", "due_date": "2026-09-24", "evidence_segment_ids": [segments[0]["id"]]}]}
        _, actions, warnings = ml._validated_extraction(raw, segments, CONTEXT)
        self.assertEqual(actions[0]["assignee"], "")
        self.assertIsNone(actions[0]["due_date"])
        self.assertIn("assignee_not_in_evidence", actions[0]["review_reasons"])
        self.assertIn("date_needs_review", actions[0]["review_reasons"])
        self.assertTrue(warnings)

    def test_missing_evidence_rejected(self):
        segments = ml._text_segments("Dana: Send the draft.", CONTEXT)
        raw = {"summary": "Draft requested.", "actions": [{"title": "Send the draft", "assignee": "Dana",
               "due_text": "", "due_date": None, "evidence_segment_ids": ["invented"]}]}
        with self.assertRaisesRegex(RuntimeError, "missing evidence"):
            ml._validated_extraction(raw, segments, CONTEXT)

    def test_cloud_and_public_ollama_hosts_rejected(self):
        for base in ("https://127.0.0.1:11434", "http://example.com:11434", "http://8.8.8.8:11434",
                     "http://127.0.0.1:11434/other", "http://user:pass@localhost:11434"):
            with self.subTest(base=base), patch.dict(os.environ, {"OLLAMA_BASE_URL": base}):
                with self.assertRaises(RuntimeError):
                    ml._ollama_url()
        with patch.dict(os.environ, {"OLLAMA_MODEL": "gpt-oss:20b-cloud"}):
            with self.assertRaisesRegex(RuntimeError, "cloud"):
                ml._llm_model()

    def test_private_host_is_explicit_opt_in(self):
        with patch.dict(os.environ, {"OLLAMA_BASE_URL": "http://10.0.0.4:11434"}):
            self.assertEqual(ml._ollama_url(), "http://10.0.0.4:11434")

    def test_audio_alignment_marks_uncertain_speaker(self):
        transcript = [{"start": 0.0, "end": 2.0, "text": "A shared turn"}]
        turns = [(0.0, 1.1, "SPEAKER_00"), (1.1, 2.0, "SPEAKER_01")]
        segments, warnings = ml._align(transcript, turns, CONTEXT)
        self.assertEqual(segments[0]["speaker_id"], "SPEAKER_00")
        self.assertTrue(any("uncertain" in warning for warning in warnings))


if __name__ == "__main__":
    unittest.main()
