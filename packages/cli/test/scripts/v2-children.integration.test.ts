/**
 * Parent / child tasks for the Planner: `arbor.py children`, the parent's
 * integration review (`run --role review --mode sweep --range a..b`, started
 * as an Orca worker like every dispatch) and the
 * parent's own gate in the main checkout.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CONTRACT,
  SESSION,
  TASK,
  complete,
  git,
  hasPython,
  setupFixture,
  writeFile,
  type Fixture,
} from "./v2-driver-helpers";

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

describe.skipIf(!hasPython())(
  "arbor.py children / parent sweep review / parent gate",
  { timeout: 90_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("lists children wherever they live, reviews the merged range, gates the parent", () => {
      f = setupFixture({ start: false });
      const parentDir = f.taskDir;
      const created = taskPy(
        f,
        "create",
        "Child A",
        "--description",
        "first deliverable",
        "--slug",
        "childa",
        "--parent",
        parentDir,
        "--tier",
        "light",
        "--no-start",
        "--base-branch",
        "main",
      );
      expect(created.status, created.stdout + created.stderr).toBe(0);
      const parent = f.taskJson();
      expect(parent.children).toHaveLength(1);
      const child = parent.children[0] as string;
      const childRel = `.arbor/tasks/${child}`;
      writeFile(f.repo, `${childRel}/contract.md`, CONTRACT);
      const curated =
        JSON.stringify({
          file: ".arbor/spec/guides/index.md",
          reason: "guides",
        }) + "\n";
      writeFile(f.repo, `${childRel}/implement.jsonl`, curated);
      writeFile(f.repo, `${childRel}/check.jsonl`, curated);

      // Unstarted child: found in the main tasks dir.
      let rows = JSON.parse(
        f.run("--task", parentDir, "children", "--json").stdout,
      ).children;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        task: child,
        found: true,
        started: false,
        status: "planning",
      });
      expect(rows[0]).not.toHaveProperty("conductor");

      // Started child (explicit --base-branch: no integration branch): moved
      // into its worktree; still listed, waiting for its implement step.
      const started = taskPy(f, "start", child);
      expect(started.status, started.stdout + started.stderr).toBe(0);
      rows = JSON.parse(
        f.run("--task", parentDir, "children", "--json").stdout,
      ).children;
      expect(rows[0]).toMatchObject({
        task: child,
        started: true,
        state: "BUILD",
        step: "implement",
        merged: false,
      });
      expect(rows[0].dir).toContain(
        path.join("proj-wt", child, ".arbor", "tasks", child),
      );
      const text = f.run("--task", parentDir, "children");
      expect(text.stdout).toContain(`${child}: BUILD/implement [light]`);

      // The parent is not started: `next` on it is still the CONTRACT view, but
      // it can run its integration review over an explicit range.
      const before = git(f.repo, "rev-parse", "HEAD");
      writeFile(f.repo, "src/feature.txt", "feature\n");
      git(f.repo, "add", "src/feature.txt");
      git(f.repo, "commit", "-q", "-m", "merge child a");
      const after = git(f.repo, "rev-parse", "HEAD");
      const next = JSON.parse(
        f.run("--task", parentDir, "next", "--role", "review", "--json").stdout,
      );
      expect(next.dispatch).toBe("d-001");
      writeFile(
        parentDir,
        "briefs/d-001.md",
        "Angles: A, B, Acceptance\nIntegration review of child a.\n",
      );
      const noRange = f.run(
        "--task",
        parentDir,
        "run",
        "--role",
        "review",
        "--mode",
        "sweep",
      );
      expect(noRange.status).toBe(1);
      expect(noRange.stderr).toContain("--mode sweep needs --range");
      const prepared = f.run(
        "--task",
        parentDir,
        "run",
        "--role",
        "review",
        "--mode",
        "sweep",
        "--range",
        `${before}..${after}`,
      );
      expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
      expect(JSON.parse(prepared.stdout)).toMatchObject({
        needs: "worker",
        dispatch: "d-001",
        orca_dispatch: "orca-d-001",
      });
      const sweep = complete(f, prepared);
      expect(sweep.status, sweep.stdout + sweep.stderr).toBe(0);
      expect(sweep.stdout).toContain("d-001 review: ok");
      const prompt = fs.readFileSync(
        path.join(f.tmp, "received", "d-001.md"),
        "utf-8",
      );
      expect(prompt).toContain("Role: review\nMode: sweep\n");
      expect(prompt).toContain(`Range: ${before}..${after}`);
      expect(fs.existsSync(path.join(parentDir, "reports", "d-001.md"))).toBe(
        true,
      );
      expect(f.taskJson().dispatches).toMatchObject([
        {
          id: "d-001",
          role: "review",
          mode: "sweep",
          status: "ok",
          phase: "CONTRACT",
        },
      ]);
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(after);
      const badRange = f.run(
        "--task",
        parentDir,
        "run",
        "--role",
        "explore",
        "--range",
        `${before}..${after}`,
      );
      expect(badRange.status).toBe(1);

      // The parent's gate runs its `auto` rows in the main checkout.
      const red = f.run("--task", parentDir, "gate");
      expect(red.status).toBe(1);
      expect(red.stdout).toContain("failing: AC-1");
      writeFile(f.repo, "tests/ac1.sh", "test -f src/feature.txt\n");
      const green = f.run("--task", parentDir, "gate");
      expect(green.status, green.stdout + green.stderr).toBe(0);
      expect(green.stdout).toContain("gate green");
      expect(f.taskJson().state).toBeUndefined(); // the parent was never started
      expect(TASK).toBe(path.basename(parentDir));
    });
  },
);
