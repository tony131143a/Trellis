/**
 * arbor.py: the driver's ready set (`next --json` items / running /
 * blocked_on) over a partitioned wave, the merge-time scope check, the
 * review binding (a PASS holds only for the head it saw) and the two-level
 * merge (children merge into the parent's integration branch without a
 * human, in the same `arbor finish` run that writes their scorecard; the
 * baseline only by a human) and the parent's integration review
 * (`task.py integrate`: candidates -> fix on the integration branch).
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CONTRACT,
  IMPLEMENTED,
  SESSION,
  TASK,
  complete,
  dispatch,
  git,
  hasPython,
  orcaCalls,
  setupFixture,
  writeFile,
  type Fixture,
  type Json,
} from "./v2-driver-helpers";

const PARTITIONED = `# Feature

## Goal

Build it in parts.

## Acceptance criteria

- AC-1: Given the repo When impl lands Then src/feature.txt exists
- AC-2: Given the repo When the fixture lands Then tests/data/fixture.txt exists

## Verification map

| id   | kind | check | file |
|------|------|-------|------|
| AC-1 | auto | \`sh src/ac1.test.sh\` | src/ac1.test.sh |
| AC-2 | auto | \`sh tests/ac2.sh\` | tests/ac2.sh |

## Partitions

- impl: src/**
- tests: tests/**

## Waves

- 1: [impl, tests]
`;

const IMPL_TEST = {
  path: "src/ac1.test.sh",
  content: "test -f src/feature.txt\n",
};
const IMPL = { path: "src/feature.txt", content: "feature\n" };
const TESTS_TEST = {
  path: "tests/ac2.sh",
  content: "test -f tests/data/fixture.txt\n",
};
const TESTS_IMPL = { path: "tests/data/fixture.txt", content: "fixture\n" };

const reviewPass =
  "PASS\n\n```json\n[]\n```\nMode: self-check; angles: A; single-context pass.\n";
const partitionWt = (f: Fixture, p: string) =>
  path.join(f.tmp, "proj-wt", `${TASK}-${p}`);
const month = () => new Date().toISOString().slice(0, 7);

function ok(r: { status: number | null; stdout: string; stderr: string }) {
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

function taskPy(f: Fixture, ...args: string[]) {
  const r = spawnSync(
    "python3",
    [path.join(f.repo, ".arbor/scripts/task.py"), ...args],
    {
      cwd: f.repo,
      encoding: "utf-8",
      env: { ...process.env, ...SESSION },
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Drive a started partitioned task to the wave merge (one implement per partition). */
function driveToWaveMerge(
  f: Fixture,
  implExtra: { path: string; content: string }[] = [],
): void {
  ok(f.run("run")); // creates the partition worktrees
  f.plan({
    "d-001": { write: [IMPL_TEST, IMPL, ...implExtra] },
    "d-002": { write: [TESTS_TEST, TESTS_IMPL] },
  });
  ok(dispatch(f, "d-001", "--partition", "impl"));
  ok(dispatch(f, "d-002", "--partition", "tests"));
  expect(f.next()).toMatchObject({
    needs: "run",
    summary: expect.stringContaining("merge wave 1"),
  });
}

/** A child task created under the fixture's (unstarted) parent, ready to start. */
function createChild(f: Fixture, slug: string, contract: string): string {
  const created = taskPy(
    f,
    "create",
    `Child ${slug}`,
    "--description",
    slug,
    "--slug",
    slug,
    "--parent",
    f.taskDir,
    "--tier",
    "light",
    "--no-start",
  );
  ok(created);
  const children = f.taskJson().children as string[];
  const child = children[children.length - 1];
  const rel = `.arbor/tasks/${child}`;
  writeFile(f.repo, `${rel}/contract.md`, contract);
  const curated =
    JSON.stringify({ file: ".arbor/spec/guides/index.md", reason: "guides" }) +
    "\n";
  writeFile(f.repo, `${rel}/implement.jsonl`, curated);
  writeFile(f.repo, `${rel}/check.jsonl`, curated);
  return child;
}

const childDir = (f: Fixture, child: string) =>
  path.join(f.tmp, "proj-wt", child, ".arbor", "tasks", child);
