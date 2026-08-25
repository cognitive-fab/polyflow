"""Phase 2 — drive polyflow through OpenWorker's OWN MCP stack.

Not a mock of the seam: this imports coworker.mcp.client, coworker.mcp.tools and
coworker.tools.registry from the spike checkout and calls them exactly the way
coworker/server/manager.py:1304 does. What it proves (or disproves) is whether a
real agent can reach polyflow with no changes to that agent's core.

    POLYFLOW_SPIKE   path to the openworker checkout (default ../../spike/openworker)
    run: spike/.venv/Scripts/python.exe test/integration/openworker_seam.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPIKE = Path(os.environ.get("POLYFLOW_SPIKE", ROOT / "spike" / "openworker")).resolve()
sys.path.insert(0, str(SPIKE))

from coworker.mcp.client import MCPManager  # noqa: E402
from coworker.mcp.config import MCPServerDef  # noqa: E402
from coworker.mcp.tools import build_callables, tool_name  # noqa: E402
from coworker.tools.registry import ToolRegistry  # noqa: E402

FINDINGS: list[str] = []
FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILURES.append(label)


def note(text: str) -> None:
    FINDINGS.append(text)
    print(f"NOTE  {text}")


def payload(raw):
    """What the registry hands the model back, normalized for assertions."""
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"_text": raw}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list) and raw:
        return payload(raw[0])
    return {"_raw": repr(raw)}


async def main() -> int:
    loop = asyncio.get_running_loop()
    state = tempfile.mkdtemp(prefix="polyflow-seam-")

    server = MCPServerDef(
        name="polyflow",
        transport="stdio",
        command="node",
        args=["--no-warnings", str(ROOT / "bin" / "polyflow-mcp.mjs")],
        cwd=str(ROOT),
        env={
            **os.environ,
            "POLYFLOW_DB": str(Path(state) / "seam.sqlite"),
            "POLYFLOW_AGENT": "openworker/cowork",
            "POLYFLOW_INSTANCE": "acme",
        },
        requires_approval=True,
    )

    mgr = MCPManager()
    try:
        conn = await mgr.ensure(server)
    except Exception as exc:  # connection failure is the whole answer
        check("OpenWorker's MCPManager connects to polyflow", False, f"{type(exc).__name__}: {exc}")
        print(mgr.last_stderr("polyflow") or "(no stderr)")
        return 1

    check("OpenWorker's MCPManager connects to polyflow", True,
          f"{len(conn.tools)} tools discovered")

    # --- the exact call site from server/manager.py:1304 ----------------------
    callables = build_callables(
        server,
        conn.tools,
        lambda tool, args, name=server.name: mgr.call(name, tool, args),
        loop,
    )
    registry = ToolRegistry()
    registry.register_all(callables)

    names = sorted(registry.names())
    check("all six tools register", len(names) == 6, ", ".join(names))

    # aisuite/OpenAI schema fidelity — the model never sees our schema directly.
    schemas = {s["function"]["name"]: s for s in registry.schemas()}
    start = schemas.get(tool_name("polyflow", "workflow_start"))
    params = start["function"]["parameters"] if start else {}
    check("workflow_start keeps its schema through the aisuite bridge",
          set(params.get("required", [])) == {"workflow"}
          and set(params.get("properties", {})) == {"workflow", "input", "key"},
          json.dumps({"required": params.get("required"),
                      "properties": sorted(params.get("properties", {}))}))
    check("tool names fit OpenAI's 64-char limit",
          all(len(n) <= 64 for n in names), max(names, key=len))

    # The permission finding from Phase 0, confirmed against a live server.
    spec = registry.get(tool_name("polyflow", "workflow_start"))
    meta = spec.metadata
    check("PermissionEngine gates polyflow tools with no core change",
          bool(getattr(meta, "requires_approval", False)),
          f"requires_approval={getattr(meta, 'requires_approval', None)}")
    risk = getattr(meta, "risk_level", None)
    note(f"every polyflow tool is risk_level={risk!r} (hardcoded in coworker/mcp/tools.py). "
         "engine._parallel_safe requires 'low', so read-only tools like workflow_state "
         "can never run in parallel, and every call is approval-gated identically.")

    # --- drive a real run through THEIR registry ------------------------------
    call = lambda t, a: asyncio.to_thread(registry.execute, tool_name("polyflow", t), a)

    listed = payload(await call("workflow_list", {}))
    brief = next((w for w in listed.get("workflows", []) if w["name"] == "customer-brief"), None)
    check("workflow_list reaches the agent with its guarantees intact",
          bool(brief) and "no-post-without-prior-approval" in (brief or {}).get("guarantees", []),
          json.dumps((brief or {}).get("guarantees")))

    v = payload(await call("workflow_start", {"workflow": "customer-brief", "input": {"date": "2026-08-25"}}))
    order = (v.get("next") or [{}])[0]
    check("workflow_start returns the first work order",
          order.get("tool") == "github_search_issues", json.dumps(order))
    check("the run key is derived from input, not chosen", v.get("key") == "2026-08-25",
          json.dumps(v.get("key")))

    renamed = payload(await call("workflow_start", {
        "workflow": "customer-brief", "key": "2026-08-25-r2", "input": {"date": "2026-08-25"}}))
    check("a caller-supplied key cannot fork a second run",
          renamed.get("instance") == v.get("instance"), json.dumps(renamed.get("key_note")))
    instance = v.get("instance")

    v = payload(await call("workflow_report", {"order_id": order["order_id"], "result": {"count": 3}}))
    order = (v.get("next") or [{}])[0]
    check("a reported result advances the run", v.get("state", {}).get("briefState") == "drafting",
          json.dumps(v.get("state")))

    v = payload(await call("workflow_report", {"order_id": order["order_id"], "result": {}}))
    order = (v.get("next") or [{}])[0]
    check("the approval step is ordered as an agent tool call",
          order.get("tool") == "ask_user", json.dumps(order))

    # Deny it, the way a human answering the Inbox would.
    v = payload(await call("workflow_report", {
        "order_id": order["order_id"], "ok": False, "permanent": True, "error": "not-ready",
    }))
    check("a denial ends the run without ever ordering the post",
          v.get("state", {}).get("briefState") == "denied" and not v.get("next"),
          json.dumps(v.get("state")))

    j = payload(await call("workflow_journal", {"instance": instance}))
    check("the journal survives the round trip",
          any(r["action"] == "DENIED" for r in j.get("journal", [])),
          f"{len(j.get('journal', []))} steps")

    # --- what a tool ERROR looks like to their engine -------------------------
    try:
        bad = payload(await call("workflow_state", {"instance": "no-such-instance"}))
        note(f"an MCP isError result surfaces to the registry as: {json.dumps(bad)[:160]}")
    except Exception as exc:
        note(f"an MCP isError result RAISES into the registry: {type(exc).__name__}: {exc}")

    # --- candidate upstream patch: per-tool risk_level ------------------------
    if "tool_risk" in MCPServerDef.__dataclass_fields__:
        reads = {"workflow_list": "low", "workflow_state": "low", "workflow_journal": "low"}
        patched = MCPServerDef(**{**server.__dict__, "tool_risk": reads})
        graded = build_callables(patched, conn.tools,
                                 lambda tool, args, name=server.name: mgr.call(name, tool, args), loop)
        levels = {c.__aisuite_tool_metadata__.name.rsplit("__", 1)[-1]:
                  c.__aisuite_tool_metadata__.risk_level for c in graded}
        check("patch: declared read-only tools grade as low risk",
              all(levels[t] == "low" for t in reads), json.dumps(levels))
        check("patch: undeclared tools stay medium (fail closed)",
              levels["workflow_report"] == "medium", levels["workflow_report"])
        bogus = MCPServerDef(**{**server.__dict__, "tool_risk": {"workflow_report": "none"}})
        bogus_levels = {c.__aisuite_tool_metadata__.name.rsplit("__", 1)[-1]:
                        c.__aisuite_tool_metadata__.risk_level
                        for c in build_callables(bogus, conn.tools,
                                                 lambda tool, args, name=server.name: mgr.call(name, tool, args), loop)}
        check("patch: an unrecognised risk value is ignored, not trusted",
              bogus_levels["workflow_report"] == "medium", bogus_levels["workflow_report"])
    else:
        note("candidate patch not applied to the spike — per-tool risk_level untested")

    await mgr.aclose()
    print()
    print(f"{len(FAILURES)} failed, findings: {len(FINDINGS)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
