"""The Python plugin mirrors the TypeScript plugin where the P6-P8 review found
it did not: Continue-as-New carries the chain AND the guard (PY5/GC), a
cancellation closes the record and records the in-flight effect (PY5), a
declared failure type closes it (D1), a signal to another workflow is governed
(PY1), the exporter checks continuity and the sinks report conflicts (PY4),
and a signing key that cannot sign fails loudly."""

import asyncio
import json
import subprocess
import uuid
from pathlib import Path

import pytest
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import polyflow_temporal.plugin as plugin_mod
from polyflow_temporal.ledger import Ledger, verify_chain
from polyflow_temporal.plugin import LEDGER_HEADER, FileSink, MemorySink, PolyflowPlugin

from parity_workflows import (
    CancelledMidActivity, ChainAgent, DeclaredFailure, Refusal, Signaller, Sleeper, lookup, slow,
)

PLATFORM = Path(__file__).resolve().parents[2]
CLI = PLATFORM / "packages" / "cli" / "bin" / "polyflow.mjs"


def admit(raw: dict) -> dict:
    src = PLATFORM / "python" / f".tmp-parity-policy-{uuid.uuid4().hex[:8]}.json"
    src.write_text(json.dumps(raw))
    try:
        out = subprocess.run(["node", str(CLI), "policy", str(src)], capture_output=True, text=True, check=True)
    finally:
        src.unlink()
    return json.loads(out.stdout)


# ---- pure: sinks, exporter, signing ------------------------------------------------

def _events(n, run=None):
    ledger = Ledger(run or {"ns": "default", "wf": "w", "run": "r"})
    for i in range(n):
        ledger.append("proposal", {"i": i}, i)
    return ledger.events()


@pytest.mark.parametrize("make", [lambda tmp: FileSink(tmp), lambda tmp: MemorySink()], ids=["file", "memory"])
def test_sinks_skip_identical_report_conflicts_and_know_their_head(tmp_path, make):
    sink = make(tmp_path)
    ev = _events(3)
    run = ev[0]["run"]
    assert sink.head(run) is None
    assert sink.write(ev[:2], None) == {"written": 2, "skipped": 0, "conflicts": []}
    assert sink.head(run) == {"seq": 1, "hash": ev[1]["hash"]}
    assert sink.write(ev, None) == {"written": 1, "skipped": 2, "conflicts": []}
    forged = {**ev[1], "hash": "sha256:forged"}
    assert sink.write([forged], None)["conflicts"] == [1]
    assert sink.head(run) == {"seq": 2, "hash": ev[2]["hash"]}


def test_a_file_sink_survives_a_lone_surrogate_from_truncation(tmp_path):
    # redact() truncates in UTF-16 units, as TS does, so it can split a pair.
    ledger = Ledger({"ns": "default", "wf": "w", "run": "r"})
    ledger.append("observation", {"effect": "e1", "ok": False, "error": "a\ud83d…"}, 1)
    sink = FileSink(tmp_path)
    sink.write(ledger.events(), None)
    events, _ = sink.read(ledger.run)
    assert verify_chain(events)["ok"]


class _Info:
    workflow_id = "w"
    workflow_namespace = "default"
    workflow_run_id = "r"


async def _export(monkeypatch, sink, events, key=None):
    errors, conflicts = [], []
    monkeypatch.setattr(plugin_mod.temporalio.activity, "info", lambda: _Info())
    monkeypatch.setattr(plugin_mod.temporalio.activity, "payload_converter", lambda: plugin_mod._converter())

    class _Next:
        async def execute_activity(self, _input):
            return "ran"

    ex = plugin_mod._Exporter(_Next(), sink, key, on_conflict=lambda run, seqs: conflicts.append(seqs), on_error=errors.append)

    class _Input:
        headers = {LEDGER_HEADER: plugin_mod._converter().to_payload({"events": events, "head": None})}

    assert await ex.execute_activity(_Input()) == "ran"
    return errors, conflicts


@pytest.fixture
def key(tmp_path):
    subprocess.run(["node", str(CLI), "keygen", "--id", "k", "--out", str(tmp_path / "keys")], check=True, capture_output=True)
    return json.loads((tmp_path / "keys" / "k.key.json").read_text())


async def test_the_exporter_writes_a_gap_unsigned_and_reports_it(monkeypatch, key):
    sink = MemorySink()
    ev = _events(5)
    errors, _ = await _export(monkeypatch, sink, ev[:2], key)
    assert errors == [] and len(sink.read("w")[1]) == 1
    errors, _ = await _export(monkeypatch, sink, ev[3:], key)  # skips seq 2
    assert len(errors) == 1 and "gap" in str(errors[0])
    assert len(sink.read("w")[1]) == 1, "a delta that skips ahead is not signed"


