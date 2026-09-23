"""Contract tests for the local adapter; inference engines are intentionally mocked."""

import os
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import wave
from unittest.mock import patch

from app import ml


CONTEXT = {"id": "meeting-1", "title": "Planning", "occurred_at": "2026-09-23",
           "timezone": "Asia/Almaty", "participants": []}


class LocalMLTests(unittest.TestCase):
    def test_missing_diarization_weights_fail_before_expensive_asr(self):
        with tempfile.TemporaryDirectory() as temp:
            audio = Path(temp) / "input.wav"
            audio.touch()
            with patch.dict(os.environ, {"DIARIZATION_MODEL_PATH": temp}), patch.object(ml, "_transcribe") as asr:
                with self.assertRaisesRegex(RuntimeError, "complete offline"):
                    ml._speech_checkpoint(str(audio), CONTEXT, lambda stage: None)
                asr.assert_not_called()

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

    def test_word_alignment_splits_a_sentence_at_speaker_change(self):
        transcript = [{"start": 0, "end": 3, "text": "Я подготовлю. Жақсы.", "words": [
            {"start": 0, "end": 0.5, "text": "Я"},
            {"start": 0.5, "end": 1.5, "text": " подготовлю."},
            {"start": 2, "end": 3, "text": " Жақсы."}]}]
        segments, _ = ml._align(transcript, [(0, 1.5, "A"), (2, 3, "B")], CONTEXT)
        self.assertEqual([s["speaker_id"] for s in segments], ["A", "B"])
        self.assertEqual([s["text"] for s in segments], ["Я подготовлю.", "Жақсы."])
        self.assertEqual(segments[1]["start_ms"], 2000)

    def test_incomplete_word_timing_preserves_full_text(self):
        transcript = [{"start": 0, "end": 3, "text": "Do not send yet.", "words": [
            {"start": 0, "end": 1, "text": "Do"}, {"start": 1, "end": 2, "text": " send"}]}]
        segments, _ = ml._align(transcript, [(0, 3, "A")], CONTEXT)
        self.assertEqual(segments[0]["text"], "Do not send yet.")

    def test_invalid_timing_rejected_and_gap_not_assigned_to_nearest_voice(self):
        with self.assertRaisesRegex(RuntimeError, "invalid audio timestamps"):
            ml._align([{"start": float("nan"), "end": 2, "text": "hello"}], [], CONTEXT)
        segments, warnings = ml._align([{"start": 10, "end": 11, "text": "hello"}], [(0, 1, "A")], CONTEXT)
        self.assertEqual(segments[0]["speaker_id"], "")
        self.assertTrue(warnings)

    def test_explicit_russian_and_kazakh_dates(self):
        self.assertEqual(ml._explicit_date("К 25 сентября 2026 года"), "2026-09-25")
        self.assertEqual(ml._explicit_date("2026 жылғы 28 қыркүйекке дейін"), "2026-09-28")
        self.assertIsNone(ml._explicit_date("к 25 сентября"))
        self.assertIsNone(ml._explicit_date("31 февраля 2026 года"))
        self.assertIsNone(ml._explicit_date("с 2026-09-25 до 2026-09-28"))

    def test_deadline_grounded_in_quote_not_other_dates(self):
        segments = ml._text_segments("Dana: Сегодня 2026-09-23, отправлю завтра.", CONTEXT)
        raw = {"summary": "Задача", "actions": [{"title": "Отправить", "assignee": "Dana", "due_text": "завтра",
            "due_date": "2026-09-23", "evidence_segment_ids": [segments[0]["id"]]}]}
        _, actions, _ = ml._validated_extraction(raw, segments, CONTEXT)
        self.assertIsNone(actions[0]["due_date"])

    def test_self_commitment_uses_confirmed_speaker_mapping(self):
        context = dict(CONTEXT, participants=[{"id": "p1", "display_name": "Данияр", "speaker_id": "SPEAKER_00"}])
        segments = [{"id": "s1", "speaker_id": "SPEAKER_00", "text": "Я подготовлю отчёт."}]
        raw = {"summary": "Отчёт", "actions": [{"title": "Подготовить отчёт", "assignee": "Данияр", "due_text": "",
            "due_date": None, "evidence_segment_ids": ["s1"]}]}
        _, actions, _ = ml._validated_extraction(raw, segments, context)
        self.assertEqual(actions[0]["assignee"], "Данияр")

    def test_truncated_ollama_result_never_looks_successful(self):
        with patch.object(ml, "_installed_llm", return_value=(True, "installed")), \
             patch.object(ml, "_ollama_request", return_value={"done": True, "done_reason": "length", "response": "{}"}) as request:
            with self.assertRaisesRegex(RuntimeError, "truncated"):
                ml._ollama_extract([], CONTEXT)
            self.assertFalse(request.call_args.args[1]["think"])

    def test_whisper_cpp_auto_language_is_explicit(self):
        with tempfile.TemporaryDirectory() as temp:
            model = Path(temp) / "model.bin"
            model.touch()
            def run(command, **kwargs):
                self.assertEqual(command[command.index("-l") + 1], "auto")
                output = command[command.index("-of") + 1] + ".json"
                Path(output).write_text(json.dumps({"transcription": [{"offsets": {"from": 0, "to": 1000}, "text": "Сәлем"}]}))
            with patch.dict(os.environ, {"WHISPER_CPP_BIN": "/bin/echo", "WHISPER_CPP_MODEL": str(model)}), \
                 patch.object(ml.subprocess, "run", side_effect=run):
                self.assertEqual(ml._transcribe("unused.wav")[0]["text"], "Сәлем")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg unavailable")
    def test_real_ffmpeg_decoding_without_inference(self):
        with tempfile.TemporaryDirectory() as temp:
            source, target = str(Path(temp) / "input.wav"), str(Path(temp) / "output.wav")
            with wave.open(source, "wb") as audio:
                audio.setnchannels(2)
                audio.setsampwidth(2)
                audio.setframerate(8000)
                audio.writeframes(b"\x00" * 3200)
            ml._convert_audio(source, target)
            with wave.open(target, "rb") as audio:
                self.assertEqual((audio.getnchannels(), audio.getframerate()), (1, 16000))
                self.assertGreater(audio.getnframes(), 0)


if __name__ == "__main__":
    unittest.main()
