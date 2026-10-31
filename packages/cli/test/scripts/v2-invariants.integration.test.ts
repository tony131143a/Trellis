/**
 * Integration tests for `common/invariants.py`: ref snapshots and the
 * post-dispatch capability checks, run through the real `python3` and `git`.
 *
 * Each case snapshots the task worktree, plays the dispatched role's git
 * actions as a shell script, then prints `check_after_dispatch`'s violations.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/arbor/scripts",
);

const TASK = "10-30-foo";
const TASK_REL = `.arbor/tasks/${TASK}`;
const OWN = `arbor/${TASK}`;
const TEST_PATHS = ["packages/*/test/**", "**/*.test.ts"];

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Shell snippet: commit everything staged with a subject and optional trailer. */
function commit(subject: string, trailer: string | null = "Arbor-Dispatch: d-007"): string {
  const paragraphs = trailer ? [subject, "body", trailer] : [subject];
  return `git commit -q ${paragraphs.map((p) => `-m ${JSON.stringify(p)}`).join(" ")}`;
}

describe.skipIf(!hasPython())("common/invariants.py", () => {
  let tmp: string;
  let wt: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-inv-")));
    wt = path.join(tmp, "repo");
    fs.mkdirSync(path.join(wt, TASK_REL), { recursive: true });
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    git(wt, "init", "-q", "-b", OWN);
    git(wt, "config", "user.email", "t@example.com");
    git(wt, "config", "user.name", "tester");
    fs.writeFileSync(path.join(wt, "src", "a.ts"), "a\n");
    fs.writeFileSync(path.join(wt, TASK_REL, "contract.md"), "# c\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "init");
    git(wt, "branch", "main");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function check(
    role: string,
    actions: string,
    dispatchId: string | null = "d-007",
    scope = "worktree",
  ): string[] {
    const code = `
import json, subprocess, sys
sys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})
from pathlib import Path
from common.invariants import check_after_dispatch, snapshot_refs
wt = Path(".").resolve()
before = snapshot_refs(wt)
subprocess.run(sys.argv[1], shell=True, cwd=wt, check=True, capture_output=True)
print(json.dumps(check_after_dispatch(
    sys.argv[2], before, wt, own_branch=${JSON.stringify(OWN)},
    test_paths=${JSON.stringify(TEST_PATHS)}, task_rel_dir=${JSON.stringify(TASK_REL)},
    dispatch_id=sys.argv[3] or None, scope=sys.argv[4],
)))
`;
    const r = spawnSync("python3", ["-c", code, actions, role, dispatchId ?? "", scope], {
      cwd: wt,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`python failed (${r.status}): ${r.stderr}`);
    }
    return JSON.parse(r.stdout) as string[];
  }

  it("snapshot_refs records HEAD, local branches, remote refs and porcelain state", () => {
    git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
    fs.writeFileSync(path.join(wt, "new.txt"), "x\n");
    const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})
from common.invariants import snapshot_refs
s = snapshot_refs(".")
print(json.dumps({"head": s.head, "head_ref": s.head_ref, "branches": sorted(s.branches),
                  "remotes": sorted(s.remotes), "dirty": sorted(s.dirty), "clean": s.clean}))
`;
    const r = spawnSync("python3", ["-c", code], { cwd: wt, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      head: git(wt, "rev-parse", "HEAD"),
      head_ref: `refs/heads/${OWN}`,
      branches: [OWN, "main"],
      remotes: ["refs/remotes/origin/main"],
      dirty: ["new.txt"],
      clean: false,
    });
  });

  describe("read-only and research roles", () => {
    it("review that leaves the tree untouched passes", () => {
      expect(check("review", "true")).toEqual([]);
    });

    it("review that wrote a file is a violation", () => {
      const v = check("review", "echo x > src/a.ts");
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("review left the tree dirty: src/a.ts");
    });

    it("verify that committed is a violation", () => {
      const v = check("verify", `echo y > src/b.ts && git add src/b.ts && ${commit(`verify(${TASK}): x`)}`);
      expect(v.join("\n")).toContain("verify must not commit");
    });

    it("explore may write research files only", () => {
      expect(check("explore", `mkdir -p ${TASK_REL}/research && echo r > ${TASK_REL}/research/topic.md`)).toEqual([]);
      const v = check("architect", `echo r > ${TASK_REL}/design.md`);
      expect(v.join("\n")).toContain(`architect left the tree dirty: ${TASK_REL}/design.md`);
    });
  });

  describe("writer roles", () => {
    it("a well-formed implement commit outside test paths passes", () => {
      expect(
        check("implement", `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): change a`)}`),
      ).toEqual([]);
    });

    it("a writer with no new commit is a violation", () => {
      expect(check("implement", "true")).toEqual([`implement produced no new commit on ${OWN}`]);
    });

    it("implement that touched a test path is a violation", () => {
      const v = check(
        "implement",
        `echo t > src/a.test.ts && git add src/a.test.ts && ${commit(`implement(${TASK}): sneak test`)}`,
      );
      expect(v).toEqual(["implement touched test paths: src/a.test.ts"]);
    });

    it("fix touching a test path is reported with the report-listing caveat", () => {
      const v = check(
        "fix",
        `mkdir -p packages/cli/test && echo t > packages/cli/test/r.ts && git add packages && ${commit(`fix(${TASK}): regression`)}`,
      );
      expect(v).toEqual([
        "fix touched test paths (allowed only if listed in the fix report): packages/cli/test/r.ts",
      ]);
    });

    it("test that touched a non-test path is a violation; test paths alone pass", () => {
      expect(
        check("test", `echo t > src/a.test.ts && git add src/a.test.ts && ${commit(`test(${TASK}): red`)}`),
      ).toEqual([]);
      const v = check("test", `echo b > src/a.ts && git add src/a.ts && ${commit(`test(${TASK}): oops`)}`);
      expect(v).toEqual(["test touched non-test paths: src/a.ts"]);
    });

    it("a commit without the Arbor-Dispatch trailer is a violation", () => {
      const v = check(
        "implement",
        `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): change a`, null)}`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("missing 'Arbor-Dispatch: d-NNN' trailer");
    });

    it("a trailer naming another dispatch, a wrong task, a wrong role and a bad subject are violations", () => {
      const wrongId = check(
        "implement",
        `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): x`, "Arbor-Dispatch: d-008")}`,
      );
      expect(wrongId.join("\n")).toContain("trailer names d-008, expected d-007");

      const wrongTask = check("implement", `echo c > src/a.ts && git add src/a.ts && ${commit("implement(other): x")}`);
      expect(wrongTask.join("\n")).toContain(`subject task 'other' is not '${TASK}'`);

      const wrongRole = check("simplify", `echo d > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): x`)}`);
      expect(wrongRole.join("\n")).toContain("subject role 'implement' is not the dispatched role 'simplify'");

      const bad = check("implement", `echo e > src/a.ts && git add src/a.ts && ${commit("did stuff")}`);
      expect(bad.join("\n")).toContain("is not '<role>(<task>): <summary>'");
    });

    it("without a dispatch id any well-formed trailer is accepted", () => {
      expect(
        check(
          "implement",
          `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): x`, "Arbor-Dispatch: d-123")}`,
          null,
        ),
      ).toEqual([]);
    });

    it("moving the integration branch does not invalidate the task worktree", () => {
      const v = check(
        "implement",
        `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): x`)} && git branch -f main HEAD`,
      );
      expect(v).toEqual([]);
    });

    it("sibling branches may move, appear or be deleted during a dispatch", () => {
      git(wt, "branch", "arbor/other");
      git(wt, "branch", "arbor/gone");
      const v = check(
        "implement",
        `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): x`)} && git branch -f arbor/other HEAD && git branch arbor/new && git branch -D -q arbor/gone`,
      );
      expect(v).toEqual([]);
    });

    it("still rejects switching the current HEAD while ignoring unrelated refs", () => {
      git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
      const v = check(
        "implement",
        `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): x`)} && git update-ref refs/remotes/origin/main HEAD && git checkout -q -b side`,
      );
      const joined = v.join("\n");
      expect(joined).not.toContain("remote ref");
      expect(joined).not.toContain("branch side was created");
      expect(joined).toContain(`HEAD switched from refs/heads/${OWN} to refs/heads/side`);
    });

    it("repository scope retains the explicit cross-repository ref protections", () => {
      const v = check("implement",
        `echo b > src/a.ts && git add src/a.ts && ${commit(`implement(${TASK}): x`)} && git branch -f main HEAD`,
        "d-007", "repository");
      expect(v).toHaveLength(1);
      expect(v[0]).toMatch(/^branch main moved /);
    });

    it("a merge commit on the own branch is a violation", () => {
      git(wt, "checkout", "-q", "-b", "other");
      fs.writeFileSync(path.join(wt, "src", "o.ts"), "o\n");
      git(wt, "add", "src/o.ts");
      git(wt, "commit", "-q", "-m", "other");
      git(wt, "checkout", "-q", OWN);
      const merge = `git merge -q --no-ff other -m ${JSON.stringify(`implement(${TASK}): merge`)} -m "Arbor-Dispatch: d-007"`;
      const v = check("implement", merge);
      expect(v.join("\n")).toMatch(/commit [0-9a-f]{12} is a merge commit/);
    });

    it("a rewritten own branch is a violation", () => {
      fs.writeFileSync(path.join(wt, "src", "a.ts"), "second\n");
      git(wt, "commit", "-q", "-am", "second");
      const v = check("implement", "git reset -q --hard HEAD~1");
      expect(v.join("\n")).toContain(`own branch ${OWN} was rewritten`);
    });

    it("still refuses a missing current task branch", () => {
      const v = check("review", `git update-ref -d refs/heads/${OWN}`);
      expect(v).toContain(`own branch ${OWN} is missing`);
    });

    it("still refuses a worktree already on the wrong branch before dispatch", () => {
      git(wt, "checkout", "-q", "main");
      const v = check("review", "true");
      expect(v).toContain(`expected task branch ${OWN}, started on refs/heads/main`);
    });

    it("writes under .arbor/ outside the task dir are a violation", () => {
      const v = check(
        "implement",
        `mkdir -p .arbor/spec && echo s > .arbor/spec/x.md && git add .arbor && ${commit(`implement(${TASK}): x`)}`,
      );
      expect(v).toEqual([`writes under .arbor/ outside ${TASK_REL}/: .arbor/spec/x.md`]);
    });
  });

  describe("planning in a shared checkout", () => {
    it("ignores sibling task files and unrelated commits", () => {
      const v = check("explore",
        `echo b > src/b.ts && git add src/b.ts && ${commit("implement(other): work", "Arbor-Dispatch: d-007")} && mkdir -p .arbor/tasks/other && echo '{}' > .arbor/tasks/other/task.json`,
        "d-007", "task");
      expect(v).toEqual([]);
    });

    it("still rejects a commit explicitly attributed to this task outside its directory", () => {
      const v = check("explore",
        `echo b > src/b.ts && git add src/b.ts && ${commit(`explore(${TASK}): wrong`)}`,
        "d-007", "task");
      expect(v.join("\n")).toContain("explore must not commit");
    });

    it("still checks files inside the current task directory", () => {
      const v = check("explore", `echo wrong > ${TASK_REL}/design.md`, "d-007", "task");
      expect(v.join("\n")).toContain(`${TASK_REL}/design.md`);
    });

    it("does not hide another task's commit that changes the current task's files", () => {
      const v = check("review",
        `echo wrong > ${TASK_REL}/contract.md && git add ${TASK_REL}/contract.md && ${commit("implement(other): changed contract")}`,
        "d-007", "task");
      expect(v.join("\n")).toContain("review must not commit");
    });
  });

  it("changed_files lists both sides of a rename", () => {
    git(wt, "mv", "src/a.ts", "src/b.ts");
    git(wt, "commit", "-q", "-m", "rename");
    const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})
from common.invariants import changed_files
print(json.dumps(changed_files(".", "HEAD~1..HEAD")))
`;
    const r = spawnSync("python3", ["-c", code], { cwd: wt, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("_glob_match supports ** at the start, middle and end", () => {
    const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})
from common.invariants import _glob_match
p = ["packages/*/test/**", "**/*.test.ts", "docs/"]
print(json.dumps([_glob_match(x, p) for x in sys.argv[1:]]))
`;
    const cases = [
      "packages/cli/test/a/b.ts",
      "a.test.ts",
      "src/deep/x.test.ts",
      "docs/guide/x.md",
      "packages/cli/src/a.ts",
      "packages/test/x.ts",
      "src/a.test.tsx",
    ];
    const r = spawnSync("python3", ["-c", code, ...cases], { cwd: wt, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([true, true, true, true, false, false, false]);
  });
});