async def test_the_exporter_refuses_to_sign_a_fork_and_raises_the_tamper_signal(monkeypatch, key):
    sink = MemorySink()
    ev = _events(3)
    await _export(monkeypatch, sink, ev[:2], key)
    # Another chain for the same run: internally consistent, but not the one the sink holds.
    other = Ledger(ev[0]["run"])
    for i in range(3):
        other.append("proposal", {"i": i + 100}, i)
    errors, conflicts = await _export(monkeypatch, sink, other.events()[1:], key)
    assert conflicts == [[1]], "a different event at a held seq is the tamper signal"
    assert any("fork" in str(e) for e in errors)
    assert len(sink.read("w")[1]) == 1, "a fork is never signed"


def test_a_signing_key_that_cannot_sign_fails_at_construction(monkeypatch):
    with pytest.raises(ValueError):
        PolyflowPlugin(signing_key={"keyId": "k"})
    import builtins
    real_import = builtins.__import__

    def no_crypto(name, *a, **kw):
        if name.startswith("cryptography"):
            raise ImportError("no cryptography")
        return real_import(name, *a, **kw)

    monkeypatch.setattr(builtins, "__import__", no_crypto)
    with pytest.raises(ImportError, match="cryptography"):
        PolyflowPlugin(signing_key={"keyId": "k", "privateKeyPem": "x"})


# ---- on a dev server ------------------------------------------------------------

@pytest.fixture(scope="module")
async def env():
    e = await WorkflowEnvironment.start_local()
    yield e
    await e.shutdown()


async def test_continue_as_new_hands_over_the_chain_and_the_guard(env, tmp_path, key):
    policy = admit({
        "policy": "twice", "version": 1, "unlabelled": "deny",
        "effects": {"lookup": {"kind": "search", "class": "none"}},
        "rules": [{"id": "twice", "type": "at-most", "guards": "search", "n": 2}],
    })
    sink = FileSink(tmp_path / "ledger")
    tq = f"par-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=[ChainAgent], activities=[lookup],
                      plugins=[PolyflowPlugin(level="guard", policy=policy, sink=sink, signing_key=key)], max_cached_workflows=0):
        out = await env.client.execute_workflow(ChainAgent.run, 3, id="par-chain", task_queue=tq)
    assert out == "denied:PolyflowDenied", f"the third execution's lookup is the chain's third: {out}"
    files = [p for p in (tmp_path / "ledger").rglob("*.jsonl") if not p.name.endswith(".heads.jsonl")]
    assert len(files) == 1, "one chain, keyed by the run that started it"
    events = [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]
    assert verify_chain(events)["ok"]
    assert [e["kind"] for e in events].count("admission") == 1
    assert [e["body"]["outcome"] for e in events if e["kind"] == "closure"] == ["continued-as-new", "continued-as-new", "completed"]
    out = subprocess.run(["node", str(CLI), "verify", str(files[0]), "--trust", str(tmp_path / "keys" / "trust.json")], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr


async def test_a_cancelled_activity_is_observed_and_the_run_closes_cancelled(env):
    sink = MemorySink()
    tq = f"par-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=[CancelledMidActivity], activities=[slow],
                      plugins=[PolyflowPlugin(sink=sink)], max_cached_workflows=0):
        h = await env.client.start_workflow(CancelledMidActivity.run, id=f"par-cancel-{uuid.uuid4()}", task_queue=tq)
        for _ in range(100):
            if sink.read(h.id)[0]:
                break
            await asyncio.sleep(0.1)
        await h.cancel()
        with pytest.raises(WorkflowFailureError):
            await h.result()
    events, _ = sink.read(h.id)
    kinds = [e["kind"] for e in events]
    assert kinds[-1] == "closure" and events[-1]["body"]["outcome"] == "cancelled", kinds
    obs = [e["body"] for e in events if e["kind"] == "observation"]
    assert obs and obs[0]["ok"] is False, f"the in-flight activity's cancellation is recorded: {obs}"
    assert verify_chain(events)["ok"]


async def test_a_declared_failure_type_closes_the_record(env):
    sink = MemorySink()
    tq = f"par-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=[DeclaredFailure], activities=[lookup],
                      plugins=[PolyflowPlugin(sink=sink)], max_cached_workflows=0, workflow_failure_exception_types=[Refusal]):
        with pytest.raises(WorkflowFailureError):
            await env.client.execute_workflow(DeclaredFailure.run, id="par-d1", task_queue=tq)
    events, _ = sink.read("par-d1")
    assert events[-1]["kind"] == "closure" and events[-1]["body"]["outcome"] == "failed", [e["kind"] for e in events]


