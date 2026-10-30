/**
 * Integration tests for `common/worktree.py` and the v2 config accessors in
 * `common/arbor_config.py`, run through the real `python3` and `git` against
 * a throwaway repository.
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

function initRepo(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "tester");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
}

/** Run a python snippet with the template scripts importable; parse its JSON stdout. */
function py(cwd: string, code: string, ...args: string[]): unknown {
  const prelude = `import json, sys\nsys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})\nfrom pathlib import Path\n`;
  const r = spawnSync("python3", ["-c", prelude + code, ...args], {
    cwd,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`python failed (${r.status}): ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

describe.skipIf(!hasPython())("common/worktree.py", () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-wt-")));
    repo = path.join(tmp, "proj");
    initRepo(repo);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("names branches arbor/<task> and arbor/<task>--<partition>; root defaults to ../<repo>-wt", () => {
    const out = py(
      repo,
      `
from common.worktree import partition_branch, task_branch, worktree_root
repo = Path(".").resolve()
print(json.dumps({
    "task": task_branch("10-30-foo"),
    "part": partition_branch("10-30-foo", "impl"),
    "default_root": str(worktree_root(repo, {})),
    "custom_root": str(worktree_root(repo, {"worktree": {"root": "../wt/{repo}"}})),
    "abs_root": str(worktree_root(repo, {"worktree": {"root": sys.argv[1]}})),
}))
`,
      path.join(tmp, "elsewhere"),
    );
    expect(out).toEqual({
      task: "arbor/10-30-foo",
      part: "arbor/10-30-foo--impl",
      default_root: path.join(tmp, "proj-wt"),
      custom_root: path.join(tmp, "wt", "proj"),
      abs_root: path.join(tmp, "elsewhere"),
    });
  });

  it("worktree_root resolves against the main checkout even from a linked worktree", () => {
    const linked = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", "-b", "side", linked);
    const out = py(
      linked,
      `
from common.worktree import worktree_root
print(json.dumps(str(worktree_root(Path(".").resolve(), {}))))
`,
    );
    expect(out).toBe(path.join(tmp, "proj-wt"));
  });

  it("add_worktree creates the branch; list_worktrees sees it; remove_worktree removes both", () => {
    const wt = path.join(tmp, "proj-wt", "10-30-foo");
    const out = py(
      repo,
      `
from common.worktree import add_worktree, list_worktrees, remove_worktree
repo = Path(".").resolve()
wt = Path(sys.argv[1])
add_worktree(repo, wt, "arbor/10-30-foo", "HEAD")
listed = [str(p) for p in list_worktrees(repo)]
exists = wt.is_dir()
remove_worktree(repo, wt, delete_branch=True)
print(json.dumps({"listed": listed, "exists": exists, "gone": not wt.exists()}))
`,
      wt,
    );
    expect(out).toEqual({ listed: [repo, wt], exists: true, gone: true });
    expect(git(repo, "branch", "--list", "arbor/*")).toBe("");
  });

  it("remove_worktree keeps the branch by default and refuses a dirty worktree", () => {
    const wt = path.join(tmp, "wt-a");
    git(repo, "worktree", "add", "-q", "-b", "arbor/a", wt);
    fs.writeFileSync(path.join(wt, "untracked.txt"), "x\n");
    const out = py(
      repo,
      `
from common.worktree import WorktreeError, remove_worktree
repo, wt = Path(".").resolve(), Path(sys.argv[1])
try:
    remove_worktree(repo, wt)
    refused = None
except WorktreeError as e:
    refused = str(e)
(wt / "untracked.txt").unlink()
remove_worktree(repo, wt)
print(json.dumps({"refused": refused, "gone": not wt.exists()}))
`,
      wt,
    );
    expect((out as { refused: string }).refused).toContain("git worktree remove");
    expect((out as { gone: boolean }).gone).toBe(true);
    expect(git(repo, "branch", "--list", "arbor/a")).toContain("arbor/a");
  });

  it("add_worktree raises WorktreeError when the branch already exists", () => {
    git(repo, "branch", "arbor/dup");
    const out = py(
      repo,
      `
from common.worktree import WorktreeError, add_worktree
try:
    add_worktree(Path(".").resolve(), Path(sys.argv[1]), "arbor/dup", "HEAD")
    print(json.dumps(None))
except WorktreeError as e:
    print(json.dumps(str(e)))
`,
      path.join(tmp, "wt-dup"),
    );
    expect(out).toContain("already exists");
  });

  describe("merge_no_ff", () => {
    const MERGE = `
from common.worktree import merge_no_ff
r = merge_no_ff(Path(".").resolve(), sys.argv[1], "merge part")
print(json.dumps({"ok": r.ok, "conflicts": r.conflicts, "sha": r.sha}))
`;

    it("creates a two-parent merge commit with the given message", () => {
      git(repo, "checkout", "-q", "-b", "part");
      fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
      git(repo, "add", "b.txt");
      git(repo, "commit", "-q", "-m", "part work");
      git(repo, "checkout", "-q", "main");

      const out = py(repo, MERGE, "part") as { ok: boolean; sha: string; conflicts: string[] };
      expect(out.ok).toBe(true);
      expect(out.conflicts).toEqual([]);
      expect(out.sha).toBe(git(repo, "rev-parse", "HEAD"));
      expect(git(repo, "log", "-1", "--format=%s")).toBe("merge part");
      expect(git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    });

    it("aborts a conflicted merge and reports the conflicting paths", () => {
      git(repo, "checkout", "-q", "-b", "part");
      fs.writeFileSync(path.join(repo, "a.txt"), "theirs\n");
      git(repo, "commit", "-q", "-am", "theirs");
      git(repo, "checkout", "-q", "main");
      fs.writeFileSync(path.join(repo, "a.txt"), "ours\n");
      git(repo, "commit", "-q", "-am", "ours");
      const headBefore = git(repo, "rev-parse", "HEAD");

      const out = py(repo, MERGE, "part");
      expect(out).toEqual({ ok: false, conflicts: ["a.txt"], sha: null });
      expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    });
  });

  it("run_setup: empty command is a no-op; a failure returns its code and prints the tail", () => {
    const code = `
from common.worktree import run_setup
wt = Path(".").resolve()
print(json.dumps([run_setup(wt, None), run_setup(wt, "  "), run_setup(wt, "touch made"),
                  run_setup(wt, "echo first-line; echo setup-broke >&2; exit 3")]))
`;
    const r = spawnSync(
      "python3",
      ["-c", `import json, sys\nsys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})\nfrom pathlib import Path\n${code}`],
      { cwd: repo, encoding: "utf-8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([0, 0, 0, 3]);
    expect(fs.existsSync(path.join(repo, "made"))).toBe(true);
    expect(r.stderr).toContain("worktree.setup exited 3");
    expect(r.stderr).toContain("setup-broke");
  });

  it("create_task_worktree branches from HEAD under the configured root and refuses a second time", () => {
    const out = py(
      repo,
      `
from common.worktree import WorktreeError, create_task_worktree
repo = Path(".").resolve()
task_dir = repo / ".arbor" / "tasks" / "10-30-foo"
wt = create_task_worktree(repo, task_dir, {})
try:
    create_task_worktree(repo, task_dir, {})
    again = None
except WorktreeError as e:
    again = str(e)
print(json.dumps({"path": str(wt.path), "branch": wt.branch, "base": wt.base_sha, "again": again}))
`,
    ) as Record<string, string>;
    expect(out.path).toBe(path.join(tmp, "proj-wt", "10-30-foo"));
    expect(out.branch).toBe("arbor/10-30-foo");
    expect(out.base).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(out.path, "branch", "--show-current")).toBe("arbor/10-30-foo");
    expect(out.again).toContain("already exists");
  });
});

describe.skipIf(!hasPython())("common/arbor_config.py v2 accessors", () => {
  it("fall back to defaults and overlay configured values", () => {
    const out = py(
      os.tmpdir(),
      `
from common.arbor_config import (
    get_executors_config, get_test_paths, get_worktree_config, parse_simple_yaml,
)
cfg = parse_simple_yaml("""
worktree:
  setup: "pnpm install --offline"
test_paths:
  - "tests/**"
executors:
  default: claude
""")
print(json.dumps({
    "wt_default": get_worktree_config({}),
    "wt": get_worktree_config(cfg),
    "tp_default": get_test_paths({}),
    "tp": get_test_paths(cfg),
    "ex_default": get_executors_config({})["default"],
    "ex": get_executors_config(cfg),
}))
`,
    );
    expect(out).toEqual({
      wt_default: { root: "../{repo}-wt", setup: "" },
      wt: { root: "../{repo}-wt", setup: "pnpm install --offline" },
      tp_default: ["packages/*/test/**", "**/*.test.ts"],
      tp: ["tests/**"],
      ex_default: "codeg",
      ex: { default: "claude" },
    });
  });

  it("the shipped config.yaml template parses to the documented worktree/test_paths defaults", () => {
    const template = path.resolve(__dirname, "../../src/templates/arbor/config.yaml");
    const out = py(
      os.tmpdir(),
      `
from common.arbor_config import get_test_paths, get_worktree_config, parse_simple_yaml
cfg = parse_simple_yaml(Path(sys.argv[1]).read_text())
print(json.dumps([get_worktree_config(cfg), get_test_paths(cfg)]))
`,
      template,
    );
    expect(out).toEqual([
      { root: "../{repo}-wt", setup: "" },
      ["packages/*/test/**", "**/*.test.ts"],
    ]);
  });
});
