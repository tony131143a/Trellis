/**
 * arbor.py v4: the driver's ready set (`next --json` items / running /
 * blocked_on), the merge-time scope check, the review binding (a PASS holds
 * only for the head it saw) and the two-level merge (children merge into the
 * parent's integration branch without a human; the baseline only by a human).
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CONTRACT, FEATURE, RED_TEST, SESSION, TASK, dispatch, git, hasPython, runAsync, setupFixture, writeFile,
  type Fixture, type Json,
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

## Interface pins

- existing interfaces

## Test paths

- tests/**/*.sh
- src/**/*.test.sh

## Partitions

- impl: src/**
- tests: tests/**

## Waves

- 1: [impl, tests]
`;

const IMPL_TEST = { path: "src/ac1.test.sh", content: "test -f src/feature.txt\n" };
const IMPL = { path: "src/feature.txt", content: "feature\n" };
const TESTS_TEST = { path: "tests/ac2.sh", content: "test -f tests/data/fixture.txt\n" };
const TESTS_IMPL = { path: "tests/data/fixture.txt", content: "fixture\n" };

const reviewPass = "PASS\n\n```json\n[]\n```\nMode: self-check; angles: A; single-context pass.\n";
const partitionWt = (f: Fixture, p: string) => path.join(f.tmp, "proj-wt", `${TASK}-${p}`);
const month = () => new Date().toISOString().slice(0, 7);

function ok(r: { status: number | null; stdout: string; stderr: string }) {
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

function taskPy(f: Fixture, ...args: string[]) {
  const r = spawnSync("python3", [path.join(f.repo, ".arbor/scripts/task.py"), ...args], {
    cwd: f.repo, encoding: "utf-8", env: { ...process.env, ...SESSION },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Drive a started partitioned task to the wave merge (test -> implement in both partitions). */
function driveToWaveMerge(f: Fixture, implExtra: { path: string; content: string }[] = []): void {
  ok(f.run("run")); // creates the partition worktrees
  f.plan({
    "d-001": { write: [IMPL_TEST] }, "d-002": { write: [TESTS_TEST] },
    "d-003": { write: [IMPL, ...implExtra] }, "d-004": { write: [TESTS_IMPL] },
  });
  for (const [id, p] of [["d-001", "impl"], ["d-002", "tests"], ["d-003", "impl"], ["d-004", "tests"]]) {
    f.brief(id);
    ok(f.run("run", "--partition", p, "--dispatch", id));
  }
  expect(f.next()).toMatchObject({ needs: "run", summary: expect.stringContaining("merge wave 1") });
}

/** A child task created under the fixture's (unstarted) parent, ready to start. */
function createChild(f: Fixture, slug: string, contract: string): string {
  const created = taskPy(f, "create", `Child ${slug}`, "--description", slug, "--slug", slug,
    "--parent", f.taskDir, "--tier", "light", "--no-start");
  ok(created);
  const children = f.taskJson().children as string[];
  const child = children[children.length - 1];
  const rel = `.arbor/tasks/${child}`;
  writeFile(f.repo, `${rel}/contract.md`, contract);
  const curated = JSON.stringify({ file: ".arbor/spec/guides/index.md", reason: "guides" }) + "\n";
  writeFile(f.repo, `${rel}/implement.jsonl`, curated);
  writeFile(f.repo, `${rel}/check.jsonl`, curated);
  return child;
}

const childDir = (f: Fixture, child: string) => path.join(f.tmp, "proj-wt", child, ".arbor", "tasks", child);
const childJson = (f: Fixture, child: string): Json =>
  JSON.parse(fs.readFileSync(path.join(childDir(f, child), "task.json"), "utf-8"));

/** Light child to FINISH: test -> implement -> gate -> review PASS, all in its own worktree. */
function driveChildToFinish(f: Fixture, child: string, test: { path: string; content: string },
                            impl: { path: string; content: string }): void {
  const dir = childDir(f, child);
  f.plan({ "d-001": { write: [test] }, "d-002": { write: [impl] }, "d-003": { reply: reviewPass } });
  for (const id of ["d-001", "d-002"]) {
    writeFile(dir, `briefs/${id}.md`, `Brief for ${id}.\n`);
    ok(f.run("--task", dir, "run", "--dispatch", id));
  }
  ok(f.run("--task", dir, "gate"));
  writeFile(dir, "briefs/d-003.md", "Brief for d-003.\n");
  ok(f.run("--task", dir, "run", "--dispatch", "d-003"));
  expect(childJson(f, child).state).toBe("FINISH");
}

