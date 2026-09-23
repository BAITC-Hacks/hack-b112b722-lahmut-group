"""Compare VAD on/off on the rented Linux CUDA server; never run on a Mac.

Both passes use the same full decoded recording and one loaded ASR model. Only
vad_filter changes. No reference transcript, prompt, or hotwords are supplied.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import platform
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import ml


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--log-file", type=Path, help="defaults to output path with .log suffix")
    args = parser.parse_args()
    if platform.system() != "Linux" or os.getenv("ASR_DEVICE") != "cuda":
        parser.error("Run this benchmark only on the rented Linux server with ASR_DEVICE=cuda.")
    if not args.audio.is_file():
        parser.error("audio file does not exist")
    log_path = args.log_file or args.output.with_suffix(".log")
    if args.output.resolve() == log_path.resolve():
        parser.error("JSON output and log file must have different paths")
    if args.output.exists() or log_path.exists():
        parser.error("output or log already exists; choose new paths")
    kind, detail = ml._asr_source()
    if kind != "faster-whisper":
        parser.error("This comparison requires a cached faster-whisper model: " + detail)

    options = {"beam_size": 3, "condition_on_previous_text": True, "language": None,
               "word_timestamps": True, "task": "transcribe", "multilingual": True,
               "initial_prompt": None, "hotwords": None}
    versions = {"python": platform.python_version(), "platform": platform.platform()}
    for package in ("faster-whisper", "ctranslate2", "numpy"):
        versions[package] = importlib.metadata.version(package)
    report = {"status": "failed", "real_inference": True, "quality_review": "not_performed",
              "started_at": datetime.now(timezone.utc).isoformat(),
              "source_sha256": _sha256(args.audio), "source_path": str(args.audio.resolve()),
              "timestamp_origin": "original_audio", "timestamp_unit": "seconds",
              "versions": versions, "common_options": options,
              "model": os.getenv("ASR_MODEL", "large-v3"), "device": "cuda",
              "compute_type": os.getenv("ASR_COMPUTE_TYPE", "int8"),
              "log_path": str(log_path.resolve()), "runs": [],
              "timing_note": "One shared model, VAD-on pass first; timings are not a controlled latency benchmark."}
    model_path = Path(report["model"])
    manifest_path = model_path.parent / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        model_record = manifest.get("models", {}).get("asr", {})
        if Path(model_record.get("path", "")).resolve() == model_path.resolve():
            report["model_revision"] = {k: model_record.get(k) for k in ("repo", "revision")}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    # Exclusive creation also prevents overwriting if another run races us.
    with args.output.open("x", encoding="utf-8") as target, log_path.open("x", encoding="utf-8") as log:
        handler = logging.StreamHandler(log)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        logger = logging.getLogger("faster_whisper")
        logger.setLevel(logging.DEBUG)
        logger.addHandler(handler)
        try:
            ml._offline_mode()
            from faster_whisper import WhisperModel

            with tempfile.TemporaryDirectory(prefix="hatama-vad-ab-") as temp:
                wav_path = Path(temp) / "full-audio.wav"
                ml._convert_audio(str(args.audio.resolve()), str(wav_path))
                report["decoded_sha256"] = _sha256(wav_path)
                load_started = time.monotonic()
                model = WhisperModel(report["model"], device="cuda", compute_type=report["compute_type"],
                                     cpu_threads=min(4, os.cpu_count() or 1), num_workers=1, local_files_only=True)
                report["model_load_seconds"] = round(time.monotonic() - load_started, 3)
                for vad_filter in (True, False):
                    name = "vad_on" if vad_filter else "vad_off"
                    logger.info("BEGIN variant=%s source_sha256=%s", name, report["source_sha256"])
                    print(name, flush=True)
                    run_started = time.monotonic()
                    stream, info = model.transcribe(str(wav_path), vad_filter=vad_filter, **options)
                    segments = [asdict(segment) for segment in stream]
                    report["runs"].append({"variant": name, "vad_filter": vad_filter,
                                           "elapsed_seconds": round(time.monotonic() - run_started, 3),
                                           "info": asdict(info), "segments": segments})
                    logger.info("END variant=%s segments=%s duration_after_vad=%s", name, len(segments), info.duration_after_vad)
                del model
            report["status"] = "completed"
        except Exception as exc:
            report["error"] = f"{type(exc).__name__}: {exc}"
            logger.exception("ASR VAD comparison failed")
            print(report["error"], file=sys.stderr)
        finally:
            report["elapsed_seconds"] = round(time.monotonic() - started, 3)
            json.dump(report, target, ensure_ascii=False, indent=2)
            target.write("\n")
            handler.flush()
            logger.removeHandler(handler)
    print(f"Result: {args.output}; status={report['status']}", flush=True)
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
