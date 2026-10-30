/**
 * Integration tests for task tiers (light / standard / full).
 *
 * Templates under test (stamped into a fresh `.arbor/` tree and run through
 * the real `python3`):
 *   - `common/tasks.py` — `resolve_tier` / `explicit_tier` / `infer_tier` /
 *     `missing_tier_artifacts`
 *   - `task.py` + `common/task_store.py` — `create --tier`, `set-meta tier`,
 *     the `start` tier gate
 *   - `common/task_context.py` + `common/packages_context.py` —
 *     `seed-context` and the shared manifest writer behind `add-context`
 *   - `common/session_context.py` — `Tier:` in `get_context.py` output
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

const DEVELOPER = "tester";
const SESSION = { ARBOR_CONTEXT_ID: "tier-test-session" };

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function setupRepo(tmp: string): void {
  fs.mkdirSync(tmp, { recursive: true });
  const scriptsDest = path.join(tmp, ".arbor", "scripts");
  fs.mkdirSync(scriptsDest, { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, scriptsDest, { recursive: true });

  const r = spawnSync(
    "python3",
    [".arbor/scripts/init_developer.py", DEVELOPER],
    { cwd: tmp, encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(`init_developer failed: ${r.stderr}`);
  }
}

function runScript(
  repo: string,
  script: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return spawnSync("python3", [`.arbor/scripts/${script}`, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function runTask(repo: string, args: string[], env: Record<string, string> = {}) {
  return runScript(repo, "task.py", args, env);
}

function writeFile(repo: string, rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

function readFile(repo: string, rel: string): string {
  return fs.readFileSync(path.join(repo, rel), "utf-8");
}

function tasksIn(repo: string): string[] {
  const dir = path.join(repo, ".arbor", "tasks");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function findTaskDir(repo: string, needle: string): string {
  const dir = tasksIn(repo).find((d) => d.includes(needle));
  if (!dir) {
    throw new Error(`no task dir matching ${needle}`);
  }
  return dir;
}

function readTaskJson(repo: string, dirName: string): Record<string, unknown> {
  return JSON.parse(readFile(repo, `.arbor/tasks/${dirName}/task.json`));
}

const GUIDES_INDEX = ".arbor/spec/guides/index.md";
const CURATED_ROW =
  JSON.stringify({ file: GUIDES_INDEX, reason: "shared guides" }) + "\n";

/** Write a task directory by hand; returns its repo-relative path. */
function makeTask(
  repo: string,
  name: string,
  data: Record<string, unknown>,
  files: string[] = [],
  manifests: { implement: string; check: string } = {
    implement: CURATED_ROW,
    check: CURATED_ROW,
  },
): string {
  const rel = `.arbor/tasks/${name}`;
  writeFile(
    repo,
    `${rel}/task.json`,
    JSON.stringify({ id: name, name, title: name, children: [], ...data }) +
      "\n",
  );
  for (const file of files) {
    writeFile(repo, `${rel}/${file}`, `# ${file}\n`);
  }
  writeFile(repo, `${rel}/implement.jsonl`, manifests.implement);
  writeFile(repo, `${rel}/check.jsonl`, manifests.check);
  if (!fs.existsSync(path.join(repo, GUIDES_INDEX))) {
    writeFile(repo, GUIDES_INDEX, "# Guides\n");
  }
  return rel;
}

function manifestFiles(repo: string, rel: string): string[] {
  return readFile(repo, rel)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, string>)
    .filter((row) => row.file)
    .map((row) => row.file);
}

