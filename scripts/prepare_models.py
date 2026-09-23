"""Explicit one-time model download on the inference host; never processes audio."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("models"))
    parser.add_argument("--only", choices=("asr", "diarization", "all"), default="all")
    parser.add_argument("--asr-model", choices=("small", "large-v3"), default="large-v3",
                        help="small is only a lower-memory CPU smoke-test baseline")
    parser.add_argument("--asr-revision", default="main", help="use the recorded commit SHA for repeat deployments")
    parser.add_argument("--diarization-revision", default="main")
    args = parser.parse_args()
    if os.getenv("HF_HUB_OFFLINE", "").upper() in {"1", "TRUE", "YES", "ON"}:
        parser.error("Provisioning requires network access: unset HF_HUB_OFFLINE for this command only.")
    try:
        from huggingface_hub import HfApi, get_token, snapshot_download
        from huggingface_hub.errors import GatedRepoError
    except ImportError:
        print("Install backend/requirements-ml.txt first (huggingface_hub is required).", file=sys.stderr)
        return 1
    specs = []
    if args.only in ("asr", "all"):
        specs.append(("asr", f"Systran/faster-whisper-{args.asr_model}", args.asr_revision,
                      ["config.json", "model.bin", "tokenizer.json", "preprocessor_config.json", "vocabulary.*"]))
    if args.only in ("diarization", "all"):
        if not get_token():
            print("Accept Community-1 access conditions in your Hugging Face account, then run `hf auth login` on this host. No token was found.", file=sys.stderr)
            return 1
        specs.append(("diarization", "pyannote/speaker-diarization-community-1", args.diarization_revision, None))
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"models": {}}
    for name, repo, revision, patterns in specs:
        try:
            # Resolve first, then download an immutable revision rather than a moving branch.
            sha = HfApi().model_info(repo, revision=revision).sha
            target = args.output / name
            print(f"Downloading {repo}@{sha} into {target}", flush=True)
            snapshot_download(repo_id=repo, revision=sha, local_dir=target, allow_patterns=patterns)
            required = ["model.bin", "tokenizer.json", "config.json"] if name == "asr" else ["config.yaml"]
            if any(not (target / item).is_file() for item in required):
                raise RuntimeError("Downloaded model is incomplete")
            manifest["models"][name] = {"repo": repo, "revision": sha,
                "path": str(target.resolve()), "prepared_at": datetime.now(timezone.utc).isoformat()}
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        except GatedRepoError:
            print(f"Access denied to {repo}. Accept that model's access conditions with the same account used by `hf auth login`. For a fine-grained token, enable reading accessible public gated repositories. Never paste tokens into logs or chat.", file=sys.stderr)
            return 1
        except Exception as exc:
            # Avoid dumping request details that might contain credentials.
            print(f"Model preparation failed for {repo}: {type(exc).__name__}. Check account access, disk space and network; partial downloads can be resumed.", file=sys.stderr)
            return 1
    if "asr" in manifest["models"]:
        print("Prepared. Set ASR_MODEL=" + manifest["models"]["asr"]["path"])
    if "diarization" in manifest["models"]:
        print("Set DIARIZATION_MODEL_PATH=" + manifest["models"]["diarization"]["path"])
    print("LLM is separate: ollama pull qwen3:8b. Run the speech checkpoint before claiming offline readiness.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
