/**
 * Unit-level checks of common/driver/{executor,validate,state,gate}.py and
 * arbor_config.get_gate_commands, run as python3 probes against the template
 * sources (no bytecode written).
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TEMPLATE_SCRIPTS, git, hasPython } from "./v2-driver-helpers";

function probe(body: string, cwd = os.tmpdir()): string {
  const code = `import sys\nsys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})\n${body}`;
  const r = spawnSync("python3", ["-B", "-c", code], {
    cwd,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

describe.skipIf(!hasPython())("driver modules", { timeout: 30_000 }, () => {
  it("executor: timeouts, the built-in codeg executor, overlays, rejected configurations", () => {
    const out = probe(`
from common.driver.executor import *
assert parse_timeout("90m") == 5400 and parse_timeout("30s") == 30 and parse_timeout("2h") == 7200
assert parse_timeout("45") == 45 and parse_timeout("") is None and parse_timeout(None) is None
try:
    parse_timeout("soon"); raise SystemExit("bad timeout accepted")
except ExecutorError: pass
ex = resolve_executor({})
assert (ex.name, ex.timeout, ex.max_parallel, ex.assistant, ex.assistant_ids, ex.agent_type) == \\
    ("codeg", 5400, 3, "arbor-{role}", None, None), ex
ex = resolve_executor({"executors": {"codeg": {"timeout": "30s", "agent_type": "coder"}}})
assert (ex.name, ex.timeout, ex.assistant, ex.agent_type) == ("codeg", 30, "arbor-{role}", "coder"), ex
ex = resolve_executor({"executors": {"default": "x", "x": {"type": "codeg-mcp", "assistant_ids": {"fix": "a-1"}}}})
assert (ex.name, ex.timeout, ex.assistant_ids) == ("x", None, {"fix": "a-1"}), ex
for cfg in (
    {"executors": {"default": "nope"}},
    {"executors": {"default": "x", "x": {"type": "command", "command": "sh run.sh"}}},
    {"executors": {"default": "x", "x": {"type": "codeg-cli"}}},
    {"executors": {"codeg": {"assistant_ids": "a-1"}}},
):
    try:
        resolve_executor(cfg); raise SystemExit("bad executor accepted: %r" % (cfg,))
    except ExecutorError: pass
r = ExecResult("codeg", "mcp", 0, "ok", "", "t0", "t1", 1.0)
assert r.ok and not ExecResult("codeg", "mcp", 1, "", "", "t0", "t1", 1.0).ok
assert not ExecResult("codeg", "mcp", 0, "", "", "t0", "t1", 1.0, error="timed out").ok
print("ok")
`);
    expect(out).toBe("ok");
  });

  it("validate: fail-closed replies, finding ids, allowed no-commit", () => {
    const out = probe(`
from common.driver.validate import *
J = lambda s: "\`\`\`json\\n" + s + "\\n\`\`\`"
F = '[{"file": "a.py", "line": 3, "summary": "s", "verdict": "CONFIRMED"}]'
assert not check_reply("implement", "  \\n").ok and check_reply("implement", "").problem == "empty reply"
c = check_reply("review", "I think it is fine\\nPASS")
assert not c.ok and c.verdict == "FAIL" and c.confidence == "low"
c = check_reply("review", "**FAIL**\\n" + J(F))
assert c.ok and c.verdict == "FAIL" and c.confidence == "high" and len(c.findings) == 1
c = check_reply("review", "PASS\\n" + J(F))
assert c.ok and c.verdict == "FAIL" and c.confidence == "low"
c = check_reply("review", "FAIL\\n" + J("{not json"))
assert not c.ok and c.verdict == "FAIL" and c.confidence == "low" and c.findings == []
assert not check_reply("verify", "CONFIRMED 1, PLAUSIBLE 0, REFUTED 0.").ok
assert not check_reply("verify", J('[{"file": "a", "line": 1, "summary": "s", "verdict": "MAYBE"}]')).ok
c = check_reply("verify", J('[{"file": "a", "line": 1, "summary": "s", "verdict": "REFUTED"}]'))
assert c.ok and c.confidence == "low"
c = check_reply("verify", J('[{"file": "a", "line": 1, "summary": "s", "verdict": "REFUTED"}]') + "\\nCONFIRMED 0, PLAUSIBLE 0, REFUTED 1.")
assert c.ok and c.confidence == "high"
assert check_reply("implement", "## Implementation Partial").verdict == "Partial"
c = check_reply("implement", "done!")
assert c.ok and c.confidence == "low"
assert check_reply("explore", "## Explore Results\\nx").problem is None
assert finding_id({"file": "a.py", "line": 7, "summary": "x" * 60}) == "a.py:7:" + "x" * 40
assert len(dedup([{"file": "a", "line": 1, "summary": "s"}] * 3)) == 1

no_commit = ["simplify produced no new commit on arbor/t"]
r = "## Simplify: No Change\\n"
assert adjust_violations("simplify", no_commit, r, check_reply("simplify", r)) == []
r = "## Simplify: Changed\\n"
assert adjust_violations("simplify", no_commit, r, check_reply("simplify", r)) == no_commit
fix_no_commit = ["fix produced no new commit on arbor/t"]
r = "## Fix: Done\\n\\n### Findings\\n1. \`a:1\` x -> skipped: false positive\\n2. \`b:2\` y -> skipped: out of scope\\n"
assert adjust_violations("fix", fix_no_commit, r, check_reply("fix", r)) == []
r = "## Fix: Done\\n\\n### Findings\\n1. \`a:1\` x -> fixed: z\\n2. \`b:2\` y -> skipped: out of scope\\n"
assert adjust_violations("fix", fix_no_commit, r, check_reply("fix", r)) == fix_no_commit
# only the no-commit hit is ever dropped; a boundary violation stays
v = fix_no_commit + ["fix left uncommitted changes: a"]
r = "## Fix: Done\\n\\n### Findings\\n1. \`a:1\` x -> skipped: false positive\\n"
assert adjust_violations("fix", v, r, check_reply("fix", r)) == ["fix left uncommitted changes: a"]
assert only_missing_commit(no_commit) and not only_missing_commit(no_commit + ["x"]) and not only_missing_commit([])
print("ok")
`);
    expect(out).toBe("ok");
  });

  it("validate.prefilter: file, line within the range (±5), cited rule files", () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-prefilter-")),
    );
    try {
      git(tmp, "init", "-q", "-b", "main");
      git(tmp, "config", "user.email", "t@example.com");
      git(tmp, "config", "user.name", "t");
      const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
      fs.writeFileSync(path.join(tmp, "a.txt"), lines.join("\n") + "\n");
      fs.writeFileSync(path.join(tmp, "AGENTS.md"), "rules\n");
      git(tmp, "add", ".");
      git(tmp, "commit", "-q", "-m", "one");
      const base = git(tmp, "rev-parse", "HEAD");
      lines[19] = "changed 20";
      fs.writeFileSync(path.join(tmp, "a.txt"), lines.join("\n") + "\n");
      git(tmp, "commit", "-qam", "two");
      const out = probe(`
import json
from pathlib import Path
from common.driver.validate import prefilter
fs = [
  {"file": "a.txt", "line": 25, "summary": "near"},
  {"file": "a.txt", "line": 26, "summary": "far"},
  {"file": "missing.txt", "line": 1, "summary": "gone"},
  {"file": "a.txt", "line": 20, "angle": "Conventions", "summary": "rule", "evidence": "AGENTS.md: rules"},
  {"file": "a.txt", "line": 20, "angle": "Conventions", "summary": "norule", "evidence": "style"},
  {"file": "a.txt", "line": 20, "summary": "badrule", "evidence": ".arbor/spec/nope.md says"},
  {"file": "a.txt", "line": 1, "angle": "Acceptance", "summary": "ac"},
]
kept, dropped = prefilter(fs, Path(${JSON.stringify(tmp)}), "${base}..HEAD")
print(json.dumps([[k["summary"] for k in kept], sorted(d["summary"] for d, _ in dropped)]))
`);
      expect(JSON.parse(out)).toEqual([
        ["near", "rule", "ac"],
        ["badrule", "far", "gone", "norule"],
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("state: round caps enter STOP (NO_PROGRESS / BUDGET); resume continues and raises the budget", () => {
    const out = probe(`
from common.driver import state as sm
def gate(d, failing):  # the real flow: decide -> fix -> GATE/gate -> on_gate
    sm.goto(d, "GATE"); sm.on_gate(d, failing)
d = sm.ensure_fields({"state": "GATE", "base": "b"})
gate(d, ["AC-1", "AC-2"]); assert d["step"] == "decide" and d["counters"]["no_progress"] == 0
gate(d, ["AC-1"]);         assert d["counters"]["no_progress"] == 0          # shrank
gate(d, ["AC-2"]);         assert d["counters"]["no_progress"] == 0          # AC-1 now passes
gate(d, ["AC-2"]);         assert d["counters"]["no_progress"] == 1
gate(d, ["AC-2"]);         assert d["state"] == "STOP" and d["stop"]["reason"] == "NO_PROGRESS" and d["stop"]["prev"] == {"state": "GATE", "step": "decide"}
sm.resume(d); assert (d["state"], d["step"]) == ("GATE", "decide") and d["counters"]["no_progress"] == 0 and d["decision"]["kind"] == "gate_red"
d["after_gate"] = {"state": "REVIEW", "step": "review"}
sm.on_gate(d, []); assert (d["state"], d["step"]) == ("REVIEW", "review") and d["gate_reds"] == 0
# implement -> GATE -> the tier's REVIEW entry
for tier, want in (("light", "review"), ("standard", "candidates"), ("full", "candidates")):
    e = sm.ensure_fields({"state": "BUILD", "step": "implement", "base": "b"})
    sm.on_writer_done(e, "BUILD", "implement", True, tier); assert e["state"] == "GATE"
    sm.on_gate(e, [], tier); assert (e["state"], e["step"]) == ("REVIEW", want), (tier, e)
# a child with a deferred review (its parent reviews the integration branch) finishes after the gate
e = sm.ensure_fields({"state": "BUILD", "step": "implement", "base": "b", "review_deferred": True})
sm.on_writer_done(e, "BUILD", "implement", True, "standard"); assert e["after_gate"] == {"state": "FINISH"}
sm.on_gate(e, [], "standard"); assert e["state"] == "FINISH"
e = sm.ensure_fields({"state": "GATE", "base": "b"})
sm.on_gate(e, [], "light"); assert (e["state"], e["step"]) == ("REVIEW", "review")

g = sm.ensure_fields({"state": "GATE", "base": "b"})
for i in range(sm.GATE_RED_CAP):
    gate(g, ["AC-%d" % j for j in range(10 - i)])
assert g["state"] == "GATE" and g["step"] == "decide" and "stop" not in g
gate(g, ["AC-0"]); assert g["state"] == "STOP" and g["stop"]["reason"] == "BUDGET" and g["stop"]["counter"] == "gate"
sm.resume(g); assert (g["state"], g["step"]) == ("GATE", "decide") and g["caps_extra"] == {"gate": 2}
gate(g, ["AC-0"]); assert g["state"] == "GATE"                                # one more round granted
gate(g, []); assert g["state"] != "STOP"

# light review: REVIEW_ROUND_CAP fix rounds, then STOP(BUDGET) at the fix
r = sm.ensure_fields({"state": "REVIEW", "base": "b"})
sm.on_review(r, "FAIL", ["x"], "b", "h1"); assert (r["step"], r["counters"]["review"]) == ("fix", 1)
assert r["review_from"] == "b" and r["last_reviewed"] == "h1"
r["state"], r["step"] = "REVIEW", "review"
sm.on_review(r, "FAIL", ["y"], "h1", "h2"); assert (r["step"], r["counters"]["review"]) == ("fix", 2) and "stop" not in r
r["state"], r["step"] = "REVIEW", "review"
sm.on_review(r, "FAIL", ["z"], "h2", "h3")
assert r["state"] == "STOP" and r["stop"]["reason"] == "BUDGET" and r["stop"]["prev"] == {"state": "REVIEW", "step": "fix"}
sm.resume(r); assert (r["state"], r["step"]) == ("REVIEW", "fix") and r["caps_extra"] == {"review": 2} and r["review_from"] == "h2"

l = sm.ensure_fields({"state": "REVIEW", "base": "b"})
sm.on_review(l, "FAIL", ["x"], "b", "h1"); l["step"] = "review"
sm.on_review(l, "FAIL", ["x"], "h1", "h2")
assert l["counters"]["no_progress"] == 1 and l["step"] == "fix"
l["step"] = "review"
sm.on_review(l, "FAIL", ["x"], "h2", "h3")
assert l["state"] == "STOP" and l["stop"]["reason"] == "NO_PROGRESS"
p = sm.ensure_fields({"state": "REVIEW", "base": "b"})
sm.on_review(p, "PASS", [], "b", "h"); assert p["state"] == "FINISH" and p["last_reviewed"] == "h"

# REVIEW cycle (standard / full): candidates -> verify batches -> fix -> GATE -> recheck of the delta
q = sm.ensure_fields({"state": "GATE", "base": "b", "last_reviewed": "h"})
sm.on_gate(q, [], "full")  # a green gate after BUILD opens the first cycle over base..HEAD
assert q["step"] == "candidates" and q["cycle"]["range_from"] == "b"
assert not sm.on_candidate(q, "full", "d-1", "h2") and not sm.on_candidate(q, "full", "d-2", "h2")
assert sm.on_candidate(q, "full", "d-3", "h2")
sm.on_candidates_filtered(q, ["f%d" % i for i in range(9)], "c.json", "full")
assert q["step"] == "verify" and q["cycle"]["verify_batches"] == 2 and q["last_reviewed"] == "h2"
assert q["counters"]["review"] == 1 and q["cycle_ids"] == ["f%d" % i for i in range(9)]
sm.on_verify(q, ["f1"], [], "full"); assert q["step"] == "verify"
sm.on_verify(q, ["f2"], [], "full"); assert q["step"] == "fix" and q["cycle"]["fix"] == ["f1", "f2"]
sm.on_writer_done(q, "REVIEW", "fix", True, "full")
assert q["state"] == "GATE" and q["after_gate"] == {"state": "REVIEW", "step": "recheck"}
import copy
small = copy.deepcopy(q); sm.on_gate(small, [], "full", delta_lines=sm.RECHECK_MAX_LINES)
assert (small["state"], small["step"]) == ("REVIEW", "review"), small  # one self-check reader over last_reviewed..HEAD
unknown = copy.deepcopy(q); sm.on_gate(unknown, [], "full")
assert unknown["step"] == "candidates", unknown  # no delta size known: the full cycle
sm.on_gate(q, [], "full", delta_lines=sm.RECHECK_MAX_LINES + 1)
assert q["step"] == "candidates" and q["cycle"]["range_from"] == "h2"
# the cap: REVIEW_ROUND_CAP cycles with findings, the next one stops (BUDGET)
q["counters"]["review"] = sm.REVIEW_ROUND_CAP
for n in range(3): sm.on_candidate(q, "full", "d-%d" % (4 + n), "h3")
sm.on_candidates_filtered(q, ["g1"], "c2.json", "full")
assert q["state"] == "STOP" and q["stop"]["reason"] == "BUDGET" and q["stop"]["counter"] == "review"
sm.resume(q); assert q["state"] == "REVIEW" and q["caps_extra"] == {"review": 2}
# the same candidate ids twice is a round without progress; a clean cycle finishes (full: after its sweep)
u = sm.ensure_fields({"state": "REVIEW", "step": "candidates", "base": "b", "cycle": {"range_from": "b"}, "cycle_ids": ["g1"]})
sm.on_candidates_filtered(u, ["g1"], "c.json", "standard"); assert u["counters"]["no_progress"] == 1 and u["step"] == "verify"
for tier, want in (("standard", ("FINISH", "finish")), ("full", ("REVIEW", "sweep"))):
    w = sm.ensure_fields({"state": "REVIEW", "step": "candidates", "base": "b", "cycle": {"range_from": "b"}})
    sm.on_candidates_filtered(w, [], "c.json", tier); assert (w["state"], w["step"]) == want, (tier, w)
assert w["cycle"] == {"sweep": True, "range_from": "b"}
sm.on_sweep_filtered(w, [], "s.json", "h9"); assert w["state"] == "FINISH" and w["sweep_done"] and "cycle" not in w
w = sm.ensure_fields({"state": "REVIEW", "step": "sweep", "base": "b", "cycle": {"sweep": True, "range_from": "b"}})
sm.on_sweep_filtered(w, ["s1"], "s.json", "h9"); assert w["step"] == "verify" and w["sweep_ids"] == ["s1"] and w["review_from"] == "b"
sm.on_verify(w, ["s1"], [], "full"); assert w["step"] == "fix"
sm.on_writer_done(w, "REVIEW", "fix", True, "full"); assert w["after_gate"] == {"state": "REVIEW", "step": "recheck"}
sm.on_gate(w, [], "full", delta_lines=3); assert (w["state"], w["step"]) == ("REVIEW", "review")
sm.on_review(w, "PASS", [], "h9", "h10", "full"); assert w["state"] == "FINISH" and "cycle" not in w  # the sweep never repeats
# a clean self-check in full before the sweep goes to the sweep, not to FINISH
x = sm.ensure_fields({"state": "REVIEW", "step": "review", "base": "b"})
sm.on_review(x, "PASS", [], "b", "h", "full"); assert (x["state"], x["step"]) == ("REVIEW", "sweep")
# PLAUSIBLE findings: a human (or the mandate) decides fix|skip
v = sm.ensure_fields({"state": "REVIEW", "step": "verify", "base": "b", "cycle": {"range_from": "b", "verify_batches": 1}})
sm.on_verify(v, ["c1"], ["p1"], "standard")
assert v["step"] == "plausible" and v["decision"] == {"kind": "plausible", "options": ["fix", "skip"], "failing": ["p1"]}
assert sm.plan(v, "standard").human == {"kind": "plausible"}
try:
    sm.decide(v, "impl"); raise SystemExit("impl accepted for plausible")
except sm.StateError: pass
sm.decide(v, "fix", "standard"); assert v["step"] == "fix" and v["cycle"]["fix"] == ["c1", "p1"]
v["state"], v["step"], v["decision"] = "REVIEW", "plausible", {"kind": "plausible"}
sm.decide(v, "skip", "standard"); assert v["step"] == "fix" and v["cycle"]["fix"] == ["c1"]

# decide / plan
x = sm.ensure_fields({"state": "GATE", "base": "b"})
sm.on_gate(x, ["AC-1"]); assert sm.plan(x, "light").needs == "decide"
for bad in ("tests", "fix"):
    try:
        sm.decide(x, bad); raise SystemExit(bad + " accepted for gate_red")
    except sm.StateError: pass
sm.decide(x, "impl"); assert (x["state"], x["step"]) == ("GATE", "fix")
try:
    sm.decide(x, "impl"); raise SystemExit("decide without a decision")
except sm.StateError: pass
y = sm.ensure_fields({"state": "GATE", "base": "b"})
sm.on_gate(y, ["AC-1"]); sm.decide(y, "contract")
assert y["state"] == "CONTRACT" and y["resume_to"] == {"state": "GATE", "step": "gate"}
sm.resume(y); assert (y["state"], y["step"]) == ("GATE", "gate")
step = sm.plan(sm.ensure_fields({"state": "BUILD", "base": "b"}), "light")
assert (step.needs, step.role, step.range_from) == ("brief", "implement", "b")
assert sm.plan({"state": "FINISH"}, "light").human == {"kind": "merge"}
assert set(sm.DISPATCH_STEPS.values()) == {"implement", "fix", "review", "verify"}
assert ("REVIEW", "simplify") not in sm.DISPATCH_STEPS  # simplify runs only through override --role simplify
assert "POLISH" not in sm.STATES and sm.DECIDE_CHOICES == ("impl", "contract")
print("ok")
`);
    expect(out).toBe("ok");
  });

  it("gate: gate commands as GATE-n, auto map checks; get_gate_commands", () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-gate-")),
    );
    try {
      const out = probe(
        `
import json
from pathlib import Path
from common.arbor_config import get_gate_commands, parse_simple_yaml
from common.contract import parse_contract
from common.driver.gate import auto_checks, format_checks, run_gate
cfg = parse_simple_yaml('gate:\\n  commands:\\n    - "true"\\n    - "exit 2"\\n')
assert get_gate_commands(cfg) == ["true", "exit 2"] and get_gate_commands({}) == []
c = parse_contract("""## Acceptance criteria
- AC-1: a
- AC-2: b
- AC-3: c
## Verification map
| id | kind | check | file |
|----|------|-------|------|
| AC-1 | auto | \`true\` | |
| AC-2 | auto | \`echo 'ImportError: no module x'; exit 1\` | tests/ac2.sh |
| AC-3 | manual | look | |
""", Path("contract.md"))
assert [i for i, _ in auto_checks(c)] == ["AC-1", "AC-2"]
g = run_gate(get_gate_commands(cfg), c, Path("."))
assert [x.id for x in g.checks] == ["GATE-1", "GATE-2", "AC-1", "AC-2"] and g.failing == ["GATE-2", "AC-2"] and not g.green
text = format_checks(g.checks)
assert "- GATE-2: exit 2" in text and "ImportError: no module x" in text and "- AC-1: pass" in text
assert run_gate([], c, Path(".")).failing == ["AC-2"]
print("ok")
`,
        tmp,
      );
      expect(out).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