async def test_a_signal_to_another_workflow_is_governed(env):
    policy = admit({
        "policy": "quiet", "version": 1, "unlabelled": "deny",
        "effects": {"lookup": {"kind": "search", "class": "none"}},
        "rules": [],
    })
    tq = f"par-{uuid.uuid4()}"
    denied, observed = MemorySink(), MemorySink()
    async with Worker(env.client, task_queue=tq, workflows=[Signaller, Sleeper], activities=[lookup],
                      plugins=[PolyflowPlugin(level="guard", policy=policy, sink=denied)], max_cached_workflows=0):
        target = await env.client.start_workflow(Sleeper.run, id=f"par-sleeper-{uuid.uuid4()}", task_queue=tq)
        out = await env.client.execute_workflow(Signaller.run, target.id, id="par-signal-deny", task_queue=tq)
        await target.terminate()
    assert out == "denied:PolyflowDenied", out
    events, _ = denied.read("par-signal-deny")
    assert "signal:poke" in [e["body"].get("action") for e in events if e["kind"] == "proposal"]
    # Under observe, the same signal is delivered, and recorded as an effect with its outcome.
    tq = f"par-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=[Signaller, Sleeper], activities=[lookup],
                      plugins=[PolyflowPlugin(sink=observed)], max_cached_workflows=0):
        target = await env.client.start_workflow(Sleeper.run, id=f"par-sleeper-{uuid.uuid4()}", task_queue=tq)
        out = await env.client.execute_workflow(Signaller.run, target.id, id="par-signal-ok", task_queue=tq)
        assert await target.result() == "poked"
    assert out == "signalled"
    events, _ = observed.read("par-signal-ok")
    effect = next(e for e in events if e["kind"] == "effect" and e["body"]["activityType"] == "signal:poke")
    assert effect["body"]["via"] == "signal"
    assert any(e["kind"] == "observation" and e["body"]["effect"] == effect["body"]["id"] and e["body"]["ok"] for e in events)


# ---- P9 security review, Python side --------------------------------------------------

import base64  # noqa: E402

from polyflow_temporal.plugin import partition_delta, safe_component  # noqa: E402
from polyflow_temporal.sealed import seal_header  # noqa: E402

HEADER_KEY = {"keyId": "hk-1", "key": base64.b64encode(bytes(range(32))).decode()}


@pytest.mark.parametrize("raw,encoded", [
    ("..", "~2E~2E"), (".", "~2E"), ("x%", "x~25"), ("x~25", "x~7E25"), (r"a/b\c", "a~2Fb~5Cc"),
    ("wf-1_A", "wf-1_A"), ("é", "~C3~A9"), ("", "~"),
])
def test_sink_path_components_are_encoded_injectively(raw, encoded):
    assert safe_component(raw) == encoded


def test_a_file_sink_ignores_events_of_another_run_in_its_file(tmp_path):
    sink = FileSink(tmp_path)
    ev = _events(2)
    _, path, _ = sink.paths(ev[0]["run"])
    path.parent.mkdir(parents=True)
    alien = _events(1, {"ns": "default", "wf": "w", "run": "other"})
    path.write_text(json.dumps(alien[0]) + "\n", encoding="utf-8")
    assert sink.head(ev[0]["run"]) is None
    assert sink.write(ev, None)["written"] == 2


def test_partition_refuses_a_fork_that_does_not_chain_from_the_held_event():
    ev = _events(3)
    held = {e["seq"]: e for e in ev[:1]}
    other = Ledger(ev[0]["run"])
    for i in range(3):
        other.append("proposal", {"i": i + 100}, i)
    # seq 1 of another chain: new, but its prev is not the held seq 0.
    r = partition_delta(other.events()[1:2], held.get)
    assert r == {"fresh": [], "skipped": 0, "conflicts": [1]}


async def test_the_exporter_refuses_a_chain_started_for_another_run(monkeypatch, key):
    # SEC-EX1: the activity belongs to run "r"; the delta starts a chain for a run that never happened.
    sink = MemorySink()
    forged = _events(3, {"ns": "default", "wf": "w", "run": "run-that-never-happened"})
    errors, _ = await _export(monkeypatch, sink, forged, key)
    assert errors and "starts a chain for run run-that-never-happened" in str(errors[0])
    assert sink.runs == {}, "refused whole, never signed"


