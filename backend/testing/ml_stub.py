"""Deterministic synthetic ML for integration tests, not an inference fallback."""

import copy
import threading
import time
import uuid
import wave
from datetime import date, timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

MARKER = "ТЕСТОВАЯ ИМИТАЦИЯ ML — реальные модели не запускались."
Stage = Literal["transcribing", "diarizing", "extracting"]


class Scenario(BaseModel):
    name: Literal["unavailable", "review", "empty", "invalid-evidence", "invalid-summary", "fail-transcribing", "fail-diarizing", "fail-extracting"] = "unavailable"
    delay_ms: int = Field(default=60, ge=0, le=10000)
    gate_stage: Stage | None = None
    language: Literal["ru", "kz", "mixed"] = "mixed"


class StubML:
    def __init__(self, scenario: Scenario | None = None):
        self.lock = threading.RLock()
        self.scenario = scenario or Scenario()
        self.gate = threading.Event()
        self.events = []
        self.active = 0
        self.peak_active = 0

    def configure(self, scenario: Scenario):
        with self.lock:
            if self.active:
                raise ValueError("Release/finish the active job before changing scenarios")
            self.scenario = scenario
            self.gate = threading.Event()
        return scenario.model_dump()

    def release(self):
        self.gate.set()

    def state(self):
        with self.lock:
            return {"scenario": self.scenario.model_dump(), "active": self.active,
                    "peak_active": self.peak_active, "events": copy.deepcopy(self.events)}

    def probe(self):
        # Do not claim any actual model is installed. The ordinary real-ML
        # acceptance client consequently refuses to certify this server.
        return {"speech": False, "llm": False, "diarization": False,
                "details": {"test_mode": True, "speech": MARKER, "llm": MARKER, "diarization": MARKER}}

    def process_audio(self, path, context, on_stage):
        # Decoding this synthetic fixture is real; ASR and diarization are not.
        try:
            with wave.open(str(Path(path)), "rb") as audio:
                if audio.getnframes() <= 0 or audio.getframerate() <= 0:
                    raise ValueError("Empty WAV")
        except (OSError, EOFError, wave.Error, ValueError) as exc:
            raise RuntimeError(f"{MARKER} Test audio must be a valid nonempty PCM WAV") from exc
        return self._process(context, on_stage, audio=True)

    def process_text(self, text, context, on_stage):
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError(f"{MARKER} Empty transcript")
        return self._process(context, on_stage, audio=False, text=text)

    def _process(self, context, callback, *, audio, text=""):
        with self.lock:
            scenario = self.scenario.model_copy()
            gate = self.gate
            self.active += 1
            self.peak_active = max(self.peak_active, self.active)
        try:
            stages = ["transcribing", "diarizing", "extracting"] if audio else ["extracting"]
            for stage in stages:
                callback(stage)
                with self.lock:
                    self.events.append({"title": context["title"], "stage": stage})
                if scenario.gate_stage == stage and not gate.wait(timeout=60):
                    raise RuntimeError(f"{MARKER} Test stage gate timed out")
                time.sleep(scenario.delay_ms / 1000)
                if scenario.name == "unavailable":
                    raise RuntimeError(f"{MARKER} Ollama / speech providers unavailable (simulated)")
                if scenario.name == f"fail-{stage}":
                    raise RuntimeError(f"{MARKER} Injected failure at {stage}")
            result = self._result(context, audio, scenario.language, text)
            if scenario.name == "empty":
                result["actions"] = []
            elif scenario.name == "invalid-evidence":
                result["actions"][0]["evidence_segment_ids"] = ["invented-segment"]
            elif scenario.name == "invalid-summary":
                result["summary"] = None
            return result
        finally:
            with self.lock:
                self.active -= 1

    @staticmethod
    def _result(context, audio, language, text):
        due = (date.fromisoformat(context["occurred_at"]) + timedelta(days=1)).isoformat()
        source = {
            "ru": [f"Әлия, подготовьте отчёт к {due}.", "Бюджет согласуем после совещания.", "Данияр отправит план без указанного срока."],
            "kz": [f"Әлия, есепті {due} дейін дайындаңыз.", "Бюджетті жиналыстан кейін келісеміз.", "Данияр жоспарды жібереді. Мерзімі көрсетілмеген."],
            "mixed": [f"Әлия, подготовьте отчёт к {due}. Жақсы, дайындаймын.", "Бюджетті после совещания согласуем.", "Данияр отправит жоспар. Срок не указан."],
        }[language]
        segments = [{"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"stub-segment:{i}")),
                     "start_ms": (i + 1) * 1000 if audio else 0, "end_ms": (i + 2) * 1000 if audio else 0,
                     "speaker_id": f"SPEAKER_{i % 2:02d}", "text": value} for i, value in enumerate(source)]
        if not audio:
            segments.append({"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "stub-original-text")), "start_ms": 0,
                             "end_ms": 0, "speaker_id": "", "text": text[:4000]})
        actions = [
            {"title": "Подготовить отчёт — Ә Ғ Қ Ң Ө Ұ Ү Һ І", "assignee": "Әлия", "due_text": f"к {due}", "due_date": due, "review_reasons": []},
            {"title": "Согласовать бюджет", "assignee": "", "due_text": "после совещания", "due_date": None, "review_reasons": ["assignee_needs_review", "deadline_needs_review"]},
            {"title": "Отправить план", "assignee": "Данияр", "due_text": "Не указан", "due_date": None, "review_reasons": []},
        ]
        for i, action in enumerate(actions):
            action.update(id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"stub-action:{i}")),
                          evidence_segment_ids=[segments[i]["id"]], status="open")
        return {"segments": segments, "summary": f"{MARKER}\nОтчёт, бюджет и план. Ә Ғ Қ Ң Ө Ұ Ү Һ І.",
                "actions": actions, "warnings": [MARKER, "Синтетические реплики и аудиометки используются только для проверки приложения."]}