describe.skipIf(!hasPython())("arbor.py v4 ready set and two-level merge", { timeout: 300_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("next --json lists every ready partition as an item, then what is running and what it waits for", async () => {
    f = setupFixture({ contract: PARTITIONED, gate: ["true"] });
    ok(f.run("run"));
    let next = f.next();
    expect(next.items).toHaveLength(2);
    expect(next.items.map((i: Json) => [i.partition, i.role, i.dispatch])).toEqual([
      ["impl", "test", "d-001"], ["tests", "test", "d-002"],
    ]);
    expect(next.items[0].brief_path).toBe(path.join(f.taskDir, "briefs", "d-001.md"));
    expect(next.items[1].brief_path).toBe(path.join(f.taskDir, "briefs", "d-002.md"));
    expect(next.running).toEqual([]);
    expect(next.blocked_on).toBeUndefined();
    expect(next.summary).toContain("2 items ready");
    expect(f.run("next").stdout).toContain("ready:");

    f.plan({ "d-001": { sleep: 4, write: [IMPL_TEST] }, "d-002": { sleep: 4, write: [TESTS_TEST] } });
    f.brief("d-001");
    f.brief("d-002");
    const runs = [runAsync(f, "run", "--partition", "impl"), runAsync(f, "run", "--partition", "tests")];
    for (let i = 0; i < 40; i++) {
      const parts = f.taskJson().partitions;
      if (parts.impl.running && parts.tests.running) break;
      sleepMs(100);
    }
    next = f.next();
    expect(next.items).toEqual([]);
    expect(next.running.map((r: Json) => [r.partition, r.dispatch, r.kind]).sort()).toEqual([
      ["impl", "d-001", "command"], ["tests", "d-002", "command"],
    ]);
    expect(next.blocked_on).toBeTruthy();
    for (const r of await Promise.all(runs)) ok(r);
    expect(f.next().items.map((i: Json) => i.role)).toEqual(["implement", "implement"]);
  });

  it("a partition that changed files outside its paths does not merge: human merge_conflict, revert, resume", () => {
    f = setupFixture({ contract: PARTITIONED, gate: ["true"] });
    driveToWaveMerge(f, [{ path: "README.md", content: "changed by impl\n" }]);
    const r = f.run("run");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("partition impl changed files outside its paths");
    expect(r.stdout).toContain("README.md");
    const data = f.taskJson();
    expect(data.merge_conflict).toMatchObject({ partition: "impl", reason: "scope", files: ["README.md"] });
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "merge_conflict" } });
    expect(git(f.wt, "log", "--merges", "--format=%s", `${data.base}..HEAD`)).toBe("");

    // The user decides to revert the stray change on the partition branch.
    const impl = partitionWt(f, "impl");
    writeFile(impl, "README.md", "hi\n");
    git(impl, "commit", "-qam", `fix(${TASK}): revert README`);
    ok(f.run("resume"));
    const after = f.taskJson();
    expect(after.merge_conflict).toBeUndefined();
    expect(after.state).toBe("GATE");
    expect(git(f.wt, "log", "--merges", "--format=%s", `${after.base}..HEAD`).split("\n").reverse()).toEqual([
      `arbor(${TASK}): merge wave 1 partition impl`, `arbor(${TASK}): merge wave 1 partition tests`,
    ]);
  });

  it("an auto-merge needs the review to have seen the head: a product commit after PASS blocks it", () => {
    f = setupFixture({ mandate: "default" });
    fs.appendFileSync(path.join(f.repo, ".arbor/config.yaml"), "mandate:\n  light:\n    merge: auto\n");
    f.plan({ "d-001": { write: [RED_TEST] }, "d-002": { write: [FEATURE] }, "d-003": { reply: reviewPass } });
    ok(dispatch(f, "d-001"));
    ok(dispatch(f, "d-002"));
    ok(f.run("gate"));
    ok(dispatch(f, "d-003"));
    expect(f.taskJson().state).toBe("FINISH");
    writeFile(f.wt, "src/late.txt", "late\n");
    git(f.wt, "add", "src/late.txt");
    git(f.wt, "commit", "-qm", `implement(${TASK}): late change`);

    ok(f.run("finish"));
    const r = f.run("finish");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("auto-merge skipped");
    expect(r.stdout).toContain("late change");
    expect(r.stdout).toContain("after the last review");
    expect(r.stdout).toContain(`merge (human): git -C ${f.repo} merge --no-ff arbor/${TASK}`);
    expect(git(f.repo, "log", "--merges", "--format=%s", "main")).toBe("");
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
    expect(git(landing, "rev-parse", "--abbrev-ref", "HEAD")).toBe(integration);
    expect(f.taskJson().integration).toMatchObject({ branch: integration, worktree: landing, base_branch: "main", merged: [] });
    expect(childJson(f, a)).toMatchObject({
      base_branch: integration, base_branch_source: "integration",
      integration_target: { parent: TASK, branch: integration, worktree: landing },
    });

    // A second child started now is cut from the same integration branch and will need a catch-up.
    const contractB = CONTRACT.replace(/src\/feature\.txt/g, "src/b.txt").replace(/tests\/ac1\.sh/g, "tests/acb.sh");
    const b = createChild(f, "childb", contractB);
    ok(taskPy(f, "start", b));
    expect(f.taskJson().integration.merged).toEqual([]);

    driveChildToFinish(f, a, RED_TEST, FEATURE);
    const first = f.run("--task", childDir(f, a), "finish");
    ok(first);
    expect(first.stdout).toContain("merge deferred");
    const second = f.run("--task", childDir(f, a), "finish");
    ok(second);
    expect(second.stdout).toContain(`merged arbor/${a} into ${integration} with --no-ff (integration branch)`);
    expect(second.stdout).not.toContain("merge (human)");
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(git(landing, "log", "--merges", "-1", "--format=%s")).toBe(`merge arbor/${a} into ${integration}`);
    expect(fs.existsSync(path.join(landing, ".arbor/tasks/archive", month(), a))).toBe(true);
    expect(fs.existsSync(path.join(f.tmp, "proj-wt", a))).toBe(false);
    expect(f.taskJson().integration.merged.map((m: Json) => m.task)).toEqual([a]);

    let view = JSON.parse(f.run("--task", f.taskDir, "children", "--json").stdout);
    expect(view.children.map((r: Json) => [r.task, r.merged])).toEqual([[a, true], [b, false]]);
    expect(view.children[1]).toMatchObject({ merge_target: integration, behind: true });
    expect(view.integration).toMatchObject({ branch: integration, children_merged: 1, all_merged: false, merged_into_base: false });

    driveChildToFinish(f, b, { path: "tests/acb.sh", content: "test -f src/b.txt\n" }, { path: "src/b.txt", content: "b\n" });
    ok(f.run("--task", childDir(f, b), "finish"));
    const mergedB = f.run("--task", childDir(f, b), "finish");
    ok(mergedB);
    expect(mergedB.stdout).toContain(`caught up with ${integration}`);
    expect(mergedB.stdout).toContain(`merged arbor/${b} into ${integration} with --no-ff`);
    expect(fs.readFileSync(path.join(landing, "src/feature.txt"), "utf-8")).toBe("feature\n");
    expect(fs.readFileSync(path.join(landing, "src/b.txt"), "utf-8")).toBe("b\n");
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);

    view = JSON.parse(f.run("--task", f.taskDir, "children", "--json").stdout);
    expect(view.integration).toMatchObject({ children_merged: 2, all_merged: true, merged_into_base: false });
    expect(view.integration.sweep_range).toBe(`${mainBefore}..${integration}`);
    expect(f.run("--task", f.taskDir, "children").stdout).toContain("then a human merges it");
    const early = f.run("--task", f.taskDir, "children", "--cleanup");
    expect(early.status).toBe(1);
    expect(early.stderr).toContain(`is not merged into main yet`);

    // The human merges the integration branch into the baseline, then the parent cleans up.
    git(f.repo, "merge", "--no-ff", "--no-edit", integration);
    ok(f.run("--task", f.taskDir, "children", "--cleanup"));
    expect(fs.existsSync(landing)).toBe(false);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${integration}`], { cwd: f.repo }).status).not.toBe(0);
    expect(f.taskJson().integration.cleaned).toBeTruthy();
    expect(f.run("--task", f.taskDir, "children").stdout).toContain("merged and cleaned up");
  });
});
