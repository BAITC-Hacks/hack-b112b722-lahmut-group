"""Record real local LLM extraction for a fixed transcript or synthetic quality suite.

Expected answers are used only after inference and are never sent to the model.
This evaluates extraction, not acoustic recognition or diarization quality.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import ml


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--checkpoint', type=Path)
    source.add_argument('--cases', type=Path)
    source.add_argument('--text', type=Path)
    parser.add_argument('--model', required=True)
    parser.add_argument('--thinking', action='store_true', help='enable Qwen3 thinking for a controlled comparison')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; retain old results and choose a new path')
    os.environ['OLLAMA_MODEL'] = args.model
    os.environ['OLLAMA_THINKING'] = 'true' if args.thinking else 'false'
    context = {'id': 'quality-eval', 'title': 'Проверка извлечения', 'occurred_at': '2026-09-23',
               'timezone': 'Asia/Almaty', 'participants': []}
    if args.checkpoint:
        checkpoint = json.loads(args.checkpoint.read_text())
        cases = [{'id': args.checkpoint.stem, 'segments': checkpoint['segments']}]
    elif args.text:
        cases = [{'id': args.text.stem, 'text': args.text.read_text()}]
    else:
        value = json.loads(args.cases.read_text())
        cases = value['cases'] if isinstance(value, dict) else value
    adapter = Path(ml.__file__)
    model_info = next((m for m in ml._ollama_request('/api/tags').get('models', [])
                       if m.get('name') == args.model), {})
    source_path = args.checkpoint or args.cases or args.text
    report = {'model': args.model, 'thinking': args.thinking, 'model_digest': model_info.get('digest'),
              'adapter_sha256': hashlib.sha256(adapter.read_bytes()).hexdigest(),
              'input_sha256': hashlib.sha256(source_path.read_bytes()).hexdigest(),
              'git_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=adapter.parents[2], text=True).strip(),
              'started_at': datetime.now(timezone.utc).isoformat(),
              'real_inference': True, 'scope': 'extraction_only', 'cases': []}
    for case in cases:
        ctx = dict(context, id=case['id'])
        segments = case.get('segments') or ml._text_segments(case['text'], ctx)
        # Keep one chunk, matching the current two meeting transcripts.
        if sum(len(s['text']) for s in segments) > 6000:
            parser.error('Evaluation case exceeds one extraction chunk')
        started = time.monotonic()
        entry = {'id': case['id'], 'segments': segments}
        try:
            raw = ml._ollama_extract(segments, ctx)
            summary, actions, warnings = ml._validated_extraction(raw, segments, ctx)
            entry.update(status='completed', raw=raw, result={'summary': summary, 'actions': actions, 'warnings': warnings})
        except Exception as exc:
            entry.update(status='failed', error=f'{type(exc).__name__}: {exc}')
        entry['elapsed_seconds'] = round(time.monotonic() - started, 3)
        if 'expected' in case:
            entry['expected'] = case['expected']
        report['cases'].append(entry)
        print(case['id'], entry['status'], entry['elapsed_seconds'], flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return int(any(c['status'] != 'completed' for c in report['cases']))


if __name__ == '__main__':
    raise SystemExit(main())