const childJson = (f: Fixture, child: string): Json =>
  JSON.parse(
    fs.readFileSync(path.join(childDir(f, child), "task.json"), "utf-8"),
  );

/** Child to FINISH: implement -> gate, all in its own worktree; its review is deferred to the parent. */
function driveChildToFinish(
  f: Fixture,
  child: string,
  files: { path: string; content: string }[],
): void {
  const dir = childDir(f, child);
  expect(childJson(f, child).review_deferred).toBe(true);
  f.plan({ "d-001": { write: files } });
  writeFile(dir, "briefs/d-001.md", "Brief for d-001.\n");
  ok(complete(f, f.run("--task", dir, "run", "--dispatch", "d-001")));
  expect(childJson(f, child)).toMatchObject({
    state: "GATE",
    after_gate: { state: "FINISH" },
  });
  ok(f.run("--task", dir, "gate"));
  expect(childJson(f, child).state).toBe("FINISH");
}

describe.skipIf(!hasPython())(
  "arbor.py ready set and two-level merge",
  { timeout: 300_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("next --json lists every ready partition as an item, then what is running and what it waits for", () => {
      f = setupFixture({ contract: PARTITIONED, gate: ["true"] });
      ok(f.run("run"));
      let next = f.next();
      expect(next.items).toHaveLength(2);
      expect(
        next.items.map((i: Json) => [i.partition, i.role, i.dispatch]),
      ).toEqual([
        ["impl", "implement", "d-001"],
        ["tests", "implement", "d-002"],
      ]);
      expect(next.items[0].brief_path).toBe(
        path.join(f.taskDir, "briefs", "d-001.md"),
      );
      expect(next.items[1].brief_path).toBe(
        path.join(f.taskDir, "briefs", "d-002.md"),
      );
      expect(next.running).toEqual([]);
      expect(next.blocked_on).toBeUndefined();
      expect(next.summary).toContain("2 items ready");
      expect(f.run("next").stdout).toContain("ready:");

      f.plan({
        "d-001": { write: [IMPL_TEST, IMPL] },
        "d-002": { write: [TESTS_TEST, TESTS_IMPL] },
      });
      f.brief("d-001");
      f.brief("d-002");
      const impl = f.run("run", "--partition", "impl");
      const tests = f.run("run", "--partition", "tests");
      ok(impl);
      ok(tests);
      const parts = f.taskJson().partitions;
      expect(parts.impl.running).toMatchObject({
        dispatch: "d-001",
        external: true,
      });
      expect(parts.tests.running).toMatchObject({
        dispatch: "d-002",
        external: true,
      });
      // `run` started both workers: nothing is left to act on, both are running.
      next = f.next();
      expect(next.items).toEqual([]);
      expect(
        next.running
          .map((r: Json) => [r.partition, r.dispatch, r.kind, r.orca_dispatch])
          .sort(),
      ).toEqual([
        ["impl", "d-001", "worker", "orca-d-001"],
        ["tests", "d-002", "worker", "orca-d-002"],
      ]);
      expect(next.blocked_on).toBe(
        "BUILD wave 1: waiting for d-001 (impl), d-002 (tests)",
      );
      ok(complete(f, impl));
      expect(f.taskJson().partitions).toMatchObject({
        impl: { step: "done" },
        tests: { running: { dispatch: "d-002" } },
      });
      expect(f.next().blocked_on).toBe(
        "BUILD wave 1: waiting for d-002 (tests)",
      );
      ok(complete(f, tests));
      expect(f.taskJson().partitions).toMatchObject({
        impl: { step: "done" },
        tests: { step: "done" },
      });
      next = f.next();
      expect(next).toMatchObject({
        needs: "run",
        summary: expect.stringContaining("merge wave 1"),
      });
      expect(next.items.map((i: Json) => i.action)).toEqual(["merge"]);
    });

    it("a partition that changed files outside its paths does not merge: human merge_conflict, revert, resume", () => {
      f = setupFixture({ contract: PARTITIONED, gate: ["true"] });
      driveToWaveMerge(f, [
        { path: "README.md", content: "changed by impl\n" },
      ]);
      expect(f.taskJson().dispatches[0].observations).toContain(
        "implement touched files outside partition impl: README.md",
      );
      const r = f.run("run");
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(
        "partition impl changed files outside its paths",
      );
      expect(r.stdout).toContain("README.md");
      const data = f.taskJson();
      expect(data.merge_conflict).toMatchObject({
        partition: "impl",
        reason: "scope",
        files: ["README.md"],
      });
      expect(f.next()).toMatchObject({
        needs: "human",
        human: { kind: "merge_conflict" },
      });
      expect(
        git(f.wt, "log", "--merges", "--format=%s", `${data.base}..HEAD`),
      ).toBe("");

      // The user decides to revert the stray change on the partition branch.
      const impl = partitionWt(f, "impl");
      writeFile(impl, "README.md", "hi\n");
      git(impl, "commit", "-qam", `fix(${TASK}): revert README`);
      ok(f.run("resume"));
      const after = f.taskJson();
      expect(after.merge_conflict).toBeUndefined();
      expect(after.state).toBe("GATE");
      expect(
        git(f.wt, "log", "--merges", "--format=%s", `${after.base}..HEAD`)
          .split("\n")
          .reverse(),
      ).toEqual([
        `arbor(${TASK}): merge wave 1 partition impl`,
        `arbor(${TASK}): merge wave 1 partition tests`,
      ]);
      expect(fs.existsSync(impl)).toBe(false);
      ok(f.run("gate"));
      expect(f.next()).toMatchObject({
        state: "REVIEW",
        role: "review",
        mode: "self-check",
      });
    });

    it("an auto-merge needs the review to have seen the head: a product commit after PASS blocks it", () => {
      f = setupFixture({ mandate: "default" });
      fs.appendFileSync(
        path.join(f.repo, ".arbor/config.yaml"),
        "mandate:\n  light:\n    merge: auto\n",
      );
      f.plan({
        "d-001": { write: IMPLEMENTED },
        "d-002": { reply: reviewPass },
      });
      ok(dispatch(f, "d-001"));
      ok(f.run("gate"));
      ok(dispatch(f, "d-002"));
      expect(f.taskJson().state).toBe("FINISH");
      expect(f.next()).toMatchObject({
        state: "FINISH",
        needs: "run",
        summary: expect.stringContaining("scorecard"),
      });
      writeFile(f.wt, "src/late.txt", "late\n");
      git(f.wt, "add", "src/late.txt");
      git(f.wt, "commit", "-qm", `implement(${TASK}): late change`);

      // One run: scorecard, then the merge decision.
      const r = f.run("finish");
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(
        `scorecard: ${path.join(f.taskDir, "scorecard.md")}`,
      );
      expect(r.stdout).toContain("auto-merge skipped");
      expect(r.stdout).toContain("late change");
      expect(r.stdout).toContain("after the last review");
      expect(r.stdout).toContain(
        `merge (human): git -C ${f.repo} merge --no-ff arbor/${TASK}`,
      );
      expect(git(f.repo, "log", "--merges", "--format=%s", "main")).toBe("");
      expect(f.taskJson().auto_merge).toBeUndefined();
      expect(git(f.wt, "log", "-1", "--format=%s")).toBe(
        `arbor(${TASK}): scorecard`,
      );
      expect(
        fs.readFileSync(path.join(f.taskDir, "scorecard.md"), "utf-8"),
      ).toContain("## REVIEW");
      expect(f.next()).toMatchObject({
        state: "FINISH",
        needs: "human",
        human: { kind: "merge", mandate: "auto" },
      });
    });

    it("children merge into the parent's integration branch by themselves; the baseline only by a human", () => {
      f = setupFixture({ start: false });
      const mainBefore = git(f.repo, "rev-parse", "main");
      const integration = `arbor/${TASK}`;
      const landing = path.join(f.tmp, "proj-wt", TASK);

      const a = createChild(f, "childa", CONTRACT);
      const startedA = taskPy(f, "start", a);
      ok(startedA);
      expect(startedA.stdout).toContain(`Integration branch: ${integration}`);
      expect(git(landing, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        integration,
      );
      expect(f.taskJson().integration).toMatchObject({
        branch: integration,
        worktree: landing,
        base_branch: "main",
        merged: [],
      });
      // Orca creates both: the integration worktree under the main checkout,
      // the child's worktree under the integration worktree.
      const created = orcaCalls(f).filter(
        (argv) => argv.slice(0, 2).join(" ") === "worktree create",
      );
      expect(created).toEqual([
        [
          "worktree",
          "create",
          "--repo",
          `path:${f.repo}`,
          "--name",
          TASK,
          "--branch",
          integration,
          "--base-branch",
          mainBefore,
          "--parent-worktree",
          `path:${f.repo}`,
        ],
        [
          "worktree",
          "create",
          "--repo",
          `path:${f.repo}`,
          "--name",
          a,
          "--branch",
          `arbor/${a}`,
          "--base-branch",
          git(f.repo, "rev-parse", integration),
          "--parent-worktree",
          `path:${landing}`,
        ],
      ]);
      expect(childJson(f, a)).toMatchObject({
        base_branch: integration,
        base_branch_source: "integration",
        integration_target: {
          parent: TASK,
          branch: integration,
          worktree: landing,
        },
      });

      // A second child started now is cut from the same integration branch and will need a catch-up.
      const contractB = CONTRACT.replace(
        /src\/feature\.txt/g,
        "src/b.txt",
      ).replace(/tests\/ac1\.sh/g, "tests/acb.sh");
      const b = createChild(f, "childb", contractB);
      ok(taskPy(f, "start", b));
      expect(f.taskJson().integration.merged).toEqual([]);

      driveChildToFinish(f, a, IMPLEMENTED);
      expect(
        f.run("--task", childDir(f, a), "next", "--json").stdout,
      ).toContain("write the scorecard");
      const first = f.run("--task", childDir(f, a), "finish");
      ok(first);
      expect(first.stdout).toContain(
        `merged arbor/${a} into ${integration} with --no-ff (integration branch)`,
      );
      expect(first.stdout).not.toContain("merge (human)");
      expect(first.stdout).toContain(`arbor/${a} is merged: cleaning up`);
      expect(first.stdout).toContain(`${a}: DONE`);
      expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
      expect(git(landing, "log", "--merges", "-1", "--format=%s")).toBe(
        `merge arbor/${a} into ${integration}`,
      );
      expect(
        fs.existsSync(path.join(landing, ".arbor/tasks/archive", month(), a)),
      ).toBe(true);
      expect(fs.existsSync(path.join(f.tmp, "proj-wt", a))).toBe(false);
      expect(f.taskJson().integration.merged.map((m: Json) => m.task)).toEqual([
        a,
      ]);

      let view = JSON.parse(
        f.run("--task", f.taskDir, "children", "--json").stdout,
      );
      expect(view.children.map((r: Json) => [r.task, r.merged])).toEqual([
        [a, true],
        [b, false],
      ]);
      expect(view.children[1]).toMatchObject({
        merge_target: integration,
        behind: true,
      });
      expect(view.integration).toMatchObject({
        branch: integration,
        children_merged: 1,
        all_merged: false,
        merged_into_base: false,
      });

      driveChildToFinish(f, b, [
        { path: "tests/acb.sh", content: "test -f src/b.txt\n" },
        { path: "src/b.txt", content: "b\n" },
      ]);
      const mergedB = f.run("--task", childDir(f, b), "finish");
      ok(mergedB);
      expect(mergedB.stdout).toContain(`caught up with ${integration}`);
      expect(mergedB.stdout).toContain(
        `merged arbor/${b} into ${integration} with --no-ff`,
      );
      expect(mergedB.stdout).toContain(`${b}: DONE`);
      expect(
        fs.readFileSync(path.join(landing, "src/feature.txt"), "utf-8"),
      ).toBe("feature\n");
      expect(fs.readFileSync(path.join(landing, "src/b.txt"), "utf-8")).toBe(
        "b\n",
      );
      expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);

      view = JSON.parse(
        f.run("--task", f.taskDir, "children", "--json").stdout,
      );
      expect(view.integration).toMatchObject({
        children_merged: 2,
        all_merged: true,
        merged_into_base: false,
      });
      expect(view.integration.sweep_range).toBe(
        `${mainBefore}..${integration}`,
      );
      expect(f.run("--task", f.taskDir, "children").stdout).toContain(
        "then a human merges it",
      );
      const early = f.run("--task", f.taskDir, "children", "--cleanup");
      expect(early.status).toBe(1);
      expect(early.stderr).toContain(`is not merged into main yet`);

      // The human merges the integration branch into the baseline, then the parent cleans up.
      git(f.repo, "merge", "--no-ff", "--no-edit", integration);
      ok(f.run("--task", f.taskDir, "children", "--cleanup"));
      expect(fs.existsSync(landing)).toBe(false);
      expect(
        spawnSync(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${integration}`],
          { cwd: f.repo },
        ).status,
      ).not.toBe(0);
      expect(f.taskJson().integration.cleaned).toBeTruthy();
      expect(f.run("--task", f.taskDir, "children").stdout).toContain(
        "merged and cleaned up",
      );
    });

    it("starting a child of a tracked plan untracks the parent and every child before the integration branch is cut", () => {
      f = setupFixture({ start: false });
      const a = createChild(f, "childa", CONTRACT);
      const b = createChild(f, "childb", CONTRACT);
      const rels = [TASK, a, b].map((t) => `.arbor/tasks/${t}`);
      git(f.repo, "add", ...rels);
      git(f.repo, "commit", "-q", "-m", "plan");

      ok(taskPy(f, "start", a));
      expect(git(f.repo, "log", "-1", "--format=%s")).toBe(
        `chore(task): untrack ${a} task dirs before start`,
      );
      expect(git(f.repo, "ls-files", "--", ...rels)).toBe("");
      // untracked (??), never a pending deletion
      expect(
        git(f.repo, "status", "--porcelain", "--", ...rels)
          .split("\n")
          .every((line) => line.startsWith("??")),
      ).toBe(true);
      const integration = `arbor/${TASK}`;
      expect(git(f.repo, "rev-parse", integration)).toBe(
        git(f.repo, "rev-parse", "main"),
      );
      expect(fs.existsSync(path.join(f.repo, rels[2], "task.json"))).toBe(true);

      ok(taskPy(f, "start", b)); // nothing tracked any more: no second commit
      expect(git(f.repo, "rev-list", "--count", `${integration}..main`)).toBe(
        "0",
      );
    });

    it("task.py integrate: the parent reviews every merged child on the integration branch, fixes there, a human merges it", () => {
      f = setupFixture({ start: false, gate: ["true"] });
      const mainBefore = git(f.repo, "rev-parse", "main");
      const integration = `arbor/${TASK}`;
      const landing = path.join(f.tmp, "proj-wt", TASK);
      const parentDir = path.join(landing, ".arbor", "tasks", TASK);
      const parentJson = (): Json =>
        JSON.parse(fs.readFileSync(path.join(parentDir, "task.json"), "utf-8"));
      const review = (v: string, fs_: object[]) =>
        `${v}\n\n\`\`\`json\n${JSON.stringify(fs_)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;
      const finding = {
        file: "src/feature.txt",
        line: 1,
        angle: "B",
        summary: "wrong word",
        failure_scenario: "x",
        evidence: "feature",
        fix: "feature!",
      };
      const play = (id: string) => {
        writeFile(parentDir, `briefs/${id}.md`, `Brief for ${id}.\n`);
        return complete(f, f.run("--task", parentDir, "run", "--dispatch", id));
      };

      const a = createChild(f, "childa", CONTRACT);
      ok(taskPy(f, "start", a));
      // integrate waits for every child
      const early = taskPy(f, "integrate", TASK);
      expect(early.status).toBe(1);
      expect(early.stdout + early.stderr).toContain(
        "not every child is merged",
      );
      expect(
        JSON.parse(f.run("--task", f.taskDir, "next", "--json").stdout).summary,
      ).toContain("0/1 children merged");

      driveChildToFinish(f, a, IMPLEMENTED);
      ok(f.run("--task", childDir(f, a), "finish"));
      expect(f.taskJson().integration.merged.map((m: Json) => m.task)).toEqual([
        a,
      ]);
      expect(
        JSON.parse(f.run("--task", f.taskDir, "next", "--json").stdout),
      ).toMatchObject({
        needs: "run",
        summary: expect.stringContaining(`task.py integrate ${TASK}`),
      });

      // integrate: the parent takes the integration worktree and enters REVIEW/candidates over base..HEAD
      const started = taskPy(f, "integrate", TASK);
      ok(started);
      expect(started.stdout).toContain("state REVIEW/candidates");
      expect(fs.existsSync(f.taskDir)).toBe(false);
      expect(parentJson()).toMatchObject({
        status: "in_progress",
        state: "REVIEW",
        step: "candidates",
        branch: integration,
        worktree_path: landing,
        base: mainBefore,
        base_branch: "main",
        sweep_done: true,
        integration_review: true,
        meta: { tier: "standard" },
        cycle: { range_from: mainBefore },
      });
      expect(git(landing, "log", "-1", "--format=%s")).toBe(
        `integrate(${TASK}): start the integration review`,
      );
      expect(taskPy(f, "integrate", TASK).status).toBe(1); // only once
      const next = JSON.parse(f.run("--task", TASK, "next", "--json").stdout);
      expect(next).toMatchObject({
        state: "REVIEW",
        role: "review",
        mode: "candidates",
        dispatch: "d-001",
        range: `${mainBefore}..${git(landing, "rev-parse", "HEAD")}`,
      });
      expect(next.batch.map((b: Json) => b.dispatch)).toEqual([
        "d-001",
        "d-002",
      ]);

      f.plan({
        "d-001": {
          reply: review("FAIL", [
            {
              ...finding,
              verdict: "CONFIRMED",
              repro: {
                kind: "trace",
                path: ["src/feature.txt:1", "src/feature.txt:1"],
              },
            },
          ]),
        },
        "d-002": { reply: reviewPass },
        "d-003": {
          write: [{ path: "src/feature.txt", content: "feature!\n" }],
          reply: "## Fix: Done\n",
        },
        "d-004": { reply: reviewPass },
      });
      ok(play("d-001"));
      ok(play("d-002"));
      expect(parentJson()).toMatchObject({
        step: "fix",
        counters: { review: 1 },
      });
      ok(play("d-003")); // the fix lands on the integration branch itself
      expect(git(landing, "log", "-3", "--format=%s")).toContain(
        `fix(${TASK}): work`,
      );
      expect(parentJson()).toMatchObject({
        state: "GATE",
        after_gate: { state: "REVIEW", step: "recheck" },
      });
      ok(f.run("--task", parentDir, "gate"));
      expect(parentJson()).toMatchObject({ state: "REVIEW", step: "review" });
      ok(play("d-004"));
      expect(parentJson().state).toBe("FINISH");

      // FINISH: scorecard, then the human merge of the integration branch into the baseline
      const finish = f.run("--task", parentDir, "finish");
      ok(finish);
      expect(finish.stdout).toContain(`merge --no-ff ${integration}`);
      expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
      expect(fs.existsSync(path.join(parentDir, "scorecard.md"))).toBe(true);
      git(f.repo, "merge", "--no-ff", "--no-edit", integration);
      expect(
        fs.readFileSync(path.join(f.repo, "src/feature.txt"), "utf-8"),
      ).toBe("feature!\n");
      const done = f.run("--task", TASK, "finish");
      ok(done);
      expect(done.stdout).toContain(`${TASK}: DONE`);
      expect(fs.existsSync(landing)).toBe(false);
      expect(
        spawnSync(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${integration}`],
          { cwd: f.repo },
        ).status,
      ).not.toBe(0);
      const archive = path.join(f.repo, ".arbor/tasks/archive", month());
      expect(fs.existsSync(path.join(archive, TASK))).toBe(true);
      expect(fs.existsSync(path.join(archive, a))).toBe(true);
      const archived = JSON.parse(
        fs.readFileSync(path.join(archive, TASK, "task.json"), "utf-8"),
      );
      expect(archived.integration.cleaned).toBeTruthy();
      const workspace = path.join(f.repo, ".arbor/workspace/tester");
      const journal = fs
        .readdirSync(workspace)
        .filter((n) => n.startsWith("journal-"))
        .map((n) => fs.readFileSync(path.join(workspace, n), "utf-8"))
        .join("\n");
      expect(journal).toContain(`${a}:`);
    });
  },
);
