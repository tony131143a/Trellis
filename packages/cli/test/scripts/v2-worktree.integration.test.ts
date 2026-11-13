/**
 * Integration tests for `common/worktree.py` and the v2 config accessors in
 * `common/arbor_config.py`, run through the real `python3` and `git` against
 * a throwaway repository. Worktrees are created and removed through the fake
 * Orca CLI (`fakeOrca`), never the real one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fakeOrca, orcaCalls } from "./v2-driver-helpers";

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
  /** The config naming the fake Orca CLI, which creates and removes the worktrees. */
  let config: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-wt-")),
    );
    repo = path.join(tmp, "proj");
    initRepo(repo);
    config = fakeOrca(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  /** `py` with `CFG`, the parsed config that uses the fake Orca. */
  function pyOrca(cwd: string, code: string, ...args: string[]): unknown {
    return py(
      cwd,
      `from common.arbor_config import parse_simple_yaml\nCFG = parse_simple_yaml(${JSON.stringify(config)})\n${code}`,
      ...args,
    );
  }

  /** The `orca worktree <verb>` calls the code under test made. */
  function worktreeCalls(verb: string): string[][] {
    return orcaCalls({ tmp }).filter(
      (argv) => argv[0] === "worktree" && argv[1] === verb,
    );
  }

  it("names branches arbor/<task> and arbor/<task>--<partition>", () => {
    const out = py(
      repo,
      `
from common.worktree import partition_branch, task_branch
print(json.dumps({"task": task_branch("10-30-foo"), "part": partition_branch("10-30-foo", "impl")}))
`,
    );
    expect(out).toEqual({
      task: "arbor/10-30-foo",
      part: "arbor/10-30-foo--impl",
    });
  });

  it("branch_worktree finds the checkout of a branch, the main checkout included, from a linked worktree", () => {
    const linked = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", "-b", "side", linked);
    const out = py(
      linked,
      `
from common.worktree import branch_worktree
here = Path(".").resolve()
print(json.dumps([str(branch_worktree(here, b)) for b in ("main", "side", "nope")]))
`,
    );
    expect(out).toEqual([repo, linked, "None"]);
  });

  it("add_worktree creates the branch in an Orca workspace under its parent; remove_worktree removes both through Orca", () => {
    const wt = path.join(tmp, "proj-wt", "10-30-foo");
    const out = pyOrca(
      repo,
      `
from common.worktree import add_worktree, list_worktrees, remove_worktree
repo = Path(".").resolve()
wt = add_worktree(CFG, repo, "10-30-foo", "arbor/10-30-foo", "HEAD", repo)
listed = [str(p) for p in list_worktrees(repo)]
exists = wt.is_dir()
remove_worktree(CFG, repo, wt, delete_branch=True)
print(json.dumps({"path": str(wt), "listed": listed, "exists": exists, "gone": not wt.exists()}))
`,
    );
    expect(out).toEqual({ path: wt, listed: [repo, wt], exists: true, gone: true });
    expect(git(repo, "branch", "--list", "arbor/*")).toBe("");
    expect(worktreeCalls("create")).toEqual([
      [
        "worktree",
        "create",
        "--repo",
        `path:${repo}`,
        "--name",
        "10-30-foo",
        "--branch",
        "arbor/10-30-foo",
        "--base-branch",
        "HEAD",
        "--parent-worktree",
        `path:${repo}`,
      ],
    ]);
    expect(worktreeCalls("rm")).toEqual([
      ["worktree", "rm", "--worktree", `path:${wt}`],
    ]);
  });

  it("add_worktree without a parent creates a top-level Orca workspace", () => {
    pyOrca(
      repo,
      `
from common.worktree import add_worktree
print(json.dumps(str(add_worktree(CFG, Path(".").resolve(), "solo", "arbor/solo", "HEAD", None))))
`,
    );
    expect(worktreeCalls("create")[0]).toContain("--no-parent");
    expect(worktreeCalls("create")[0]).not.toContain("--parent-worktree");
  });

  it("remove_worktree keeps the branch by default and refuses a dirty worktree", () => {
    const wt = path.join(tmp, "wt-a");
    git(repo, "worktree", "add", "-q", "-b", "arbor/a", wt);
    fs.writeFileSync(path.join(wt, "untracked.txt"), "x\n");
    const out = pyOrca(
      repo,
      `
from common.worktree import WorktreeError, remove_worktree
repo, wt = Path(".").resolve(), Path(sys.argv[1])
try:
    remove_worktree(CFG, repo, wt)
    refused = None
except WorktreeError as e:
    refused = str(e)
(wt / "untracked.txt").unlink()
remove_worktree(CFG, repo, wt)
print(json.dumps({"refused": refused, "gone": not wt.exists()}))
`,
      wt,
    );
    expect((out as { refused: string }).refused).toContain(
      `orca worktree rm ${wt} failed`,
    );
    expect((out as { gone: boolean }).gone).toBe(true);
    expect(git(repo, "branch", "--list", "arbor/a")).toContain("arbor/a");
    // never forced unless asked
    expect(worktreeCalls("rm").every((argv) => !argv.includes("--force"))).toBe(
      true,
    );
  });

  it("add_worktree refuses when Orca answers with another branch (a taken name) and leaves nothing behind", () => {
    git(repo, "branch", "arbor/dup");
    const out = pyOrca(
      repo,
      `
from common.worktree import WorktreeError, add_worktree
try:
    add_worktree(CFG, Path(".").resolve(), "dup", "arbor/dup", "HEAD", None)
    print(json.dumps(None))
except WorktreeError as e:
    print(json.dumps(str(e)))
`,
    );
    expect(out).toContain("Orca already has a workspace or branch named dup / arbor/dup");
    expect(out).toContain("arbor/dup-2");
    expect(git(repo, "branch", "--list", "arbor/dup-2")).toBe("");
    expect(fs.existsSync(path.join(tmp, "proj-wt", "dup-2"))).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("dup-2");
    expect(worktreeCalls("rm")).toEqual([
      [
        "worktree",
        "rm",
        "--worktree",
        `path:${path.join(tmp, "proj-wt", "dup-2")}`,
        "--force",
      ],
    ]);
  });

  it("add_worktree names the fix when the repository is not a project in Orca", () => {
    fs.writeFileSync(
      path.join(tmp, "fake.json"),
      JSON.stringify({ unregistered: ["proj"] }),
    );
    const out = pyOrca(
      repo,
      `
from common.worktree import WorktreeError, add_worktree
try:
    add_worktree(CFG, Path(".").resolve(), "x", "arbor/x", "HEAD", None)
    print(json.dumps(None))
except WorktreeError as e:
    print(json.dumps(str(e)))
`,
    );
    expect(out).toBe(
      `orca worktree create x failed: ${repo} is not a project in Orca (\`orca repo add --path ${repo}\`)`,
    );
    expect(git(repo, "branch", "--list", "arbor/*")).toBe("");
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

      const out = py(repo, MERGE, "part") as {
        ok: boolean;
        sha: string;
        conflicts: string[];
      };
      expect(out.ok).toBe(true);
      expect(out.conflicts).toEqual([]);
      expect(out.sha).toBe(git(repo, "rev-parse", "HEAD"));
      expect(git(repo, "log", "-1", "--format=%s")).toBe("merge part");
      expect(
        git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" "),
      ).toHaveLength(3);
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
      [
        "-c",
        `import json, sys\nsys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})\nfrom pathlib import Path\n${code}`,
      ],
      { cwd: repo, encoding: "utf-8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([0, 0, 0, 3]);
    expect(fs.existsSync(path.join(repo, "made"))).toBe(true);
    expect(r.stderr).toContain("worktree.setup exited 3");
    expect(r.stderr).toContain("setup-broke");
  });

  it("create_task_worktree branches from HEAD in an Orca workspace under the main checkout and refuses a second time", () => {
    const out = pyOrca(
      repo,
      `
from common.worktree import WorktreeError, create_task_worktree
repo = Path(".").resolve()
task_dir = repo / ".arbor" / "tasks" / "10-30-foo"
wt = create_task_worktree(repo, task_dir, CFG)
try:
    create_task_worktree(repo, task_dir, CFG)
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
    const created = worktreeCalls("create");
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.arrayContaining(["--parent-worktree", `path:${repo}`]),
    );
    expect(created[0][created[0].indexOf("--base-branch") + 1]).toBe(out.base);
  });
});

describe.skipIf(!hasPython())("common/arbor_config.py v2 accessors", () => {
  it("fall back to defaults and overlay configured values", () => {
    const out = py(
      os.tmpdir(),
      `
from common.arbor_config import get_executors_config, get_worktree_config, parse_simple_yaml
cfg = parse_simple_yaml("""
worktree:
  setup: "pnpm install --offline"
executors:
  default: omp
  omp:
    type: orca
    command: orca
    agent: omp
  orca:
    timeout: 30m
""")
partial = parse_simple_yaml("""
executors:
  default: orca
  orca:
    agent: claude
""")
print(json.dumps({
    "wt_default": get_worktree_config({}),
    "wt": get_worktree_config(cfg),
    "ex_default": get_executors_config({}),
    "ex": get_executors_config(cfg),
    "ex_partial": get_executors_config(partial),
}))
`,
    );
    const orca = {
      type: "orca",
      command: "orca",
      agent: "codex",
      timeout: "90m",
      max_parallel: "5",
      keep_open: "false",
    };
    expect(out).toEqual({
      wt_default: { setup: "", branch_prefix: "arbor/" },
      wt: {
        setup: "pnpm install --offline",
        branch_prefix: "arbor/",
      },
      ex_default: { default: "orca", orca },
      ex: {
        default: "omp",
        omp: { type: "orca", command: "orca", agent: "omp" },
        orca: { ...orca, timeout: "30m" },
      },
      ex_partial: { default: "orca", orca: { ...orca, agent: "claude" } },
    });
  });

  it("the shipped config.yaml template parses to the documented worktree/executor defaults", () => {
    const template = path.resolve(
      __dirname,
      "../../src/templates/arbor/config.yaml",
    );
    const out = py(
      os.tmpdir(),
      `
from common.arbor_config import get_executors_config, get_worktree_config, parse_simple_yaml
cfg = parse_simple_yaml(Path(sys.argv[1]).read_text())
print(json.dumps([get_worktree_config(cfg), get_executors_config(cfg)]))
`,
      template,
    );
    expect(out).toEqual([
      { setup: "", branch_prefix: "arbor/" },
      {
        default: "orca",
        orca: {
          type: "orca",
          command: "orca",
          agent: "codex",
          timeout: "90m",
          max_parallel: "5",
          keep_open: "false",
        },
      },
    ]);
  });
});
