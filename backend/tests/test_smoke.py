"""Exercise the real-model acceptance client without claiming real inference."""

import json
from types import SimpleNamespace

import pytest

from backend import smoke
from backend.app import ml
from backend.tests.test_backend import ml_result, wav_bytes


def test_acceptance_client_requires_real_providers(client, tmp_path, monkeypatch):
    monkeypatch.setattr(ml, "probe", lambda: {"speech": False, "llm": False, "diarization": False, "details": {"llm": "missing"}})
    args = SimpleNamespace(audio=tmp_path / "record.wav")
    with pytest.raises(RuntimeError, match="providers are not ready"):
        smoke.upload(client, args)
    assert client.get("/api/meetings").json() == []


def test_acceptance_client_upload_manual_review_approve_docx(client, tmp_path, monkeypatch):
    monkeypatch.setattr(ml, "probe", lambda: {"speech": True, "llm": True, "diarization": True, "details": {}})
    monkeypatch.setattr(ml, "process_audio", lambda *args: ml_result())
    audio, output = tmp_path / "record.wav", tmp_path / "review.json"
    audio.write_bytes(wav_bytes())
    smoke.upload(client, SimpleNamespace(audio=audio, participants=None, title="Acceptance test", occurred_at="2026-09-20",
                                         timezone="Asia/Almaty", output=output, timeout=5))
    meeting = json.loads(output.read_text(encoding="utf-8"))
    assert not meeting["approved"] and meeting["status"] == "review_ready"
    smoke.review(client, SimpleNamespace(input=output, approve=True, docx=tmp_path / "protocol.docx"))
    assert (tmp_path / "protocol.docx").read_bytes().startswith(b"PK")
    assert json.loads(output.read_text(encoding="utf-8"))["approved"]


def test_acceptance_client_preserves_review_revision(client, tmp_path):
    meeting = client.post("/api/meetings/demo").json()
    meeting["source_mode"] = "audio"  # Only to reach stale-revision validation in this client test.
    output = tmp_path / "review.json"
    smoke.write_json(output, meeting)
    client.patch(f"/api/meetings/{meeting['id']}", json={"revision": meeting["revision"], "summary": "Other reviewer"})
    with pytest.raises(RuntimeError, match="409"):
        smoke.review(client, SimpleNamespace(input=output, approve=True, docx=tmp_path / "protocol.docx"))
    assert not (tmp_path / "protocol.docx").exists()
