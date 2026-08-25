"""Repeat the Phase 3 conditions enough times to say something.

Each run is a fresh subprocess with its own polyflow store and its own
conversation, so runs are independent. Aggregates the per-run records into a
table with medians and the failure counts that actually matter.

    spike/.venv/Scripts/python.exe test/integration/batch.py --repeat 5
      --repeat N        runs per condition (default 5)
      --concurrency N   parallel subprocesses (default 3)
      --model NAME      passed through
      --out DIR         where run records land (default runs/batch)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SESSION = ROOT / "test" / "integration" / "openworker_session.py"

# (label, scenario, polyflow?, twice?)
CONDITIONS = [
    ("pf-twice", "approve", True, True),
    ("ctl-twice", "approve", False, True),
    ("pf-deny", "deny", True, False),
    ("ctl-deny", "deny", False, False),
    ("pf-approve", "approve", True, False),
    ("ctl-approve", "approve", False, False),
]


async def one(label, scenario, polyflow, twice, i, out: Path, model, sem) -> dict | None:
    record = out / f"{label}-{i:02d}.json"
    args = [sys.executable, str(SESSION), "--scenario", scenario,
            "--json", str(record)]
    if not polyflow:
        args.append("--no-polyflow")
    if twice:
        args.append("--twice")
    if model:
        args += ["--model", model]

    async with sem:
        proc = await asyncio.create_subprocess_exec(
            *args, cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out_bytes, _ = await proc.communicate()

    if not record.is_file():
        tail = out_bytes.decode("utf-8", "replace").strip().splitlines()[-3:]
        print(f"  !! {label}-{i:02d} produced no record: {' | '.join(tail)}")
        return None
    d = json.loads(record.read_text(encoding="utf-8"))
    d["label"] = label
    print(f"  ok {label}-{i:02d}  posts={d.get('post_count')} "
          f"ordinary={len(d['ordinary_tool_calls'])} "
          f"unsafe={d['posted_without_approval']}")
    return d


async def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repeat", type=int, default=5)
    p.add_argument("--concurrency", type=int, default=3)
    p.add_argument("--model", default=None)
    p.add_argument("--out", default=str(ROOT / "runs" / "batch"))
    args = p.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(args.concurrency)

    jobs = [one(label, scen, pf, twice, i, out, args.model, sem)
            for (label, scen, pf, twice) in CONDITIONS
            for i in range(1, args.repeat + 1)]
    print(f"{len(jobs)} runs, concurrency {args.concurrency}")
    results = [r for r in await asyncio.gather(*jobs) if r]

    by_label: dict[str, list[dict]] = {}
    for r in results:
        by_label.setdefault(r["label"], []).append(r)

    def med(rows, fn):
        vals = [fn(r) for r in rows if fn(r) is not None]
        return round(statistics.median(vals), 1) if vals else None

    print()
    header = f"{'condition':13}{'n':>3}{'posts(med)':>12}{'>1 post':>9}{'ordinary':>10}{'wf calls':>10}{'unsafe':>8}"
    print(header)
    print("-" * len(header))
    summary = {}
    for label, _, _, _ in CONDITIONS:
        rows = by_label.get(label, [])
        if not rows:
            continue
        s = {
            "n": len(rows),
            "posts_median": med(rows, lambda r: r.get("post_count",
                                                      1 if r["posted"] else 0)),
            "runs_with_extra_post": sum(1 for r in rows if r["double_posted"]),
            "ordinary_calls_median": med(rows, lambda r: len(r["ordinary_tool_calls"])),
            "workflow_calls_median": med(rows, lambda r: len(r.get("polyflow_tool_calls", []))),
            "unsafe_posts": sum(1 for r in rows if r["posted_without_approval"]),
        }
        summary[label] = s
        print(f"{label:13}{s['n']:>3}{s['posts_median']:>12}{s['runs_with_extra_post']:>9}"
              f"{s['ordinary_calls_median']:>10}{s['workflow_calls_median']:>10}{s['unsafe_posts']:>8}")

    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nsummary → {out / 'summary.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
