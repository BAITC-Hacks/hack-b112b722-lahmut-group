"""Small SQLite store with one connection per operation and serialized writes."""

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

from . import telegram_store


ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env", override=False)
_configured_data_dir = Path(os.environ.get("DATA_DIR", "data")).expanduser()
DATA_DIR = (_configured_data_dir if _configured_data_dir.is_absolute() else ROOT / _configured_data_dir).resolve()
DB_PATH = DATA_DIR / "meetings.sqlite3"
UPLOAD_DIR = DATA_DIR / "uploads"
_write_lock = threading.RLock()


class ActionIDConflict(ValueError):
    """An action ID already belongs to another meeting."""


def initialize() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with connection() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL, audio_path TEXT, transcript TEXT)")
        db.execute("CREATE INDEX IF NOT EXISTS meetings_created_at ON meetings(created_at DESC)")
        if "approved_data" not in {row["name"] for row in db.execute("PRAGMA table_info(meetings)")}:
            db.execute("ALTER TABLE meetings ADD COLUMN approved_data TEXT")
        telegram_store.initialize(db)
        for row in db.execute("SELECT data FROM meetings").fetchall():
            telegram_store.observe(db, json.loads(row["data"]))
        # Preserve existing approved records on upgrade as well as new approvals.
        for row in db.execute("SELECT id, data FROM meetings WHERE approved_data IS NULL").fetchall():
            if json.loads(row["data"])["approved"]:
                db.execute("UPDATE meetings SET approved_data = data WHERE id = ?", (row["id"],))
        db.commit()


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
        db.execute("BEGIN IMMEDIATE")
        _check_action_ids(db, meeting)
        telegram_store.observe(db, meeting)
        db.execute(
            "INSERT INTO meetings(id, created_at, data, audio_path, transcript) VALUES(?, ?, ?, ?, ?)",
            (meeting["id"], meeting["created_at"], json.dumps(meeting, ensure_ascii=False), audio_path, transcript),
        )
        db.commit()


def get_record(meeting_id: str) -> dict | None:
    with connection() as db:
        row = db.execute("SELECT data, audio_path, transcript, approved_data FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    if row is None:
        return None
    return {"meeting": json.loads(row["data"]), "audio_path": row["audio_path"], "transcript": row["transcript"],
            "approved_meeting": json.loads(row["approved_data"]) if row["approved_data"] else None}


def _check_action_ids(db, meeting: dict) -> None:
    ids = {action["id"] for action in meeting["actions"]}
    if not ids:
        return
    for row in db.execute("SELECT data FROM meetings WHERE id != ?", (meeting["id"],)):
        if ids.intersection(action["id"] for action in json.loads(row["data"])["actions"]):
            raise ActionIDConflict("Action IDs must be unique across meetings")


def list_meetings() -> list[dict]:
    with connection() as db:
        rows = db.execute("SELECT data FROM meetings ORDER BY created_at DESC, id DESC").fetchall()
    return [json.loads(row["data"]) for row in rows]


def update(meeting_id: str, mutate):
    """Atomically read, mutate and write a meeting. Mutator may raise HTTPException."""
    with _write_lock, connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data, approved_data FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row is None:
            db.rollback()
            return None
        meeting = json.loads(row["data"])
        result = mutate(meeting)
        _check_action_ids(db, meeting)
        telegram_store.observe(db, meeting)
        encoded = json.dumps(meeting, ensure_ascii=False)
        snapshot = (row["approved_data"] or encoded) if meeting["approved"] else None
        db.execute("UPDATE meetings SET data = ?, approved_data = ? WHERE id = ?", (encoded, snapshot, meeting_id))
        db.commit()
    return meeting if result is None else result


def recover_interrupted_jobs() -> None:
    """Keep queued work durable; never silently rerun interrupted inference."""
    with _write_lock, connection() as db:
        db.execute("BEGIN IMMEDIATE")
        for row in db.execute("SELECT id, data FROM meetings").fetchall():
            meeting = json.loads(row["data"])
            if meeting["status"] in {"transcribing", "diarizing", "extracting"}:
                stage = meeting["status"]
                meeting.update(status="failed", approved=False,
                               error=f"Processing interrupted during {stage} by a server restart. Upload the source again to retry.")
                meeting["revision"] += 1
                db.execute("UPDATE meetings SET data = ?, approved_data = NULL WHERE id = ?",
                           (json.dumps(meeting, ensure_ascii=False), row["id"]))
        db.commit()


def pending_jobs() -> list[dict]:
    with connection() as db:
        rows = db.execute("SELECT data, audio_path, transcript FROM meetings ORDER BY created_at ASC").fetchall()
    return [
        {"meeting": json.loads(row["data"]), "audio_path": row["audio_path"], "transcript": row["transcript"]}
        for row in rows
        if json.loads(row["data"])["status"] == "queued"
    ]
