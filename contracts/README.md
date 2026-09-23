# MVP contract v1

All HTTP paths have `/api` prefix. JSON keys use snake_case. IDs are UUID strings except deterministic demo segments/actions. Dates are ISO, timezone is `Asia/Almaty` by default. Errors: `{detail: string}`. Core never calls external hosted inference.

## Records

Meeting `{id,title,occurred_at: YYYY-MM-DD,timezone,source_mode: audio|text|demo,status: queued|transcribing|diarizing|extracting|review_ready|failed,approved: boolean,revision: integer,participants: Participant[],segments: Segment[],summary: string,actions: Action[],warnings: string[],error: string|null,created_at: ISO,has_audio: boolean}`

Participant `{id,display_name,speaker_id: string|null}`
Segment `{id,start_ms: integer,end_ms: integer,speaker_id: string,text: string}`
Action `{id,title,assignee: string,due_text: string,due_date: YYYY-MM-DD|null,evidence_segment_ids: string[],review_reasons: string[],status: open|done}`
Notification `{id,meeting_id,action_id,title,kind: due_soon|overdue,assignee}`

Empty responsible is `""`, missing due date is `null`; never invent. Source timestamps for text import are zero and cannot be marketed as audio alignment. All edits/approval require revision; stale revision -> 409. Changes after approval reset approved=false. Completion status may change after approval without invalidating protocol.

## HTTP

- `GET /api/health` -> `{status:"ok",mode:"local",providers:{speech: boolean,llm: boolean,diarization:boolean},details: object}`; status availability is probe only, not quality claim.
- `GET /api/meetings` -> `Meeting[]` newest first.
- `POST /api/meetings/demo` no body -> Meeting. Known synthetic fixture, already review_ready, clearly marked demo. Must not invoke paid API or pretend live inference.
- `POST /api/meetings/text` JSON `{title,occurred_at,timezone,transcript:string,participants:Participant[]}` -> Meeting queued for REAL local LLM. No heuristic fallback presented as ML.
- `POST /api/meetings/audio` multipart fields `file,title,occurred_at,timezone,participants` (participants JSON string) -> Meeting queued. Limit 100MB, allowed wav/mp3/m4a/mp4/webm/ogg/flac; bounded writes, opaque file names.
- `GET /api/meetings/{id}` -> Meeting
- `PATCH /api/meetings/{id}` JSON `{revision,participants?:Participant[],actions?:Action[],summary?:string}` -> Meeting. Validate evidence IDs, unique IDs, dates, bounds and action statuses. Preserve action IDs. Reset approval.
- `POST /api/meetings/{id}/approve` JSON `{revision}` -> Meeting. Requires review_ready; reject empty assignees/titles and any unresolved review_reasons. User clears review reasons after manual correction in UI. Missing due date allowed, explicit unspecified text retained.
- `GET /api/meetings/{id}/export.docx` -> DOCX, only approved.
- `GET /api/meetings/{id}/audio` -> original file, when present, support browser playback.
- `GET /api/actions` -> `[{...Action,meeting_id,meeting_title,approved,overdue:boolean}]`
- `PATCH /api/actions/{id}` JSON `{status:"open"|"done"}` -> Action; only approved meeting.
- `GET /api/notifications` -> Notification[] derived from approved open tasks and confirmed concrete dates, deterministic IDs.

## Internal ML interface (owned by ML agent)

`backend/app/ml.py` exports:

`probe() -> dict` containing speech/llm/diarization booleans and details dict, fast and must not download models.

`process_audio(path: str, context: dict, on_stage: Callable[[str], None]) -> dict`

`process_text(text: str, context: dict, on_stage: Callable[[str], None]) -> dict`

Context is meeting dict with title/occurred_at/timezone/participants. Return `{segments: Segment[],summary: str,actions: Action[],warnings: string[]}`. Raise actionable RuntimeError on missing dependencies/models or invalid generation. Imports of heavyweight libraries lazy. No automatic cloud fallback. Calls local Ollama only (default http://127.0.0.1:11434; explicit private host opt-in). Env: OLLAMA_BASE_URL, OLLAMA_MODEL (qwen3:8b), ASR_MODEL (large-v3), ASR_DEVICE (cpu), ASR_COMPUTE_TYPE (int8), DIARIZATION_MODEL_PATH, WHISPER_CPP_BIN, WHISPER_CPP_MODEL. Full audio requires real diarization, else fail with instructions. Use local cached weights; downloading is separate explicit setup.

## Ownership

Backend agent: backend except ml.py and requirements-ml.txt. UI agent: frontend only. ML agent: ml.py, requirements-ml.txt, tests/test_ml.py, scripts/check_models.py. Root: contract, fixtures, README, root scripts/config and integration tests. Do not overwrite other owners' files. Ask root when contract must change.
