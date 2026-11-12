/**
 * Shared fixture for the driver tests: a tmp repo with the arbor scripts,
 * a started task in its own worktree, and the Orca executor configured in
 * `.arbor/config.yaml` with a fake Orca CLI (`fake_orca.py`).
 *
 * The fake CLI answers `orchestration worker-start` with a receipt (Orca
 * dispatch id `orca-<dispatch>`; `fake.json` `<dispatch>.start` overrides the
 * receipt, e.g. `{ "state": "failed" }`), keeps each worker's state in
 * `<tmp>/orca/<id>.json` for `worker-show` and logs every call in
 * `<tmp>/orca/calls.jsonl`. It never runs a role.
 *
 * `dispatch()` plays the worker: `arbor.py run` starts it, the fake role
 * (`fake_exec.py`) saves the prompt it received to
 * `<tmp>/received/<dispatch>.md`, then follows `<tmp>/fake.json`
 * (keyed by dispatch id): `sleep` seconds first, `write` files and commit
 * them with the pinned format (or `message`), leave `dirty` files
 * uncommitted, print `reply` (default: a valid report for the role), exit
 * with `exit`. The helper writes the reply to the request's reply file,
 * settles the worker (`completed`, or `failed` on a non-zero exit) and runs
 * `arbor.py sync`.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/arbor/scripts",
);
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

const FAKE_EXEC =
  String.raw`import json, pathlib, subprocess, sys, time
role, prompt, worktree, task, dispatch = sys.argv[1:6]
here = pathlib.Path(__file__).resolve().parent
(here / "received").mkdir(exist_ok=True)
(here / "received" / (dispatch + ".md")).write_bytes(pathlib.Path(prompt).read_bytes())
plan_file = here / "fake.json"
plan = json.loads(plan_file.read_text()) if plan_file.exists() else {}
spec = plan.get(dispatch, {})
DEFAULT = {
    "implement": "## Implementation Complete\n",
    "fix": "## Fix: Done\n\n### Findings\n1. a.txt:1 x -> fixed: y\n",
    "simplify": "## Simplify: No Change\n",
    "review": "PASS\n\n` +
  "```json\\n[]\\n```" +
  String.raw`\nMode: self-check; angles: A; single-context pass.\n",
    "verify": "` +
  "```json\\n[]\\n```" +
  String.raw`\nCONFIRMED 0, PLAUSIBLE 0, REFUTED 0.\n",
    "explore": "## Explore Results\n\n### Conclusion\ncanary ok\n",
}
def git(*args):
    subprocess.run(["git", *args], cwd=worktree, check=True, capture_output=True)
time.sleep(spec.get("sleep", 0))
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

const FAKE_ORCA = String.raw`import json, pathlib, re, sys
here = pathlib.Path(__file__).resolve().parent
state = here / "orca"
state.mkdir(exist_ok=True)
argv = [a for a in sys.argv[1:] if a != "--json"]
with (state / "calls.jsonl").open("a") as f:
    f.write(json.dumps(argv) + "\n")
def flag(name):
    return argv[argv.index(name) + 1] if name in argv else None
def out(result, ok=True, code=0):
    print(json.dumps({"ok": ok, "result": result} if ok else {"ok": False, "error": result}))
    sys.exit(code)
command = " ".join(argv[:2])
if command == "orchestration worker-start":
    spec = pathlib.Path(flag("--spec-file")).read_text()
    dispatch = re.search(r"^Dispatch: (\S+)", spec, re.M).group(1)
    plan_file = here / "fake.json"
    plan = json.loads(plan_file.read_text()) if plan_file.exists() else {}
    receipt = {"dispatchId": "orca-" + dispatch, "taskId": "task-" + dispatch, "runId": "run-1",
               "state": "ready", **plan.get(dispatch, {}).get("start", {})}
    if receipt.get("dispatchId"):
        (state / (receipt["dispatchId"] + ".json")).write_text(json.dumps(
            {"dispatch": {"id": receipt["dispatchId"], "taskId": receipt["taskId"],
                          "status": "failed" if receipt["state"] == "failed" else "dispatched"},
             "worker": {"state": "running"}, "projection": {"liveness": {"verdict": "live"}}}))
    out(receipt, code=0 if receipt["state"] == "ready" else 1)
if command in ("orchestration worker-show", "orchestration worker-stop"):
    file = state / (flag("--dispatch") + ".json")
    if not file.exists():
        out({"code": "dispatch_not_found", "message": "no such dispatch"}, ok=False, code=1)
    data = json.loads(file.read_text())
    if command.endswith("stop"):
        data["projection"] = {"liveness": {"verdict": "exited"}}
        file.write_text(json.dumps(data))
    if command.endswith("show") and "--full" not in argv:
        # Orca >= 1.4.257: the default view is concise and flat (no dispatch / projection objects)
        out({"dispatchId": data["dispatch"]["id"], "taskId": data["dispatch"]["taskId"],
             "state": {"completed": "succeeded"}.get(data["dispatch"]["status"], data["dispatch"]["status"]),
             "liveness": data["projection"]["liveness"]["verdict"]})
    out(data)
if command == "worktree set":
    out({})
out({"code": "unknown_command", "message": command}, ok=False, code=1)
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

`;

/** The AC-1 check; red until src/feature.txt exists. */
export const RED_TEST = {
  path: "tests/ac1.sh",
  content: "test -f src/feature.txt\n",
};
export const FEATURE = { path: "src/feature.txt", content: "feature\n" };
/** What implement commits by default: the check and the feature it proves. */
export const IMPLEMENTED = [RED_TEST, FEATURE];

