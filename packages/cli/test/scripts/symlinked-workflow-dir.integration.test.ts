/**
 * Regression tests for #567: a `.arbor` directory that is a symlink into a
 * shared store outside the repo must keep working.
 *
 * 0.6.15 enforced path containment with physical paths only
 * (`Path.resolve()` / `os.path.realpath()` against the repo root), so every
 * ref through the symlinked workflow dir resolved outside the repo and was
 * refused: `task start` failed with "Task not found" and the context hook
 * exited silently. The fix keeps the physical check but adds the workflow
 * dir's own real location as a second containment base, and maps accepted
 * refs back to their in-repo (lexical) form for storage.
 *
 * The escapes the containment closed must STAY closed in this layout:
 * `..` traversal, absolute paths elsewhere, and a task dir symlinked out of
 * the tasks tree are still refused.
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

const TASK = "08-21-demo";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runTask(
  repo: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "python3",
    [path.join(".arbor", "scripts", "task.py"), ...args],
    {
      cwd: repo,
      encoding: "utf-8",
      env: { ...process.env, ARBOR_CONTEXT_ID: "test-ctx" },
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run a Python snippet with the repo's dispatch_context module preloaded as `mod`. */
function runHookProbe(repo: string, code: string): string {
  const probePath = path.join(repo, "probe.py");
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(repo, ".arbor", "scripts"))})
REPO_ROOT = ${JSON.stringify(repo)}
from common import dispatch_context as mod
${code}
`;
  fs.writeFileSync(probePath, script, "utf-8");
  const r = spawnSync("python3", [probePath], { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`probe failed (rc=${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}

describe.skipIf(!hasPython() || process.platform === "win32")(
  "symlinked .arbor workflow dir (#567)",
  () => {
    let base: string;
    let store: string; // the real .arbor, outside the repo
    let repo: string; // the git worktree; repo/.arbor -> store

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-567-"));
      store = path.join(base, "shared", ".arbor");
      repo = path.join(base, "repo");

      fs.mkdirSync(path.join(store, "tasks", TASK), { recursive: true });
      fs.writeFileSync(
        path.join(store, "tasks", TASK, "task.json"),
        JSON.stringify({
          id: TASK,
          name: TASK,
          title: TASK,
          status: "in_progress",
          meta: {},
          children: [],
        }) + "\n",
      );
      fs.cpSync(TEMPLATE_SCRIPTS, path.join(store, "scripts"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(store, ".developer"), "name=tester\n");

      fs.mkdirSync(repo, { recursive: true });
      spawnSync("git", ["init", "-q", repo], { encoding: "utf-8" });
      fs.symlinkSync(store, path.join(repo, ".arbor"), "dir");
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("task.py start resolves a task by name and stores the in-repo ref", () => {
      const r = runTask(repo, "start", TASK);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Current task set to: .arbor/tasks/${TASK}`);
    });

    it("task.py start resolves the path form too", () => {
      const r = runTask(repo, "start", `.arbor/tasks/${TASK}`);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Current task set to: .arbor/tasks/${TASK}`);
    });

    it("still refuses `..` traversal in the symlinked layout", () => {
      const r = runTask(repo, "set-meta", "../escape", "pwned", "yes");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("refusing to use");
    });

    it("still refuses a task dir symlinked out of the tasks tree", () => {
      const outside = path.join(base, "outside-target");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(
        path.join(outside, "task.json"),
        JSON.stringify({ id: "outside", meta: {} }),
      );
      fs.symlinkSync(outside, path.join(store, "tasks", "evil"), "dir");

      const r = runTask(repo, "set-meta", "evil", "pwned", "yes");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("refusing to use");
      expect(
        JSON.parse(fs.readFileSync(path.join(outside, "task.json"), "utf-8"))
          .meta,
      ).toEqual({});
    });

    it("hook injects task artifacts and jsonl refs through the symlink", () => {
      fs.writeFileSync(
        path.join(store, "tasks", TASK, "prd.md"),
        "PRD THROUGH SYMLINK\n",
      );
      fs.writeFileSync(
        path.join(store, "tasks", TASK, "implement.jsonl"),
        JSON.stringify({
          file: `.arbor/tasks/${TASK}/task.json`,
          reason: "self",
        }) + "\n",
      );
      const out = runHookProbe(
        repo,
        `print(mod.get_implement_context(REPO_ROOT, ${JSON.stringify(`.arbor/tasks/${TASK}`)}))`,
      );
      expect(out).toContain("PRD THROUGH SYMLINK");
      expect(out).toContain(`=== .arbor/tasks/${TASK}/task.json ===`);
    });

    it("hook still refuses a jsonl ref outside both containment bases", () => {
      const secret = path.join(base, "secret.txt");
      fs.writeFileSync(secret, "TOP SECRET CONTENT");
      fs.writeFileSync(
        path.join(store, "tasks", TASK, "implement.jsonl"),
        JSON.stringify({ file: secret, reason: "escape" }) + "\n",
      );
      const out = runHookProbe(
        repo,
        `print(mod.get_implement_context(REPO_ROOT, ${JSON.stringify(`.arbor/tasks/${TASK}`)}))`,
      );
      expect(out).not.toContain("TOP SECRET CONTENT");
    });
  },
);
