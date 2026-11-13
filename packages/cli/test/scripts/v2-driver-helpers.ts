/**
 * Shared fixture for the driver tests: a tmp repo with the arbor scripts,
 * a started task in its own worktree, and the Orca executor configured in
 * `.arbor/config.yaml` with a fake Orca CLI (`fake_orca.py`).
 *
 * The fake CLI answers with the shapes Orca 1.4.258 gave in a live run. It
 * creates and removes worktrees (`worktree create` puts workspace `<name>` of
 * repository `<repo>` at `<repo>-wt/<name>`; like Orca it suffixes a taken name
 * or branch with `-2`), creates Runs (`run-create` -> `run-<n>`) and answers
 * `orchestration worker-start` with a receipt (Orca dispatch id
 * `orca-<dispatch>`, a retry on the same Task `orca-<dispatch>-r<n>`;
 * `fake.json` `<dispatch>.start` overrides the receipt, e.g.
 * `{ "state": "failed" }`, `<dispatch>.starts` gives one override per attempt,
 * `<dispatch>.fenced` refuses the start until `run-use`, `<dispatch>.stop:
 * "unknown"` makes `worker-stop` unable to prove the stop). The same
 * `--retry-request` id replays the first answer. It keeps each worker's
 * state in `<tmp>/orca/<id>.json` for `worker-show` and logs every call in
 * `<tmp>/orca/calls.jsonl`. It never runs a role.
 *
 * `dispatch()` plays the worker: `arbor.py run` starts it, the fake role
 * (`fake_exec.py`) saves the prompt it received to
 * `<tmp>/received/<dispatch>.md`, then follows `<tmp>/fake.json`
 * (keyed by dispatch id): `sleep` seconds first, `write` files and commit
 * them with the pinned format (or `message`), leave `dirty` files
 * uncommitted, print `reply` (default: a valid report for the role), exit
 * with `exit`. The helper writes the reply to the request's reply file and
 * settles the worker as `completed`; on a non-zero exit the worker died
 * before it wrote a report (`failed`, no reply). Then it runs `arbor.py sync`.
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

const FAKE_ORCA = String.raw`import json, pathlib, re, subprocess, sys
here = pathlib.Path(__file__).resolve().parent
state = here / "orca"
state.mkdir(exist_ok=True)
argv = [a for a in sys.argv[1:] if a != "--json"]
with (state / "calls.jsonl").open("a") as f:
    f.write(json.dumps(argv) + "\n")
def flag(name):
    return argv[argv.index(name) + 1] if name in argv else None
def emit(payload, code):
    print(json.dumps(payload))
    sys.exit(code)
def out(result):
    emit({"ok": True, "result": result}, 0)
def fail(code, message):
    emit({"ok": False, "error": {"code": code, "message": message}}, 1)
def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
plan_file = here / "fake.json"
plan = json.loads(plan_file.read_text()) if plan_file.exists() else {}
command = " ".join(argv[:2])
if command == "worktree create":
    repo = pathlib.Path(flag("--repo")[len("path:"):])
    if repo.name in plan.get("unregistered", []):
        fail("repo_not_found", "repo_not_found")
    name, branch = flag("--name"), flag("--branch")
    path = repo.parent / (repo.name + "-wt") / name
    # Orca suffixes a taken workspace name or branch instead of refusing
    if path.exists() or git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/" + branch).returncode == 0:
        path, branch = path.with_name(name + "-2"), branch + "-2"
    made = git(repo, "worktree", "add", "--no-track", "-q", "-b", branch, str(path), flag("--base-branch"))
    if made.returncode:
        fail("runtime_error", "Command failed: git worktree add\n" + made.stderr)
    parent = flag("--parent-worktree")
    out({"worktree": {"path": str(path), "branch": "refs/heads/" + branch, "displayName": name,
                      "parentWorktreeId": parent and "repo::" + parent[len("path:"):]}})
if command == "worktree rm":
    path = flag("--worktree")[len("path:"):]
    common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir") if pathlib.Path(path).is_dir() else None
    if common is None or common.returncode:
        fail("selector_not_found", "selector_not_found")
    done = git(pathlib.Path(common.stdout.strip()).parent, "worktree", "remove",
               *(["--force"] if "--force" in argv else []), path)
    if done.returncode:
        fail("runtime_error", "Failed to delete worktree at " + path + ". " + done.stderr.strip())
    out({"removed": True})
if command == "orchestration run-create":
    run = "run-%d" % (len(list(state.glob("run-*"))) + 1)
    (state / run).write_text(flag("--objective"))
    out({"runId": run, "objective": flag("--objective")})
if command == "orchestration run-use":
    (state / ("used-" + flag("--id"))).write_text("")
    out({"runId": flag("--id")})
if command == "orchestration worker-start":
    request = state / ("req-%s.json" % flag("--retry-request"))
    if request.exists():  # the same request again: Orca replays its answer
        emit(*json.loads(request.read_text()))
    if flag("--task"):  # a retry on the same Orca Task
        dispatch = flag("--task")[len("task-"):]
    else:
        dispatch = re.search(r"^Dispatch: (\S+)", pathlib.Path(flag("--spec-file")).read_text(), re.M).group(1)
    spec = plan.get(dispatch, {})
    if spec.get("fenced") and not (state / ("used-" + flag("--run"))).exists():
        fail("consumer_fenced", "worker-start needs the coordinator bound to the Run")
    attempt = len(list(state.glob("orca-" + dispatch + "*.json")))
    overrides = spec.get("starts") or [spec.get("start", {})]
    receipt = {"dispatchId": "orca-" + dispatch + ("-r%d" % attempt if attempt else ""),
               "taskId": "task-" + dispatch, "runId": flag("--run"), "state": "ready",
               **overrides[min(attempt, len(overrides) - 1)]}
    if receipt.get("dispatchId"):
        (state / (receipt["dispatchId"] + ".json")).write_text(json.dumps(
            {"arbor": dispatch,
             "dispatch": {"id": receipt["dispatchId"], "taskId": receipt["taskId"],
                          "status": "failed" if receipt["state"] == "failed" else "dispatched"},
             "worker": {"state": receipt["state"]},
             "projection": {"stage": {"activity": "working"}, "liveness": {"verdict": "live"}},
             "observation": {"agentWait": None}}))
    answer = ({"ok": receipt["state"] == "ready", "result": receipt}, 0 if receipt["state"] == "ready" else 1)
    request.write_text(json.dumps(answer))
    emit(*answer)
if command in ("orchestration worker-show", "orchestration worker-stop", "orchestration worker-release"):
    file = state / (flag("--dispatch") + ".json")
    if not file.exists():
        fail("dispatch_not_found", "Worker Dispatch %s was not found." % flag("--dispatch"))
    data = json.loads(file.read_text())
    if command.endswith("release"):
        out({"dispatchId": data["dispatch"]["id"], "state": "released"})
    if command.endswith("stop"):
        if plan.get(data.get("arbor"), {}).get("stop") == "unknown":
            emit({"ok": False, "result": {"dispatchId": data["dispatch"]["id"], "state": "stop_unknown"}}, 1)
        data["dispatch"]["status"] = "failed"
        data["projection"] = {"stage": {"activity": "unknown"}, "liveness": {"verdict": "exited", "source": "worker_stop"}}
        file.write_text(json.dumps(data))
        out({"dispatchId": data["dispatch"]["id"], "state": "stopped", "alreadySettled": False,
             "processAction": "closed_agent_terminal"})
    if "--full" not in argv:
        # Orca >= 1.4.257: the default view is concise and flat (no dispatch / projection objects)
        out({"dispatchId": data["dispatch"]["id"], "taskId": data["dispatch"].get("taskId"),
             "state": {"completed": "succeeded"}.get(data["dispatch"]["status"], data["dispatch"]["status"])})
    out(data)
fail("unknown_command", command)
`;

/**
 * Write the fake Orca CLI to `<dir>/fake_orca.py` and return the
 * `executors:` section of `.arbor/config.yaml` that uses it. For tests with
 * their own repository setup: `task.py start`, wave starts, integration and
 * finish cleanup create and remove worktrees through Orca, and the real Orca
 * must never be called.
 */
export function fakeOrca(dir: string): string {
  writeFile(dir, "fake_orca.py", FAKE_ORCA);
  return `executors:\n  default: fake\n  fake:\n    type: orca\n    command: "python3 ${path.join(dir, "fake_orca.py")}"\n    agent: codex\n`;
}

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
  const executors = fakeOrca(tmp);
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
    `${executors}    timeout: 30s\n${gate}${mandate}`,
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
export function orcaCalls(f: Pick<Fixture, "tmp">): string[][] {
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
  if (fake.status === 0) fs.writeFileSync(env.reply_path, fake.stdout);
  setOrcaState(f, env.orca_dispatch, {
    dispatch:
      fake.status === 0
        ? { id: env.orca_dispatch, status: "completed" }
        : {
            id: env.orca_dispatch,
            status: "failed",
            terminationReason: fake.stderr || `exit ${fake.status}`,
          },
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