/** Loose JSON view for assertions on task.json, `next --json` and results rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Fixture {
  tmp: string;
  repo: string;
  wt: string;
  taskDir: string;
  run: (...args: string[]) => RunResult;
  next: () => Json;
  taskJson: () => Json;
  plan: (spec: Record<string, unknown>) => void;
  brief: (dispatch: string, text?: string) => void;
  results: () => Json[];
  cleanup: () => void;
}

/** `start: false` leaves the task in planning, in the main checkout (CONTRACT phase). */
export function setupFixture(
  opts: {
    tier?: string;
    gate?: string[];
    start?: boolean;
    contract?: string;
    mandate?: "ask" | "default";
  } = {},
): Fixture {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-driver-")),
  );
  const repo = path.join(tmp, "proj");
  const wt = path.join(tmp, "proj-wt", TASK);
  const started = opts.start ?? true;
  const taskDir = started
    ? path.join(wt, ".arbor", "tasks", TASK)
    : path.join(repo, ".arbor", "tasks", TASK);
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
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(repo, ".arbor", "scripts"), {
    recursive: true,
  });
  writeFile(tmp, "fake_exec.py", FAKE_EXEC);
  writeFile(tmp, "fake_orca.py", FAKE_ORCA);
  const gate = opts.gate?.length
    ? `gate:\n  commands:\n${opts.gate.map((c) => `    - "${c}"`).join("\n")}\n`
    : "";
  // Every human gate asks by default, so the driver tests see the gates themselves;
  // `mandate: "default"` keeps the shipped per-tier defaults (the mandate tests).
  const gatesAsk = "    contract: ask\n    plausible: ask\n    merge: ask\n";
  const mandate =
    opts.mandate === "default"
      ? ""
      : `mandate:\n  light:\n${gatesAsk}  standard:\n${gatesAsk}  full:\n${gatesAsk}`;
  writeFile(
    repo,
    ".arbor/config.yaml",
    `executors:\n  default: fake\n  fake:\n    type: orca\n    command: "python3 ${path.join(tmp, "fake_orca.py")}"\n    agent: codex\n    timeout: 30s\n${gate}${mandate}`,
  );
  const rel = `.arbor/tasks/${TASK}`;
  writeFile(
    repo,
    `${rel}/task.json`,
    JSON.stringify({
      id: "feat",
      name: "feat",
      title: "Feat",
      status: "planning",
      children: [],
      meta: { tier: opts.tier ?? "light" },
    }) + "\n",
  );
  writeFile(repo, `${rel}/contract.md`, opts.contract ?? CONTRACT);
  if ((opts.tier ?? "light") !== "light")
    writeFile(repo, `${rel}/design.md`, "# Design\n");
  if (opts.tier === "full") writeFile(repo, `${rel}/waves.md`, "# Waves\n");
  writeFile(repo, ".arbor/spec/guides/index.md", "# Guides\n");
  const curated =
    JSON.stringify({ file: ".arbor/spec/guides/index.md", reason: "guides" }) +
    "\n";
  writeFile(repo, `${rel}/implement.jsonl`, curated);
  writeFile(repo, `${rel}/check.jsonl`, curated);
  const env = { ...process.env, ...SESSION };
  let r = spawnSync("python3", [".arbor/scripts/init_developer.py", "tester"], {
    cwd: repo,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`init_developer failed: ${r.stderr}`);
  if (started) {
    r = spawnSync("python3", [".arbor/scripts/task.py", "start", TASK], {
      cwd: repo,
      encoding: "utf-8",
      env,
    });
    if (r.status !== 0) throw new Error(`start failed: ${r.stdout}${r.stderr}`);
  }

  const run = (...args: string[]) => {
    const res = spawnSync(
      "python3",
      [path.join(repo, ".arbor/scripts/arbor.py"), ...args],
      {
        cwd: repo,
        encoding: "utf-8",
        env,
      },
    );
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  return {
    tmp,
    repo,
    wt,
    taskDir,
    run,
    next: () => {
      const res = run("next", "--json");
      if (res.status !== 0) throw new Error(`next failed: ${res.stderr}`);
      return JSON.parse(res.stdout);
    },
    taskJson: () =>
      JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")),
    plan: (spec) =>
      fs.writeFileSync(path.join(tmp, "fake.json"), JSON.stringify(spec)),
    brief: (dispatch, text = `Brief for ${dispatch}.`) =>
      writeFile(taskDir, `briefs/${dispatch}.md`, text + "\n"),
    results: () =>
      fs
        .readFileSync(path.join(repo, ".arbor/.runtime/results.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    cleanup: () =>
      fs.rmSync(tmp, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      }),
  };
}

/** The started worker `arbor.py run` printed (`needs=worker`). */
export function worker(res: RunResult): Json {
  if (res.status !== 0)
    throw new Error(`run failed: ${res.stdout}${res.stderr}`);
  const out = JSON.parse(res.stdout);
  if (out.needs !== "worker")
    throw new Error(`expected a started worker: ${res.stdout}`);
  return out;
}

/** The fake Orca state file of a started worker. */
export function orcaState(f: Fixture, orcaDispatch: string): string {
  return path.join(f.tmp, "orca", `${orcaDispatch}.json`);
}

/** Merge `patch` into the fake Orca state of a started worker. */
export function setOrcaState(
  f: Fixture,
  orcaDispatch: string,
  patch: Json,
): void {
  const file = orcaState(f, orcaDispatch);
  const state = JSON.parse(fs.readFileSync(file, "utf-8"));
  fs.writeFileSync(file, JSON.stringify({ ...state, ...patch }));
}

/** Every call the driver made to the fake Orca CLI (argv without `--json`). */
export function orcaCalls(f: Fixture): string[][] {
  const file = path.join(f.tmp, "orca", "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

/**
 * Play the worker of a started dispatch: run the fake role, write its reply
 * to the reply file, settle the worker in the fake Orca, then `arbor.py sync`.
 * Returns the sync result (status 1 when the driver marked the dispatch
 * failed).
 */
export function complete(
  f: Fixture,
  res: RunResult,
  extraArgs: string[] = [],
): RunResult {
  const env = worker(res);
  const record = JSON.parse(fs.readFileSync(env.request_path, "utf-8"));
  const fake = spawnSync(
    "python3",
    [
      path.join(f.tmp, "fake_exec.py"),
      record.role,
      env.prompt_path,
      record.worktree,
      record.task ?? TASK,
      record.dispatch,
    ],
    { cwd: f.repo, encoding: "utf-8" },
  );
  if (fake.status === null)
    throw new Error(`fake role did not run: ${fake.stderr}`);
  fs.writeFileSync(env.reply_path, fake.stdout);
  setOrcaState(f, env.orca_dispatch, {
    dispatch: {
      id: env.orca_dispatch,
      status: fake.status === 0 ? "completed" : "failed",
    },
    lastReport: fake.status === 0 ? "done" : fake.stderr || `exit ${fake.status}`,
  });
  return f.run(
    "--task",
    record.task_dir,
    "sync",
    "--dispatch",
    record.dispatch,
    ...extraArgs,
  );
}

/** Brief + run one dispatch and play its role; returns the sync result (or the refused run). */
export function dispatch(
  f: Fixture,
  id: string,
  ...runArgs: string[]
): RunResult {
  f.brief(id);
  const res = f.run("run", "--dispatch", id, ...runArgs);
  if (res.status !== 0) return res;
  return complete(f, res);
}

/** `arbor.py <args>` as a child process that runs alongside others. */
export function runAsync(f: Fixture, ...args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "python3",
      [path.join(f.repo, ".arbor/scripts/arbor.py"), ...args],
      {
        cwd: f.repo,
        env: { ...process.env, ...SESSION },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
