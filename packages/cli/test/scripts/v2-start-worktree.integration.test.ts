/**
 * Integration tests for the v2 git model in `task.py`:
 *   - `start` (default): contract required, task worktree + branch, task dir
 *     moved and committed there, v2 task.json fields, absolute session pointer
 *   - `start --no-worktree`: the v1 behaviour
 *   - `create` writing contract.md
 *   - `archive` of a task that lives in its worktree
 *   - `active_task` / `paths` accepting task dirs in registered worktrees
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/arbor/scripts",
);

const TASK = "10-30-foo";
const SESSION = { ARBOR_CONTEXT_ID: "v2-start-session" };
const CURATED_ROW =
  JSON.stringify({ file: ".arbor/spec/guides/index.md", reason: "guides" }) + "\n";

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

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

function runTask(repo: string, args: string[], env: Record<string, string> = SESSION) {
  return spawnSync("python3", [".arbor/scripts/task.py", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

describe.skipIf(!hasPython())("task.py start in a worktree (v2)", () => {
  let tmp: string;
  let repo: string;
  let wt: string;
  let wtTask: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-start-")));
    repo = path.join(tmp, "proj");
    wt = path.join(tmp, "proj-wt", TASK);
    wtTask = path.join(wt, ".arbor", "tasks", TASK);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "tester");
    writeFile(repo, "README.md", "hi\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(repo, ".arbor", "scripts"), { recursive: true });
    writeFile(repo, ".arbor/spec/guides/index.md", "# Guides\n");
    const r = spawnSync("python3", [".arbor/scripts/init_developer.py", "tester"], {
      cwd: repo,
      encoding: "utf-8",
    });
    if (r.status !== 0) throw new Error(`init_developer failed: ${r.stderr}`);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A planning task with curated manifests; `contract` false = none at all. */
  function makeTask(contract = true): string {
    const rel = `.arbor/tasks/${TASK}`;
    writeFile(
      repo,
      `${rel}/task.json`,
      JSON.stringify({ id: "foo", name: "foo", title: "Foo", status: "planning", children: [], meta: {} }) + "\n",
    );
    if (contract) {
      writeFile(repo, `${rel}/contract.md`, "# Foo\n\n## Goal\n\nDo foo.\n");
      // The light-tier gate (common/tasks.py) still names prd.md until the
      // contract partition renames its artifacts.
      writeFile(repo, `${rel}/prd.md`, "# Foo\n");
    }
    writeFile(repo, `${rel}/implement.jsonl`, CURATED_ROW);
    writeFile(repo, `${rel}/check.jsonl`, CURATED_ROW);
    return rel;
  }

  function readJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  }

  it("creates arbor/<task> + worktree, moves and commits the task dir, writes the v2 fields", () => {
    const rel = makeTask();
    const base = git(repo, "rev-parse", "HEAD");
    const contractBytes = fs.readFileSync(path.join(repo, rel, "contract.md"));

    const r = runTask(repo, ["start", TASK]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Current task set to: ${wtTask}`);

    // moved, not copied
    expect(fs.existsSync(path.join(repo, rel))).toBe(false);
    expect(fs.existsSync(path.join(wtTask, "contract.md"))).toBe(true);
    expect(git(wt, "branch", "--show-current")).toBe(`arbor/${TASK}`);

    // one commit on the task branch, task dir only, no trailer
    expect(git(wt, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
    expect(git(wt, "log", "-1", "--format=%B")).toBe(`contract(${TASK}): approve contract`);
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(
      ["check.jsonl", "contract.md", "implement.jsonl", "prd.md", "task.json"].map(
        (f) => `.arbor/tasks/${TASK}/${f}`,
      ),
    );
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);

    const data = readJson(path.join(wtTask, "task.json"));
    expect(data).toMatchObject({
      status: "in_progress",
      state: "BUILD",
      wave: 1,
      base,
      branch: `arbor/${TASK}`,
      base_branch: "main",
      worktree_path: wt,
      contract_hash: createHash("sha256").update(contractBytes).digest("hex"),
      counters: { gate: 0, review: 0, polish: 0, no_progress: 0 },
      dispatches: [],
    });

    // the pointer is the absolute task dir in the worktree
    const current = runTask(repo, ["current"]);
    expect(current.status).toBe(0);
    expect(current.stdout.trim()).toBe(wtTask);
    const json = JSON.parse(runTask(repo, ["current", "--json"]).stdout);
    expect(json.current_task).toMatchObject({ dir: wtTask, status: "in_progress", branch: `arbor/${TASK}` });
    expect(json.stale).toBe(false);
  });

  it("refuses without a contract and leaves everything in place", () => {
    const rel = makeTask(false);
    const r = runTask(repo, ["start", TASK]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("has no contract.md");
    expect(r.stdout).toContain("--no-worktree");
    expect(fs.existsSync(path.join(repo, rel, "task.json"))).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, "branch", "--list", "arbor/*")).toBe("");
    expect(readJson(path.join(repo, rel, "task.json")).status).toBe("planning");
  });

  it("refuses a tracked task dir unless --force-move", () => {
    const rel = makeTask();
    git(repo, "add", rel);
    git(repo, "commit", "-q", "-m", "track task");

    const refused = runTask(repo, ["start", TASK]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain(`file(s) under ${rel} are tracked`);
    expect(refused.stdout).toContain("--force-move");
    expect(fs.existsSync(wt)).toBe(false);

    writeFile(repo, `${rel}/contract.md`, "# Foo\n\n## Goal\n\nEdited after tracking.\n");
    const forced = runTask(repo, ["start", TASK, "--force-move"]);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(forced.stdout).toContain("shows it as deleted");
    expect(fs.existsSync(path.join(repo, rel))).toBe(false);
    // the working copy (with the edit) is what lands on the task branch
    expect(git(wt, "show", `HEAD:${rel}/contract.md`)).toContain("Edited after tracking.");
    expect(readJson(path.join(wtTask, "task.json")).state).toBe("BUILD");
  });

  it("runs worktree.setup under a configured root; a failing setup rolls the start back", () => {
    const rel = makeTask();
    writeFile(repo, ".arbor/config.yaml", 'worktree:\n  root: "../trees"\n  setup: "echo setup-tail-line; exit 7"\n');
    const originalJson = fs.readFileSync(path.join(repo, rel, "task.json"), "utf-8");

    const failed = runTask(repo, ["start", TASK]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("worktree.setup exited 7");
    expect(failed.stderr).toContain("setup-tail-line");
    expect(failed.stdout).toContain("start rolled back");
    expect(fs.readFileSync(path.join(repo, rel, "task.json"), "utf-8")).toBe(originalJson);
    expect(fs.existsSync(path.join(tmp, "trees", TASK))).toBe(false);
    expect(git(repo, "branch", "--list", "arbor/*")).toBe("");
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("trees");

    writeFile(repo, ".arbor/config.yaml", 'worktree:\n  root: "../trees"\n  setup: "touch setup-ran"\n');
    const ok = runTask(repo, ["start", TASK]);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(fs.existsSync(path.join(tmp, "trees", TASK, "setup-ran"))).toBe(true);
  });

  it("--no-worktree keeps the v1 behaviour", () => {
    const rel = makeTask();
    const r = runTask(repo, ["start", TASK, "--no-worktree"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Current task set to: ${rel}`);
    expect(fs.existsSync(wt)).toBe(false);
    const data = readJson(path.join(repo, rel, "task.json"));
    expect(data.status).toBe("in_progress");
    expect(data.branch).toBe("main");
    expect(data.state).toBeUndefined();
    expect(runTask(repo, ["current"]).stdout.trim()).toBe(rel);
  });

  it("re-starting by the absolute worktree path only re-points the session", () => {
    makeTask();
    expect(runTask(repo, ["start", TASK]).status).toBe(0);
    const head = git(wt, "rev-parse", "HEAD");

    const other = { ARBOR_CONTEXT_ID: "second-session" };
    const r = runTask(repo, ["start", wtTask], other);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(runTask(repo, ["current"], other).stdout.trim()).toBe(wtTask);
    expect(git(wt, "rev-parse", "HEAD")).toBe(head);
  });

  it("archive finds a task that lives in its worktree and clears the session pointer", () => {
    makeTask();
    expect(runTask(repo, ["start", TASK]).status).toBe(0);

    const r = runTask(repo, ["archive", TASK]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const month = new Date().toISOString().slice(0, 7);
    expect(fs.existsSync(path.join(wt, ".arbor", "tasks", "archive", month, TASK, "task.json"))).toBe(true);
    expect(fs.existsSync(wtTask)).toBe(false);
    expect(git(wt, "log", "-1", "--format=%s")).toBe(`chore(task): archive ${TASK}`);
    expect(runTask(repo, ["current"]).status).toBe(1);
  });

  it("active_task / paths accept a task dir in a registered worktree and refuse other outside dirs", () => {
    makeTask();
    expect(runTask(repo, ["start", TASK]).status).toBe(0);
    const outside = path.join(tmp, "stray", ".arbor", "tasks", TASK);
    fs.mkdirSync(outside, { recursive: true });

    const probe = `
import json, sys
sys.path.insert(0, ".arbor/scripts")
from pathlib import Path
from common import active_task, paths
repo = Path(".").resolve()
out = {}
for label, ref in (("wt", sys.argv[1]), ("stray", sys.argv[2])):
    a = active_task.resolve_task_ref(ref, repo)
    b = paths.resolve_task_ref(ref, repo)
    out[label] = [str(a) if a else None, str(b) if b else None]
print(json.dumps(out))
`;
    const r = spawnSync("python3", ["-c", probe, wtTask, outside], { cwd: repo, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ wt: [wtTask, wtTask], stray: [null, null] });
  });
});

