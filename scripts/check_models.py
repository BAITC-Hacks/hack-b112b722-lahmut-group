"""Fast local inference readiness report; never fetches model weights."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.ml import probe  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exit 1 if any provider is unavailable")
    arguments = parser.parse_args()
    result = probe()
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return int(arguments.strict and not all(result[key] for key in ("speech", "llm", "diarization")))


if __name__ == "__main__":
    raise SystemExit(main())
