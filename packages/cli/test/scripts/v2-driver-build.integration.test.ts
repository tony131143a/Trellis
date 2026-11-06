/**
 * arbor.py driver: `next --json`, BUILD (implement delivers code and tests),
 * GATE, `prompt --print`, results.jsonl and the task-branch commits.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CONTRACT,
  FEATURE,
  IMPLEMENTED,
  TASK,
  dispatch,
  git,
  hasPython,
  setupFixture,
  writeFile,
  type Fixture,
} from "./v2-driver-helpers";

describe.skipIf(!hasPython())(
  "arbor.py next / BUILD / GATE",
  { timeout: 90_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("next --json: BUILD asks for an implement brief with a concrete range; no brief -> run refuses", () => {
      f = setupFixture();
      const data = f.taskJson();
      const head = git(f.wt, "rev-parse", "HEAD");
      const next = f.next();
      expect(next).toMatchObject({
        task: TASK,
        state: "BUILD",
        tier: "light",
        wave: 1,
        partition: "default",
        needs: "brief",
        role: "implement",
        mode: null,
        range: `${data.base}..${head}`,
        dispatch: "d-001",
        brief_path: path.join(f.taskDir, "briefs", "d-001.md"),
        touched_files: [],
      });
      expect(next.summary).toContain("implement");

      const refused = f.run("run");
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("write the brief first");
      expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);
    });

    it.each<[string, NodeJS.ProcessEnv]>([
      ["missing identity", {}],
      ["unbound Arbor session", { ARBOR_CONTEXT_ID: "other-session" }],
      ["unbound Codex thread", { CODEX_THREAD_ID: "other-thread" }],
      ["unbound Claude session", { CLAUDE_CODE_SESSION_ID: "other-session" }],
    ])(
      "does not borrow another session's sole task: %s",
      (_label, identity) => {
        f = setupFixture();
        const env = { ...process.env };
        delete env.ARBOR_CONTEXT_ID;
        delete env.CODEX_THREAD_ID;
        delete env.CLAUDE_CODE_SESSION_ID;
        Object.assign(env, identity);
        const run = (...args: string[]) =>
          spawnSync(
            "python3",
            [path.join(f.repo, ".arbor/scripts/arbor.py"), ...args],
            { cwd: f.repo, encoding: "utf-8", env },
          );
        const before = f.taskJson();
        const head = git(f.wt, "rev-parse", "HEAD");

        const none = run("next", "--json");
        expect(none.status, none.stdout + none.stderr).toBe(0);
        expect(JSON.parse(none.stdout)).toMatchObject({
          task: null,
          state: "INTAKE",
          needs: "human",
          started: false,
        });

        const refused = run(
          "override",
          "--role",
          "implement",
          "--reason",
          "session isolation probe",
        );
        expect(refused.status, refused.stdout + refused.stderr).toBe(1);
        expect(refused.stderr).toContain("no active task");
        expect(f.taskJson()).toEqual(before);
        expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);

        // The owning session and an explicit --task still resolve the task.
        expect(f.next()).toMatchObject({ task: TASK, state: "BUILD" });
        const explicit = run("--task", f.taskDir, "next", "--json");
        expect(explicit.status, explicit.stdout + explicit.stderr).toBe(0);
        expect(JSON.parse(explicit.stdout)).toMatchObject({
          task: TASK,
          state: "BUILD",
        });
      },
    );

    it("next --json for an explicitly selected task still in planning", () => {
      f = setupFixture();
      writeFile(
        f.repo,
        ".arbor/tasks/10-30-plan/task.json",
        JSON.stringify({ id: "plan", status: "planning" }),
      );
      const planning = f.run(
        "--task",
        ".arbor/tasks/10-30-plan",
        "next",
        "--json",
      );
      expect(JSON.parse(planning.stdout)).toEqual({
        task: "10-30-plan",
        state: "CONTRACT",
        needs: "human",
        started: false,
        human: { kind: "approve_contract", mandate: "ask" },
        dispatch: "d-001",
        brief_path: path.join(
          f.repo,
          ".arbor/tasks/10-30-plan/briefs/d-001.md",
        ),
        contract_roles: ["explore", "architect", "review"],
        summary: expect.stringContaining("task.py start"),
      });
    });

    it("implement -> gate green -> REVIEW; prompts, reports, commits, results", () => {
      f = setupFixture({ gate: ["true"] });
      const base = f.taskJson().base;
      f.plan({ "d-001": { write: IMPLEMENTED } });

      const t = dispatch(f, "d-001");
      expect(t.status, t.stdout + t.stderr).toBe(0);
      let data = f.taskJson();
      expect(data.dispatches[0]).toMatchObject({
        id: "d-001",
        role: "implement",
        status: "ok",
      });
      expect(data.state).toBe("GATE");
      const report = fs.readFileSync(
        path.join(f.taskDir, "reports/d-001.md"),
        "utf-8",
      );
      expect(report).toContain("## Implementation Complete");

      // the prompt sent is reproducible byte for byte
      const printed = f.run("prompt", "--dispatch", "d-001", "--print");
      expect(printed.status).toBe(0);
      const received = fs.readFileSync(
        path.join(f.tmp, "received/d-001.md"),
        "utf-8",
      );
      expect(printed.stdout).toBe(received);
      expect(received).toMatch(
        new RegExp(
          `^Active task: ${f.taskDir}\nRole: implement\nRange: ${base}\\.\\.[0-9a-f]{40}\nDispatch: d-001\n`,
        ),
      );
      expect(received).toContain("Brief for d-001.");

      expect(f.next()).toMatchObject({
        state: "GATE",
        needs: "run",
        touched_files: ["src/feature.txt", "tests/ac1.sh"],
      });
      const gate = f.run("gate");
      expect(gate.status, gate.stdout).toBe(0);
      expect(gate.stdout).toContain("gate green");
      data = f.taskJson();
      expect(data.state).toBe("REVIEW");
      expect(data.counters.gate).toBe(1);
      expect(f.next()).toMatchObject({
        role: "review",
        mode: "self-check",
        dispatch: "d-002",
      });

      // task branch: brief / role / result commits, nothing left dirty
      const subjects = git(f.wt, "log", "--format=%s", `${base}..HEAD`)
        .split("\n")
        .reverse();
      expect(subjects).toEqual([
        `contract(${TASK}): approve contract`,
        `arbor(${TASK}): d-001 implement brief`,
        `implement(${TASK}): work`,
        `arbor(${TASK}): d-001 implement ok`,
      ]);
      expect(git(f.wt, "status", "--porcelain", "--", "src", "tests")).toBe("");

      const rows = f.results();
      expect(rows.map((r) => [r.dispatch, r.role, r.status])).toEqual([
        ["d-001", "implement", "ok"],
      ]);
      expect(Object.keys(rows[0]).sort()).toEqual([
        "commit",
        "dispatch",
        "duration_s",
        "ended",
        "executor",
        "exit_code",
        "mode",
        "partition",
        "role",
        "started",
        "state",
        "status",
        "task",
        "ts",
        "violations",
        "wave",
      ]);
      expect(rows[0]).toMatchObject({
        executor: "fake",
        exit_code: 0,
        state: "BUILD",
        wave: 1,
        violations: [],
      });
      expect(rows[0].commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it("implement Blocked or without a commit waits for the main agent; retries count toward NO_PROGRESS", () => {
      f = setupFixture({ tier: "standard" });
      f.plan({
        "d-001": { write: IMPLEMENTED, reply: "## Implementation Blocked\n" },
        "d-002": {}, // Complete, but no commit
        "d-003": { write: [{ path: "src/more.txt", content: "more\n" }] },
      });
      for (const id of ["d-001", "d-002"]) {
        expect(dispatch(f, id).status).toBe(0);
        expect(f.taskJson().state).toBe("BUILD");
        expect(f.taskJson().report_pending).toHaveProperty(id);
        expect(f.next()).toMatchObject({
          needs: "decide",
          decision: { kind: "report", dispatch: id },
        });
        expect(f.run("decide", "retry", "--reason", "re-brief").status).toBe(0);
      }
      // two retries without progress: STOP(NO_PROGRESS), resume grants another round
      expect(f.taskJson()).toMatchObject({
        state: "STOP",
        stop: { reason: "NO_PROGRESS" },
      });
      expect(f.run("resume").status).toBe(0);
      expect(f.next()).toMatchObject({ needs: "brief", role: "implement" });
      expect(dispatch(f, "d-003").status).toBe(0);
      expect(f.taskJson()).toMatchObject({ state: "GATE", step: "gate" });
      expect(f.run("gate").stdout).not.toContain("warning:");
    });

    it("resume re-approves a contract edited after start, in place", () => {
      f = setupFixture();
      fs.appendFileSync(
        path.join(f.taskDir, "contract.md"),
        "\n<!-- clarified -->\n",
      );
      expect(JSON.stringify(f.next().observations)).toContain(
        "differs from the recorded approval",
      );
      const r = f.run("resume");
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("contract re-approved in place");
      expect(f.taskJson().state).toBe("BUILD");
      expect(f.taskJson().decisions.at(-1)).toMatchObject({
        kind: "contract",
        choice: "re-approve",
      });
      expect(f.next().observations).toBeUndefined();
    });

    it("next refuses a started task whose contract no longer parses instead of falling back to default", () => {
      f = setupFixture();
      fs.appendFileSync(
        path.join(f.taskDir, "contract.md"),
        "\n## Partitions\n\n- impl:\n",
      );
      const r = f.run("next");
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toContain("contract.md does not parse");
    });

    it("the gate warns when an auto check's file is unchanged since the task base", () => {
      f = setupFixture();
      f.plan({ "d-001": { write: [FEATURE] } }); // the feature without its AC-1 test
      expect(dispatch(f, "d-001").status).toBe(0);
      const gate = f.run("gate");
      expect(gate.stdout).toContain(
        "warning: AC-1: `tests/ac1.sh` is unchanged since the task base",
      );
    });

    it("the gate warns when no test and no selector names the criterion id", () => {
      f = setupFixture({
        contract: CONTRACT.replaceAll("tests/ac1.sh", "tests/check.sh"),
      });
      const check = {
        path: "tests/check.sh",
        content: "test -f src/feature.txt\n",
      };
      f.plan({ "d-001": { write: [check, FEATURE] } });
      expect(dispatch(f, "d-001").status).toBe(0);
      const gate = f.run("gate");
      expect(gate.status).toBe(0);
      expect(gate.stdout).toContain(
        "warning: AC-1: no test in `tests/check.sh` names AC-1",
      );
    });

    it("GATE red -> decide contract -> CONTRACT -> resume re-runs the gate", () => {
      f = setupFixture({ gate: ["exit 3"] });
      f.plan({ "d-001": { write: IMPLEMENTED } });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.run("gate").status).toBe(1);
      expect(f.next()).toMatchObject({
        state: "GATE",
        needs: "decide",
        decision: {
          kind: "gate_red",
          options: ["impl", "contract"],
          failing: ["GATE-1"],
        },
      });
      expect(f.run("decide", "tests", "--reason", "gone in v5").status).toBe(2);

      expect(
        f.run("decide", "contract", "--reason", "the criterion is wrong")
          .status,
      ).toBe(0);
      expect(f.next()).toMatchObject({
        state: "CONTRACT",
        needs: "human",
        human: { kind: "approve_contract" },
      });
      const contract = path.join(f.taskDir, "contract.md");
      fs.appendFileSync(contract, "\n<!-- revised -->\n");
      const resumed = f.run("resume");
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      const data = f.taskJson();
      expect(data.state).toBe("GATE");
      expect(data.step).toBe("gate");
      expect(data.decisions[0]).toMatchObject({
        kind: "gate_red",
        choice: "contract",
      });
      expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
      expect(git(f.wt, "log", "-1", "--format=%s")).toBe(
        `contract(${TASK}): re-approve contract`,
      );
    });

    it("GATE red -> decide impl -> fix; two rounds without progress -> STOP, resume -> decide again", () => {
      f = setupFixture({ gate: ["exit 3"] });
      f.plan({
        "d-001": { write: IMPLEMENTED },
        "d-002": { write: [{ path: "src/a.txt", content: "1\n" }] },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      const red = f.run("gate");
      expect(red.status).toBe(1);
      expect(red.stdout).toContain("failing: GATE-1");
      expect(f.next()).toMatchObject({
        state: "GATE",
        needs: "decide",
        decision: { kind: "gate_red", failing: ["GATE-1"] },
      });
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/gate-1.md"), "utf-8"),
      ).toContain("failing: GATE-1");
      expect(
        f.run("decide", "impl", "--reason", "lint is an impl bug").status,
      ).toBe(0);
      expect(f.next()).toMatchObject({
        state: "GATE",
        role: "fix",
        dispatch: "d-002",
      });
      expect(dispatch(f, "d-002").status).toBe(0);
      expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
      // `run` in GATE runs the gate
      expect(f.run("run").status).toBe(1);
      let data = f.taskJson();
      expect(data.counters).toMatchObject({ gate: 2, no_progress: 1 });
      expect(data.step).toBe("decide");
      expect(f.run("decide", "impl", "--reason", "retry").status).toBe(0);
      expect(f.next()).toMatchObject({ role: "fix", dispatch: "d-003" });
      f.run("override", "--reason", "skip the fix", "--to", "GATE/gate");
      expect(f.run("gate").status).toBe(1);
      data = f.taskJson();
      expect(data.state).toBe("STOP"); // the second round without progress
      expect(data.stop).toMatchObject({
        reason: "NO_PROGRESS",
        prev: { state: "GATE", step: "decide" },
      });
      expect(data.counters.no_progress).toBe(2);
      expect(f.next()).toMatchObject({
        needs: "human",
        human: { kind: "stop" },
      });
      expect(f.run("resume").status).toBe(0);
      expect(f.next()).toMatchObject({
        needs: "decide",
        decision: { kind: "gate_red" },
      });
      expect(
        f.run("decide", "impl", "--reason", "continue with a different fix")
          .status,
      ).toBe(0);
      expect(f.taskJson()).toMatchObject({ state: "GATE", step: "fix" });
      expect(f.taskJson().overrides).toHaveLength(1);
    });

    describe("light -> standard escalation", () => {
      it("an implement report Partial escalates; the green gate enters candidates with two readers", () => {
        f = setupFixture();
        f.plan({
          "d-001": { write: IMPLEMENTED, reply: "## Implementation Partial\n" },
        });
        expect(dispatch(f, "d-001").status).toBe(0);
        let data = f.taskJson();
        expect(data.meta.tier).toBe("standard");
        expect(data.tier_history).toEqual([
          expect.objectContaining({
            from: "light",
            to: "standard",
            signal: "implement_partial",
            detail: "implement reported Partial",
          }),
        ]);
        expect(data.dispatches[0].verdict).toBe("Partial");
        expect(f.run("gate").status).toBe(0);
        data = f.taskJson();
        expect(data).toMatchObject({ state: "REVIEW", step: "candidates" });
        const next = f.next();
        expect(next).toMatchObject({
          tier: "standard",
          mode: "candidates",
          escalated: { signal: "implement_partial" },
        });
        expect(next.batch).toHaveLength(2);
        expect(f.run("status").stdout).toContain(
          "escalated: light -> standard (implement reported Partial",
        );
      });

      it("a diff over 300 lines escalates at the BUILD gate", () => {
        f = setupFixture();
        f.plan({
          "d-001": {
            write: [
              ...IMPLEMENTED,
              { path: "src/big.txt", content: "x\n".repeat(320) },
            ],
          },
        });
        expect(dispatch(f, "d-001").status).toBe(0);
        expect(f.taskJson().meta.tier).toBe("light");
        const gate = f.run("gate");
        expect(gate.status).toBe(0);
        expect(gate.stdout).toContain(
          "tier: light -> standard (322 changed lines (> 300))",
        );
        expect(f.taskJson()).toMatchObject({
          state: "REVIEW",
          step: "candidates",
          meta: { tier: "standard" },
          tier_history: [expect.objectContaining({ signal: "diff_lines" })],
        });
      });

      it("changes in two configured packages escalate at the BUILD gate", () => {
        f = setupFixture();
        fs.appendFileSync(
          path.join(f.repo, ".arbor/config.yaml"),
          "packages:\n  a:\n    path: pkg-a\n  b:\n    path: ./pkg-b/\ndefault_package: a\n",
        );
        f.plan({
          "d-001": {
            write: [
              ...IMPLEMENTED,
              { path: "pkg-a/x.txt", content: "x\n" },
              { path: "pkg-b/y.txt", content: "y\n" },
            ],
          },
        });
        expect(dispatch(f, "d-001").status).toBe(0);
        expect(f.run("gate").status).toBe(0);
        expect(f.taskJson()).toMatchObject({
          state: "REVIEW",
          step: "candidates",
          tier_history: [
            expect.objectContaining({
              signal: "packages",
              detail: "changes span packages a, b",
            }),
          ],
        });
      });

      it("a small single-package light task stays light and enters the self-check", () => {
        f = setupFixture();
        f.plan({ "d-001": { write: IMPLEMENTED } });
        expect(dispatch(f, "d-001").status).toBe(0);
        expect(f.run("gate").status).toBe(0);
        const data = f.taskJson();
        expect(data).toMatchObject({ state: "REVIEW", step: "review" });
        expect(data.tier_history).toBeUndefined();
        expect(f.next().escalated).toBeUndefined();
      });

      it("meta.tier_lock keeps a light task light; a standard task never records tier_history", () => {
        f = setupFixture();
        const r = spawnSync(
          "python3",
          [
            ".arbor/scripts/task.py",
            "set-meta",
            f.taskDir,
            "tier_lock",
            "true",
          ],
          { cwd: f.repo, encoding: "utf-8" },
        );
        expect(r.status, r.stdout + r.stderr).toBe(0);
        f.plan({
          "d-001": { write: IMPLEMENTED, reply: "## Implementation Blocked\n" },
        });
        expect(dispatch(f, "d-001").status).toBe(0);
        expect(f.taskJson().meta).toMatchObject({
          tier: "light",
          tier_lock: "true",
        });
        expect(f.taskJson().tier_history).toBeUndefined();
        f.cleanup();

        f = setupFixture({ tier: "standard" });
        f.plan({
          "d-001": { write: IMPLEMENTED, reply: "## Implementation Partial\n" },
        });
        expect(dispatch(f, "d-001").status).toBe(0);
        expect(f.taskJson().tier_history).toBeUndefined();
      });
    });
  },
);