describe.skipIf(!hasPython())("task.py create (v2)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-create-"));
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".arbor", "scripts"), { recursive: true });
    const r = spawnSync("python3", [".arbor/scripts/init_developer.py", "tester"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    if (r.status !== 0) throw new Error(`init_developer failed: ${r.stderr}`);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes contract.md from the template and no prd.md", () => {
    const r = runTask(tmp, ["create", "Add Foo", "--description", "Foo goes here", "--slug", "foo", "--no-start"]);
    expect(r.status, r.stderr).toBe(0);
    const dir = fs.readdirSync(path.join(tmp, ".arbor", "tasks")).find((d) => d.endsWith("-foo"));
    expect(dir).toBeDefined();
    const taskDir = path.join(tmp, ".arbor", "tasks", dir as string);
    expect(fs.existsSync(path.join(taskDir, "prd.md"))).toBe(false);
    const contract = fs.readFileSync(path.join(taskDir, "contract.md"), "utf-8");
    expect(contract.startsWith("# Add Foo\n")).toBe(true);
    expect(contract).toContain("## Goal\n\nFoo goes here\n");
    expect(contract).toContain("## Acceptance criteria");
    expect(contract).toContain("## Verification map");
    expect(r.stderr).toContain("Fill contract.md");
  });
});
