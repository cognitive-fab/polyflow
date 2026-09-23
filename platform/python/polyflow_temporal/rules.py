"""The G1 rule kernel, ported from platform/packages/kernel/src/rules.mjs.

A deterministic reducer over a run's effects. Every function returns a NEW
state. The TypeScript kernel is the reference: this port must reproduce its
decisions, its witnesses and its states byte for byte (canonical digests),
which platform/conformance/guard.json pins.

Policies arrive ADMITTED (normalised by the TypeScript toolchain, with their
digest): admission runs once, in CI; workers in any language only decide.
"""

from __future__ import annotations

import copy
import math
import re

from .canonical import digest, js_str

TRACE_MAX = 32


ROUTE_PATH = re.compile(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*", re.ASCII)
_DIGITS = re.compile(r"[0-9]+", re.ASCII)
_DERIVED = ("digest", "kinds", "notes")


class PolicyError(ValueError):
    pass


def policy_body(policy: dict) -> dict:
    """What an admitted policy's digest covers: everything but what admission derived."""
    return {k: v for k, v in policy.items() if k not in _DERIVED}


def check_admitted(policy: dict) -> None:
    """Refuse an admitted policy that was edited after admission, or whose routes
    the TypeScript kernel would not have accepted (plan P7.3a). Workers do not
    re-admit: they check that what they were given is what was admitted."""
    problems = []
    for activity, path in (policy.get("routes") or {}).items():
        if not isinstance(path, str) or not ROUTE_PATH.fullmatch(path):
            problems.append(f"routes.{activity}: a dotted path into the argument list, e.g. \"0.tool_name\"")
    if "routes" in policy and not policy["routes"]:
        problems.append("routes: stored only when non-empty (an empty map changes the digest)")
    if digest(policy_body(policy)) != policy.get("digest"):
        problems.append("the policy's digest does not match its content: it was edited after admission")
    if problems:
        raise PolicyError("; ".join(problems))


def route_target(policy: dict, activity_type: str, args) -> str:
    """The target an activity is classified as: its type, or, when the policy
    routes that type, "<type>:<value at the route's path in the arguments>".
    ``args`` is the argument LIST, JSON-shaped (as it travels). A missing or
    non-string value is "<type>:?", which no effect declares. The TypeScript
    kernel's ``routeTarget``, pinned by conformance/routes.json."""
    path = (policy.get("routes") or {}).get(activity_type)
    if not path:
        return activity_type
    v = args
    for k in path.split("."):
        if isinstance(v, (list, tuple)):
            v = v[int(k)] if _DIGITS.fullmatch(k) and int(k) < len(v) else None
        elif isinstance(v, dict):
            v = v.get(k)
        else:
            v = None
            break
    return f"{activity_type}:{v}" if isinstance(v, str) and v else f"{activity_type}:?"


def classify(policy: dict, activity_type: str) -> dict:
    e = policy["effects"].get(activity_type)
    if e:
        return {"kind": e["kind"], "class": e["class"], "labels": list(e["labels"]), "declared": True}
    # A routed call whose tool the policy does not name is DENIED whatever
    # `unlabelled` says: the agent chooses the route value, and a case variant or
    # a confusable of a denied tool must not pass as "unlabelled" (review SEC-UL1).
    sep = activity_type.find(":")
    routed = sep > 0 and activity_type[:sep] in (policy.get("routes") or {})
    out = {"kind": f"unlabelled:{activity_type}", "class": "unknown", "labels": [], "declared": False}
    if routed:
        out["routed"] = True
    return out


_INDEX = re.compile(r"(?:0|[1-9][0-9]*)", re.ASCII)


def _utf16(s: str) -> bytes:
    return s.encode("utf-16-le", "surrogatepass")


def _step(v, k: str):
    """``v[k]`` in JavaScript, for JSON-shaped values (review PYC1).

    Objects read their own keys; arrays read a canonical decimal index and
    ``length``; strings read a UTF-16 code unit by index and ``length`` in
    UTF-16 code units. Anything else reads nothing a budget could spend.
    """
    if isinstance(v, dict):
        return v.get(k)
    if isinstance(v, (list, tuple)):
        if k == "length":
            return len(v)
        if _INDEX.fullmatch(k) and int(k) < len(v):
            return v[int(k)]
        return None
    if isinstance(v, str):
        units = _utf16(v)
        if k == "length":
            return len(units) // 2
        if _INDEX.fullmatch(k) and int(k) < len(units) // 2:
            i = int(k)
            return units[2 * i:2 * i + 2].decode("utf-16-le", "surrogatepass")
        return None
    return None


def _pick(obj, path):
    v = obj
    for k in str(path).split("."):
        if v is None:
            return None
        v = _step(v, k)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return v


class Guard:
    def __init__(self, policy: dict):
        self.policy = policy
        self.rules = policy["rules"]
        self.kinds = policy["kinds"]
        self.labels_of_kind: dict[str, list] = {}
        for e in policy["effects"].values():
            self.labels_of_kind[e["kind"]] = sorted(set(self.labels_of_kind.get(e["kind"], [])) | set(e["labels"]))

    # ---- state ----------------------------------------------------------------
    def init(self) -> dict:
        credits = {r["id"]: 0 for r in self.rules if r["type"] in ("requires-prior", "implies-prior") and r.get("consume")}
        return {
            "seq": 0, "n": {}, "ok": {}, "credits": credits, "approvals": [],
            "taint": {"untrusted": False, "private": False, "declassified": False, "lastSeq": 0},
            "meters": {}, "rate": {}, "signals": {}, "trace": [],
        }

    def _approval_for(self, s, c):
        for a in s["approvals"]:
            if a.get("consumed") or a.get("void"):
                continue
            if a["kind"] != c["kind"] or a["argsDigest"] != c.get("argsDigest"):
                continue
            if a.get("proposal") is None or a["proposal"] == c.get("proposal"):
                return a
        return None

    # ---- evaluation -----------------------------------------------------------
    def _evaluate(self, s, c):
        out = []
        for r in self.rules:
            t = r["type"]
            if t in ("requires-prior", "implies-prior"):
                if c["kind"] != r["guards"]:
                    continue
                if r.get("bind") == "per-effect":
                    holds = False
                elif r.get("consume"):
                    holds = s["credits"].get(r["id"], 0) > 0
                else:
                    holds = (s["ok"] if t == "requires-prior" else s["n"]).get(r["prior"], 0) > 0
                if r.get("bind") == "per-effect":
                    fix = f"'{r['guards']}' needs an approval for this exact effect; it has been requested"
                elif t == "requires-prior":
                    fix = f"run '{r['prior']}' and wait for it to succeed before '{r['guards']}'" + (f" (each '{r['prior']}' licenses one '{r['guards']}')" if r.get("consume") else "")
                else:
                    fix = f"order '{r['prior']}' before '{r['guards']}'"
                out.append((r, holds, fix))
            elif t == "at-most":
                if c["kind"] != r["guards"]:
                    continue
                used = s["n"].get(r["guards"], 0)
                out.append((r, used < r["n"], f"'{r['guards']}' may happen at most {js_str(r['n'])} time(s) in this run; it has happened {js_str(used)}"))
            elif t == "never-after":
                if c["kind"] != r["guards"]:
                    continue
                after = r["after"]
                happened = s["n"].get(after["kind"], 0) > 0 if after.get("kind") else after["signal"] in s["signals"]
                what = f"'{after['kind']}'" if after.get("kind") else f"the {after['signal']} signal"
                out.append((r, not happened, f"'{r['guards']}' is not allowed after {what}"))
            elif t == "trifecta":
                if "egress" not in (c.get("labels") or []):
                    continue
                exposed = s["taint"]["untrusted"] and s["taint"]["private"] and not s["taint"]["declassified"]
                declass = f"'{r['declassify']}' first, or " if r.get("declassify") else ""
                out.append((r, not exposed, f"this run has read untrusted content and private data; an egress effect needs {declass}an approval for this exact effect"))
            elif t == "budget":
                if r.get("kinds") and c["kind"] not in r["kinds"]:
                    continue
                used = s["meters"].get(r["id"], 0)
                holds = used + 1 <= r["max"] if r["metric"] == "effects" else used < r["max"]
                out.append((r, holds, f"budget '{r['id']}' is exhausted ({js_str(used)} of {js_str(r['max'])} {r['metric']})"))
            elif t == "rate":
                if c["kind"] != r["guards"]:
                    continue
                window = [x for x in s["rate"].get(r["id"], []) if x > c["at"] - r["perMs"]]
                holds = len(window) < r["n"]
                fix = "" if holds else f"at most {js_str(r['n'])} '{r['guards']}' per {js_str(r['perMs'])} ms; the next is allowed at {js_str(window[0] + r['perMs'])}"
                out.append((r, holds, fix))
        return out

    def _witness(self, s, c, failed):
        involved = {c["kind"]}
        for r, _, _ in failed:
            if r.get("prior"):
                involved.add(r["prior"])
            if (r.get("after") or {}).get("kind"):
                involved.add(r["after"]["kind"])
        return {
            "rules": [{"id": r["id"], "type": r["type"], "fix": fix} for r, _, fix in failed],
            "candidate": {"kind": c["kind"], "target": c.get("target"), "argsDigest": c.get("argsDigest")},
            "counters": {"scheduled": s["n"].get(c["kind"], 0), "succeeded": s["ok"].get(c["kind"], 0)},
            "sequence": [copy.deepcopy(t) for t in s["trace"] if t["kind"] in involved],
            "allowedNow": self.allowed_now(s, c.get("at")),
        }

    def _decide(self, s, c, with_witness):
        policy = self.policy
        if not c.get("declared"):
            budgets = [e for e in self._evaluate(s, c) if e[0]["type"] == "budget" and not e[0].get("kinds")]
            over = [e for e in budgets if not e[1]]
            if over:
                denies = [e for e in over if e[0]["outcome"] == "deny"]
                shown = denies or over
                if not denies:
                    a = self._approval_for(s, c)
                    if a:
                        return {"outcome": "allow", "rules": [e[0]["id"] for e in shown], "approval": a["id"]}
                d = {"outcome": "deny" if denies else "escalate", "rules": [e[0]["id"] for e in shown], "message": "; ".join(f"{e[0]['id']}: {e[2]}" for e in shown)}
                if with_witness:
                    d["witness"] = self._witness(s, c, shown)
                return d
            if policy["unlabelled"] == "report" and not c.get("routed"):
                return {"outcome": "allow", "rules": ["unlabelled"] + [e[0]["id"] for e in budgets], "note": f"'{c.get('target')}' is not declared in policy '{policy['policy']}'"}
            if policy["unlabelled"] == "escalate" and not c.get("routed"):
                a = self._approval_for(s, c)
                if a:
                    return {"outcome": "allow", "rules": ["unlabelled"], "approval": a["id"]}
            fix = f"activity '{c.get('target')}' is not declared in policy '{policy['policy']}'"
            d = {"outcome": "deny" if c.get("routed") else policy["unlabelled"], "rules": ["unlabelled"], "message": fix}
            if with_witness:
                d["witness"] = {"rules": [{"id": "unlabelled", "type": "unlabelled", "fix": fix}], "candidate": {"kind": c["kind"], "target": c.get("target"), "argsDigest": c.get("argsDigest")}, "counters": {}, "sequence": [], "allowedNow": self.allowed_now(s, c.get("at"))}
            return d
        evals = self._evaluate(s, c)
        failed = [e for e in evals if not e[1]]
        fired = [e[0]["id"] for e in evals]
        if not failed:
            return {"outcome": "allow", "rules": fired}
        denies = [e for e in failed if e[0]["outcome"] == "deny"]
        escalations = [e for e in failed if e[0]["outcome"] == "escalate"]
        if not denies:
            a = self._approval_for(s, c)
            if a:
                return {"outcome": "allow", "rules": fired, "approval": a["id"]}
        shown = denies or escalations
        d = {"outcome": "deny" if denies else "escalate", "rules": [e[0]["id"] for e in shown], "message": "; ".join(f"{e[0]['id']}: {e[2]}" for e in shown)}
        if with_witness:
            d["witness"] = self._witness(s, c, shown)
        return d

    def decide(self, s, c):
        return self._decide(s, c, True)

    def allowed_now(self, s, at):
        return [k for k in self.kinds if self._decide(s, {"kind": k, "labels": self.labels_of_kind.get(k, []), "declared": True, "argsDigest": None, "target": k, "at": at}, False)["outcome"] == "allow"]

    # ---- transitions ------------------------------------------------------------
    def commit(self, s0, c, d):
        s = copy.deepcopy(s0)
        s["seq"] += 1
        s["n"][c["kind"]] = s["n"].get(c["kind"], 0) + 1
        if d and d.get("approval"):
            for a in s["approvals"]:
                if a["id"] == d["approval"]:
                    a["consumed"] = True
        for r in self.rules:
            t = r["type"]
            if t in ("requires-prior", "implies-prior") and r.get("consume") and r.get("guards") == c["kind"] and r.get("bind") != "per-effect":
                s["credits"][r["id"]] = max(0, s["credits"].get(r["id"], 0) - 1)
            if t == "budget" and r["metric"] == "effects" and (not r.get("kinds") or c["kind"] in r["kinds"]):
                s["meters"][r["id"]] = s["meters"].get(r["id"], 0) + 1
            if t == "rate" and r["guards"] == c["kind"]:
                s["rate"][r["id"]] = [x for x in s["rate"].get(r["id"], []) if x > c["at"] - r["perMs"]] + [c["at"]]
            if t == "implies-prior" and r.get("consume") and r.get("prior") == c["kind"]:
                s["credits"][r["id"]] = s["credits"].get(r["id"], 0) + 1
        s["trace"] = (s["trace"] + [{"seq": s["seq"], "kind": c["kind"], "ok": None}])[-TRACE_MAX:]
        return s

    def observe(self, s0, kind, ok, labels=None, result=None, seq=None):
        s = copy.deepcopy(s0)
        labels = self.labels_of_kind.get(kind, []) if labels is None else labels
        effect_seq = seq
        for t in s["trace"]:
            if t["kind"] == kind and t["ok"] is None and (seq is None or t["seq"] == seq):
                t["ok"] = bool(ok)
                effect_seq = t["seq"]
                break
        if effect_seq is None:
            effect_seq = s["seq"]
        s["taint"]["lastSeq"] = s["taint"].get("lastSeq", 0)
        if "reads-untrusted" in labels:
            s["taint"]["untrusted"] = True
            s["taint"]["declassified"] = False
            s["taint"]["lastSeq"] = max(s["taint"]["lastSeq"], effect_seq)
        if not ok:
            return s
        s["ok"][kind] = s["ok"].get(kind, 0) + 1
        for r in self.rules:
            if r["type"] == "requires-prior" and r.get("consume") and r["prior"] == kind and r.get("bind") != "per-effect":
                s["credits"][r["id"]] = s["credits"].get(r["id"], 0) + 1
            if r["type"] == "budget" and r["metric"] != "effects" and (not r.get("kinds") or kind in r["kinds"]):
                v = _pick(result, r["from"])
                if v is not None and v < 0:
                    s["meters"][r["id"]] = max(s["meters"].get(r["id"], 0), r["max"])
                elif v is not None:
                    s["meters"][r["id"]] = s["meters"].get(r["id"], 0) + v
        if "reads-private" in labels:
            s["taint"]["private"] = True
            s["taint"]["declassified"] = False
            s["taint"]["lastSeq"] = max(s["taint"]["lastSeq"], effect_seq)
        for r in self.rules:
            if r["type"] == "trifecta" and r.get("declassify") == kind and effect_seq > s["taint"]["lastSeq"]:
                s["taint"]["declassified"] = True
        return s

    def signal(self, s0, name, at):
        s = copy.deepcopy(s0)
        s["signals"][name] = at
        return s

    def grant(self, s0, id, kind, args_digest, proposal=None, principal=None, at=0):
        s = copy.deepcopy(s0)
        if any(a["id"] == id for a in s["approvals"]):
            return s
        s["approvals"].append({"id": id, "kind": kind, "argsDigest": args_digest, "proposal": proposal, "principal": principal, "at": at, "consumed": False})
        return s

    def void_approval(self, s0, id):
        s = copy.deepcopy(s0)
        for a in s["approvals"]:
            if a["id"] == id:
                a["void"] = True
        return s
