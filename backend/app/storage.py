"""Small SQLite store with one connection per operation and serialized writes."""

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
_configured_data_dir = Path(os.environ.get("DATA_DIR", "data")).expanduser()
DATA_DIR = (_configured_data_dir if _configured_data_dir.is_absolute() else ROOT / _configured_data_dir).resolve()
DB_PATH = DATA_DIR / "meetings.sqlite3"
UPLOAD_DIR = DATA_DIR / "uploads"
_write_lock = threading.RLock()


def initialize() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with connection() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL, audio_path TEXT, transcript TEXT)")
        db.execute("CREATE INDEX IF NOT EXISTS meetings_created_at ON meetings(created_at DESC)")


@contextmanager
def connection():
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    try:
        yield db
    finally:
        db.close()


def insert(meeting: dict, *, audio_path: str | None = None, transcript: str | None = None) -> None:
    with _write_lock, connection() as db:
        db.execute(
            "INSERT INTO meetings(id, created_at, data, audio_path, transcript) VALUES(?, ?, ?, ?, ?)",
            (meeting["id"], meeting["created_at"], json.dumps(meeting, ensure_ascii=False), audio_path, transcript),
        )
        db.commit()


def get_record(meeting_id: str) -> dict | None:
    with connection() as db:
        row = db.execute("SELECT data, audio_path, transcript FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    if row is None:
        return None
    return {"meeting": json.loads(row["data"]), "audio_path": row["audio_path"], "transcript": row["transcript"]}


def list_meetings() -> list[dict]:
    with connection() as db:
        rows = db.execute("SELECT data FROM meetings ORDER BY created_at DESC, id DESC").fetchall()
    return [json.loads(row["data"]) for row in rows]


def update(meeting_id: str, mutate):
    """Atomically read, mutate and write a meeting. Mutator may raise HTTPException."""
    with _write_lock, connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row is None:
            db.rollback()
            return None
        meeting = json.loads(row["data"])
        result = mutate(meeting)
        db.execute("UPDATE meetings SET data = ? WHERE id = ?", (json.dumps(meeting, ensure_ascii=False), meeting_id))
        db.commit()
    return meeting if result is None else result


def pending_jobs() -> list[dict]:
    with connection() as db:
        rows = db.execute("SELECT data, audio_path, transcript FROM meetings ORDER BY created_at ASC").fetchall()
    return [
        {"meeting": json.loads(row["data"]), "audio_path": row["audio_path"], "transcript": row["transcript"]}
        for row in rows
        if json.loads(row["data"])["status"] in {"queued", "transcribing", "diarizing", "extracting"}
    ]
