/**
 * arbor.py FINISH: scorecard, merge gate, PR, cleanup after the merge
 * (worktree, archive, session pointer, journal), idempotent re-runs, and
 * `run --autopilot` from BUILD to the merge gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  FEATURE, RED_TEST, SESSION, TASK, dispatch, git, hasPython, setupFixture, writeFile, type Fixture, type Json,
} from "./v2-driver-helpers";

const BRANCH = `arbor/${TASK}`;
const finding = (file: string, line: number, verdict: string, summary = "wrong content") =>
  ({ file, line, angle: "correctness", summary, failure_scenario: "x -> y", verdict, evidence: "e", fix: "z" });
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: self-check; angles: A; single-context pass.\n`;

/**
 * Light task to FINISH: test -> implement (wrong file) -> gate red -> decide impl
 * -> fix -> gate green -> review FAIL (1 CONFIRMED) -> fix -> gate green -> review PASS.
 */
function driveToFinish(f: Fixture): void {
  f.plan({
    "d-001": { write: [RED_TEST] },
    "d-002": { write: [{ path: "src/other.txt", content: "other\n" }] },
    "d-003": { write: [FEATURE], reply: "## Fix: Done\n" },
    "d-004": { reply: reviewReply("FAIL", [finding("src/feature.txt", 1, "CONFIRMED")]) },
    "d-005": { write: [{ path: "src/feature.txt", content: "feature v2\n" }], reply: "## Fix: Done\n" },
    "d-006": { reply: reviewReply("PASS", []) },
  });
  expect(dispatch(f, "d-001").status).toBe(0);
  expect(dispatch(f, "d-002").status).toBe(0);
  expect(f.run("gate").status).toBe(1);
  expect(f.run("decide", "impl", "--reason", "implementation missed the file").status).toBe(0);
  expect(dispatch(f, "d-003").status).toBe(0);
  expect(f.run("gate").status).toBe(0);
  expect(dispatch(f, "d-004").status).toBe(0);
  expect(dispatch(f, "d-005").status).toBe(0);
  expect(f.run("gate").status).toBe(0);
  expect(dispatch(f, "d-006").status).toBe(0);
  expect(f.taskJson().state).toBe("FINISH");
}

const merge = (f: Fixture) => git(f.repo, "merge", "--no-ff", "-q", "-m", `merge ${BRANCH}`, BRANCH);
const month = () => new Date().toISOString().slice(0, 7);
const archived = (f: Fixture) => path.join(f.repo, ".arbor/tasks/archive", month(), TASK);
function journal(f: Fixture): string {
  const dir = path.join(f.repo, ".arbor/workspace/tester");
  return fs.readdirSync(dir).filter((n) => n.startsWith("journal-"))
    .map((n) => fs.readFileSync(path.join(dir, n), "utf-8")).join("\n");
}
function currentTask(f: Fixture): Json {
  const r = spawnSync("python3", [".arbor/scripts/task.py", "current", "--json"], {
    cwd: f.repo, encoding: "utf-8", env: { ...process.env, ...SESSION },
  });
  return JSON.parse(r.stdout);
}

