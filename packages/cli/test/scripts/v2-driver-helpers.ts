/**
 * Shared fixture for the v2 driver tests: a tmp repo with the arbor scripts,
 * a started task in its own worktree, and a fake executor configured in
 * `.arbor/config.yaml`.
 *
 * The fake (`fake_exec.py`) saves the prompt it received to
 * `<tmp>/received/<dispatch>.md`, then follows `<tmp>/fake.json`
 * (keyed by dispatch id): `write` files and commit them with the pinned
 * format (or `message`), leave `dirty` files uncommitted, print `reply`
 * (default: a valid report for the role), exit with `exit`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMPLATE_SCRIPTS = path.resolve(__dirname, "../../src/templates/arbor/scripts");
export const TASK = "10-30-feat";
export const SESSION = { ARBOR_CONTEXT_ID: "v2-driver-session" };

export function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

const FAKE_EXEC = String.raw`import json, pathlib, subprocess, sys
role, prompt, worktree, task, dispatch = sys.argv[1:6]
here = pathlib.Path(__file__).resolve().parent
(here / "received").mkdir(exist_ok=True)
(here / "received" / (dispatch + ".md")).write_bytes(pathlib.Path(prompt).read_bytes())
plan_file = here / "fake.json"
plan = json.loads(plan_file.read_text()) if plan_file.exists() else {}
spec = plan.get(dispatch, {})
DEFAULT = {
    "test": "## Tests Written\n\n### Red run\n$ sh tests/ac1.sh\nexit 1\n",
    "implement": "## Implementation Complete\n",
    "fix": "## Fix: Done\n\n### Findings\n1. a.txt:1 x -> fixed: y\n",
    "simplify": "## Simplify: No Change\n",
    "review": "PASS\n\n` + "```json\\n[]\\n```" + String.raw`\nMode: self-check; angles: A; single-context pass.\n",
    "verify": "` + "```json\\n[]\\n```" + String.raw`\nCONFIRMED 0, PLAUSIBLE 0, REFUTED 0.\n",
    "explore": "## Explore Results\n\n### Conclusion\ncanary ok\n",
}
def git(*args):
    subprocess.run(["git", *args], cwd=worktree, check=True, capture_output=True)
for f in spec.get("write", []):
    p = pathlib.Path(worktree, f["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f["content"])
    git("add", f["path"])
if spec.get("write"):
    git("commit", "-q", "-m", spec.get("message") or (role + "(" + task + "): work\n\nArbor-Dispatch: " + dispatch))
for f in spec.get("dirty", []):
    p = pathlib.Path(worktree, f["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f["content"])
sys.stderr.write(spec.get("stderr", ""))
sys.stdout.write(spec.get("reply", DEFAULT.get(role, "ok\n")))
sys.exit(spec.get("exit", 0))
`;

export const CONTRACT = `# Feature

## Goal

Add the feature file.

## Acceptance criteria

- AC-1: Given the repo When the feature lands Then src/feature.txt exists

## Verification map

| id   | kind | check             | file         |
|------|------|-------------------|--------------|
| AC-1 | auto | \`sh tests/ac1.sh\` | tests/ac1.sh |

## Interface pins

- existing interfaces

## Test paths

- tests/**
`;

/** A test commit that is red until src/feature.txt exists. */
export const RED_TEST = { path: "tests/ac1.sh", content: "test -f src/feature.txt\n" };
export const FEATURE = { path: "src/feature.txt", content: "feature\n" };

/** Loose JSON view for assertions on task.json, `next --json` and results rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export interface Fixture {
  tmp: string;
  repo: string;
  wt: string;
  taskDir: string;
  run: (...args: string[]) => { status: number | null; stdout: string; stderr: string };
  next: () => Json;
  taskJson: () => Json;
  plan: (spec: Record<string, unknown>) => void;
  brief: (dispatch: string, text?: string) => void;
  results: () => Json[];
  cleanup: () => void;
}

export function setupFixture(opts: { tier?: string; gate?: string[]; executor?: string } = {}): Fixture {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-driver-")));
  const repo = path.join(tmp, "proj");
  const wt = path.join(tmp, "proj-wt", TASK);
  const taskDir = path.join(wt, ".arbor", "tasks", TASK);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "tester");
  // No detached auto-gc / maintenance writing into the tmp dir while it is removed.
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "maintenance.auto", "false");
  writeFile(repo, "README.md", "hi\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(repo, ".arbor", "scripts"), { recursive: true });
  writeFile(tmp, "fake_exec.py", FAKE_EXEC);
  const command =
    opts.executor ?? `python3 ${path.join(tmp, "fake_exec.py")} {role} {prompt} {worktree} {task} {dispatch}`;
  const gate = opts.gate?.length
    ? `gate:\n  commands:\n${opts.gate.map((c) => `    - "${c}"`).join("\n")}\n`
    : "";
  writeFile(
    repo,
    ".arbor/config.yaml",
    `executors:\n  default: fake\n  fake:\n    command: "${command}"\n    timeout: 30s\n${gate}`,
  );
  const rel = `.arbor/tasks/${TASK}`;
  writeFile(
    repo,
    `${rel}/task.json`,
    JSON.stringify({
      id: "feat", name: "feat", title: "Feat", status: "planning", children: [],
      meta: { tier: opts.tier ?? "light" },
    }) + "\n",
  );
  writeFile(repo, `${rel}/contract.md`, CONTRACT);
  if ((opts.tier ?? "light") !== "light") writeFile(repo, `${rel}/design.md`, "# Design\n");
  writeFile(repo, ".arbor/spec/guides/index.md", "# Guides\n");
  const curated = JSON.stringify({ file: ".arbor/spec/guides/index.md", reason: "guides" }) + "\n";
  writeFile(repo, `${rel}/implement.jsonl`, curated);
  writeFile(repo, `${rel}/check.jsonl`, curated);
  const env = { ...process.env, ...SESSION };
  let r = spawnSync("python3", [".arbor/scripts/init_developer.py", "tester"], { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`init_developer failed: ${r.stderr}`);
  r = spawnSync("python3", [".arbor/scripts/task.py", "start", TASK], { cwd: repo, encoding: "utf-8", env });
  if (r.status !== 0) throw new Error(`start failed: ${r.stdout}${r.stderr}`);

  const run = (...args: string[]) => {
    const res = spawnSync("python3", [path.join(repo, ".arbor/scripts/arbor.py"), ...args], {
      cwd: repo, encoding: "utf-8", env,
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  return {
    tmp, repo, wt, taskDir, run,
    next: () => {
      const res = run("next", "--json");
      if (res.status !== 0) throw new Error(`next failed: ${res.stderr}`);
      return JSON.parse(res.stdout);
    },
    taskJson: () => JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")),
    plan: (spec) => fs.writeFileSync(path.join(tmp, "fake.json"), JSON.stringify(spec)),
    brief: (dispatch, text = `Brief for ${dispatch}.`) =>
      writeFile(taskDir, `briefs/${dispatch}.md`, text + "\n"),
    results: () =>
      fs.readFileSync(path.join(repo, ".arbor/.runtime/results.jsonl"), "utf-8")
        .trim().split("\n").map((l) => JSON.parse(l)),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

/** Brief + run one dispatch; returns the run result. */
export function dispatch(f: Fixture, id: string) {
  f.brief(id);
  return f.run("run", "--dispatch", id);
}
