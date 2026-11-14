/**
 * Regression tests for #567: a `.arbor` directory that is a symlink into a
 * shared store outside the repo must keep working.
 *
 * arbor 1.0 finds its tasks under `<checkout>/.arbor/tasks/` by name; the
 * name must stay a plain directory name, so `--task` cannot reach outside
 * the tasks tree through `..`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEMPLATE_SCRIPTS, hasPython } from "./driver-helpers";

function arbor(
  repo: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "python3",
    [path.join(".arbor", "scripts", "arbor.py"), ...args],
    { cwd: repo, encoding: "utf-8" },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!hasPython() || process.platform === "win32")(
  "symlinked .arbor workflow dir (#567)",
  () => {
    let base: string;
    let store: string; // the real .arbor, outside the repo
    let repo: string; // the git checkout; repo/.arbor -> store

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-567-"));
      store = path.join(base, "shared", ".arbor");
      repo = path.join(base, "repo");
      fs.mkdirSync(path.join(store, "tasks"), { recursive: true });
      fs.cpSync(TEMPLATE_SCRIPTS, path.join(store, "scripts"), {
        recursive: true,
      });
      fs.mkdirSync(repo, { recursive: true });
      spawnSync("git", ["init", "-q", repo], { encoding: "utf-8" });
      fs.symlinkSync(store, path.join(repo, ".arbor"), "dir");
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("creates and finds a task through the symlink", () => {
      const created = arbor(repo, "new", "Demo task");
      expect(created.status, created.stderr).toBe(0);
      const name = fs.readdirSync(path.join(store, "tasks"))[0];
      expect(name).toMatch(/^\d\d-\d\d-demo-task$/);
      const status = arbor(repo, "status");
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain(`${name}: planning`);
      expect(arbor(repo, "--task", name, "status").status).toBe(0);
    });

    it("refuses a --task that is not a plain directory name", () => {
      fs.mkdirSync(path.join(base, "escape"), { recursive: true });
      fs.writeFileSync(
        path.join(base, "escape", "task.json"),
        JSON.stringify({ schema: 3, status: "active" }),
      );
      for (const ref of ["../../escape", "..", "a/b"]) {
        const r = arbor(repo, "--task", ref, "status");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("--task takes a task directory name");
      }
    });
  },
);
