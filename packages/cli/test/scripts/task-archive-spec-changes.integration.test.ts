/**
 * Integration tests for spec change traceability at `task.py archive`.
 *
 * `common/task_store.py:cmd_archive` calls `spec_trace.derive_spec_changes`
 * and writes `spec_changes` + `spec_changes_source` into task.json before
 * the move. One case per `spec_changes_source` label:
 *
 *   branch-diff    feature branch differs from base_branch
 *   since-created  shared branch: commits since createdAt
 *   none           git unavailable, nothing recorded manually
 *   manual         only `task.py add-spec-change` entries
 *   mixed          manual + derived
 *
 * Derivation is advisory: the git-less case must still exit 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/trellis/scripts",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pythonExecutable(): string {
  return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf-8",
  }).trim();
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (rc=${r.status}): ${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

function setupRepo(tmp: string): void {
  git(tmp, "init", "-q", "-b", "main");
  git(tmp, "config", "user.email", "test@example.com");
  git(tmp, "config", "user.name", "Test");
  const scriptsDest = path.join(tmp, ".trellis", "scripts");
  fs.mkdirSync(scriptsDest, { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, scriptsDest, { recursive: true });
  // Keep archive from committing so each case inspects task.json directly.
  fs.writeFileSync(
    path.join(tmp, ".trellis", "config.yaml"),
    "session_auto_commit: false\n",
  );
  fs.mkdirSync(path.join(tmp, ".trellis", "spec", "backend"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tmp, ".trellis", "spec", "backend", "index.md"),
    "# idx\n",
  );
  fs.writeFileSync(
    path.join(tmp, ".trellis", "spec", "backend", "x.md"),
    "# x\n",
  );
  fs.writeFileSync(path.join(tmp, "src.ts"), "export {};\n");
}

function makeTask(
  repo: string,
  name: string,
  overrides: Record<string, unknown> = {},
): void {
  const dir = path.join(repo, ".trellis", "tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prd.md"), `${name} prd\n`);
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id: name,
      name,
      title: name,
      status: "in_progress",
      priority: "P2",
      // Well before any fixture commit so `--since` includes them all.
      createdAt: "2020-01-01",
      assignee: "tester",
      creator: "tester",
      subtasks: [],
      children: [],
      parent: null,
      relatedFiles: [],
      meta: {},
      ...overrides,
    }) + "\n",
  );
}

function commitAll(repo: string, message: string, date?: string): void {
  git(repo, "add", "-A");
  const r = spawnSync("git", ["commit", "-q", "-m", message], {
    cwd: repo,
    encoding: "utf-8",
    env: date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : process.env,
  });
  if (r.status !== 0) {
    throw new Error(`git commit failed (rc=${r.status}): ${r.stderr}`);
  }
}

function runTask(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  python = "python3",
): SpawnSyncReturns<string> {
  return spawnSync(python, [".trellis/scripts/task.py", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...env, TRELLIS_DEVELOPER: "tester" },
  });
}

function archivedTaskJson(repo: string, name: string): Record<string, unknown> {
  const archive = path.join(repo, ".trellis", "tasks", "archive");
  for (const month of fs.readdirSync(archive)) {
    const file = path.join(archive, month, name, "task.json");
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
        string,
        unknown
      >;
    }
  }
  throw new Error(`archived task.json for ${name} not found`);
}

function activeTaskJson(repo: string, name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.join(repo, ".trellis", "tasks", name, "task.json"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

describe.skipIf(!hasPython())("task.py archive records spec_changes", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-archive-spec-"));
    setupRepo(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("AC5: feature branch -> branch-diff over the spec files the branch touched", () => {
    makeTask(tmp, "feat-task", { branch: "feat", base_branch: "main" });
    commitAll(tmp, "initial");

    git(tmp, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(
      path.join(tmp, ".trellis", "spec", "backend", "x.md"),
      "# x changed\n",
    );
    fs.writeFileSync(path.join(tmp, "src.ts"), "export const changed = 1;\n");
    commitAll(tmp, "change spec and code on feat");

    const r = runTask(tmp, ["archive", "feat-task"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("could not derive spec changes");

    const data = archivedTaskJson(tmp, "feat-task");
    expect(data.spec_changes).toEqual([".trellis/spec/backend/x.md"]);
    expect(data.spec_changes_source).toBe("branch-diff");
  });

  it("branch-diff uses the recorded branch even when HEAD is back on base", () => {
    makeTask(tmp, "feat-task", { branch: "feat", base_branch: "main" });
    commitAll(tmp, "initial");
    git(tmp, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(
      path.join(tmp, ".trellis", "spec", "backend", "x.md"),
      "# x changed\n",
    );
    commitAll(tmp, "spec on feat");
    git(tmp, "checkout", "-q", "main");

    const r = runTask(tmp, ["archive", "feat-task"]);
    expect(r.status, r.stderr).toBe(0);
    const data = archivedTaskJson(tmp, "feat-task");
    expect(data.spec_changes).toEqual([".trellis/spec/backend/x.md"]);
    expect(data.spec_changes_source).toBe("branch-diff");
  });

  it("branch-diff still finds the branch's spec changes after it was merged into base", () => {
    // finish-work often runs after the feature branch is merged. Then the
    // branch tip is an ancestor of base, `merge-base base branch` is the tip
    // itself, and a plain tip..tip diff is empty. The fork point must come
    // from the merge commit that brought the branch in.
    makeTask(tmp, "feat-task", { branch: "feat", base_branch: "main" });
    commitAll(tmp, "initial");
    git(tmp, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(
      path.join(tmp, ".trellis", "spec", "backend", "x.md"),
      "# x changed\n",
    );
    commitAll(tmp, "spec x on feat");
    git(tmp, "checkout", "-q", "main");
    // A concurrent base-only spec change must not be attributed to the task.
    fs.writeFileSync(
      path.join(tmp, ".trellis", "spec", "backend", "y.md"),
      "# y on main\n",
    );
    commitAll(tmp, "spec y on main");
    git(tmp, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");

    const r = runTask(tmp, ["archive", "feat-task"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("could not derive spec changes");
    const data = archivedTaskJson(tmp, "feat-task");
    expect(data.spec_changes).toEqual([".trellis/spec/backend/x.md"]);
    expect(data.spec_changes_source).toBe("branch-diff");
  });

  it("AC5: shared branch -> since-created from commits after createdAt", () => {
    makeTask(tmp, "shared-task");
    commitAll(tmp, "initial");
    fs.writeFileSync(
      path.join(tmp, ".trellis", "spec", "backend", "y.md"),
      "# y\n",
    );
    commitAll(tmp, "add spec y on main");
    fs.rmSync(path.join(tmp, ".trellis", "spec", "backend", "x.md"));
    commitAll(tmp, "delete spec x on main");

    const r = runTask(tmp, ["archive", "shared-task"]);
    expect(r.status, r.stderr).toBe(0);

    const data = archivedTaskJson(tmp, "shared-task");
    // Deleted paths count: the task still changed them. index.md/x.md come
    // from the initial commit, which is also after createdAt.
    expect(data.spec_changes).toEqual([
      ".trellis/spec/backend/index.md",
      ".trellis/spec/backend/x.md",
      ".trellis/spec/backend/y.md",
    ]);
    expect(data.spec_changes_source).toBe("since-created");
  });

  it("AC5: git unavailable -> archive exits 0 with a warning and source none", () => {
    makeTask(tmp, "nogit-task");
    commitAll(tmp, "initial");

    // A PATH that can run python but not git.
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const python = path.join(bin, "python3");
    fs.symlinkSync(pythonExecutable(), python);
    const env = { ...process.env, PATH: bin };

    const r = runTask(
      tmp,
      ["archive", "nogit-task", "--no-commit"],
      env,
      python,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("Warning: could not derive spec changes");
    expect(r.stderr).toContain("Archived: nogit-task");

    const data = archivedTaskJson(tmp, "nogit-task");
    expect(data.spec_changes).toEqual([]);
    expect(data.spec_changes_source).toBe("none");
  });

  it("AC5: add-spec-change -> manual, kept through archive", () => {
    makeTask(tmp, "manual-task");
    // Committed before createdAt (2020-01-01), so `git log --since` derives
    // nothing and only the manual entry remains.
    commitAll(tmp, "initial", "2019-06-01T12:00:00Z");

    const add = runTask(tmp, [
      "add-spec-change",
      ".trellis/tasks/manual-task",
      "./.trellis/spec/backend/index.md",
    ]);
    expect(add.status, add.stderr).toBe(0);
    const data = activeTaskJson(tmp, "manual-task");
    expect(data.spec_changes).toEqual([".trellis/spec/backend/index.md"]);
    expect(data.spec_changes_source).toBe("manual");

    // Adding the same path twice is a no-op; outside / missing paths fail.
    const dup = runTask(tmp, [
      "add-spec-change",
      ".trellis/tasks/manual-task",
      ".trellis/spec/backend/index.md",
    ]);
    expect(dup.status).toBe(0);
    expect(dup.stdout).toContain("Already recorded");
    const outside = runTask(tmp, [
      "add-spec-change",
      ".trellis/tasks/manual-task",
      "src.ts",
    ]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("not under .trellis/spec/");
    const missing = runTask(tmp, [
      "add-spec-change",
      ".trellis/tasks/manual-task",
      ".trellis/spec/backend/nope.md",
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("does not exist");
    expect(activeTaskJson(tmp, "manual-task").spec_changes).toEqual([
      ".trellis/spec/backend/index.md",
    ]);

    const r = runTask(tmp, ["archive", "manual-task"]);
    expect(r.status, r.stderr).toBe(0);
    const archived = archivedTaskJson(tmp, "manual-task");
    expect(archived.spec_changes).toEqual([".trellis/spec/backend/index.md"]);
    expect(archived.spec_changes_source).toBe("manual");
  });

  it("manual + derived -> mixed, deduplicated and sorted", () => {
    makeTask(tmp, "mixed-task", { branch: "feat", base_branch: "main" });
    commitAll(tmp, "initial");
    git(tmp, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(
      path.join(tmp, ".trellis", "spec", "backend", "x.md"),
      "# x changed\n",
    );
    commitAll(tmp, "spec on feat");

    for (const p of [
      ".trellis/spec/backend/index.md",
      ".trellis/spec/backend/x.md",
    ]) {
      const add = runTask(tmp, [
        "add-spec-change",
        ".trellis/tasks/mixed-task",
        p,
      ]);
      expect(add.status, add.stderr).toBe(0);
    }

    const r = runTask(tmp, ["archive", "mixed-task"]);
    expect(r.status, r.stderr).toBe(0);
    const data = archivedTaskJson(tmp, "mixed-task");
    expect(data.spec_changes).toEqual([
      ".trellis/spec/backend/index.md",
      ".trellis/spec/backend/x.md",
    ]);
    expect(data.spec_changes_source).toBe("mixed");
  });

  it("task.py create does not write the new fields (D5)", () => {
    commitAll(tmp, "initial");
    const r = runTask(tmp, [
      "create",
      "Fresh",
      "--description",
      "d",
      "--slug",
      "fresh",
      "--no-start",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const created = fs
      .readdirSync(path.join(tmp, ".trellis", "tasks"))
      .filter((d: string) => d.endsWith("-fresh"));
    expect(created).toHaveLength(1);
    const data = activeTaskJson(tmp, created[0]);
    expect("spec_changes" in data).toBe(false);
    expect("spec_changes_source" in data).toBe(false);
  });
});