async def _export_sealed(monkeypatch, sink, value, header_keys):
    errors = []
    monkeypatch.setattr(plugin_mod.temporalio.activity, "info", lambda: _Info())
    monkeypatch.setattr(plugin_mod.temporalio.activity, "payload_converter", lambda: plugin_mod._converter())

    class _Next:
        async def execute_activity(self, _input):
            return "ran"

    ex = plugin_mod._Exporter(_Next(), sink, None, on_error=errors.append, header_keys=header_keys)

    class _Input:
        headers = {LEDGER_HEADER: plugin_mod._converter().to_payload(value)}
    await ex.execute_activity(_Input())
    return errors


async def test_with_a_header_key_the_exporter_requires_a_sealed_delta_for_its_own_run(monkeypatch):
    keys = {HEADER_KEY["keyId"]: HEADER_KEY["key"]}
    ev = _events(2)
    delta = {"events": ev, "head": {"seq": 1, "hash": ev[1]["hash"]}}
    sink = MemorySink()
    errors = await _export_sealed(monkeypatch, sink, delta, keys)
    assert errors and "not sealed" in str(errors[0]) and sink.runs == {}
    errors = await _export_sealed(monkeypatch, sink, seal_header(delta, HEADER_KEY, run_id="another-run", purpose="ledger", seq=1), keys)
    assert errors and "sealed for run another-run" in str(errors[0]) and sink.runs == {}
    errors = await _export_sealed(monkeypatch, sink, seal_header(delta, HEADER_KEY, run_id="r", purpose="head", seq=1), keys)
    assert errors and "sealed as 'head'" in str(errors[0]) and sink.runs == {}
    errors = await _export_sealed(monkeypatch, sink, seal_header(delta, HEADER_KEY, run_id="r", purpose="ledger", seq=1), keys)
    assert errors == [] and len(sink.read("w")[0]) == 2


async def test_sealed_headers_keep_the_ledger_out_of_history_and_the_chain_verifies(env, tmp_path, key):
    """Plan P2.6 in Python: with header_key, every ledger header and the Continue-as-New head
    are sealed, the guard state still crosses Continue-as-New, and the TS verifier accepts the chain."""
    policy = admit({
        "policy": "twice", "version": 1, "unlabelled": "deny",
        "effects": {"lookup": {"kind": "search", "class": "none"}},
        "rules": [{"id": "twice", "type": "at-most", "guards": "search", "n": 2}],
    })
    sink = FileSink(tmp_path / "ledger")
    tq, wid = f"par-{uuid.uuid4()}", f"par-sealed-{uuid.uuid4()}"
    plugin = PolyflowPlugin(level="guard", policy=policy, sink=sink, signing_key=key, header_key=HEADER_KEY)
    async with Worker(env.client, task_queue=tq, workflows=[ChainAgent], activities=[lookup], plugins=[plugin], max_cached_workflows=0):
        out = await env.client.execute_workflow(ChainAgent.run, 3, id=wid, task_queue=tq)
    assert out == "denied:PolyflowDenied"
    files = [p for p in (tmp_path / "ledger").rglob("*.jsonl") if not p.name.endswith(".heads.jsonl")]
    assert len(files) == 1
    # History, every execution of the chain: the headers carry envelopes, never events or guard state.
    run_id, carried, purposes = json.loads(files[0].read_text(encoding="utf-8").splitlines()[0])["run"]["run"], 0, set()
    while run_id:
        next_run = None
        async for e in env.client.get_workflow_handle(wid, run_id=run_id).fetch_history_events():
            for attrs in (e.activity_task_scheduled_event_attributes, e.workflow_execution_started_event_attributes):
                for name, payload in attrs.header.fields.items():
                    if name.startswith("polyflow-ledger"):
                        body = json.loads(payload.data)
                        assert body.get("polyflowSealed") == 2 and "events" not in body and "guard" not in body, name
                        carried += 1
                        purposes.add(body["purpose"])
            if e.HasField("workflow_execution_continued_as_new_event_attributes"):
                next_run = e.workflow_execution_continued_as_new_event_attributes.new_execution_run_id
        run_id = next_run
    assert carried >= 6 and purposes == {"ledger", "head"}
    res = subprocess.run(["node", str(CLI), "verify", str(files[0]), "--trust", str(tmp_path / "keys" / "trust.json")], capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr


def test_a_header_key_must_be_32_bytes():
    with pytest.raises(ValueError):
        PolyflowPlugin(header_key={"keyId": "k", "key": base64.b64encode(b"short").decode()})
    with pytest.raises(ValueError):
        PolyflowPlugin(header_keys={"k": "not base64 of 32 bytes"})
