"""Assignee regressions for grounded RU/KZ extraction.

Run these tests on the rented ML server; no inference engine is required.
"""

import json
import unittest
from unittest.mock import patch

from app import ml


CONTEXT = {
    "id": "extraction-quality-regression",
    "title": "Планирование",
    "occurred_at": "2026-09-23",
    "timezone": "Asia/Almaty",
    "participants": [],
}


def extraction(assignee, segment_id, title):
    return {
        "summary": title,
        "actions": [{
            "title": title,
            "assignee": assignee,
            "due_text": "",
            "due_date": None,
            "evidence_segment_ids": [segment_id],
        }],
    }


class ExtractionQualityTests(unittest.TestCase):
    def test_null_model_date_preserves_explicit_iso_russian_and_kazakh_dates(self):
        cases = (
            ("к 2026-09-25", "2026-09-25"),
            ("к 25 сентября 2026 года", "2026-09-25"),
            ("2026 жылғы 28 қыркүйекке дейін", "2026-09-28"),
        )
        for deadline, expected_date in cases:
            with self.subTest(deadline=deadline):
                segments = ml._text_segments(f"Алия: Я подготовлю отчёт {deadline}.", CONTEXT)
                raw = extraction("Алия", segments[0]["id"], "Подготовить отчёт")
                raw["actions"][0]["due_text"] = deadline

                _, actions, _ = ml._validated_extraction(raw, segments, CONTEXT)

                self.assertEqual(actions[0]["due_date"], expected_date)
                self.assertEqual(actions[0]["due_text"], deadline)
                self.assertNotIn("date_needs_review", actions[0]["review_reasons"])
                self.assertNotIn("deadline_needs_review", actions[0]["review_reasons"])

    def test_null_model_date_leaves_incomplete_invalid_or_ambiguous_dates_for_review(self):
        for deadline in (
            "к 25 сентября",
            "завтра",
            "31 февраля 2026 года",
            "с 2026-09-25 до 2026-09-28",
        ):
            with self.subTest(deadline=deadline):
                segments = ml._text_segments(f"Алия: Я подготовлю отчёт {deadline}.", CONTEXT)
                raw = extraction("Алия", segments[0]["id"], "Подготовить отчёт")
                raw["actions"][0]["due_text"] = deadline

                _, actions, _ = ml._validated_extraction(raw, segments, CONTEXT)

                self.assertIsNone(actions[0]["due_date"])
                self.assertEqual(actions[0]["due_text"], deadline)
                self.assertIn("deadline_needs_review", actions[0]["review_reasons"])

    def test_null_model_date_cannot_hide_an_invented_year_in_deadline_quote(self):
        segments = ml._text_segments("Алия: Я подготовлю отчёт к 25 сентября.", CONTEXT)
        raw = extraction("Алия", segments[0]["id"], "Подготовить отчёт")
        raw["actions"][0]["due_text"] = "к 25 сентября 2023 года"

        _, actions, warnings = ml._validated_extraction(raw, segments, CONTEXT)

        self.assertIsNone(actions[0]["due_date"])
        self.assertNotIn("2023", actions[0]["due_text"])
        self.assertIn("deadline_not_in_evidence", actions[0]["review_reasons"])
        self.assertTrue(warnings)

    def test_ollama_schema_requires_null_date_for_application_side_parsing(self):
        segments = ml._text_segments("Алия: Я согласую бюджет.", CONTEXT)
        raw = extraction("Алия", "S1", "Согласовать бюджет")
        reply = {"done": True, "response": json.dumps(raw, ensure_ascii=False)}
        with patch.object(ml, "_llm_model", return_value="local-test-model"), \
             patch.object(ml, "_installed_llm", return_value=(True, "installed")), \
             patch.object(ml, "_ollama_request", return_value=reply) as request:
            result = ml._ollama_extract(segments, CONTEXT)

        action_schema = request.call_args.args[1]["format"]["properties"]["actions"]["items"]
        self.assertEqual(action_schema["properties"]["due_date"]["type"], "null")
        self.assertIn("due_date", action_schema["required"])
        self.assertIsNone(result["actions"][0]["due_date"])

    def test_short_evidence_aliases_restore_original_segment_ids(self):
        segments = ml._text_segments(
            "Алия: Я согласую бюджет.\nДанияр: Договорились, после обсуждения.", CONTEXT,
        )
        raw = extraction("Алия", "S1", "Согласовать бюджет")
        raw["actions"][0]["evidence_segment_ids"] = ["S2", "S1"]
        reply = {"done": True, "response": json.dumps(raw, ensure_ascii=False)}

        with patch.object(ml, "_llm_model", return_value="local-test-model"), \
             patch.object(ml, "_installed_llm", return_value=(True, "installed")), \
             patch.object(ml, "_ollama_request", return_value=reply) as request:
            restored = ml._ollama_extract(segments, CONTEXT)

        source = json.loads(request.call_args.args[1]["prompt"].split("Source segments: ", 1)[1])
        self.assertEqual([segment["id"] for segment in source], ["S1", "S2"])
        expected_ids = [segments[1]["id"], segments[0]["id"]]
        self.assertEqual(restored["actions"][0]["evidence_segment_ids"], expected_ids)
        _, actions, _ = ml._validated_extraction(restored, segments, CONTEXT)
        self.assertEqual(actions[0]["evidence_segment_ids"], expected_ids)

    def test_unknown_evidence_reference_cannot_silently_select_a_segment(self):
        segments = ml._text_segments("Алия: Я согласую бюджет.", CONTEXT)
        for unknown in ("S999", "S01", "s1", "1", "invented-segment-id"):
            with self.subTest(reference=unknown):
                raw = extraction("Алия", unknown, "Согласовать бюджет")
                reply = {"done": True, "response": json.dumps(raw, ensure_ascii=False)}
                with patch.object(ml, "_llm_model", return_value="local-test-model"), \
                     patch.object(ml, "_installed_llm", return_value=(True, "installed")), \
                     patch.object(ml, "_ollama_request", return_value=reply):
                    restored = ml._ollama_extract(segments, CONTEXT)

                with self.assertRaisesRegex(RuntimeError, "missing evidence"):
                    ml._validated_extraction(restored, segments, CONTEXT)

    def test_named_russian_speaker_keeps_budget_approval_commitment(self):
        segments = ml._text_segments(
            "Алия: Я согласую бюджет после обсуждения с организаторами.", CONTEXT,
        )
        raw = extraction("Алия", segments[0]["id"], "Согласовать бюджет")

        _, actions, _ = ml._validated_extraction(raw, segments, CONTEXT)

        self.assertEqual(actions[0]["assignee"], "Алия")
        self.assertNotIn("assignee_not_in_evidence", actions[0]["review_reasons"])
        self.assertNotIn("assignee_needs_review", actions[0]["review_reasons"])

    def test_named_kazakh_speaker_keeps_commitment_with_object_before_verb(self):
        segments = ml._text_segments(
            "Айдана: Мен есепті дайындаймын және командаға жіберемін.", CONTEXT,
        )
        raw = extraction("Айдана", segments[0]["id"], "Подготовить отчёт")

        _, actions, _ = ml._validated_extraction(raw, segments, CONTEXT)

        self.assertEqual(actions[0]["assignee"], "Айдана")
        self.assertNotIn("assignee_not_in_evidence", actions[0]["review_reasons"])
        self.assertNotIn("assignee_needs_review", actions[0]["review_reasons"])

    def test_unmapped_voice_cluster_is_not_a_person_name(self):
        segments = [{
            "id": "voice-commitment",
            "speaker_id": "SPEAKER_00",
            "text": "Я подготовлю отчёт.",
        }]
        raw = extraction("SPEAKER_00", "voice-commitment", "Подготовить отчёт")

        _, actions, warnings = ml._validated_extraction(raw, segments, CONTEXT)

        self.assertEqual(actions[0]["assignee"], "")
        self.assertIn("assignee_needs_review", actions[0]["review_reasons"])
        self.assertTrue(warnings)

    def test_confirmed_voice_mapping_preserves_display_name(self):
        context = dict(CONTEXT, participants=[{
            "id": "participant-daniyar",
            "display_name": "Данияр",
            "speaker_id": "SPEAKER_00",
        }])
        segments = [{
            "id": "mapped-commitment",
            "speaker_id": "SPEAKER_00",
            "text": "Я подготовлю отчёт.",
        }]
        raw = extraction("Данияр", "mapped-commitment", "Подготовить отчёт")

        _, actions, _ = ml._validated_extraction(raw, segments, context)

        self.assertEqual(actions[0]["assignee"], "Данияр")
        self.assertNotIn("assignee_not_in_evidence", actions[0]["review_reasons"])
        self.assertNotIn("assignee_needs_review", actions[0]["review_reasons"])

    def test_russian_negated_commitment_does_not_confirm_assignee(self):
        for utterance in (
            "Я не подготовлю отчёт.",
            "Я не обещала, что я подготовлю отчёт.",
        ):
            with self.subTest(utterance=utterance):
                segments = ml._text_segments(f"Алия: {utterance}", CONTEXT)
                raw = extraction("Алия", segments[0]["id"], "Подготовить отчёт")

                _, actions, warnings = ml._validated_extraction(raw, segments, CONTEXT)

                self.assertEqual(actions[0]["assignee"], "")
                self.assertIn("assignee_needs_review", actions[0]["review_reasons"])
                self.assertTrue(warnings)

    def test_kazakh_negated_commitment_does_not_confirm_assignee(self):
        for utterance in (
            "Мен есепті дайындамаймын.",
            "Мен есепті дайындаймын деген жоқпын.",
        ):
            with self.subTest(utterance=utterance):
                segments = ml._text_segments(f"Айдана: {utterance}", CONTEXT)
                raw = extraction("Айдана", segments[0]["id"], "Подготовить отчёт")

                _, actions, warnings = ml._validated_extraction(raw, segments, CONTEXT)

                self.assertEqual(actions[0]["assignee"], "")
                self.assertIn("assignee_needs_review", actions[0]["review_reasons"])
                self.assertTrue(warnings)

    def test_unrelated_negative_does_not_erase_later_positive_commitment(self):
        cases = (
            ("Алия", "Я не обещала согласовать бюджет. Я подготовлю отчёт."),
            ("Алия", "Я не обещала согласовать бюджет, но я подготовлю отчёт."),
            ("Айдана", "Мен бюджетке жауапты емеспін. Мен есепті дайындаймын."),
            ("Айдана", "Мен бюджетке жауапты емеспін, бірақ мен есепті дайындаймын."),
        )
        for name, utterance in cases:
            with self.subTest(utterance=utterance):
                segments = ml._text_segments(f"{name}: {utterance}", CONTEXT)
                raw = extraction(name, segments[0]["id"], "Подготовить отчёт")

                _, actions, _ = ml._validated_extraction(raw, segments, CONTEXT)

                self.assertEqual(actions[0]["assignee"], name)
                self.assertNotIn("assignee_needs_review", actions[0]["review_reasons"])

    def test_named_question_is_not_a_commitment_but_later_assertion_is(self):
        cases = (
            ("Алия", "Я согласую бюджет?", ""),
            ("Айдана", "Мен есепті дайындаймын ба?", ""),
            ("Алия", "Я согласую бюджет? Да, я согласую бюджет.", "Алия"),
            ("Айдана", "Мен есепті дайындаймын ба? Иә, мен есепті дайындаймын.", "Айдана"),
        )
        for name, utterance, expected_assignee in cases:
            with self.subTest(utterance=utterance):
                segments = ml._text_segments(f"{name}: {utterance}", CONTEXT)
                raw = extraction(name, segments[0]["id"], "Выполнить поручение")

                _, actions, _ = ml._validated_extraction(raw, segments, CONTEXT)

                self.assertEqual(actions[0]["assignee"], expected_assignee)
                if expected_assignee:
                    self.assertNotIn("assignee_needs_review", actions[0]["review_reasons"])
                else:
                    self.assertIn("assignee_needs_review", actions[0]["review_reasons"])


if __name__ == "__main__":
    unittest.main()
