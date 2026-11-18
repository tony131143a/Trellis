/**
 * Fixes from the 11-14-sas-ma-link run: one-line worker prompts, workers
 * whose agent never started, an older driver copy in a worktree, worktrees
 * left by an interrupted start, non-ASCII paths, rejudge and retry of a
 * cancelled node, auto checks that are prose, unknown executor settings,
 * review rounds, gates compared with the gate of the base, and an auto
 * check that restates the gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CONTRACT,
  git,
  hasPython,
  orcaCalls,
  request,
  setupProject,
  work,
  writeFile,
  type Json,
  type Project,
} from "./driver-helpers";

let p: Project;

function patchRequest(key: string, patch: (r: Json) => void): void {
  const file = path.join(
    p.repo,
    ".arbor/.runtime/workers",
    p.task,
    `${key}.json`,
  );
  const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
  patch(rec);
  fs.writeFileSync(file, JSON.stringify(rec));
}

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");

describe.skipIf(!hasPython())(
  "arbor 1.0 postmortem fixes",
  { timeout: 180_000 },
  () => {
    afterEach(() => p?.cleanup());

    it("types one line naming the spec file into the worker, whatever the brief's length", () => {
      p = setupProject();
      p.node(
        "n1",
        { paths: "[src/**]" },
        Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n"),
      );
      p.sync();
      const start = orcaCalls(p).find((c) => c[1] === "worker-start") ?? [];
      expect(start).not.toContain("--spec-file");
      const prompt = start[start.indexOf("--spec") + 1];
      expect(prompt.split("\n")).toHaveLength(1);
      const spec = request(p, "n1").spec_path as string;
      expect(prompt).toContain(spec);
      expect(fs.readFileSync(spec, "utf-8")).toContain("line 149");
    });

    it("fails a worker whose agent reported no session ten minutes after the start", () => {
      p = setupProject();
      p.plan({ a: { session: false } });
      p.node("a", { paths: "[a/**]" });
      p.node("b", { paths: "[b/**]" });
      p.sync();
      for (const key of ["a", "b"])
        patchRequest(key, (r) => (r.orca.started = minutesAgo(11)));
      const out = p.sync();
      expect(out.nodes.a.status).toBe("failed");
      expect(out.nodes.a.reason).toContain(
        "the worker did not start: its agent reported no session",
      );
      expect(
        orcaCalls(p).some(
          (c) => c[1] === "worker-stop" && c.includes("orca-a"),
        ),
      ).toBe(true);
      expect(out.nodes.b.status).toBe("running"); // its agent has a session
    });

    it("hands over to the main checkout's driver when run from a linked worktree's copy", () => {
      p = setupProject();
      const wt = path.join(p.tmp, "linked");
      git(p.repo, "worktree", "add", "-q", "--detach", wt);
      // The worktree's copy is older and broken: it must never be loaded.
      writeFile(
        wt,
        ".arbor/scripts/common/driver/sync.py",
        "raise SystemExit('old copy loaded')\n",
      );
      const res = spawnSync(
        "python3",
        [path.join(wt, ".arbor/scripts/arbor.py"), "status"],
        {
          cwd: wt,
          encoding: "utf-8",
        },
      );
      expect(res.stderr).toContain(
        `running the main checkout's driver ${path.join(p.repo, ".arbor/scripts/arbor.py")}`,
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`${p.task}: active`);
    });

    it("takes over an untouched worktree an interrupted start left, and refuses one with work", () => {
      p = setupProject();
      p.node("a", { paths: "[a/**]" });
      p.sync();
      const head = git(p.taskJson().repos["."].worktree, "rev-parse", "HEAD");
      const left = path.join(p.tmp, "left-b");
      git(
        p.repo,
        "worktree",
        "add",
        "-q",
        "-b",
        `arbor/${p.task}--b`,
        left,
        head,
      );
      p.node("b", { paths: "[b/**]" });
      let out = p.sync();
      expect(out.nodes.b.status).toBe("running");
      expect(out.nodes.b.worktree).toBe(fs.realpathSync(left));

      const dirty = path.join(p.tmp, "left-c");
      git(
        p.repo,
        "worktree",
        "add",
        "-q",
        "-b",
        `arbor/${p.task}--c`,
        dirty,
        head,
      );
      writeFile(dirty, "c/x", "x\n");
      p.node("c", { paths: "[c/**]" });
      out = p.sync();
      expect(out.nodes.c.status).toBe("pending");
      expect(out.nodes.c.start_error).toContain("with work on it");
      expect(fs.existsSync(path.join(dirty, "c/x"))).toBe(true);
    });

    it("judges paths with non-ASCII names", () => {
      p = setupProject();
      p.node("n1", { paths: "[文档/**]" });
      p.sync();
      work(p, "n1", { write: [{ path: "文档/说明.md", content: "x\n" }] });
      expect(p.sync().nodes.n1.status).toBe("merged");
    });

    it("rejudges a failed writer on its worktree and merges it once good", () => {
      p = setupProject();
      p.node("n1", { paths: "[src/**]", checks: "[AC-1]" });
      p.sync();
      work(p, "n1", { write: [{ path: "src/other.txt", content: "x\n" }] });
      const failed = p.sync().nodes.n1;
      expect(failed).toMatchObject({
        status: "failed",
        reason: "checks red: AC-1",
      });
      writeFile(failed.worktree, "src/feature.txt", "f\n");
      git(failed.worktree, "add", "-A");
      git(failed.worktree, "commit", "-q", "-m", "fix by hand");
      const out = p.ok("rejudge", "n1");
      expect(out).toContain("merged n1");
      expect(p.taskJson().nodes.n1.status).toBe("merged");
      expect(p.run("rejudge", "n1").status).toBe(1);
    });

    it("retries a cancelled node", () => {
      p = setupProject();
      p.node("n1", { paths: "[src/**]" });
      p.sync();
      p.ok("cancel", "n1");
      expect(p.ok("retry", "n1")).toContain("n1 is pending again (attempt 2)");
      expect(p.sync().nodes.n1.status).toBe("running");
    });

    it("refuses an auto check that is a description, at start and at reapprove", () => {
      const prose = CONTRACT.replace(
        "`test -f src/feature.txt`",
        "门禁全部通过",
      );
      p = setupProject({ contract: prose, start: false });
      const res = p.run("start");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(
        "AC-1 is auto but its check is not a command: `门禁全部通过` is not a program on PATH",
      );
      fs.writeFileSync(path.join(p.taskDir, "contract.md"), CONTRACT);
      p.ok("start");
      fs.writeFileSync(path.join(p.taskDir, "contract.md"), prose);
      expect(p.run("start", "--reapprove").status).toBe(1);
    });

    it("refuses an executor setting it does not know", () => {
      p = setupProject({
        executor: "    agentz:\n      write: claude\n",
        start: false,
      });
      const res = p.run("start");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("unknown setting(s) agentz");
      expect(res.stderr).toContain("`agents:` replaces the `roles:` of 0.x");
    });

    it("allows review_rounds reviews (default 1), then leaves the fixes to the main agent", () => {
      p = setupProject();
      p.node("n1", { paths: "[src/**]" });
      p.sync();
      work(p, "n1", { write: [{ path: "src/feature.txt", content: "x\n" }] });
      p.sync();
      expect(p.ok("review")).toContain(
        "note: reviewers run on codex, the agent that wrote the code",
      );
      p.sync();
      p.ok("cancel", "review-1");
      p.node("f1", { paths: "[f1/**]" });
      p.sync();
      work(p, "f1", { write: [{ path: "f1/x", content: "x\n" }] });
      const out = p.sync();
      expect(out.nodes.f1.status).toBe("merged");
      expect(p.taskJson().rounds).toBe(1); // a round per review, not per fix node
      expect(out.next.text).toContain(
        "review: no reviewer round left (executors.fake.review_rounds)",
      );
      const refused = p.run("review");
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("no reviewer round left (1 done");
      expect(p.ok("review", "--pass")).toContain("next: arbor.py finish");
    });

    it("leaves the review to the main agent with review_rounds: 0", () => {
      p = setupProject({ executor: "    review_rounds: 0\n" });
      p.node("n1", { paths: "[src/**]" });
      p.sync();
      work(p, "n1", { write: [{ path: "src/feature.txt", content: "x\n" }] });
      const out = p.sync();
      const repo = p.taskJson().repos["."];
      expect(out.next.text).toContain(
        `${repo.base.slice(0, 7)}..${repo.head.slice(0, 7)} yourself`,
      );
      expect(p.run("review").status).toBe(1);
    });

    it("blocks a gate only on failures the base did not have", () => {
      const check = String.raw`import pathlib, sys
fails = [l for l in pathlib.Path("fails.txt").read_text().split() if l] if pathlib.Path("fails.txt").exists() else []
for f in fails: print("FAILED " + f + " - AssertionError")
print("%d failed, 5 passed, %d skipped" % (len(fails), int(pathlib.Path("skips.txt").read_text()) if pathlib.Path("skips.txt").exists() else 0))
sys.exit(1 if fails else 0)
`;
      p = setupProject({
        gate: ["python3 check.py"],
        before: (repo) => {
          writeFile(repo, "check.py", check);
          writeFile(repo, "fails.txt", "tests/a.py::old\n");
          writeFile(repo, "skips.txt", "1\n");
        },
      });
      p.node("n1", { paths: "[src/**, skips.txt]" });
      p.sync();
      const waited = p.ok("sync", "--wait", "1s");
      expect(waited).toContain(`baseline . at`);
      expect(waited).toContain(
        "red before any change, on GATE-1 (1 failing tests)",
      );
      expect(
        p.taskJson().repos["."].baseline.checks["GATE-1"].failed_tests,
      ).toEqual(["tests/a.py::old"]);
      work(p, "n1", {
        write: [
          { path: "src/feature.txt", content: "f\n" },
          { path: "skips.txt", content: "3\n" },
        ],
      });
      let out = p.sync();
      expect(out.repos["."].gate).toMatchObject({ green: true, failing: [] });
      expect(out.events).toContain(
        "  GATE-1 fails only where the base fails (1 tests): not blocking",
      );
      expect(out.events).toContain("  GATE-1 skips 3 tests, 1 at the base");

      p.node("n2", { paths: "[fails.txt]" });
      p.sync();
      work(p, "n2", {
        write: [
          { path: "fails.txt", content: "tests/a.py::old\ntests/b.py::new\n" },
        ],
      });
      out = p.sync();
      expect(out.repos["."].gate).toMatchObject({
        green: false,
        failing: ["GATE-1"],
      });
      expect(out.events).toContain(
        "  GATE-1 is red at the base too; new failures: tests/b.py::new",
      );
    });

    it("runs the gate once when an auto check restates it", () => {
      const g1 = "echo one >> $(git rev-parse --git-common-dir)/runs.log";
      const g2 = "echo two >> $(git rev-parse --git-common-dir)/runs.log";
      const contract = CONTRACT.replace(
        "- AC-2:",
        "- AC-3: Given the change When the gate runs Then it passes\n- AC-2:",
      ).replace(
        "| AC-2 | manual",
        `| AC-3 | auto   | \`${g1}  &&  ${g2}\` | - |\n| AC-2 | manual`,
      );
      p = setupProject({ contract, gate: [g1, g2], start: false });
      expect(p.ok("start")).toContain(
        "note: AC-3 restates the gate of . (GATE-1, GATE-2)",
      );
      p.node("n1", { paths: "[src/**]", checks: "[AC-1, AC-3]" });
      p.sync();
      work(p, "n1", { write: [{ path: "src/feature.txt", content: "f\n" }] });
      const out = p.sync();
      expect(out.nodes.n1.status).toBe("merged");
      expect(out.repos["."].gate).toMatchObject({ green: true, failing: [] });
      expect(out.events.join("\n")).toContain(
        "- AC-3: pass  = GATE-1 && GATE-2 (the gate commands; not run again)",
      );
      // Once by the gate: not by the node's judge, not again as AC-3.
      expect(fs.readFileSync(path.join(p.repo, ".git/runs.log"), "utf-8")).toBe(
        "one\ntwo\n",
      );
    });
  },
);
