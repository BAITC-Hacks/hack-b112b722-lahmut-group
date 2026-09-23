"""Run and record real local inference. No fixtures, mocks or hosted API fallback."""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import ml


def _versions() -> dict:
    versions = {"python": platform.python_version(), "platform": platform.platform()}
    for package in ("faster-whisper", "ctranslate2", "pyannote.audio", "torch", "torchaudio", "torchcodec", "huggingface_hub"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return versions


def _model_revisions() -> dict:
    revisions = {}
    for key, env_name in (("asr", "ASR_MODEL"), ("diarization", "DIARIZATION_MODEL_PATH")):
        model_path = Path(os.getenv(env_name, ""))
        manifest_path = model_path.parent / "manifest.json"
        try:
            item = json.loads(manifest_path.read_text()).get("models", {}).get(key, {})
            if Path(item.get("path", "")).resolve() == model_path.resolve():
                revisions[key] = {"repo": item.get("repo"), "revision": item.get("revision")}
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            continue
    return revisions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="new JSON result path; existing results are never overwritten")
    parser.add_argument("--seconds", type=int, default=60, help="first 1–3600 seconds, default 60")
    parser.add_argument("--offset", type=float, default=0, help="start position in original audio, seconds")
    parser.add_argument("--min-speakers", type=int, default=2, help="checkpoint expectation, not a model hint")
    parser.add_argument("--full", action="store_true", help="also run real local Ollama extraction")
    parser.add_argument("--occurred-at", type=date.fromisoformat, required=True)
    parser.add_argument("--participants", type=Path, help="optional JSON Participant[] from the contract")
    args = parser.parse_args()
    if not args.audio.is_file():
        parser.error("audio file does not exist")
    if not 1 <= args.seconds <= 3600 or not 0 <= args.offset < 86400 or not 1 <= args.min_speakers <= 20:
        parser.error("invalid duration, offset or expected speaker count")
    if args.output.exists():
        parser.error("output already exists; choose a new result name")
    participants = json.loads(args.participants.read_text()) if args.participants else []
    if not isinstance(participants, list) or any(not isinstance(p, dict) for p in participants):
        parser.error("participants must be a JSON array of objects")
    context = {"id": "checkpoint", "title": "Проверка реальной записи", "occurred_at": args.occurred_at.isoformat(),
               "timezone": "Asia/Almaty", "participants": participants}
    digest = hashlib.sha256()
    with args.audio.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    report = {"status": "failed", "real_inference": True, "quality_review": "not_performed",
        "started_at": datetime.now(timezone.utc).isoformat(), "source_sha256": digest.hexdigest(),
        "requested_excerpt": {"offset_seconds": args.offset, "seconds": args.seconds},
        "timestamp_origin": "original_audio", "versions": _versions(),
        "model_revisions": _model_revisions(),
        "configuration": {k: os.getenv(k, default) for k, default in (
            ("ASR_MODEL", "large-v3"), ("ASR_DEVICE", "cpu"), ("ASR_COMPUTE_TYPE", "int8"),
            ("DIARIZATION_MODEL_PATH", ""), ("OLLAMA_MODEL", "qwen3:8b"),
            ("WHISPER_CPP_BIN", ""), ("WHISPER_CPP_MODEL", ""))}}
    started = time.monotonic()
    def stage(name: str) -> None:
        report["last_stage"] = name
        print(name, flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix="hatama-checkpoint-") as temp:
            excerpt = str(Path(temp) / "excerpt.wav")
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", str(args.offset),
                "-i", str(args.audio.resolve()), "-map", "0:a:0", "-t", str(args.seconds),
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", excerpt],
                check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            speech = ml._speech_checkpoint(excerpt, context, stage)
        shift = round(args.offset * 1000)
        for segment in speech["segments"]:
            segment["start_ms"] += shift
            segment["end_ms"] += shift
        report.update(speech)
        report["turns"] = [{"start_ms": round(t[0] * 1000) + shift,
                            "end_ms": round(t[1] * 1000) + shift, "speaker_id": t[2]} for t in speech["turns"]]
        observed = sorted({s["speaker_id"] for s in speech["segments"] if s["speaker_id"]})
        report["speakers"] = observed
        report["speaker_expectation_met"] = len(observed) >= args.min_speakers
        if args.full:
            stage("extracting")
            report["minutes"] = ml._extract(speech["segments"], context, list(speech["warnings"]))
        report["status"] = "completed" if report["speaker_expectation_met"] else "needs_review"
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
        print(report["error"], file=sys.stderr)
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as target:
            json.dump(report, target, ensure_ascii=False, indent=2)
            target.write("\n")
        print(f"Result: {args.output}; status={report['status']}; manual quality review still required")
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