describe.skipIf(!hasPython())("task tiers", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-task-tier-test-"));
    setupRepo(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("common/tasks.py: resolve_tier", () => {
    it("prefers a valid meta.tier, otherwise infers from the artifacts on disk", () => {
      const dirs = {
        none: path.join(tmp, "t-none"),
        design: path.join(tmp, "t-design"),
        impl: path.join(tmp, "t-impl"),
      };
      for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dirs.design, "design.md"), "d\n");
      fs.writeFileSync(path.join(dirs.impl, "implement.md"), "i\n");

      const probe = `
import json, sys
sys.path.insert(0, ".arbor/scripts")
from pathlib import Path
from common.tasks import explicit_tier, missing_tier_artifacts, resolve_tier
none, design, impl = (Path(p) for p in sys.argv[1:4])
(none / "prd.md").write_text("p\\n")
print(json.dumps({
    "meta_wins": resolve_tier(impl, {"meta": {"tier": "light"}}),
    "meta_on_empty": resolve_tier(none, {"meta": {"tier": "standard"}}),
    "heavy_impl": resolve_tier(impl, {"meta": {"tier": "heavy"}}),
    "empty_design": resolve_tier(design, {"meta": {"tier": ""}}),
    "non_string_none": resolve_tier(none, {"meta": {"tier": 3}}),
    "absent_design": resolve_tier(design, {}),
    "meta_not_dict": resolve_tier(impl, {"meta": "full"}),
    "data_none": resolve_tier(none, None),
    "normalised": resolve_tier(none, {"meta": {"tier": "Full "}}),
    "explicit_absent": explicit_tier({"meta": {}}),
    "missing_full_none": missing_tier_artifacts(none, "full"),
    "missing_standard_design": missing_tier_artifacts(design, "standard"),
    "missing_unknown_impl": missing_tier_artifacts(impl, "bogus"),
}))
`;
      const r = spawnSync(
        "python3",
        ["-c", probe, dirs.none, dirs.design, dirs.impl],
        { cwd: tmp, encoding: "utf-8" },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        meta_wins: "light",
        meta_on_empty: "standard",
        heavy_impl: "full",
        empty_design: "standard",
        non_string_none: "light",
        absent_design: "standard",
        meta_not_dict: "full",
        data_none: "light",
        normalised: "full",
        explicit_absent: null,
        missing_full_none: ["design.md", "waves.md"],
        missing_standard_design: ["contract.md"],
        missing_unknown_impl: ["contract.md"],
      });
    });
  });

  describe("task.py create --tier / set-meta tier", () => {
    function create(slug: string, ...extra: string[]) {
      return runTask(tmp, [
        "create",
        `${slug} task`,
        "--description",
        "tier fixture",
        "--slug",
        slug,
        ...extra,
      ]);
    }

    it("stores no meta.tier by default and points at the tier and seed-context", () => {
      const r = create("plain");
      expect(r.status, r.stderr).toBe(0);
      const dir = findTaskDir(tmp, "plain");
      expect(readTaskJson(tmp, dir).meta).toEqual({});
      expect(r.stderr).toContain("Tier: not set");
      expect(r.stderr).toContain(`task.py seed-context ${dir}`);
      expect(r.stderr).toContain(`task.py set-meta ${dir} tier light|standard|full`);
      // Pinned by regression.test.ts as well.
      expect(r.stderr).toContain("Curate implement.jsonl / check.jsonl");
      expect(r.stderr).toContain('{"file": "<path>", "reason": "<why>"}');
      expect(r.stderr).toContain("get_context.py --mode packages");

      const contract = readFile(tmp, `.arbor/tasks/${dir}/contract.md`);
      expect(contract).toContain("## Acceptance criteria");
      expect(contract).not.toContain("Lightweight");
    });

    it("--tier standard stores meta.tier", () => {
      const r = create("std", "--tier", "standard");
      expect(r.status, r.stderr).toBe(0);
      expect(readTaskJson(tmp, findTaskDir(tmp, "std")).meta).toEqual({
        tier: "standard",
      });
      expect(r.stderr).toContain("Tier: standard (meta.tier)");
    });

    it("--meta tier=full is the same setting", () => {
      const r = create("viameta", "--meta", "tier=full", "--meta", "epic=x");
      expect(r.status, r.stderr).toBe(0);
      expect(readTaskJson(tmp, findTaskDir(tmp, "viameta")).meta).toEqual({
        tier: "full",
        epic: "x",
      });
    });

    it("--tier and --meta tier= that disagree fail before any directory exists", () => {
      const r = create("clash", "--tier", "full", "--meta", "tier=light");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("conflicts");
      expect(tasksIn(tmp).find((d) => d.includes("clash"))).toBeUndefined();
    });

    it("--meta tier=heavy fails before any directory exists", () => {
      const r = create("heavy", "--meta", "tier=heavy");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("heavy");
      expect(r.stderr).toContain("light, standard, full");
      expect(tasksIn(tmp).find((d) => d.includes("heavy"))).toBeUndefined();
    });

    it("--tier heavy is rejected by argparse", () => {
      const r = create("argp", "--tier", "heavy");
      expect(r.status).toBe(2);
      expect(tasksIn(tmp).find((d) => d.includes("argp"))).toBeUndefined();
    });

    it("set-meta tier rejects a value outside the tiers and normalises a valid one", () => {
      expect(create("setm").status).toBe(0);
      const dir = findTaskDir(tmp, "setm");

      const bad = runTask(tmp, ["set-meta", dir, "tier", "heavy"]);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain("light, standard, full");
      expect(readTaskJson(tmp, dir).meta).toEqual({});

      const ok = runTask(tmp, ["set-meta", dir, "tier", "Standard"]);
      expect(ok.status, ok.stdout).toBe(0);
      expect(readTaskJson(tmp, dir).meta).toEqual({ tier: "standard" });

      // Other keys are untouched by the tier check.
      expect(runTask(tmp, ["set-meta", dir, "execution", "whatever"]).status).toBe(0);
    });
  });

  describe("task.py start: tier gate", () => {
    function start(rel: string, ...extra: string[]) {
      return runTask(tmp, ["start", rel, "--no-worktree", ...extra], SESSION);
    }

    function status(rel: string): unknown {
      return JSON.parse(readFile(tmp, `${rel}/task.json`)).status;
    }

    it("light (inferred) without prd.md fails, even with --allow-empty-context", () => {
      const rel = makeTask(tmp, "10-28-light", { status: "planning" });
      for (const extra of [[], ["--allow-empty-context"]]) {
        const r = start(rel, ...extra);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("tier 'light' requires contract.md before start");
        expect(r.stdout).toContain("Tier: light (inferred from artifacts)");
        expect(r.stdout).not.toContain("Current task set to");
      }
      expect(status(rel)).toBe("planning");
    });

    it("standard without design.md fails with a set-meta hint, and passes once it exists", () => {
      const rel = makeTask(
        tmp,
        "10-28-std",
        { status: "planning", meta: { tier: "standard" } },
        ["prd.md"],
      );
      const r = start(rel);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("tier 'standard' requires design.md before start");
      expect(r.stdout).toContain("Tier: standard (meta.tier)");
      expect(r.stdout).toContain(`task.py set-meta ${rel} tier`);
      expect(status(rel)).toBe("planning");

      writeFile(tmp, `${rel}/design.md`, "# design\n");
      const ok = start(rel);
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      expect(ok.stdout).toContain("Current task set to");
      expect(status(rel)).toBe("in_progress");
    });

    it("full without implement.md fails", () => {
      const rel = makeTask(
        tmp,
        "10-28-full",
        { status: "planning", meta: { tier: "full" } },
        ["prd.md", "design.md"],
      );
      const r = start(rel);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("tier 'full' requires waves.md before start");
    });

    it("meta.execution=parallel needs tier full", () => {
      const rel = makeTask(
        tmp,
        "10-28-par-std",
        { status: "planning", meta: { tier: "standard", execution: "parallel" } },
        ["prd.md", "design.md"],
      );
      const r = start(rel);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(
        "meta.execution=parallel requires tier full (this task: standard)",
      );
      expect(r.stdout).toContain("tier full");
      expect(r.stdout).toContain("execution serial");
      expect(status(rel)).toBe("planning");
    });

    it("meta.execution=parallel with tier full and all artifacts starts", () => {
      const rel = makeTask(
        tmp,
        "10-28-par-full",
        { status: "planning", meta: { tier: "full", execution: " Parallel" } },
        ["prd.md", "design.md", "implement.md"],
      );
      const r = start(rel);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });

    it("a legacy task without meta.tier is inferred full from design + implement", () => {
      const rel = makeTask(
        tmp,
        "10-28-legacy",
        { status: "planning", meta: { execution: "parallel" } },
        ["prd.md", "design.md", "implement.md"],
      );
      const r = start(rel);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(status(rel)).toBe("in_progress");
    });

    it("does not gate an in_progress task (restart after checkout)", () => {
      const rel = makeTask(tmp, "10-28-running", {
        status: "in_progress",
        meta: { tier: "full", execution: "parallel" },
      });
      const r = start(rel);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });

    it("keeps the jsonl gate after the tier gate passes", () => {
      const rel = makeTask(
        tmp,
        "10-28-empty-ctx",
        { status: "planning" },
        ["prd.md"],
        { implement: "", check: "" },
      );
      const r = start(rel);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("no curated entries");
      expect(r.stdout).not.toContain("requires");
    });
  });

  describe("task.py seed-context", () => {
    const PKG_INDEXES = [
      ".arbor/spec/cli/backend/index.md",
      ".arbor/spec/cli/frontend/index.md",
    ];

    function setupMonorepo(config = "packages:\n  cli:\n    path: packages/cli\n"): void {
      writeFile(tmp, ".arbor/config.yaml", config);
      for (const index of PKG_INDEXES) writeFile(tmp, index, "# index\n");
      // A layer without index.md contributes nothing.
      fs.mkdirSync(path.join(tmp, ".arbor/spec/cli/empty-layer"), {
        recursive: true,
      });
      writeFile(tmp, GUIDES_INDEX, "# Guides\n");
    }

    function seededTask(
      name: string,
      data: Record<string, unknown>,
      manifests = { implement: "", check: "" },
    ): string {
      const rel = makeTask(
        tmp,
        name,
        { status: "planning", ...data },
        ["prd.md", "research/b-second.md", "research/a-first.md", "research/notes.txt"],
        manifests,
      );
      return rel;
    }

    it("seeds the task's package indexes, guides and research into both manifests, idempotently", () => {
      setupMonorepo();
      const rel = seededTask("10-28-seed", { package: "cli" });
      const expected = [
        ...PKG_INDEXES,
        GUIDES_INDEX,
        `${rel}/research/a-first.md`,
        `${rel}/research/b-second.md`,
      ];

      const r = runTask(tmp, ["seed-context", rel]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("implement.jsonl: +5 (0 already present)");
      expect(r.stdout).toContain("check.jsonl: +5 (0 already present)");
      for (const p of expected) expect(r.stdout).toContain(`  ${p}`);
      expect(r.stdout).toContain("add-context");
      expect(r.stdout).not.toContain("_example");

      const implement = readFile(tmp, `${rel}/implement.jsonl`);
      const check = readFile(tmp, `${rel}/check.jsonl`);
      expect(implement).toBe(check);
      expect(manifestFiles(tmp, `${rel}/implement.jsonl`)).toEqual(expected);
      const reasons = implement
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { reason: string }).reason);
      expect(reasons).toEqual([
        "Spec index: cli/backend (seed-context)",
        "Spec index: cli/frontend (seed-context)",
        "Shared guides (seed-context)",
        "Task research (seed-context)",
        "Task research (seed-context)",
      ]);

      const again = runTask(tmp, ["seed-context", rel]);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain("implement.jsonl: +0 (5 already present)");
      expect(again.stdout).toContain("check.jsonl: +0 (5 already present)");
      expect(readFile(tmp, `${rel}/implement.jsonl`)).toBe(implement);
      expect(readFile(tmp, `${rel}/check.jsonl`)).toBe(check);

      const validate = runTask(tmp, ["validate", rel]);
      expect(validate.status, validate.stdout).toBe(0);
      const started = runTask(tmp, ["start", rel, "--no-worktree"], SESSION);
      expect(started.status, started.stdout + started.stderr).toBe(0);
      expect(started.stdout).not.toContain("no curated entries");
    });

    it("rejects an unknown --package and lists the available ones", () => {
      setupMonorepo();
      const rel = seededTask("10-28-badpkg", { package: "cli" });
      const r = runTask(tmp, ["seed-context", rel, "--package", "nope"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("unknown package 'nope'");
      expect(r.stderr).toContain("Available: cli");
      expect(readFile(tmp, `${rel}/implement.jsonl`)).toBe("");
    });

    it("fails in a monorepo when neither the task nor config names a package", () => {
      setupMonorepo();
      const rel = seededTask("10-28-nopkg", { package: null });
      const r = runTask(tmp, ["seed-context", rel]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("pass --package <pkg> (available: cli)");
      expect(readFile(tmp, `${rel}/check.jsonl`)).toBe("");
    });

    it("an explicit --package overrides the task's package", () => {
      setupMonorepo(
        "packages:\n  cli:\n    path: packages/cli\n  docs:\n    path: docs\n",
      );
      writeFile(tmp, ".arbor/spec/docs/site/index.md", "# docs\n");
      const rel = seededTask("10-28-override", { package: "cli" });
      const r = runTask(tmp, ["seed-context", rel, "--package", "docs"]);
      expect(r.status, r.stderr).toBe(0);
      expect(manifestFiles(tmp, `${rel}/implement.jsonl`)).toEqual([
        ".arbor/spec/docs/site/index.md",
        GUIDES_INDEX,
        `${rel}/research/a-first.md`,
        `${rel}/research/b-second.md`,
      ]);
    });

    it("seeds the spec root layers in a single repo and ignores --package", () => {
      writeFile(tmp, ".arbor/spec/backend/index.md", "# be\n");
      writeFile(tmp, ".arbor/spec/frontend/index.md", "# fe\n");
      writeFile(tmp, GUIDES_INDEX, "# Guides\n");
      const rel = seededTask("10-28-single", { package: null });
      const r = runTask(tmp, ["seed-context", rel, "--package", "cli"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("--package ignored in single-repo project");
      expect(manifestFiles(tmp, `${rel}/check.jsonl`)).toEqual([
        ".arbor/spec/backend/index.md",
        ".arbor/spec/frontend/index.md",
        GUIDES_INDEX,
        `${rel}/research/a-first.md`,
        `${rel}/research/b-second.md`,
      ]);
      expect(readFile(tmp, `${rel}/implement.jsonl`)).toContain(
        "Spec index: backend (seed-context)",
      );
    });

    it("does not duplicate an entry that is already listed", () => {
      setupMonorepo();
      const mine = JSON.stringify({ file: GUIDES_INDEX, reason: "mine" }) + "\n";
      const rel = seededTask(
        "10-28-preexisting",
        { package: "cli" },
        { implement: mine, check: "" },
      );
      const r = runTask(tmp, ["seed-context", rel]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("implement.jsonl: +4 (1 already present)");
      expect(r.stdout).toContain("check.jsonl: +5 (0 already present)");
      const files = manifestFiles(tmp, `${rel}/implement.jsonl`);
      expect(files.filter((f) => f === GUIDES_INDEX)).toHaveLength(1);
      expect(readFile(tmp, `${rel}/implement.jsonl`).startsWith(mine)).toBe(true);
    });

    it("keeps and warns about a legacy _example row without treating it as a duplicate", () => {
      setupMonorepo();
      // The placeholder text names the guides path; a substring check would
      // have taken it for an existing entry.
      const example =
        JSON.stringify({
          _example: `Fill with {"file": "${GUIDES_INDEX}", "reason": "<why>"}`,
        }) + "\n";
      const rel = seededTask(
        "10-28-example",
        { package: "cli" },
        { implement: example, check: "" },
      );
      const r = runTask(tmp, ["seed-context", rel]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("implement.jsonl: +5 (0 already present)");
      expect(r.stdout).toContain("implement.jsonl still has a legacy `_example` row");
      const implement = readFile(tmp, `${rel}/implement.jsonl`);
      expect(implement.startsWith(example)).toBe(true);
      expect(manifestFiles(tmp, `${rel}/implement.jsonl`)).toContain(GUIDES_INDEX);
    });

    it("add-context still deduplicates normal rows and appends after a row without a newline", () => {
      setupMonorepo();
      const rel = seededTask(
        "10-28-addctx",
        { package: "cli" },
        {
          implement: JSON.stringify({ file: PKG_INDEXES[0], reason: "x" }),
          check: "",
        },
      );
      const added = runTask(tmp, ["add-context", rel, "implement", GUIDES_INDEX, "why"]);
      expect(added.status).toBe(0);
      expect(added.stdout).toContain(`Added file: ${GUIDES_INDEX}`);
      const dup = runTask(tmp, ["add-context", rel, "implement", GUIDES_INDEX, "again"]);
      expect(dup.status).toBe(0);
      expect(dup.stdout).toContain(`Entry already exists for ${GUIDES_INDEX}`);
      expect(manifestFiles(tmp, `${rel}/implement.jsonl`)).toEqual([
        PKG_INDEXES[0],
        GUIDES_INDEX,
      ]);
    });
  });

  describe("get_context.py: Tier line", () => {
    it("prints the pinned tier, and (inferred) for a task without meta.tier", () => {
      const created = runTask(
        tmp,
        [
          "create",
          "ctx task",
          "--description",
          "tier fixture",
          "--slug",
          "ctx",
          "--tier",
          "standard",
        ],
        SESSION,
      );
      expect(created.status, created.stderr).toBe(0);
      const pinned = runScript(tmp, "get_context.py", [], SESSION);
      expect(pinned.status, pinned.stderr).toBe(0);
      expect(pinned.stdout).toMatch(/^Tier: standard$/m);

      const legacy = runTask(
        tmp,
        [
          "create",
          "legacy task",
          "--description",
          "tier fixture",
          "--slug",
          "legacy",
        ],
        SESSION,
      );
      expect(legacy.status, legacy.stderr).toBe(0);
      writeFile(
        tmp,
        `.arbor/tasks/${findTaskDir(tmp, "legacy")}/design.md`,
        "# design\n",
      );
      const inferred = runScript(tmp, "get_context.py", [], SESSION);
      expect(inferred.status, inferred.stderr).toBe(0);
      expect(inferred.stdout).toMatch(/^Tier: standard \(inferred\)$/m);
    });
  });
});
