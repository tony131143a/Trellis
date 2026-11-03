/**
 * arbor.py FINISH: one `finish` before the merge (scorecard + merge command
 * or PR), merge detection, one `finish` after the merge for the cleanup
 * (worktree, archive, session pointer, journal), idempotent re-runs, and
 * `run --autopilot` from BUILD to the merge gate (handing each dispatch to
 * codeg MCP).
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  FEATURE,
  IMPLEMENTED,
  RED_TEST,
  SESSION,
  TASK,
  complete,
  dispatch,
  git,
  hasPython,
  setupFixture,
  writeFile,
  type Fixture,
  type Json,
} from "./v2-driver-helpers";

const BRANCH = `arbor/${TASK}`;
const finding = (
  file: string,
  line: number,
  verdict: string,
  summary = "wrong content",
) => ({
  file,
  line,
  angle: "correctness",
  summary,
  failure_scenario: "x -> y",
  verdict,
  evidence: "e",
  fix: "z",
});
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: self-check; angles: A; single-context pass.\n`;

/**
 * Light task to FINISH: implement (check + wrong file) -> gate red -> decide impl
 * -> fix -> gate green -> review FAIL (1 CONFIRMED) -> fix -> gate green -> review PASS.
 */
function driveToFinish(f: Fixture): void {
  f.plan({
    "d-001": {
      write: [RED_TEST, { path: "src/other.txt", content: "other\n" }],
    },
    "d-002": { write: [FEATURE], reply: "## Fix: Done\n" },
    "d-003": {
      reply: reviewReply("FAIL", [finding("src/feature.txt", 1, "CONFIRMED")]),
    },
    "d-004": {
      write: [{ path: "src/feature.txt", content: "feature v2\n" }],
      reply: "## Fix: Done\n",
    },
    "d-005": { reply: reviewReply("PASS", []) },
  });
  expect(dispatch(f, "d-001").status).toBe(0);
  expect(f.run("gate").status).toBe(1);
  expect(
    f.run("decide", "impl", "--reason", "implementation missed the file")
      .status,
  ).toBe(0);
  expect(dispatch(f, "d-002").status).toBe(0);
  expect(f.run("gate").status).toBe(0);
  expect(dispatch(f, "d-003").status).toBe(0);
  expect(dispatch(f, "d-004").status).toBe(0);
  expect(f.run("gate").status).toBe(0);
  expect(dispatch(f, "d-005").status).toBe(0);
  expect(f.taskJson().state).toBe("FINISH");
}

const merge = (f: Fixture) =>
  git(f.repo, "merge", "--no-ff", "-q", "-m", `merge ${BRANCH}`, BRANCH);
const month = () => new Date().toISOString().slice(0, 7);
const archived = (f: Fixture) =>
  path.join(f.repo, ".arbor/tasks/archive", month(), TASK);
function journal(f: Fixture): string {
  const dir = path.join(f.repo, ".arbor/workspace/tester");
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("journal-"))
    .map((n) => fs.readFileSync(path.join(dir, n), "utf-8"))
    .join("\n");
}
function currentTask(f: Fixture): Json {
  const r = spawnSync(
    "python3",
    [".arbor/scripts/task.py", "current", "--json"],
    {
      cwd: f.repo,
      encoding: "utf-8",
      env: { ...process.env, ...SESSION },
    },
  );
  return JSON.parse(r.stdout);
}

