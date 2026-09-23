"""Optional, strictly local speech and meeting extraction adapter.

Weights are provisioned separately. Importing this module never imports a model or
downloads anything; failed prerequisites become actionable RuntimeErrors.
"""

from __future__ import annotations

import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid
import wave


MAX_TEXT_CHARS = 80_000
MAX_AUDIO_SECONDS = 3600
MAX_GENERATED_BYTES = 2_000_000
OLLAMA_TIMEOUT_SECONDS = 180
_UUID_NAMESPACE = uuid.UUID("987d6d03-4d13-48cd-bcdb-e2620931ace7")
_DATE_RE = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)")
_SPEAKER_RE = re.compile(r"^\s*([^:\n]{1,80}):\s*(\S.*)$")


def _ollama_url() -> str:
    raw = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        port = parsed.port or 80
    except ValueError as exc:
        raise RuntimeError("OLLAMA_BASE_URL is malformed.") from exc
    if parsed.scheme != "http" or not host or parsed.username or parsed.password or parsed.path.rstrip("/") or parsed.query or parsed.fragment:
        raise RuntimeError("OLLAMA_BASE_URL must be an HTTP origin without credentials or a path.")
    if host != "localhost":
        try:
            address = ipaddress.ip_address(host)
        except ValueError as exc:
            raise RuntimeError("OLLAMA_BASE_URL must use localhost or a literal private IP address.") from exc
        if not (address.is_loopback or address.is_private) or address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved:
            raise RuntimeError("OLLAMA_BASE_URL must point to a local or private address.")
        if not address.is_loopback and "OLLAMA_BASE_URL" not in os.environ:
            raise RuntimeError("Private Ollama hosts require explicit OLLAMA_BASE_URL configuration.")
    if not 1 <= port <= 65535:
        raise RuntimeError("OLLAMA_BASE_URL has an invalid port.")
    host_for_url = f"[{host}]" if ":" in host else host
    return f"http://{host_for_url}:{port}"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Ollama redirected the request; refusing to send meeting data elsewhere.")


