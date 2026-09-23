"""Local meeting review API. Run with uvicorn app.main:app from backend/."""

import json
import mimetypes
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from . import storage
from .export import render_docx


MAX_UPLOAD = 100 * 1024 * 1024
ALLOWED_EXTENSIONS = {".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".flac"}
VALID_STAGES = {"transcribing", "diarizing", "extracting"}
executor: ThreadPoolExecutor | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global executor
    storage.initialize()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-ml")
    for record in storage.pending_jobs():
        executor.submit(_run_job, record["meeting"]["id"])
    yield
    executor.shutdown(wait=False, cancel_futures=True)
    executor = None


def _enqueue(meeting_id: str) -> None:
    if executor is None:
        _bad("Processing worker is unavailable", 503)
    executor.submit(_run_job, meeting_id)


app = FastAPI(title="Local Meeting Minutes", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type"],
)


def _bad(message: str, code: int = 422):
    raise HTTPException(status_code=code, detail=message)


def _required_text(value, name: str, limit: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        _bad(f"{name} must be non-empty text up to {limit} characters")
    return value.strip()


def _optional_text(value, name: str, limit: int = 100000) -> str:
    if not isinstance(value, str) or len(value) > limit:
        _bad(f"{name} must be text up to {limit} characters")
    return value


def _date(value, name: str) -> str:
    if not isinstance(value, str):
        _bad(f"{name} must be an ISO date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        _bad(f"{name} must be an ISO date")
    if parsed.isoformat() != value or not (1900 <= parsed.year <= 2100):
        _bad(f"{name} must be an ISO date between 1900 and 2100")
    return value


def _timezone(value) -> str:
    value = _required_text(value, "timezone", 100)
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        _bad("timezone must be a valid IANA timezone")
    return value


def _list(value, name: str, max_items: int = 1000) -> list:
    if not isinstance(value, list) or len(value) > max_items:
        _bad(f"{name} must be an array of at most {max_items} items")
    return value


def _participants(value) -> list[dict]:
    result = []
    ids = set()
    for item in _list(value, "participants", 100):
        if not isinstance(item, dict):
            _bad("participant must be an object")
        participant_id = _required_text(item.get("id"), "participant.id", 100)
        if participant_id in ids:
            _bad("participant IDs must be unique")
        ids.add(participant_id)
        speaker_id = item.get("speaker_id")
        if speaker_id is not None:
            speaker_id = _required_text(speaker_id, "participant.speaker_id", 100)
        result.append({"id": participant_id, "display_name": _required_text(item.get("display_name"), "participant.display_name", 200), "speaker_id": speaker_id})
    return result


def _segments(value) -> list[dict]:
    result = []
    ids = set()
    for item in _list(value, "segments", 100000):
        if not isinstance(item, dict):
            _bad("segment must be an object")
        segment_id = _required_text(item.get("id"), "segment.id", 100)
        if segment_id in ids:
            _bad("segment IDs must be unique")
        ids.add(segment_id)
        start, end = item.get("start_ms"), item.get("end_ms")
        if type(start) is not int or type(end) is not int or start < 0 or end < start or end > 7 * 24 * 3600 * 1000:
            _bad("segment timestamps must be ordered nonnegative milliseconds")
        result.append({"id": segment_id, "start_ms": start, "end_ms": end, "speaker_id": _required_text(item.get("speaker_id"), "segment.speaker_id", 100), "text": _required_text(item.get("text"), "segment.text", 10000)})
    return result


def _actions(value, segment_ids: set[str]) -> list[dict]:
    result = []
    ids = set()
    for item in _list(value, "actions", 1000):
        if not isinstance(item, dict):
            _bad("action must be an object")
        action_id = _required_text(item.get("id"), "action.id", 100)
        if action_id in ids:
            _bad("action IDs must be unique")
        ids.add(action_id)
        title = _optional_text(item.get("title"), "action.title", 1000).strip()
        assignee = _optional_text(item.get("assignee"), "action.assignee", 200).strip()
        due_text = _optional_text(item.get("due_text"), "action.due_text", 300).strip()
        due_date = item.get("due_date")
        if due_date is not None:
            due_date = _date(due_date, "action.due_date")
        evidence = _list(item.get("evidence_segment_ids"), "action.evidence_segment_ids", 1000)
        if any(not isinstance(s, str) or s not in segment_ids for s in evidence) or len(evidence) != len(set(evidence)):
            _bad("action evidence must reference unique existing segment IDs")
        reasons = _list(item.get("review_reasons"), "action.review_reasons", 100)
        if any(not isinstance(r, str) or not r.strip() or len(r) > 300 for r in reasons):
            _bad("review_reasons must contain non-empty short text")
        status = item.get("status")
        if status not in ("open", "done"):
            _bad("action.status must be open or done")
        result.append({"id": action_id, "title": title, "assignee": assignee, "due_text": due_text, "due_date": due_date, "evidence_segment_ids": evidence, "review_reasons": reasons, "status": status})
    return result


def _new_meeting(title: str, occurred_at: str, timezone: str, participants: list, source_mode: str) -> dict:
    return {
        "id": str(uuid.uuid4()), "title": _required_text(title, "title", 300),
        "occurred_at": _date(occurred_at, "occurred_at"), "timezone": _timezone(timezone),
        "source_mode": source_mode, "status": "queued", "approved": False, "revision": 0,
        "participants": _participants(participants), "segments": [], "summary": "", "actions": [],
        "warnings": [], "error": None, "created_at": datetime.now(ZoneInfo("Asia/Almaty")).isoformat(),
        "has_audio": source_mode == "audio",
    }


def _record(meeting_id: str) -> dict:
    record = storage.get_record(meeting_id)
    if record is None:
        _bad("Meeting not found", 404)
    return record


def _revision(meeting: dict, requested):
    if type(requested) is not int or requested != meeting["revision"]:
        _bad("Stale meeting revision; reload and try again", 409)


def _run_job(meeting_id: str):
    record = storage.get_record(meeting_id)
    if not record or record["meeting"]["source_mode"] == "demo":
        return

    def set_stage(stage: str):
        if stage not in VALID_STAGES:
            raise RuntimeError(f"Invalid processing stage: {stage}")
        storage.update(meeting_id, lambda meeting: meeting.update(status=stage, error=None))

    try:
        from . import ml  # Heavy runtime dependencies remain lazy in ml.py.
        meeting = record["meeting"]
        context = {key: meeting[key] for key in ("title", "occurred_at", "timezone", "participants")}
        if meeting["source_mode"] == "audio":
            set_stage("transcribing")
            result = ml.process_audio(record["audio_path"], context, set_stage)
        else:
            set_stage("extracting")
            result = ml.process_text(record["transcript"], context, set_stage)
        if not isinstance(result, dict):
            raise RuntimeError("Local model returned an invalid result object")
        segments = _segments(result.get("segments"))
        actions = _actions(result.get("actions"), {segment["id"] for segment in segments})
        summary = _optional_text(result.get("summary"), "summary", 100000)
        warnings = _list(result.get("warnings"), "warnings", 1000)
        if any(not isinstance(w, str) or len(w) > 1000 for w in warnings):
            raise RuntimeError("Local model returned invalid warnings")

        def complete(current):
            current.update(status="review_ready", segments=segments, actions=actions, summary=summary, warnings=warnings, error=None, approved=False)
            current["revision"] += 1

        storage.update(meeting_id, complete)
    except Exception as exc:
        message = str(exc).strip() or type(exc).__name__
        if isinstance(exc, HTTPException):
            message = f"Local processing returned invalid data: {exc.detail}"
        storage.update(meeting_id, lambda meeting: meeting.update(status="failed", error=message[:2000], approved=False))


@app.get("/api/health")
def health():
    try:
        from . import ml
        providers = ml.probe()
        return {"status": "ok", "mode": "local", "providers": {key: bool(providers.get(key, False)) for key in ("speech", "llm", "diarization")}, "details": providers.get("details", {})}
    except Exception as exc:
        return {"status": "ok", "mode": "local", "providers": {"speech": False, "llm": False, "diarization": False}, "details": {"probe_error": str(exc)}}


@app.get("/api/meetings")
def list_meetings():
    return storage.list_meetings()


@app.post("/api/meetings/demo")
def create_demo():
    fixture_path = storage.ROOT / "fixtures" / "demo.json"
    if not fixture_path.is_file():
        _bad("Synthetic demo fixture is missing at fixtures/demo.json", 503)
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    meeting = _new_meeting(fixture.get("title"), fixture.get("occurred_at"), fixture.get("timezone", "Asia/Almaty"), fixture.get("participants", []), "demo")
    segments = _segments(fixture.get("segments", []))
    actions = _actions(fixture.get("actions", []), {s["id"] for s in segments})
    # Action IDs appear alone in the status endpoint, so every imported demo
    # needs distinct IDs even when the source fixture is imported twice.
    for action in actions:
        action["id"] = str(uuid.uuid5(uuid.UUID(meeting["id"]), action["id"]))
    meeting.update(status="review_ready", segments=segments, actions=actions, summary=_optional_text(fixture.get("summary", ""), "summary"))
    warnings = fixture.get("warnings", [])
    if not isinstance(warnings, list) or any(not isinstance(w, str) for w in warnings):
        _bad("Demo fixture has invalid warnings", 500)
    meeting["warnings"] = ["Демо: вымышленные данные; локальная модель не запускалась.", *warnings]
    storage.insert(meeting)
    return meeting


@app.post("/api/meetings/text")
def create_text(payload: dict = Body(...)):
    if not isinstance(payload, dict):
        _bad("Body must be an object")
    transcript = _required_text(payload.get("transcript"), "transcript", 1_000_000)
    meeting = _new_meeting(payload.get("title"), payload.get("occurred_at"), payload.get("timezone"), payload.get("participants", []), "text")
    storage.insert(meeting, transcript=transcript)
    _enqueue(meeting["id"])
    return meeting


@app.post("/api/meetings/audio")
async def create_audio(file: UploadFile = File(...), title: str = Form(...), occurred_at: str = Form(...), timezone: str = Form(...), participants: str = Form("[]")):
    try:
        parsed_participants = json.loads(participants)
    except json.JSONDecodeError:
        _bad("participants must be a JSON array")
    meeting = _new_meeting(title, occurred_at, timezone, parsed_participants, "audio")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        _bad("Unsupported file type; use wav, mp3, m4a, mp4, webm, ogg or flac")
    storage.initialize()
    path = storage.UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"
    total = 0
    try:
        with path.open("xb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD:
                    _bad("File exceeds 100 MB limit", 413)
                output.write(chunk)
        if total == 0:
            _bad("Audio file is empty")
        storage.insert(meeting, audio_path=str(path))
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    _enqueue(meeting["id"])
    return meeting


@app.get("/api/meetings/{meeting_id}")
def get_meeting(meeting_id: str):
    return _record(meeting_id)["meeting"]


@app.patch("/api/meetings/{meeting_id}")
def patch_meeting(meeting_id: str, payload: dict = Body(...)):
    if not isinstance(payload, dict) or "revision" not in payload or not any(key in payload for key in ("participants", "actions", "summary")):
        _bad("Provide revision and at least one editable field")
    if set(payload) - {"revision", "participants", "actions", "summary"}:
        _bad("Unknown meeting patch field")

    def mutate(meeting):
        _revision(meeting, payload["revision"])
        if meeting["status"] != "review_ready":
            _bad("Meeting is not ready for review", 409)
        if "participants" in payload:
            meeting["participants"] = _participants(payload["participants"])
        if "actions" in payload:
            meeting["actions"] = _actions(payload["actions"], {segment["id"] for segment in meeting["segments"]})
        if "summary" in payload:
            meeting["summary"] = _optional_text(payload["summary"], "summary")
        meeting["approved"] = False
        meeting["revision"] += 1

    updated = storage.update(meeting_id, mutate)
    if updated is None:
        _bad("Meeting not found", 404)
    return updated


@app.post("/api/meetings/{meeting_id}/approve")
def approve_meeting(meeting_id: str, payload: dict = Body(...)):
    if not isinstance(payload, dict) or set(payload) != {"revision"}:
        _bad("Provide revision")

    def mutate(meeting):
        _revision(meeting, payload["revision"])
        if meeting["status"] != "review_ready":
            _bad("Meeting is not ready for approval", 409)
        for action in meeting["actions"]:
            if not action["title"] or not action["assignee"] or action["review_reasons"]:
                _bad("Resolve empty titles, assignees and review reasons before approval", 409)
        meeting["approved"] = True
        meeting["revision"] += 1

    updated = storage.update(meeting_id, mutate)
    if updated is None:
        _bad("Meeting not found", 404)
    return updated


@app.get("/api/meetings/{meeting_id}/export.docx")
def export_meeting(meeting_id: str):
    meeting = _record(meeting_id)["meeting"]
    if not meeting["approved"]:
        _bad("Approve the meeting before export", 409)
    content = render_docx(meeting)
    return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document", headers={"Content-Disposition": f'attachment; filename="meeting-{meeting_id}.docx"'})


@app.get("/api/meetings/{meeting_id}/audio")
def get_audio(meeting_id: str):
    record = _record(meeting_id)
    path_text = record["audio_path"]
    if not path_text or not record["meeting"]["has_audio"]:
        _bad("This meeting has no audio", 404)
    path = Path(path_text).resolve()
    if not path.is_relative_to(storage.UPLOAD_DIR) or not path.is_file():
        _bad("Audio file is unavailable", 404)
    return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream", filename=f"meeting-{meeting_id}{path.suffix}", content_disposition_type="inline")


@app.get("/api/actions")
def list_actions():
    result = []
    for meeting in storage.list_meetings():
        today = datetime.now(ZoneInfo(meeting["timezone"])).date()
        for action in meeting["actions"]:
            due = action.get("due_date")
            result.append({**action, "meeting_id": meeting["id"], "meeting_title": meeting["title"], "approved": meeting["approved"], "overdue": bool(meeting["approved"] and action["status"] == "open" and due and date.fromisoformat(due) < today)})
    return result


@app.patch("/api/actions/{action_id}")
def patch_action(action_id: str, payload: dict = Body(...)):
    if not isinstance(payload, dict) or set(payload) != {"status"} or payload["status"] not in ("open", "done"):
        _bad("status must be open or done")
    for meeting in storage.list_meetings():
        if not any(action["id"] == action_id for action in meeting["actions"]):
            continue

        def mutate(current):
            if not current["approved"]:
                _bad("Approve the meeting before changing action status", 409)
            for action in current["actions"]:
                if action["id"] == action_id:
                    action["status"] = payload["status"]
                    return action
            _bad("Action not found", 404)

        return storage.update(meeting["id"], mutate)
    _bad("Action not found", 404)


@app.get("/api/notifications")
def notifications():
    result = []
    for meeting in storage.list_meetings():
        if not meeting["approved"]:
            continue
        local_today = datetime.now(ZoneInfo(meeting["timezone"])).date()
        for action in meeting["actions"]:
            if action["status"] != "open" or not action["due_date"]:
                continue
            due = date.fromisoformat(action["due_date"])
            kind = "overdue" if due < local_today else "due_soon" if due <= local_today + timedelta(days=3) else None
            if kind:
                result.append({"id": f"{action['id']}:{action['due_date']}:{kind}", "meeting_id": meeting["id"], "action_id": action["id"], "title": action["title"], "kind": kind, "assignee": action["assignee"]})
    return result


@app.get("/{path:path}")
def spa(path: str):
    if path == "api" or path.startswith("api/"):
        _bad("API route not found", 404)
    dist = storage.ROOT / "frontend" / "dist"
    if not dist.is_dir():
        _bad("Frontend build is unavailable", 404)
    candidate = (dist / path).resolve()
    if not candidate.is_relative_to(dist.resolve()):
        _bad("File not found", 404)
    if candidate.is_file():
        return FileResponse(candidate)
    if "." in Path(path).name:
        _bad("File not found", 404)
    return FileResponse(dist / "index.html")