describe.skipIf(!hasPython())("arbor.py FINISH", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("scorecard + merge command in one run, merge detection, cleanup to DONE", () => {
    f = setupFixture();
    driveToFinish(f);
    expect(f.next()).toMatchObject({
      state: "FINISH",
      needs: "run",
      summary: expect.stringContaining("arbor finish"),
    });

    const r = f.run("finish");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `scorecard: ${path.join(f.taskDir, "scorecard.md")}`,
    );
    expect(r.stdout).toContain(
      `merge (human): git -C ${f.repo} merge --no-ff ${BRANCH}`,
    );
    expect(r.stdout).toContain(".arbor/spec/");
    expect(git(f.wt, "log", "-1", "--format=%s")).toBe(
      `arbor(${TASK}): scorecard`,
    );
    const card = fs.readFileSync(path.join(f.taskDir, "scorecard.md"), "utf-8");
    expect(card).toContain("- tier: light");
    expect(card).toContain("| fix | 2 | 0 | 0 | 2 |");
    expect(card).toContain("| implement | 1 | 0 | 0 | 1 |");
    expect(card).toContain("| review | 2 | 0 | 0 | 2 |");
    expect(card).not.toContain("| test |");
    expect(card).toContain("- total: 5");
    expect(card).toContain("- rounds: 3");
    expect(card).toContain("| 1 | red | AC-1 |");
    expect(card).toContain("| 2 | green | none |");
    expect(card).toContain("| 3 | green | none |");
    expect(card).toContain("## REVIEW");
    expect(card).not.toContain("POLISH");
    expect(card).toContain("- review reads: 2");
    expect(card).toContain("- fix rounds: 1");
    expect(card).toContain("| 2 review | 1 | 0 | 0 |");
    expect(card).toContain("| 3 candidates + verify | 0 | 0 | 0 |");
    expect(card).toContain("| 4 sweep | 0 | 0 | 0 |");
    expect(card).toContain("- AC auto-coverage: 1/1 (100%)");
    expect(card).toContain("- overrides: 0");
    expect(card).toContain("- invariant violations: 0");
    expect(card).toContain("- worktree setup: n/a");
    expect(card).toMatch(
      /- total \(first dispatch start to last dispatch end\): \d+m\d\ds/,
    );

    // idempotent before the merge: no new commit, same scorecard, the merge command again
    const head = git(f.wt, "rev-parse", "HEAD");
    const again = f.run("finish");
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("scorecard:");
    expect(again.stdout).toContain("merge (human)");
    expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(f.taskDir, "scorecard.md"), "utf-8")).toBe(
      card,
    );

    const waiting = f.next();
    expect(waiting).toMatchObject({
      state: "FINISH",
      needs: "human",
      human: {
        kind: "merge",
        command: `git -C ${f.repo} merge --no-ff ${BRANCH}`,
        pr_url: null,
      },
    });
    expect(waiting.summary).toContain(".arbor/spec/");
    expect(f.run("status").stdout).toContain("finish: awaiting merge");
    expect(f.run("run").status).toBe(1); // nothing to dispatch in FINISH

    merge(f);
    const mergeSha = git(f.repo, "rev-parse", "HEAD");
    expect(f.next()).toMatchObject({
      state: "FINISH",
      needs: "run",
      summary: expect.stringContaining("merged"),
    });
    expect(f.run("status").stdout).toContain("finish: merged");

    const done = f.run("finish");
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toContain(`${BRANCH} is merged: cleaning up`);
    expect(done.stdout).toContain(
      `${TASK}: DONE (merged as ${mergeSha.slice(0, 12)})`,
    );
    expect(fs.existsSync(f.wt)).toBe(false);
    expect(git(f.repo, "branch", "--list", BRANCH)).toBe("");
    expect(fs.existsSync(path.join(f.repo, ".arbor/tasks", TASK))).toBe(false);
    const data = JSON.parse(
      fs.readFileSync(path.join(archived(f), "task.json"), "utf-8"),
    );
    expect(data).toMatchObject({ state: "DONE", status: "completed" });
    expect(fs.existsSync(path.join(archived(f), "scorecard.md"))).toBe(true);
    expect(git(f.repo, "status", "--porcelain", "--", ".arbor/tasks")).toBe("");
    const entry = journal(f);
    expect(entry).toContain("Feat");
    expect(entry).toContain(mergeSha.slice(0, 7));
    expect(entry).toContain(
      "light tier: 5 dispatches, 3 gate round(s), 2 review read(s) / 1 fix round(s)",
    );
    expect(currentTask(f).current_task).toBeNull();
    expect(
      fs.existsSync(
        path.join(f.repo, ".arbor/.runtime/finish", `${TASK}.json`),
      ),
    ).toBe(false);
    expect(f.next()).toMatchObject({ state: "INTAKE" });
  });

  it("finish refuses outside FINISH; a dirty task worktree: cleanup refuses and leaves everything in place", () => {
    f = setupFixture();
    f.plan({ "d-001": { write: IMPLEMENTED } });
    expect(dispatch(f, "d-001").status).toBe(0);
    const early = f.run("finish");
    expect(early.status).toBe(1);
    expect(early.stderr).toContain("is in GATE, not FINISH");
    expect(fs.existsSync(path.join(f.taskDir, "scorecard.md"))).toBe(false);

    f.plan({ "d-002": { reply: reviewReply("PASS", []) } });
    expect(f.run("gate").status).toBe(0);
    expect(dispatch(f, "d-002").status).toBe(0);
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
    const merged = JSON.parse(
      fs.readFileSync(
        path.join(f.repo, ".arbor/tasks", TASK, "task.json"),
        "utf-8",
      ),
    );
    expect(merged.state).toBe("FINISH");
    expect(
      fs.existsSync(
        path.join(f.repo, ".arbor/.runtime/finish", `${TASK}.json`),
      ),
    ).toBe(false);
    expect(currentTask(f).current_task).not.toBeNull();

    fs.rmSync(path.join(f.wt, "notes.txt"));
    expect(f.run("finish").status).toBe(0);
    expect(fs.existsSync(f.wt)).toBe(false);
  });

  it("a failed cleanup step: re-running finish continues at the first missing step", () => {
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
    const merged = JSON.parse(
      fs.readFileSync(
        path.join(f.repo, ".arbor/tasks", TASK, "task.json"),
        "utf-8",
      ),
    );
    expect(merged.state).toBe("DONE");
    expect(f.next()).toMatchObject({
      state: "FINISH",
      needs: "run",
      summary: expect.stringContaining("incomplete"),
    });

    fs.rmSync(blocker, { recursive: true });
    const again = f.run("finish");
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain("worktree: ok");
    expect(fs.existsSync(path.join(archived(f), "task.json"))).toBe(true);
    expect(journal(f).match(/light tier: 5 dispatches/g)).toHaveLength(1);
    expect(f.run("finish").status).toBe(1); // nothing left: no active task
    expect(journal(f).match(/light tier: 5 dispatches/g)).toHaveLength(1);
  });

  it("--pr with gh: pushes the branch, opens the PR with contract + scorecard, records pr_url", () => {
    f = setupFixture();
    const origin = path.join(f.tmp, "origin.git");
    git(f.tmp, "init", "-q", "--bare", origin);
    git(f.repo, "remote", "add", "origin", origin);
    const bin = path.join(f.tmp, "bin");
    writeFile(
      bin,
      "gh",
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${f.tmp}/gh-args.txt`,
        'while [ $# -gt 0 ]; do if [ "$1" = "--body-file" ]; then cp "$2" ' +
          `${f.tmp}/gh-body.md; fi; shift; done`,
        "echo https://example.test/pull/7",
      ].join("\n") + "\n",
    );
    fs.chmodSync(path.join(bin, "gh"), 0o755);
    driveToFinish(f);

    const env = {
      ...process.env,
      ...SESSION,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const r = spawnSync(
      "python3",
      [path.join(f.repo, ".arbor/scripts/arbor.py"), "finish", "--pr"],
      {
        cwd: f.repo,
        encoding: "utf-8",
        env,
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PR: https://example.test/pull/7");
    expect(f.taskJson().pr_url).toBe("https://example.test/pull/7");
    const args = fs
      .readFileSync(path.join(f.tmp, "gh-args.txt"), "utf-8")
      .split("\n");
    expect(args.slice(0, 8)).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      BRANCH,
      "--title",
      "Feat",
    ]);
    const body = fs.readFileSync(path.join(f.tmp, "gh-body.md"), "utf-8");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("# Scorecard: Feat");
    // the remote carries the whole branch, pr_url commit included
    expect(
      git(f.repo, "ls-remote", origin, `refs/heads/${BRANCH}`).split("\t")[0],
    ).toBe(git(f.wt, "rev-parse", "HEAD"));
    expect(git(f.wt, "status", "--porcelain")).toBe("");
    expect(f.next()).toMatchObject({
      needs: "human",
      human: { kind: "merge", pr_url: "https://example.test/pull/7" },
    });
    // a re-run before the merge only repeats the PR
    const again = f.run("finish");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("PR: https://example.test/pull/7");

    merge(f);
    expect(f.run("finish").status).toBe(0);
    expect(fs.existsSync(path.join(archived(f), "task.json"))).toBe(true);
  });

  it("--autopilot runs a light task from BUILD to the merge gate with default briefs, handing each dispatch to codeg", () => {
    f = setupFixture();
    f.plan({
      "d-001": { write: IMPLEMENTED },
      "d-002": { reply: reviewReply("PASS", []) },
    });
    const idle = f.run("run", "--autopilot");
    expect(idle.status).toBe(0);
    expect(idle.stdout).toContain("stop, no brief");
    expect(f.taskJson().dispatches).toHaveLength(0);

    for (const role of ["implement", "review"])
      writeFile(
        f.taskDir,
        `briefs/default-${role}.md`,
        `Default ${role} brief.\n`,
      );
    let r = f.run("run", "--autopilot");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // the hand-off line is followed by the delegation envelope the host must play
    let lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe(
      "[autopilot 1] BUILD implement d-001: hand off to codeg MCP",
    );
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ needs: "delegation" });
    expect(
      fs.readFileSync(path.join(f.taskDir, "briefs/d-001.md"), "utf-8"),
    ).toBe("Default implement brief.\n");
    expect(f.taskJson().dispatches.map((d: Json) => [d.id, d.status])).toEqual([
      ["d-001", "running"],
    ]);
    expect(
      complete(f, { status: 0, stdout: lines[1], stderr: "" }).status,
    ).toBe(0);
    r = f.run("run", "--autopilot");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    lines = r.stdout.trim().split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "[autopilot 1] GATE: ok",
      "[autopilot 2] REVIEW review/self-check d-002: hand off to codeg MCP",
    ]);
    expect(lines).toHaveLength(3);
    expect(
      fs.readFileSync(path.join(f.taskDir, "briefs/d-002.md"), "utf-8"),
    ).toBe("Default review brief.\n");
    // `run` while a delegation is pending repeats its envelope
    expect(JSON.parse(f.run("run").stdout)).toMatchObject({
      needs: "delegation",
      request_path: JSON.parse(lines[2]).request_path,
    });
    expect(complete(f, f.run("run")).status).toBe(0);
    r = f.run("run", "--autopilot");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      "[autopilot 1] FINISH: ok",
      expect.stringMatching(
        /^\[autopilot 2\] FINISH: stop, needs human: FINISH: .*merge --no-ff/,
      ),
    ]);
    expect(f.taskJson().state).toBe("FINISH");
    expect(fs.existsSync(path.join(f.taskDir, "scorecard.md"))).toBe(true);
    expect(f.next()).toMatchObject({
      needs: "human",
      human: { kind: "merge" },
    });
  });

  it("--autopilot stops on a red gate", () => {
    f = setupFixture();
    f.plan({
      "d-001": { write: [RED_TEST, { path: "src/other.txt", content: "x\n" }] },
    });
    writeFile(
      f.taskDir,
      "briefs/default-implement.md",
      "Default implement brief.\n",
    );
    expect(f.run("run", "--autopilot").stdout).toContain(
      "[autopilot 1] BUILD implement d-001: hand off to codeg MCP",
    );
    expect(complete(f, f.run("run")).status).toBe(0);
    const r = f.run("run", "--autopilot");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[autopilot 1] GATE: stop, run failed");
    expect(r.stdout).toContain("failing: AC-1");
    expect(f.taskJson()).toMatchObject({ state: "GATE", step: "decide" });
    expect(f.run("run", "--autopilot").stdout).toContain(
      "[autopilot 1] GATE: stop, needs decide",
    );
  });
});