def _ollama_request(endpoint: str, payload: dict | None = None, timeout: int = 2) -> dict:
    # Do not honor HTTP(S)_PROXY, and do not follow redirects to another host.
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(_ollama_url() + endpoint, data=data, headers={"Content-Type": "application/json"}, method="GET" if data is None else "POST")
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(MAX_GENERATED_BYTES + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Local Ollama is unavailable: {exc}. Start Ollama and pull the configured model.") from exc
    if len(body) > MAX_GENERATED_BYTES:
        raise RuntimeError("Local Ollama response exceeded the size limit.")
    try:
        result = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Local Ollama returned invalid JSON.") from exc
    if not isinstance(result, dict):
        raise RuntimeError("Local Ollama returned an unexpected response.")
    return result


def _llm_model() -> str:
    model = os.getenv("OLLAMA_MODEL", "qwen3:8b").strip()
    if not model or len(model) > 120 or re.search(r"[\s/@]", model) or "cloud" in model.lower():
        raise RuntimeError("OLLAMA_MODEL must name a locally installed model; cloud models are disabled.")
    return model


def _installed_llm() -> tuple[bool, str]:
    try:
        model = _llm_model()
        models = _ollama_request("/api/tags", timeout=2).get("models")
        names = {item.get("name") for item in models if isinstance(item, dict)} if isinstance(models, list) else set()
        equivalent = model if ":" in model else model + ":latest"
        if model in names or equivalent in names:
            return True, f"Ollama model {model} is installed"
        return False, f"Ollama model {model} is missing; run `ollama pull {model}` separately"
    except RuntimeError as exc:
        return False, str(exc)


def _asr_source() -> tuple[str | None, str]:
    binary = os.getenv("WHISPER_CPP_BIN", "").strip()
    model = os.getenv("WHISPER_CPP_MODEL", "").strip()
    if binary or model:
        if not binary or not model:
            return None, "Set both WHISPER_CPP_BIN and WHISPER_CPP_MODEL for whisper.cpp"
        executable = shutil.which(binary)
        if not executable or not Path(model).is_file():
            return None, "WHISPER_CPP_BIN must be executable and WHISPER_CPP_MODEL must be an existing local file"
        return "whisper.cpp", f"whisper.cpp: {model}"
    if importlib.util.find_spec("faster_whisper") is None:
        return None, "Install backend/requirements-ml.txt or configure whisper.cpp"
    model = os.getenv("ASR_MODEL", "large-v3")
    if Path(model).is_dir():
        if (Path(model) / "model.bin").is_file() and (Path(model) / "tokenizer.json").is_file():
            return "faster-whisper", f"Local faster-whisper model: {model}"
        return None, "ASR_MODEL directory needs model.bin and tokenizer.json"
    # Probe common Hugging Face cache paths without importing heavy libraries.
    aliases = {"large": "large-v3", "turbo": "large-v3-turbo"}
    size = aliases.get(model, model)
    if not re.fullmatch(r"(?:tiny|base|small|medium)(?:\.en)?|large-v[123]|large-v3-turbo|distil-(?:small\.en|medium\.en|large-v[23])", size):
        return None, "ASR_MODEL must be a local directory or supported faster-whisper model name"
    repo = ("faster-distil-whisper-" if size.startswith("distil-") else "faster-whisper-") + size.removeprefix("distil-")
    cache = Path(os.getenv("HF_HUB_CACHE", Path(os.getenv("HF_HOME", Path.home() / ".cache/huggingface")) / "hub"))
    snapshots = cache / f"models--Systran--{repo}" / "snapshots"
    if snapshots.is_dir() and any((p / "model.bin").is_file() and (p / "tokenizer.json").is_file() for p in snapshots.iterdir() if p.is_dir()):
        return "faster-whisper", f"Cached faster-whisper model: {model}"
    return None, f"ASR_MODEL={model} is not cached; download it separately or set ASR_MODEL to a local converted model directory"


def probe() -> dict:
    """Check local configuration quickly; does not load or fetch model weights."""
    speech_kind, speech_detail = _asr_source()
    diar_path = Path(os.getenv("DIARIZATION_MODEL_PATH", "")) if os.getenv("DIARIZATION_MODEL_PATH") else None
    diar_ok = bool(diar_path and diar_path.is_dir() and (diar_path / "config.yaml").is_file() and importlib.util.find_spec("pyannote") is not None)
    diar_detail = (f"Local pyannote model: {diar_path}" if diar_ok else "Set DIARIZATION_MODEL_PATH to a complete local pyannote Community-1 directory and install pyannote.audio")
    llm_ok, llm_detail = _installed_llm()
    ffmpeg_ok = bool(shutil.which("ffmpeg"))
    speech_ok = bool(speech_kind and ffmpeg_ok)
    if not ffmpeg_ok:
        speech_detail += "; install ffmpeg"
    return {"speech": speech_ok, "llm": llm_ok, "diarization": diar_ok and ffmpeg_ok,
            "details": {"speech": speech_detail, "llm": llm_detail, "diarization": diar_detail}}


def _text_segments(text: str, context: dict) -> list[dict]:
    participants = context.get("participants") or []
    names = {p.get("display_name", "").strip().casefold(): p.get("speaker_id") for p in participants if isinstance(p, dict)}
    segments: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        match = _SPEAKER_RE.match(line)
        if match:
            label, utterance = match.group(1).strip(), match.group(2).strip()
            speaker = names.get(label.casefold()) or label
            segments.append({"id": str(uuid.uuid5(_UUID_NAMESPACE, f"{context.get('id', '')}:text:{len(segments)}:{speaker}:{utterance}")),
                             "start_ms": 0, "end_ms": 0, "speaker_id": speaker, "text": utterance})
        elif segments:
            segments[-1]["text"] += " " + line
        else:
            segments.append({"id": str(uuid.uuid5(_UUID_NAMESPACE, f"{context.get('id', '')}:text:0::{line}")),
                             "start_ms": 0, "end_ms": 0, "speaker_id": "", "text": line})
    return segments


_EXTRACTION_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "summary": {"type": "string"},
        "actions": {"type": "array", "items": {"type": "object", "additionalProperties": False,
            "properties": {"title": {"type": "string"}, "assignee": {"type": "string"},
                "due_text": {"type": "string"}, "due_date": {"type": ["string", "null"]},
                "evidence_segment_ids": {"type": "array", "items": {"type": "string"}}},
            "required": ["title", "assignee", "due_text", "due_date", "evidence_segment_ids"]}}},
    "required": ["summary", "actions"]}


