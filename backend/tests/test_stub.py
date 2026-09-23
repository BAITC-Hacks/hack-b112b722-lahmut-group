"""Synthetic adapter exercises real HTTP, queue, storage and approval code."""

import pytest
import subprocess
import sys
from fastapi.testclient import TestClient

from backend.app import main, ml
from backend.testing.ml_stub import MARKER, Scenario, StubML
from backend.testing.server import create_app
from backend.tests.test_backend import approved, poll, reviewed, text_payload, upload


@pytest.mark.parametrize("scenario,stage", [("fail-transcribing", "transcribing"), ("fail-diarizing", "diarizing"),
                                           ("fail-extracting", "extracting"), ("invalid-evidence", "extracting"),
                                           ("invalid-summary", "extracting")])
def test_stub_failure_is_persisted_and_export_blocked(isolated_storage, scenario, stage):
    with TestClient(create_app(StubML(Scenario(name=scenario, delay_ms=0)))) as client:
        meeting = poll(client, upload(client).json()["id"])
        assert meeting["status"] == "failed"
        assert meeting["error"].startswith(stage + ":")
        assert not meeting["actions"] and not meeting["approved"]
        assert client.get(f"/api/meetings/{meeting['id']}/export.docx").status_code == 409


def test_stub_health_and_outputs_cannot_claim_real_inference(isolated_storage):
    original = ml.process_audio
    with TestClient(create_app(StubML(Scenario(name="review", delay_ms=0)))) as client:
        health = client.get("/api/health").json()
        assert health["details"]["test_mode"] is True
        assert not any(health["providers"].values())
        meeting = poll(client, upload(client).json()["id"])
        assert meeting["source_mode"] == "audio" and meeting["status"] == "review_ready"
        assert MARKER in meeting["warnings"] and MARKER in meeting["summary"]
        assert client.post(f"/api/meetings/{meeting['id']}/approve", json={"revision": meeting["revision"]}).status_code == 409
        approved(client, reviewed(client, meeting))
    assert ml.process_audio is original
    with TestClient(main.app) as client:
        # A production SPA may serve HTML for unknown GET paths, but it has
        # neither the JSON control route nor the mutation endpoint.
        response = client.get("/__test__/state")
        assert response.status_code == 404 or "text/html" in response.headers.get("content-type", "")
        assert client.post("/__test__/scenario", json={"name": "review"}).status_code in (404, 405)


@pytest.mark.parametrize("language", ["ru", "kz", "mixed"])
def test_stub_text_roundtrip_and_contract(isolated_storage, language):
    with TestClient(create_app(StubML(Scenario(name="review", language=language, delay_ms=0)))) as client:
        meeting = poll(client, client.post("/api/meetings/text", json=text_payload()).json()["id"])
        assert meeting["status"] == "review_ready"
        assert all(s["start_ms"] == s["end_ms"] == 0 for s in meeting["segments"])
        assert meeting["segments"][-1]["text"] == text_payload()["transcript"]
        assert meeting["actions"][1]["due_date"] is None
        assert meeting["actions"][1]["assignee"] == ""


def test_stub_corrupt_audio_is_not_successful(isolated_storage):
    with TestClient(create_app(StubML(Scenario(name="review", delay_ms=0)))) as client:
        meeting = poll(client, upload(client, content=b"invalid wave").json()["id"])
        assert meeting["status"] == "failed" and "PCM WAV" in meeting["error"]


def test_stub_empty_tasks_can_be_approved(isolated_storage):
    with TestClient(create_app(StubML(Scenario(name="empty", delay_ms=0)))) as client:
        meeting = poll(client, client.post("/api/meetings/text", json=text_payload()).json()["id"])
        assert meeting["actions"] == []
        assert approved(client, meeting)["approved"]


def test_stub_scenario_validation(isolated_storage):
    with TestClient(create_app()) as client:
        assert client.post("/__test__/scenario", json={"name": "real-ml"}).status_code == 422
        assert client.post("/__test__/scenario", json={"delay_ms": -1}).status_code == 422
        assert client.post("/__test__/scenario", json={"delay_ms": 10001}).status_code == 422


def test_stub_launcher_refuses_existing_non_test_database(isolated_storage):
    database = isolated_storage / "meetings.sqlite3"
    original = database.read_bytes()
    result = subprocess.run([sys.executable, "-m", "backend.testing.server", "--data-dir", str(isolated_storage)],
                            capture_output=True, timeout=10)
    assert result.returncode == 2
    assert b"Refusing an existing non-test database" in result.stderr
    assert database.read_bytes() == original
    assert not (isolated_storage / ".synthetic-ml-test-data").exists()
