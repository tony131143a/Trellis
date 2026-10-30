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
  const r = spawnSync("python3", ["-B", "-c", code], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

describe.skipIf(!hasPython())("driver modules", { timeout: 30_000 }, () => {
  it("executor: timeouts, quoting, missing executor, exit codes, timeout kill", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-exec-")));
    try {
      const out = probe(`
from pathlib import Path
from common.driver.executor import *
assert parse_timeout("90m") == 5400 and parse_timeout("30s") == 30 and parse_timeout("2h") == 7200
assert parse_timeout("45") == 45 and parse_timeout("") is None and parse_timeout(None) is None
try:
    parse_timeout("soon"); raise SystemExit("bad timeout accepted")
except ExecutorError: pass
assert build_command("x {role} {prompt} {other}", {"role": "fix", "prompt": "/a b/p.md"}) == "x fix '/a b/p.md' {other}"
for cfg in ({"executors": {"default": "nope", "x": {"command": "c"}}}, {"executors": {"default": "x", "x": {"command": ""}}}):
    try:
        resolve_executor(cfg); raise SystemExit("missing executor accepted")
    except ExecutorError: pass
assert resolve_executor({}).name == "codeg"
ex = Executor("t", "echo {role}-{dispatch}; echo err >&2", None)
r = run_executor(ex, role="review", prompt_path=Path("p"), worktree=Path("."), task="t", dispatch="d-001")
assert r.ok and r.stdout == "review-d-001\\n" and r.stderr == "err\\n", r
r = run_executor(Executor("t", "exit 3", None), role="r", prompt_path=Path("p"), worktree=Path("."), task="t", dispatch="d")
assert not r.ok and r.exit_code == 3 and r.error == "executor exited 3"
r = run_executor(Executor("t", "sleep 5", 0.3), role="r", prompt_path=Path("p"), worktree=Path("."), task="t", dispatch="d")
assert not r.ok and r.exit_code is None and "timed out" in r.error and r.duration_s < 3, r
print("ok")
`, tmp);
      expect(out).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("validate: fail-closed replies, finding ids, allowed no-commit / regression tests", () => {
    const out = probe(`
from common.driver.validate import *
J = lambda s: "\`\`\`json\\n" + s + "\\n\`\`\`"
F = '[{"file": "a.py", "line": 3, "summary": "s", "verdict": "CONFIRMED"}]'
assert not check_reply("test", "  \\n").ok and check_reply("test", "").problem == "empty reply"
c = check_reply("review", "I think it is fine\\nPASS")
assert not c.ok and c.verdict == "FAIL" and c.confidence == "low"
c = check_reply("review", "**FAIL**\\n" + J(F))
assert c.ok and c.verdict == "FAIL" and c.confidence == "high" and len(c.findings) == 1
c = check_reply("review", "PASS\\n" + J(F))
assert c.ok and c.verdict == "FAIL" and c.confidence == "low"
c = check_reply("review", "FAIL\\n" + J("{not json"))
assert c.ok and c.verdict == "FAIL" and c.confidence == "low" and c.findings == []
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
r = "## Fix: Done\\n\\n### Findings\\n1. \`a:1\` x -> skipped: false positive\\n2. \`b:2\` y -> skipped: out of scope\\n"
assert adjust_violations("fix", ["fix produced no new commit on arbor/t"], r, check_reply("fix", r)) == []
r = "## Fix: Done\\n\\n### Findings\\n1. \`a:1\` x -> fixed: z\\n\\n### Regression Tests Added\\n- tests/a.test.ts::AC-1 regression - finding 1\\n"
v = ["fix touched test paths (allowed only if listed in the fix report): tests/a.test.ts"]
assert listed_regression_tests(r) == ["tests/a.test.ts"]
assert adjust_violations("fix", v, r, check_reply("fix", r)) == []
v2 = ["fix touched test paths (allowed only if listed in the fix report): tests/a.test.ts, tests/b.test.ts"]
assert adjust_violations("fix", v2, r, check_reply("fix", r)) == v2
assert only_missing_commit(no_commit) and not only_missing_commit(no_commit + ["x"]) and not only_missing_commit([])
print("ok")
`);
    expect(out).toBe("ok");
  });

  it("validate.prefilter: file, line within the range (±5), cited rule files", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-prefilter-")));
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
      expect(JSON.parse(out)).toEqual([["near", "rule", "ac"], ["badrule", "far", "gone", "norule"]]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("state: progress rules, round caps, resume grants one more round", () => {
    const out = probe(`
from common.driver import state as sm
def gate(d, failing):  # the real flow: decide -> fix -> GATE/gate -> on_gate
    sm.goto(d, "GATE"); sm.on_gate(d, failing)
d = sm.ensure_fields({"state": "GATE", "base": "b"})
gate(d, ["AC-1", "AC-2"]); assert d["step"] == "decide" and d["counters"]["no_progress"] == 0
gate(d, ["AC-1"]);         assert d["counters"]["no_progress"] == 0          # shrank
gate(d, ["AC-2"]);         assert d["counters"]["no_progress"] == 0          # AC-1 now passes
gate(d, ["AC-2"]);         assert d["counters"]["no_progress"] == 1
gate(d, ["AC-2"]);         assert d["state"] == "STOP" and d["stop"]["reason"] == "NO_PROGRESS"
sm.resume(d); assert (d["state"], d["step"]) == ("GATE", "gate") and d["counters"]["no_progress"] == 0
d["after_gate"] = {"state": "REVIEW", "step": "review"}
sm.on_gate(d, []); assert (d["state"], d["step"]) == ("REVIEW", "review") and d["gate_reds"] == 0

g = sm.ensure_fields({"state": "GATE", "base": "b"})
for i in range(sm.GATE_RED_CAP + 1):
    gate(g, ["AC-%d" % j for j in range(10 - i)])
assert g["state"] == "STOP" and g["stop"]["reason"] == "BUDGET" and g["stop"]["counter"] == "gate"

r = sm.ensure_fields({"state": "REVIEW", "base": "b"})
sm.on_review(r, "standard", "FAIL", ["x"], "b", "h1"); assert (r["step"], r["counters"]["review"]) == ("fix", 1)
r["state"], r["step"] = "REVIEW", "review"
sm.on_review(r, "standard", "FAIL", ["y"], "h1", "h2")
assert r["state"] == "STOP" and r["stop"]["reason"] == "BUDGET" and r["stop"]["prev"] == {"state": "REVIEW", "step": "fix"}
sm.resume(r); assert (r["state"], r["step"]) == ("REVIEW", "fix") and r["caps_extra"] == {"review": 1}

l = sm.ensure_fields({"state": "REVIEW", "base": "b"})
sm.on_review(l, "light", "FAIL", ["x"], "b", "h1"); l["step"] = "review"
sm.on_review(l, "light", "FAIL", ["x"], "h1", "h2")
assert l["counters"]["no_progress"] == 1 and l["step"] == "fix"
p = sm.ensure_fields({"state": "REVIEW", "base": "b"})
sm.on_review(p, "light", "PASS", [], "b", "h"); assert p["state"] == "FINISH" and p["last_reviewed"] == "h"
s = sm.ensure_fields({"state": "REVIEW", "base": "b"})
sm.on_review(s, "full", "PASS", [], "b", "h"); assert (s["state"], s["step"]) == ("POLISH", "simplify")

# POLISH: rounds, verify batches, cap
q = sm.ensure_fields({"state": "POLISH", "base": "b", "last_reviewed": "h"})
sm.on_writer_done(q, "POLISH", "simplify", False)
assert q["step"] == "candidates" and q["polish"]["range_from"] == "b"
assert not sm.on_candidate(q, "full", "d-1", "h2") and not sm.on_candidate(q, "full", "d-2", "h2")
assert sm.on_candidate(q, "full", "d-3", "h2")
sm.on_candidates_filtered(q, ["f%d" % i for i in range(9)], "c.json")
assert q["step"] == "verify" and q["polish"]["verify_batches"] == 2 and q["last_reviewed"] == "h2"
sm.on_verify(q, ["f1"], []); assert q["step"] == "verify"
sm.on_verify(q, ["f2"], []); assert q["step"] == "fix" and q["polish"]["fix"] == ["f1", "f2"]
sm.on_writer_done(q, "POLISH", "fix", True); assert q["state"] == "GATE"
sm.on_gate(q, []); assert q["step"] == "candidates" and q["polish"]["range_from"] == "h2"
q["counters"]["polish"] = sm.POLISH_ROUND_CAP
q["state"], q["step"], q["after_gate"] = "GATE", "gate", {"state": "POLISH", "step": "candidates"}
sm.on_gate(q, []); assert q["state"] == "STOP" and q["stop"]["counter"] == "polish"

# decide / plan
x = sm.ensure_fields({"state": "BUILD", "base": "b"})
sm.on_red_check(x, [], []); assert x["step"] == "implement"
sm.on_red_check(x, ["AC-1"], []); assert sm.plan(x, "light").needs == "decide"
try:
    sm.decide(x, "fix"); raise SystemExit("fix accepted for red_check")
except sm.StateError: pass
sm.decide(x, "impl"); assert (x["state"], x["step"]) == ("BUILD", "implement")
try:
    sm.decide(x, "impl"); raise SystemExit("decide without a decision")
except sm.StateError: pass
step = sm.plan(sm.ensure_fields({"state": "BUILD", "base": "b"}), "light")
assert (step.needs, step.role, step.range_from) == ("brief", "test", "b")
assert sm.plan({"state": "FINISH"}, "light").human == {"kind": "merge"}
print("ok")
`);
    expect(out).toBe("ok");
  });

  it("gate: gate commands as GATE-n, auto map checks, red check classification; get_gate_commands", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-gate-")));
    try {
      const out = probe(`
import json
from pathlib import Path
from common.arbor_config import get_gate_commands, parse_simple_yaml
from common.contract import parse_contract
from common.driver.gate import run_gate, run_red_check
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
| AC-2 | auto | \`echo 'ImportError: no module x'; exit 1\` | |
| AC-3 | manual | look | |
""", Path("contract.md"))
g = run_gate(get_gate_commands(cfg), c, Path("."))
assert [x.id for x in g.checks] == ["GATE-1", "GATE-2", "AC-1", "AC-2"] and g.failing == ["GATE-2", "AC-2"]
red = run_red_check(c, Path("."))
assert red.passing == ["AC-1"] and red.errored == ["AC-2"] and not red.valid
print("ok")
`, tmp);
      expect(out).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