def _ollama_extract(segments: list[dict], context: dict) -> dict:
    model = _llm_model()
    installed, detail = _installed_llm()
    if not installed:
        raise RuntimeError(detail)
    source = [{"id": s["id"], "speaker_id": s["speaker_id"], "text": s["text"]} for s in segments]
    prompt = (
        "Summarize the meeting and extract ONLY explicit commitments or tasks. "
        "Use the source segment IDs as evidence for every action. A speaker is not automatically the assignee. "
        "If the assignee is not explicitly named, return an empty assignee. Never infer names or deadlines. "
        "Quote the deadline phrase verbatim in due_text; leave due_date null for relative or ambiguous dates. "
        "Return JSON matching this schema exactly: " + json.dumps(_EXTRACTION_SCHEMA) + "\n"
        "Meeting context: " + json.dumps({k: context.get(k) for k in ("title", "occurred_at", "timezone", "participants")}, ensure_ascii=False) + "\n"
        "Source segments: " + json.dumps(source, ensure_ascii=False)
    )
    reply = _ollama_request("/api/generate", {"model": model, "prompt": prompt, "format": _EXTRACTION_SCHEMA,
                         "stream": False, "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 2048}, "keep_alive": "0"},
                            timeout=OLLAMA_TIMEOUT_SECONDS)
    content = reply.get("response")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Local Ollama returned no extraction; try a stronger local model.")
    try:
        value = json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Local Ollama returned invalid structured JSON.") from exc
    if not isinstance(value, dict):
        raise RuntimeError("Local Ollama extraction must be a JSON object.")
    return value


def _validated_extraction(raw: dict, segments: list[dict], context: dict) -> tuple[str, list[dict], list[str]]:
    if set(raw) != {"summary", "actions"} or not isinstance(raw["summary"], str) or not raw["summary"].strip() or len(raw["summary"]) > 10_000:
        raise RuntimeError("Local Ollama returned an invalid summary or schema.")
    if not isinstance(raw["actions"], list) or len(raw["actions"]) > 100:
        raise RuntimeError("Local Ollama returned an invalid action list.")
    by_id = {s["id"]: s for s in segments}
    actions = []
    warnings = []
    for index, item in enumerate(raw["actions"]):
        required = {"title", "assignee", "due_text", "due_date", "evidence_segment_ids"}
        if not isinstance(item, dict) or set(item) != required:
            raise RuntimeError(f"Local Ollama returned an invalid action schema at item {index + 1}.")
        title, assignee, due_text, due_date, evidence = (item[key] for key in ("title", "assignee", "due_text", "due_date", "evidence_segment_ids"))
        if not all(isinstance(x, str) for x in (title, assignee, due_text)) or not title.strip() or len(title) > 500 or len(assignee) > 120 or len(due_text) > 200:
            raise RuntimeError(f"Local Ollama returned invalid action text at item {index + 1}.")
        if due_date is not None and (not isinstance(due_date, str) or len(due_date) > 20):
            raise RuntimeError(f"Local Ollama returned an invalid due date at item {index + 1}.")
        if not isinstance(evidence, list) or not evidence or len(evidence) > 30 or any(not isinstance(x, str) or x not in by_id for x in evidence):
            raise RuntimeError(f"Local Ollama cited missing evidence for action {index + 1}.")
        evidence = list(dict.fromkeys(evidence))
        source_text = " ".join(by_id[e]["text"] for e in evidence)
        reasons = []
        assignee = assignee.strip()
        named_in_text = bool(assignee and re.search(r"(?<!\w)" + re.escape(assignee) + r"(?!\w)", source_text, re.IGNORECASE))
        self_commitment = bool(assignee and any(
            by_id[e]["speaker_id"].casefold() == assignee.casefold()
            and re.search(r"\b(?:I\s+(?:will|can|shall|am going to)|I'll|я\s+(?:сделаю|подготовлю|отправлю)|мен\s+(?:жасаймын|жіберемін))\b", by_id[e]["text"], re.IGNORECASE)
            for e in evidence))
        if assignee and not (named_in_text or self_commitment):
            assignee = ""
            reasons.append("assignee_not_in_evidence")
        if not assignee:
            reasons.append("assignee_needs_review")
        due_text = due_text.strip()
        if due_text and due_text.casefold() not in source_text.casefold():
            due_text = ""
            reasons.append("deadline_not_in_evidence")
        confirmed_date = None
        if due_date:
            try:
                from datetime import date
                parsed = date.fromisoformat(due_date)
                valid_iso = parsed.isoformat() == due_date
            except ValueError:
                valid_iso = False
            if valid_iso and due_date in source_text and (not due_text or due_date in due_text):
                confirmed_date = due_date
            else:
                reasons.append("date_needs_review")
        if due_text and not confirmed_date:
            reasons.append("deadline_needs_review")
        if not due_text:
            due_text = "Not specified"
        action_id = str(uuid.uuid5(_UUID_NAMESPACE, f"{context.get('id', '')}:action:{index}:{title.strip()}:{','.join(evidence)}"))
        actions.append({"id": action_id, "title": title.strip(), "assignee": assignee, "due_text": due_text,
                        "due_date": confirmed_date, "evidence_segment_ids": evidence,
                        "review_reasons": list(dict.fromkeys(reasons)), "status": "open"})
        if reasons:
            warnings.append(f"Action {index + 1} needs review: {', '.join(dict.fromkeys(reasons))}.")
    return raw["summary"].strip(), actions, warnings


def _extract(segments: list[dict], context: dict, warnings: list[str]) -> dict:
    if not segments:
        raise RuntimeError("No speech or transcript text was found to summarize.")
    chunks: list[list[dict]] = []
    current: list[dict] = []
    length = 0
    for segment in segments:
        size = len(segment["text"])
        if size > 5_000:
            raise RuntimeError("A transcript segment is too long; split long paragraphs into shorter speaker turns.")
        if current and length + size > 6_000:
            chunks.append(current)
            current, length = [], 0
        current.append(segment)
        length += size
    if current:
        chunks.append(current)
    if len(chunks) > 20:
        raise RuntimeError("Transcript exceeds the local extraction limit of 20 chunks; split this meeting into shorter recordings.")
    summaries: list[str] = []
    actions: list[dict] = []
    for chunk in chunks:
        summary, extracted, review_warnings = _validated_extraction(_ollama_extract(chunk, context), chunk, context)
        summaries.append(summary)
        actions.extend(extracted)
        warnings.extend(review_warnings)
    if len(chunks) > 1:
        warnings.append("Long transcript was summarized in consecutive parts; review continuity across parts.")
    return {"segments": segments, "summary": "\n\n".join(summaries), "actions": actions, "warnings": warnings}


def process_text(text: str, context: dict, on_stage) -> dict:
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("Transcript is empty.")
    if len(text) > MAX_TEXT_CHARS:
        raise RuntimeError(f"Transcript exceeds the {MAX_TEXT_CHARS:,} character local processing limit.")
    on_stage("extracting")
    segments = _text_segments(text, context)
    return _extract(segments, context, ["Text import has no audio timestamps; all segment times are zero."])


def _convert_audio(path: str, output: str) -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is required for local audio processing.")
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", path,
                        "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", str(MAX_AUDIO_SECONDS + 1), output],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600)
        with wave.open(output, "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
    except (subprocess.SubprocessError, wave.Error, OSError) as exc:
        raise RuntimeError(f"Could not decode audio locally with ffmpeg: {exc}") from exc
    if duration > MAX_AUDIO_SECONDS:
        raise RuntimeError(f"Audio exceeds the {MAX_AUDIO_SECONDS // 60} minute local processing limit.")
    if duration <= 0:
        raise RuntimeError("Decoded audio is empty.")


def _transcribe(wav_path: str) -> list[dict]:
    kind, detail = _asr_source()
    if kind is None:
        raise RuntimeError(detail)
    if kind == "whisper.cpp":
        with tempfile.TemporaryDirectory(prefix="meeting-asr-") as temp:
            stem = str(Path(temp) / "transcript")
            binary = shutil.which(os.environ["WHISPER_CPP_BIN"])
            try:
                subprocess.run([binary, "-m", os.environ["WHISPER_CPP_MODEL"], "-f", wav_path, "-oj", "-of", stem, "-np"],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=7200)
                data = json.loads(Path(stem + ".json").read_text(encoding="utf-8"))
                rows = data["transcription"]
                return [{"start": row["offsets"]["from"] / 1000, "end": row["offsets"]["to"] / 1000,
                         "text": row["text"].strip()} for row in rows if row.get("text", "").strip()]
            except (subprocess.SubprocessError, OSError, KeyError, ValueError, TypeError) as exc:
                raise RuntimeError(f"whisper.cpp failed to produce valid local JSON transcription: {exc}") from exc
    # faster-whisper's local_files_only prevents checkpoint downloads. Requiring
    # tokenizer.json above also avoids its fallback tokenizer fetch.
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from faster_whisper import WhisperModel
    try:
        model = WhisperModel(os.getenv("ASR_MODEL", "large-v3"), device=os.getenv("ASR_DEVICE", "cpu"),
                             compute_type=os.getenv("ASR_COMPUTE_TYPE", "int8"), cpu_threads=min(4, os.cpu_count() or 1),
                             num_workers=1, local_files_only=True)
        stream, _ = model.transcribe(wav_path, beam_size=3, vad_filter=True)
        return [{"start": part.start, "end": part.end, "text": part.text.strip()} for part in stream if part.text.strip()]
    except Exception as exc:
        raise RuntimeError(f"Local faster-whisper transcription failed ({exc}); check cached weights and ASR_DEVICE/ASR_COMPUTE_TYPE.") from exc


def _diarize(wav_path: str) -> list[tuple[float, float, str]]:
    location = os.getenv("DIARIZATION_MODEL_PATH", "")
    if not location or not (Path(location) / "config.yaml").is_file():
        raise RuntimeError("Audio requires real speaker diarization. Set DIARIZATION_MODEL_PATH to an offline pyannote Community-1 model directory containing config.yaml.")
    if importlib.util.find_spec("pyannote") is None:
        raise RuntimeError("Install pyannote.audio from backend/requirements-ml.txt for speaker diarization.")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    try:
        import torch
        from pyannote.audio import Pipeline
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        pipeline = Pipeline.from_pretrained(location)
        if pipeline is None:
            raise RuntimeError("pyannote could not load the local model")
        device = os.getenv("ASR_DEVICE", "cpu")
        pipeline.to(torch.device("cuda" if device == "cuda" else "cpu"))
        output = pipeline(wav_path)
        annotation = getattr(output, "exclusive_speaker_diarization", None) or getattr(output, "speaker_diarization", None)
        if annotation is None:
            raise RuntimeError("pyannote returned no speaker annotation")
        if hasattr(annotation, "itertracks"):
            turns = [(turn.start, turn.end, str(speaker)) for turn, _, speaker in annotation.itertracks(yield_label=True)]
        else:
            turns = [(turn.start, turn.end, str(speaker)) for turn, speaker in annotation]
        if not turns:
            raise RuntimeError("pyannote detected no speakers")
        return turns
    except Exception as exc:
        raise RuntimeError(f"Offline pyannote diarization failed ({exc}); verify the complete local Community-1 model and ffmpeg.") from exc


def _align(transcript: list[dict], turns: list[tuple[float, float, str]], context: dict) -> tuple[list[dict], list[str]]:
    segments = []
    warnings = []
    for part in transcript:
        start, end, text = part["start"], part["end"], part["text"].strip()
        if not text or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or start < 0 or end < start:
            continue
        by_speaker: dict[str, float] = {}
        for turn_start, turn_end, speaker in turns:
            overlap = max(0.0, min(end, turn_end) - max(start, turn_start))
            by_speaker[speaker] = by_speaker.get(speaker, 0.0) + overlap
        ranked = sorted(by_speaker.items(), key=lambda entry: entry[1], reverse=True)
        overlap = ranked[0][1] if ranked else 0
        speaker = ranked[0][0] if overlap else ""
        if not speaker:
            warnings.append(f"Speaker could not be aligned for transcript segment {len(segments) + 1}.")
        elif len(ranked) > 1 and ranked[1][1] >= overlap * 0.6:
            warnings.append(f"Speaker attribution is uncertain for transcript segment {len(segments) + 1}.")
        index = len(segments)
        segments.append({"id": str(uuid.uuid5(_UUID_NAMESPACE, f"{context.get('id', '')}:audio:{index}:{start}:{end}:{text}")),
                         "start_ms": round(start * 1000), "end_ms": round(end * 1000), "speaker_id": speaker, "text": text})
    return segments, warnings


def process_audio(path: str, context: dict, on_stage) -> dict:
    if not Path(path).is_file():
        raise RuntimeError("Audio file does not exist.")
    if not probe()["diarization"]:
        raise RuntimeError("Audio requires real diarization. Install pyannote.audio and set DIARIZATION_MODEL_PATH to a complete offline Community-1 directory.")
    with tempfile.TemporaryDirectory(prefix="meeting-audio-") as temp:
        wav_path = str(Path(temp) / "audio.wav")
        _convert_audio(path, wav_path)
        on_stage("transcribing")
        transcript = _transcribe(wav_path)
        if not transcript:
            raise RuntimeError("Speech recognition found no spoken content.")
        on_stage("diarizing")
        turns = _diarize(wav_path)
        segments, warnings = _align(transcript, turns, context)
    on_stage("extracting")
    return _extract(segments, context, warnings)
