"""Evaluate three real FLEURS Kazakh clips on the rented Linux CUDA server."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
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
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import ml


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _words(text: str) -> list[str]:
    text = unicodedata.normalize("NFC", text).lower()
    return "".join(char for char in text if not unicodedata.category(char).startswith("P")).split()


def _distance(reference: list[str], hypothesis: list[str]) -> int:
    previous = list(range(len(hypothesis) + 1))
    for i, expected in enumerate(reference, 1):
        current = [i]
        for j, observed in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (expected != observed)))
        previous = current
    return previous[-1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or os.getenv("ASR_DEVICE") != "cuda":
        parser.error("Run only on the rented Linux server with ASR_DEVICE=cuda.")
    if not args.manifest.is_file() or args.output.exists():
        parser.error("manifest must exist and output must be a new file")
    manifest = json.loads(args.manifest.read_text())
    samples = manifest["samples"]
    if len(samples) != 3:
        parser.error("This bounded check requires exactly three clips.")
    root = Path(__file__).resolve().parents[1]
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    except subprocess.CalledProcessError:
        commit = None
    versions = {"python": platform.python_version(), "platform": platform.platform()}
    for package in ("faster-whisper", "ctranslate2", "numpy"):
        versions[package] = importlib.metadata.version(package)
    report = {"status": "failed", "real_inference": True,
        "started_at": datetime.now(timezone.utc).isoformat(), "versions": versions,
        "code": {"git_commit": commit, "adapter_sha256": _sha256(Path(ml.__file__)),
                 "runner_sha256": _sha256(Path(__file__))},
        "model": os.getenv("ASR_MODEL", "large-v3"), "device": os.getenv("ASR_DEVICE"),
        "compute_type": os.getenv("ASR_COMPUTE_TYPE", "int8"),
        "asr_options": {"beam_size": 3, "vad_filter": True, "word_timestamps": True,
                        "task": "transcribe", "multilingual": True, "language": None,
                        "condition_on_previous_text": True, "initial_prompt": None, "hotwords": None},
        "dataset": {k: manifest.get(k) for k in ("dataset", "configuration", "split", "revision",
                    "source_card", "metadata_source", "archive_source", "license", "license_url", "citation", "selection")},
        "manifest_sha256": _sha256(args.manifest),
        "normalization": "Unicode NFC, lowercase, delete Unicode punctuation (category P*), split on whitespace. Numerals are not expanded.",
        "metric": "Word-level Levenshtein edit distance divided by reference word count; micro WER sums distances and reference words.",
        "limitations": "Three isolated read-speech clips only; not a Kazakh meeting benchmark, diarization test, or RU/KZ code-switching evaluation.",
        "references_used_as_prompt": False, "clips": []}
    model_path = Path(report["model"])
    revision_path = model_path.parent / "manifest.json"
    if revision_path.is_file():
        model = json.loads(revision_path.read_text()).get("models", {}).get("asr", {})
        if Path(model.get("path", "")).resolve() == model_path.resolve():
            report["model_revision"] = {key: model.get(key) for key in ("repo", "revision")}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with args.output.open("x", encoding="utf-8") as target:
        try:
            hypotheses = []
            # All inference finishes before references are normalized or scored.
            with tempfile.TemporaryDirectory(prefix="hatama-kz-asr-") as temp:
                for index, sample in enumerate(samples):
                    path = Path(sample["path"])
                    digest = _sha256(path)
                    if digest != sample["sha256"]:
                        raise RuntimeError(f"Input checksum mismatch: {path.name}")
                    wav = str(Path(temp) / f"clip-{index}.wav")
                    clip_started = time.monotonic()
                    ml._convert_audio(str(path), wav)
                    segments = ml._transcribe(wav)
                    hypotheses.append({"filename": path.name, "id": sample["id"],
                        "sha256": digest, "duration_seconds": sample["duration_seconds"],
                        "elapsed_seconds": round(time.monotonic() - clip_started, 3),
                        "hypothesis": " ".join(part["text"] for part in segments), "segments": segments})
                    print(f"Transcribed {index + 1}/3: {path.name}", flush=True)
            for sample, hypothesis in zip(samples, hypotheses):
                reference = sample["transcription"]
                expected, observed = _words(reference), _words(hypothesis["hypothesis"])
                if not expected:
                    raise RuntimeError("Empty normalized reference.")
                distance = _distance(expected, observed)
                report["clips"].append(dict(hypothesis, reference=reference,
                    raw_reference=sample.get("raw_transcription"), reference_words=len(expected),
                    hypothesis_words=len(observed), edit_distance=distance, wer=distance / len(expected)))
            count = sum(clip["reference_words"] for clip in report["clips"])
            edits = sum(clip["edit_distance"] for clip in report["clips"])
            report["overall"] = {"clips": len(samples), "reference_words": count,
                                 "edit_distance": edits, "micro_wer": edits / count,
                                 "audio_seconds": sum(clip["duration_seconds"] for clip in report["clips"])}
            report["status"] = "completed"
        except Exception as exc:
            report["error"] = f"{type(exc).__name__}: {exc}"
            print(report["error"], file=sys.stderr)
        finally:
            report["elapsed_seconds"] = round(time.monotonic() - started, 3)
            json.dump(report, target, ensure_ascii=False, indent=2)
            target.write("\n")
    print(json.dumps({"status": report["status"], "overall": report.get("overall")}, ensure_ascii=False), flush=True)
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