describe.skipIf(!hasPython())("arbor.py FINISH", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("scorecard, merge gate, merge detection, cleanup to DONE", () => {
    f = setupFixture();
    driveToFinish(f);
    expect(f.next()).toMatchObject({ state: "FINISH", needs: "run", summary: expect.stringContaining("arbor finish") });

    const r = f.run("finish");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`merge (human): git -C ${f.repo} merge --no-ff ${BRANCH}`);
    expect(git(f.wt, "log", "-1", "--format=%s")).toBe(`arbor(${TASK}): scorecard`);
    const card = fs.readFileSync(path.join(f.taskDir, "scorecard.md"), "utf-8");
    expect(card).toContain("- tier: light");
    expect(card).toContain("| fix | 2 | 0 | 0 | 2 |");
    expect(card).toContain("| implement | 1 | 0 | 0 | 1 |");
    expect(card).toContain("| review | 2 | 0 | 0 | 2 |");
    expect(card).toContain("| test | 1 | 0 | 0 | 1 |");
    expect(card).toContain("- total: 6");
    expect(card).toContain("- rounds: 3");
    expect(card).toContain("| 1 | red | AC-1 |");
    expect(card).toContain("| 2 | green | none |");
    expect(card).toContain("| 3 | green | none |");
    expect(card).toContain("- review rounds: 2 (1 failed)");
    expect(card).toContain("- polish rounds: 0");
    expect(card).toContain("| 2 review | 1 | 0 | 0 |");
    expect(card).toContain("| 3 candidates + verify | 0 | 0 | 0 |");
    expect(card).toContain("- AC auto-coverage: 1/1 (100%)");
    expect(card).toContain("- overrides: 0");
    expect(card).toContain("- invariant violations: 0");
    expect(card).toContain("- worktree setup: n/a");
    expect(card).toMatch(/- total \(first dispatch start to last dispatch end\): \d+m\d\ds/);

    // idempotent before the merge: no new commit, same scorecard
    const head = git(f.wt, "rev-parse", "HEAD");
    expect(f.run("finish").status).toBe(0);
    expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);

    const waiting = f.next();
    expect(waiting).toMatchObject({
      state: "FINISH", needs: "human",
      human: { kind: "merge", command: `git -C ${f.repo} merge --no-ff ${BRANCH}`, pr_url: null },
    });
    expect(waiting.summary).toContain(".arbor/spec/");
    expect(f.run("status").stdout).toContain("finish: awaiting merge");
    expect(f.run("run").status).toBe(1); // nothing to dispatch in FINISH

    merge(f);
    const mergeSha = git(f.repo, "rev-parse", "HEAD");
    expect(f.next()).toMatchObject({ state: "FINISH", needs: "run", summary: expect.stringContaining("merged") });

    const done = f.run("finish");
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toContain(`${TASK}: DONE (merged as ${mergeSha.slice(0, 12)})`);
    expect(fs.existsSync(f.wt)).toBe(false);
    expect(git(f.repo, "branch", "--list", BRANCH)).toBe("");
    expect(fs.existsSync(path.join(f.repo, ".arbor/tasks", TASK))).toBe(false);
    const data = JSON.parse(fs.readFileSync(path.join(archived(f), "task.json"), "utf-8"));
    expect(data).toMatchObject({ state: "DONE", status: "completed" });
    expect(fs.existsSync(path.join(archived(f), "scorecard.md"))).toBe(true);
    expect(git(f.repo, "status", "--porcelain", "--", ".arbor/tasks")).toBe("");
    const entry = journal(f);
    expect(entry).toContain("Feat");
    expect(entry).toContain(mergeSha.slice(0, 7));
    expect(entry).toContain("light tier: 6 dispatches, 3 gate round(s)");
    expect(currentTask(f).current_task).toBeNull();
    expect(fs.existsSync(path.join(f.repo, ".arbor/.runtime/finish", `${TASK}.json`))).toBe(false);
    expect(f.next()).toMatchObject({ state: "INTAKE" });
  });

  it("a dirty task worktree: finish refuses and leaves everything in place", () => {
    f = setupFixture();
    driveToFinish(f);
    expect(f.run("finish").status).toBe(0);
    merge(f);
    writeFile(f.wt, "notes.txt", "uncommitted\n");
    const before = f.taskJson();
    const r = f.run("finish");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("uncommitted changes");
    expect(r.stderr).toContain("notes.txt");
    expect(fs.existsSync(f.wt)).toBe(true);
    expect(git(f.repo, "branch", "--list", BRANCH)).toContain(BRANCH);
    expect(f.taskJson()).toEqual(before);
    const merged = JSON.parse(fs.readFileSync(path.join(f.repo, ".arbor/tasks", TASK, "task.json"), "utf-8"));
    expect(merged.state).toBe("FINISH");
    expect(fs.existsSync(path.join(f.repo, ".arbor/.runtime/finish", `${TASK}.json`))).toBe(false);
    expect(currentTask(f).current_task).not.toBeNull();

    fs.rmSync(path.join(f.wt, "notes.txt"));
    expect(f.run("finish").status).toBe(0);
    expect(fs.existsSync(f.wt)).toBe(false);
  });

  it("a failed step: re-running finish continues at the first missing step", () => {
    f = setupFixture();
    driveToFinish(f);
    expect(f.run("finish").status).toBe(0);
    merge(f);
    const blocker = archived(f);
    writeFile(blocker, "keep.txt", "in the way\n");
    const r = f.run("finish");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("archive");
    expect(fs.existsSync(f.wt)).toBe(false);
    const merged = JSON.parse(fs.readFileSync(path.join(f.repo, ".arbor/tasks", TASK, "task.json"), "utf-8"));
    expect(merged.state).toBe("DONE");
    expect(f.next()).toMatchObject({ state: "FINISH", needs: "run", summary: expect.stringContaining("incomplete") });

    fs.rmSync(blocker, { recursive: true });
    const again = f.run("finish");
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain("worktree: ok");
    expect(fs.existsSync(path.join(archived(f), "task.json"))).toBe(true);
    expect(journal(f).match(/light tier: 6 dispatches/g)).toHaveLength(1);
    expect(f.run("finish").status).toBe(1); // nothing left: no active task
    expect(journal(f).match(/light tier: 6 dispatches/g)).toHaveLength(1);
  });

  it("--pr with gh: pushes the branch, opens the PR with contract + scorecard, records pr_url", () => {
    f = setupFixture();
    const origin = path.join(f.tmp, "origin.git");
    git(f.tmp, "init", "-q", "--bare", origin);
    git(f.repo, "remote", "add", "origin", origin);
    const bin = path.join(f.tmp, "bin");
    writeFile(bin, "gh", [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${f.tmp}/gh-args.txt`,
      'while [ $# -gt 0 ]; do if [ "$1" = "--body-file" ]; then cp "$2" ' + `${f.tmp}/gh-body.md; fi; shift; done`,
      "echo https://example.test/pull/7",
    ].join("\n") + "\n");
    fs.chmodSync(path.join(bin, "gh"), 0o755);
    driveToFinish(f);

    const env = { ...process.env, ...SESSION, PATH: `${bin}:${process.env.PATH}` };
    const r = spawnSync("python3", [path.join(f.repo, ".arbor/scripts/arbor.py"), "finish", "--pr"], {
      cwd: f.repo, encoding: "utf-8", env,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PR: https://example.test/pull/7");
    expect(f.taskJson().pr_url).toBe("https://example.test/pull/7");
    const args = fs.readFileSync(path.join(f.tmp, "gh-args.txt"), "utf-8").split("\n");
    expect(args.slice(0, 8)).toEqual(["pr", "create", "--base", "main", "--head", BRANCH, "--title", "Feat"]);
    const body = fs.readFileSync(path.join(f.tmp, "gh-body.md"), "utf-8");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("# Scorecard: Feat");
    // the remote carries the whole branch, pr_url commit included
    expect(git(f.repo, "ls-remote", origin, `refs/heads/${BRANCH}`).split("\t")[0]).toBe(git(f.wt, "rev-parse", "HEAD"));
    expect(git(f.wt, "status", "--porcelain")).toBe("");
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "merge", pr_url: "https://example.test/pull/7" } });

    merge(f);
    expect(f.run("finish").status).toBe(0);
    expect(fs.existsSync(path.join(archived(f), "task.json"))).toBe(true);
  });

  it("--autopilot runs a light task from BUILD to the merge gate with default briefs", () => {
    f = setupFixture();
    f.plan({ "d-001": { write: [RED_TEST] }, "d-002": { write: [FEATURE] }, "d-003": { reply: reviewReply("PASS", []) } });
    const idle = f.run("run", "--autopilot");
    expect(idle.status).toBe(0);
    expect(idle.stdout).toContain("stop, no brief");
    expect(f.taskJson().dispatches).toHaveLength(0);

    for (const role of ["test", "implement", "review"]) writeFile(f.taskDir, `briefs/default-${role}.md`, `Default ${role} brief.\n`);
    const r = f.run("run", "--autopilot");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toEqual([
      "[autopilot 1] BUILD test d-001: ok",
      "[autopilot 2] BUILD implement d-002: ok",
      "[autopilot 3] GATE: ok",
      "[autopilot 4] REVIEW review/self-check d-003: ok",
      "[autopilot 5] FINISH: ok",
      expect.stringMatching(/^\[autopilot 6\] FINISH: stop, needs human: FINISH: .*merge --no-ff/),
    ]);
    expect(fs.readFileSync(path.join(f.taskDir, "briefs/d-001.md"), "utf-8")).toBe("Default test brief.\n");
    expect(f.taskJson().state).toBe("FINISH");
    expect(fs.existsSync(path.join(f.taskDir, "scorecard.md"))).toBe(true);
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "merge" } });
  });

  it("--autopilot stops on a red gate", () => {
    f = setupFixture();
    f.plan({ "d-001": { write: [RED_TEST] }, "d-002": { write: [{ path: "src/other.txt", content: "x\n" }] } });
    for (const role of ["test", "implement"]) writeFile(f.taskDir, `briefs/default-${role}.md`, `Default ${role} brief.\n`);
    const r = f.run("run", "--autopilot");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[autopilot 3] GATE: stop, run failed");
    expect(r.stdout).toContain("failing: AC-1");
    expect(f.taskJson()).toMatchObject({ state: "GATE", step: "decide" });
  });
});
