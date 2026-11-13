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
  it("executor: timeouts, the built-in orca executor, role overrides, rejected configurations", () => {
    const out = probe(`
from common.driver.executor import *
assert parse_timeout("90m") == 5400 and parse_timeout("30s") == 30 and parse_timeout("2h") == 7200
assert parse_timeout("45") == 45 and parse_timeout("") is None and parse_timeout(None) is None
try:
    parse_timeout("soon"); raise SystemExit("bad timeout accepted")
except ExecutorError: pass
ex = resolve_executor({})
assert (ex.name, ex.command, ex.timeout, ex.max_parallel, ex.keep_open, ex.agent, ex.roles) == \\
    ("orca", "orca", 5400, 5, False, "codex", {}), ex
ex = resolve_executor({"executors": {"orca": {"timeout": "30s", "agent": "claude", "keep_open": "true"}}})
assert (ex.name, ex.timeout, ex.keep_open, ex.agent_for("fix")) == ("orca", 30, True, "claude"), ex
ex = resolve_executor({"executors": {"default": "x", "x": {
    "type": "orca", "command": "/opt/orca", "agent": "codex",
    "roles": {"explore": {"agent": "omp"}, "fix": {"agent": "claude"}}}}})
assert (ex.name, ex.command, ex.timeout) == ("x", "/opt/orca", None), ex
assert ex.roles == {"explore": "omp", "fix": "claude"}, ex
assert (ex.agent_for("explore"), ex.agent_for("fix"), ex.agent_for("review")) == ("omp", "claude", "codex")
for cfg in (
    {"executors": {"default": "nope"}},
    {"executors": {"default": "x", "x": {"type": "command", "command": "sh run.sh"}}},
    {"executors": {"default": "x", "x": {"type": "orca", "command": "orca"}}},
    {"executors": {"default": "x", "x": {"type": "orca", "agent": "codex"}}},
    {"executors": {"orca": {"roles": "explore"}}},
    {"executors": {"orca": {"roles": {"explore": "omp"}}}},
    {"executors": {"orca": {"roles": {"explore": {"effort": "high"}}}}},
):
    try:
        resolve_executor(cfg); raise SystemExit("bad executor accepted: %r" % (cfg,))
    except ExecutorError: pass
r = ExecResult("orca", "worker", 0, "ok", "", "t0", "t1", 1.0)
assert r.ok and not ExecResult("orca", "worker", 1, "", "", "t0", "t1", 1.0).ok
assert not ExecResult("orca", "worker", 0, "", "", "t0", "t1", 1.0, error="timed out").ok
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
c = check_reply("review", "FAIL\\n" + J('[{"file": "a", "line": 1, "summary": "s", "verdict": "CANDIDATE"}]'))
assert not c.ok and c.confidence == "low"  # every finding carries a verdict now
c = check_reply("review", "PASS\\n" + J('[{"file": "a", "line": 1, "summary": "s", "verdict": "REFUTED"}]'))
assert c.ok and c.verdict == "PASS" and c.confidence == "high"  # REFUTED findings do not contradict PASS
d = dedup([{"file": "a", "line": 1, "summary": "s", "verdict": "PLAUSIBLE"}, {"file": "a", "line": 1, "summary": "s", "verdict": "CONFIRMED"}])
assert [x["verdict"] for x in d] == ["CONFIRMED"]
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
      fs.mkdirSync(path.join(tmp, ".arbor/spec"), { recursive: true });
      fs.writeFileSync(path.join(tmp, ".arbor/spec/rules.md"), "rules\n");
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
  {"file": "a.txt", "line": 20, "angle": "Conventions", "summary": "rule", "evidence": ".arbor/spec/rules.md: rules"},
  {"file": "a.txt", "line": 20, "angle": "Conventions", "summary": "agentsrule", "evidence": "AGENTS.md: rules"},
  {"file": "a.txt", "line": 20, "angle": "Conventions", "summary": "norule", "evidence": "style"},
  {"file": "a.txt", "line": 20, "summary": "badrule", "evidence": ".arbor/spec/nope.md says"},
  {"file": "a.txt", "line": 1, "angle": "Acceptance", "summary": "ac"},
]
kept, dropped = prefilter(fs, Path(${JSON.stringify(tmp)}), "${base}..HEAD")
print(json.dumps([[k["summary"] for k in kept], sorted(d["summary"] for d, _ in dropped)]))
`);
      expect(JSON.parse(out)).toEqual([
        ["near", "rule", "ac"],
        ["agentsrule", "badrule", "far", "gone", "norule"],
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

# REVIEW cycle (standard / full): self-verified candidates -> fix -> GATE -> recheck of the delta
q = sm.ensure_fields({"state": "GATE", "base": "b", "last_reviewed": "h"})
sm.on_gate(q, [], "full")  # a green gate after BUILD opens the first cycle over base..HEAD
assert q["step"] == "candidates" and q["cycle"]["range_from"] == "b"
assert not sm.on_candidate(q, "full", "d-1", "h2") and not sm.on_candidate(q, "full", "d-2", "h2")
assert sm.on_candidate(q, "full", "d-3", "h2")
sm.on_candidates_filtered(q, ["f1", "f2"], [], "c.json", "full", {"f1": {"kind": "trace"}, "x": {"kind": "trace"}})
assert q["step"] == "fix" and q["cycle"]["fix"] == ["f1", "f2"] and q["last_reviewed"] == "h2"
assert q["counters"]["review"] == 1 and q["cycle_ids"] == ["f1", "f2"]
assert q["cycle"]["repros"] == {"f1": {"kind": "trace"}}  # only CONFIRMED ids keep a repro
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
sm.on_candidates_filtered(q, ["g1"], [], "c2.json", "full")
assert q["state"] == "STOP" and q["stop"]["reason"] == "BUDGET" and q["stop"]["counter"] == "review"
sm.resume(q); assert q["state"] == "REVIEW" and q["caps_extra"] == {"review": 2}
# the same candidate ids twice is a round without progress; a clean cycle finishes (full: after its sweep)
u = sm.ensure_fields({"state": "REVIEW", "step": "candidates", "base": "b", "cycle": {"range_from": "b"}, "cycle_ids": ["g1"]})
sm.on_candidates_filtered(u, ["g1"], [], "c.json", "standard"); assert u["counters"]["no_progress"] == 1 and u["step"] == "fix"
for tier, want in (("standard", ("FINISH", "finish")), ("full", ("REVIEW", "sweep"))):
    w = sm.ensure_fields({"state": "REVIEW", "step": "candidates", "base": "b", "cycle": {"range_from": "b"}})
    sm.on_candidates_filtered(w, [], [], "c.json", tier); assert (w["state"], w["step"]) == want, (tier, w)
assert w["cycle"] == {"sweep": True, "range_from": "b"}
sm.on_sweep_filtered(w, [], [], "s.json", "h9"); assert w["state"] == "FINISH" and w["sweep_done"] and "cycle" not in w
w = sm.ensure_fields({"state": "REVIEW", "step": "sweep", "base": "b", "cycle": {"sweep": True, "range_from": "b"}})
sm.on_sweep_filtered(w, ["s1"], [], "s.json", "h9"); assert w["step"] == "fix" and w["sweep_ids"] == ["s1"] and w["review_from"] == "b"
sm.on_writer_done(w, "REVIEW", "fix", True, "full"); assert w["after_gate"] == {"state": "REVIEW", "step": "recheck"}
sm.on_gate(w, [], "full", delta_lines=3); assert (w["state"], w["step"]) == ("REVIEW", "review")
sm.on_review(w, "PASS", [], "h9", "h10", "full"); assert w["state"] == "FINISH" and "cycle" not in w  # the sweep never repeats
# a clean self-check in full before the sweep goes to the sweep, not to FINISH
x = sm.ensure_fields({"state": "REVIEW", "step": "review", "base": "b"})
sm.on_review(x, "PASS", [], "b", "h", "full"); assert (x["state"], x["step"]) == ("REVIEW", "sweep")
# PLAUSIBLE findings: a human (or the mandate) decides fix|skip
v = sm.ensure_fields({"state": "REVIEW", "step": "candidates", "base": "b", "cycle": {"range_from": "b"}})
sm.on_candidates_filtered(v, ["c1"], ["p1"], "c.json", "standard")
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
assert set(sm.DISPATCH_STEPS.values()) == {"implement", "fix", "review"}
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
r = run_gate([], c, Path("."), repros=[("x:1:s", "true"), ("y:2:t", "exit 3")])
assert [x.id for x in r.checks] == ["AC-1", "AC-2", "REPRO-1", "REPRO-2"] and r.failing == ["AC-2", "REPRO-2"]
print("ok")
`,
        tmp,
      );
      expect(out).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("validate.check_repros: exec needs a file under research/repro/ and a command; trace needs two existing steps", () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-repro-")),
    );
    try {
      fs.mkdirSync(path.join(tmp, ".arbor/tasks/t/research/repro"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmp, ".arbor/tasks/t/research/repro/r.sh"),
        "exit 1\n",
      );
      fs.writeFileSync(path.join(tmp, ".arbor/tasks/t/notes.sh"), "exit 1\n");
      fs.mkdirSync(path.join(tmp, "src"));
      fs.writeFileSync(path.join(tmp, "src/a.py"), "x\n");
      const out = probe(
        `
from pathlib import Path
from common.driver.validate import ReplyCheck, check_repros, finding_id, repro_problem
wt, rel = Path("."), ".arbor/tasks/t"
ok = lambda r: repro_problem(r, wt, rel)
assert ok({"kind": "exec", "path": "research/repro/r.sh", "command": "sh x"})[1] == \\
    {"kind": "exec", "path": ".arbor/tasks/t/research/repro/r.sh", "command": "sh x"}
assert ok({"kind": "exec", "path": ".arbor/tasks/t/research/repro/r.sh", "command": "sh x"})[1] is not None
for bad in ({"kind": "exec", "path": "research/repro/missing.sh", "command": "sh x"},
            {"kind": "exec", "path": ".arbor/tasks/t/notes.sh", "command": "sh x"},
            {"kind": "exec", "path": "research/repro/../notes.sh", "command": "sh x"},
            {"kind": "exec", "path": "research/repro/r.sh", "command": " "},
            {"kind": "trace", "path": ["src/a.py:1"]},
            {"kind": "trace", "path": ["src/a.py:1", "src/missing.py:2"]},
            {"kind": "trace", "path": ["src/a.py:1", "src/a.py"]},
            {"kind": "guess"}, None, "sh x"):
    problem, repro = ok(bad)
    assert repro is None and problem, bad
assert ok({"kind": "trace", "path": ["src/a.py:1", "src/a.py:9"]})[1] == {"kind": "trace", "path": ["src/a.py:1", "src/a.py:9"]}
good = {"file": "src/a.py", "line": 1, "summary": "g", "verdict": "CONFIRMED", "repro": {"kind": "trace", "path": ["src/a.py:1", "src/a.py:2"]}}
bare = {"file": "src/a.py", "line": 2, "summary": "b", "verdict": "CONFIRMED"}
kept = {"file": "src/a.py", "line": 3, "summary": "p", "verdict": "PLAUSIBLE"}
c = check_repros(ReplyCheck(True, findings=[good, bare, kept]), wt, rel)
assert c.downgraded == [finding_id(bare)] and list(c.repros) == [finding_id(good)]
assert bare["verdict"] == "PLAUSIBLE" and bare["downgraded_from"] == "CONFIRMED" and bare["repro_problem"]
assert kept["verdict"] == "PLAUSIBLE" and "downgraded_from" not in kept
print("ok")
`,
        tmp,
      );
      expect(out).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("state.on_gate: passing repros that cover every fixed finding skip the recheck self-check (full: to the sweep)", () => {
    const out = probe(`
from common.driver import state as sm
def fixed(tier="standard", fix=("a", "b")):
    d = sm.ensure_fields({"state": "GATE", "step": "gate", "base": "b0", "last_reviewed": "r1",
                          "after_gate": {"state": "REVIEW", "step": "recheck"},
                          "cycle": {"fix": list(fix), "range_from": "b0"}})
    return d
d = fixed(); sm.on_gate(d, [], "standard", delta_lines=10, repros_run=["a"], head="h")
assert (d["state"], d["step"], d["last_reviewed"]) == ("REVIEW", "review", "r1") and "recheck_skips" not in d
d = fixed(); sm.on_gate(d, [], "standard", delta_lines=500, repros_run=["a", "b"], head="h")
assert (d["state"], d["step"]) == ("REVIEW", "candidates")
d = fixed(fix=()); sm.on_gate(d, [], "standard", delta_lines=10, repros_run=[], head="h")
assert (d["state"], d["step"]) == ("REVIEW", "review")
d = fixed(); sm.on_gate(d, [], "standard", delta_lines=10, repros_run=["a", "b"], head="h")
assert d["state"] == "FINISH" and d["last_reviewed"] == "h" and "cycle" not in d
assert d["recheck_skips"] == [{"reason": "repros", "findings": ["a", "b"], "gate": 1}]
d = fixed("full"); sm.on_gate(d, [], "full", delta_lines=10, repros_run=["a", "b"], head="h")
assert (d["state"], d["step"]) == ("REVIEW", "sweep") and len(d["recheck_skips"]) == 1
d = fixed(); sm.on_gate(d, ["REPRO-1"], "standard", delta_lines=10, repros_run=["a", "b"], head="h")
assert (d["state"], d["step"]) == ("GATE", "decide") and d["after_gate"]["step"] == "recheck"
print("ok")
`);
    expect(out).toBe("ok");
  });

  it("lessons: rows keep task-relative exec repros; union merge; downgraded review findings are neither lessons nor CONFIRMED", () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-lessons-")),
    );
    try {
      const out = probe(
        `
import json
from pathlib import Path
from common import lessons as ls
from common.driver import finish as fin
f = {"file": "a.py", "line": 3, "summary": "  two   words ", "angle": "C", "verdict": "CONFIRMED",
     "repro": {"kind": "exec", "path": ".arbor/tasks/10-30-t/research/repro/d-3-1.sh", "command": "sh x"}}
r = ls.row(f, "10-30-t", "2026-11-03")
assert r["repro"] == "research/repro/d-3-1.sh" and r["summary"] == "two words" and r["category"] == "C", r
assert ls.row({**f, "repro": {"kind": "trace", "path": ["a:1", "b:2"]}}, "t", "d")["repro"] is None
p = Path("spec/lessons.jsonl")
assert ls.append_rows(p, [r, dict(r)]) == 1 and ls.append_rows(p, [r]) == 0 and len(ls.read_rows(p)) == 1
assert ls.ensure_union_merge(Path("spec")) and not ls.ensure_union_merge(Path("spec"))
assert Path("spec/.gitattributes").read_text() == "lessons.jsonl merge=union\\n"
rows = [{"category": "A", "task": "t1"}, {"category": "A", "task": "t2"}, {"category": "A", "task": "t2"},
        {"category": "B", "task": "t1"}, {"category": "B", "task": "t3", "check": "lint"}, {"category": "C", "task": "t1"}]
assert ls.recurring_across_tasks(rows) == [("A", ["t1", "t2"])]
assert ls.digest([{"check": "test"}]) is None
task = Path("task"); (task / "reports").mkdir(parents=True)
F = lambda line, s: {"file": "a.py", "line": line, "summary": s, "verdict": "CONFIRMED", "angle": "A"}
(task / "reports" / "d-001.md").write_text("FAIL\\n\`\`\`json\\n" + json.dumps([F(1, "kept"), F(2, "cut")]) + "\\n\`\`\`\\n")
(task / "reports" / "d-002.md").write_text("FAIL\\n\`\`\`json\\n" + json.dumps([F(5, "second")]) + "\\n\`\`\`\\n")
ds = [{"id": "d-001", "role": "review", "mode": "candidates", "status": "ok", "downgraded": ["a.py:2:cut"]},
      {"id": "d-002", "role": "review", "mode": "candidates", "status": "ok"}]
assert [x["summary"] for x in fin.confirmed_findings(task, ds)] == ["kept", "second"]
levels, angles = fin.verdict_counts(task, ds)
assert levels["3"]["CONFIRMED"] == 2 and levels["3"]["PLAUSIBLE"] == 1, levels
print("ok")
`,
        tmp,
      );
      expect(out).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("escalate: packages_touched maps paths to configured packages; maybe_escalate is one-way and lock-aware", () => {
    const out = probe(`
from common.driver.escalate import packages_touched
from common.driver import state as sm
pk = {"cli": {"path": "packages/cli"}, "docs": {"path": "./docs/"}, "root": {"path": "."}}
assert packages_touched(["packages/cli/a.ts", "docs/x.md", "README.md", "packages/cli-x/b"], pk) == ["cli", "docs"]
assert packages_touched(["a"], None) == []
def light(**meta):
    return {"meta": {"tier": "light", **meta}}
for signals, name in (({"gate_reds": 2}, "gate_reds"), ({"implement_status": "Blocked"}, "implement_blocked"),
                      ({"changed_lines": 301}, "diff_lines"), ({"packages": ["a", "b"]}, "packages")):
    d = light()
    assert sm.maybe_escalate(d, "light", {**signals, "at": "t"}) == "standard", signals
    assert d["meta"]["tier"] == "standard" and d["tier_history"][0]["signal"] == name and d["tier_history"][0]["at"] == "t"
for signals in ({"gate_reds": 1}, {"implement_status": "Complete"}, {"changed_lines": 300}, {"packages": ["a"]}, {}):
    d = light(); assert sm.maybe_escalate(d, "light", signals) is None and "tier_history" not in d, signals
for d, tier in ((light(tier_lock="true"), "light"), (light(tier_lock=True), "light"),
                ({"meta": {}, "review_deferred": True}, "light"), ({"meta": {"tier": "standard"}}, "standard"),
                ({"meta": {"tier": "full"}}, "full")):
    assert sm.maybe_escalate(d, tier, {"gate_reds": 9}) is None and "tier_history" not in d
d = light(tier_lock="no"); assert sm.maybe_escalate(d, "light", {"gate_reds": 2}) == "standard"
print("ok")
`);
    expect(out).toBe("ok");
  });
});
