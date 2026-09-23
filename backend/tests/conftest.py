"""Backend tests use disposable storage and never access a developer's database."""

import pytest
from fastapi.testclient import TestClient

from backend.app import main, storage


@pytest.fixture
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_ENABLED", "false")
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "meetings.sqlite3")
    monkeypatch.setattr(storage, "UPLOAD_DIR", tmp_path / "uploads")
    storage.initialize()
    return tmp_path


@pytest.fixture
def client(isolated_storage):
    with TestClient(main.app) as instance:
        yield instance
