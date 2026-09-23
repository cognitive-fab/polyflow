"""P9 security review: failing tests for the Python plugin's ledger sink.

Pure: no Temporal server. Each test asserts what the TypeScript sink does (or
must do) and fails today for the reason in its message. See
docs/platform/reviews/P9-security-review.md (ids in the test names).
"""

import shutil
import tempfile
from pathlib import Path

from polyflow_temporal.ledger import Ledger
from polyflow_temporal.plugin import FileSink


def _chain(run: dict, bodies: list) -> list:
    led = Ledger(run)
    for i, body in enumerate(bodies):
        led.append("proposal" if i else "admission", body, 1000 + i)
    return led.drain()


def test_sec_py1_a_delta_that_conflicts_is_refused_whole():
    """P6-P8 SV6 was fixed in the TS sinks (partitionDelta); the Python FileSink still stores
    the fresh tail of a delta whose head conflicts, on top of the real chain."""
    root = Path(tempfile.mkdtemp(prefix="p9-pysink-"))
    try:
        run = {"ns": "default", "wf": "wf-1", "run": "r1"}
        sink = FileSink(root)
        real = _chain(run, [{"level": "guard"}, {"action": "real"}])
        sink.write(real[:2], None)
        forged = _chain(run, [{"level": "guard"}, {"action": "FORGED"}, {"action": "after the fork"}])
        r = sink.write(forged, None)
        assert r["conflicts"] == [1], "setup: seq 1 conflicts"
        assert r["written"] == 0, (
            f"SEC-PY1: the Python FileSink wrote {r['written']} event(s) of a delta it reported as a conflict: "
            "seq 2 now chains from the FORGED seq 1, so the held run can never verify again (review SV6, re-opened in Python)"
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_sec_py2_the_file_sink_stays_inside_its_root():
    root = Path(tempfile.mkdtemp(prefix="p9-pysink-")).resolve()
    try:
        _, events, _ = FileSink(root).paths({"ns": "..", "wf": "..", "run": "r"})
        escaped = events.resolve()
        assert root in escaped.parents, (
            f"SEC-PY2: namespace '..' and workflow id '..' write {escaped}, outside the sink root {root}"
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)
