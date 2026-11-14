/**
 * Shared fixture for the arbor 1.0 driver tests: a control repository with
 * the arbor scripts, the Orca executor configured in `.arbor/config.yaml`
 * with a fake Orca CLI (`fake_orca.py`), and helpers that play the workers.
 *
 * The fake CLI answers with the shapes Orca 1.4.258 gave in a live run:
 * - `repo list` lists the projects in `<tmp>/orca-repos.json` (the control
 *   repository by default); `repo add` appends to it (`fake.json`
 *   `repo_add: "fail"` refuses); `worktree create` for any other repository
 *   fails with `repo_not_found`.
 * - `worktree create` puts workspace `<name>` of repository `<repo>` at
 *   `<repo>-wt/<name>`; like Orca it suffixes a taken name or branch with
 *   `-2` instead of refusing. `worktree rm` without `--force` refuses a dirty
 *   worktree (git does).
 * - `run-create` -> `run-<n>`; `orchestration check` answers the `mail` of
 *   `fake.json`.
 * - `worker-start` keys a worker by its spec file's stem (`n1`, `n1.r2`):
 *   Orca dispatch id `orca-<key>`, a retry on the same Task
 *   `orca-<key>-r<n>`. `fake.json` `<key>.start` overrides the receipt (e.g.
 *   `{ "state": "failed" }`), `<key>.starts` gives one override per attempt,
 *   `<key>.fenced` refuses until `run-use`, `<key>.stop: "unknown"` makes
 *   `worker-stop` unable to prove the stop. The same `--retry-request` id
 *   replays the first answer.
 * It keeps each worker's state in `<tmp>/orca/<id>.json` for `worker-show`
 * and logs every call in `<tmp>/orca/calls.jsonl`. It never runs an agent:
 * `work()` plays the worker.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/arbor/scripts",
);

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
repos_file = here / "orca-repos.json"
projects = json.loads(repos_file.read_text()) if repos_file.exists() else []
command = " ".join(argv[:2])
if command == "repo list":
    out({"repos": [{"id": "repo-%d" % i, "path": p} for i, p in enumerate(projects)]})
if command == "repo add":
    if plan.get("repo_add") == "fail":
        fail("invalid_argument", "not a git repository")
    repos_file.write_text(json.dumps([*projects, flag("--path")]))
    out({"repo": {"id": "repo-%d" % len(projects), "path": flag("--path")}})
if command == "worktree create":
    repo = pathlib.Path(flag("--repo")[len("path:"):])
    if str(repo.resolve()) not in [str(pathlib.Path(p).resolve()) for p in projects]:
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
if command == "orchestration check":
    out({"messages": plan.get("mail", [])})
if command == "orchestration worker-start":
    request = state / ("req-%s.json" % flag("--retry-request"))
    if request.exists():  # the same request again: Orca replays its answer
        emit(*json.loads(request.read_text()))
    if flag("--task"):  # a retry on the same Orca Task
        key = flag("--task")[len("task-"):]
    else:
        key = pathlib.Path(flag("--spec-file")).stem
    spec = plan.get(key, {})
    if spec.get("fenced") and not (state / ("used-" + flag("--run"))).exists():
        fail("consumer_fenced", "worker-start needs the coordinator bound to the Run")
    attempt = len(list(state.glob("orca-" + key + ".json"))) + len(list(state.glob("orca-" + key + "-r*.json")))
    overrides = spec.get("starts") or [spec.get("start", {})]
    receipt = {"dispatchId": "orca-" + key + ("-r%d" % attempt if attempt else ""),
               "taskId": "task-" + key, "runId": flag("--run"), "state": "ready",
               **overrides[min(attempt, len(overrides) - 1)]}
    if receipt.get("dispatchId"):
        (state / (receipt["dispatchId"] + ".json")).write_text(json.dumps(
            {"arbor": key, "worktree": flag("--worktree")[len("path:"):], "agent": flag("--agent"),
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
 * `executors:` section of `.arbor/config.yaml` that uses it. The real Orca
 * must never be called.
 */
export function fakeOrca(dir: string, extra = ""): string {
  writeFile(dir, "fake_orca.py", FAKE_ORCA);
  return (
    `executors:\n  default: fake\n  fake:\n    type: orca\n` +
    `    command: "python3 ${path.join(dir, "fake_orca.py")}"\n    agent: codex\n    timeout: 2h\n${extra}`
  );
}

export const CONTRACT = `# Feature

## Goal

Add the feature file.

## Acceptance criteria

- AC-1: Given the repo When the feature lands Then src/feature.txt exists
- AC-2: Given the feature When a person reads it Then it reads well

## Verification map

| id   | kind   | check                     | file |
|------|--------|---------------------------|------|
| AC-1 | auto   | \`test -f src/feature.txt\` | -    |
| AC-2 | manual | read src/feature.txt      | -    |
`;

/** Loose JSON view for assertions on task.json and `--json` output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface File {
  path: string;
  content: string;
}

export interface Project {
  tmp: string;
  repo: string;
  task: string;
  taskDir: string;
  run: (...args: string[]) => RunResult;
  /** `arbor.py <args>` that must exit 0; returns stdout. */
  ok: (...args: string[]) => string;
  sync: () => Json;
  taskJson: () => Json;
  node: (id: string, front: Record<string, string>, brief?: string) => void;
  plan: (spec: Json) => void;
  orcaRepos: (paths: string[]) => void;
  cleanup: () => void;
}

export interface ProjectOptions {
  gate?: string[];
  /** Appended under the fake executor (e.g. `    max_parallel: 1\n`). */
  executor?: string;
  /** Appended to `.arbor/config.yaml`. */
  config?: string;
  contract?: string;
  /** `false`: leave the task in planning. */
  start?: boolean;
  /** Called after the control repo exists and before the task is created. */
  before?: (repo: string) => void;
  newArgs?: string[];
}

export function initRepo(dir: string, branch = "main"): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "tester");
  // No detached auto-gc / maintenance writing into the tmp dir while it is removed.
  git(dir, "config", "gc.auto", "0");
  git(dir, "config", "maintenance.auto", "false");
  writeFile(dir, "README.md", "hi\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
}

/** A control repo with a task created (`new`), its contract written and approved (`start`). */
export function setupProject(opts: ProjectOptions = {}): Project {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "arbor1-")),
  );
  const repo = path.join(tmp, "proj");
  initRepo(repo);
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(repo, ".arbor", "scripts"), {
    recursive: true,
  });
  const gate = opts.gate?.length
    ? `gate:\n  commands:\n${opts.gate.map((c) => `    - "${c}"`).join("\n")}\n`
    : "";
  writeFile(
    repo,
    ".arbor/config.yaml",
    `${fakeOrca(tmp, opts.executor)}${gate}${opts.config ?? ""}`,
  );
  writeFile(
    repo,
    ".gitignore",
    ".arbor/.runtime/\n.arbor/.developer\n**/__pycache__/\n/*-wt/\n",
  );
  fs.writeFileSync(path.join(tmp, "orca-repos.json"), JSON.stringify([repo]));
  const r = spawnSync("python3", [".arbor/scripts/init_developer.py", "tester"], {
    cwd: repo,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`init_developer failed: ${r.stderr}`);
  opts.before?.(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "arbor");

  const run = (...args: string[]): RunResult => {
    const res = spawnSync(
      "python3",
      [path.join(repo, ".arbor/scripts/arbor.py"), ...args],
      { cwd: repo, encoding: "utf-8", // a Claude Code session running the suite must not make the driver inline nodes
        env: { ...process.env, CLAUDECODE: "" } },
    );
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const ok = (...args: string[]): string => {
    const res = run(...args);
    if (res.status !== 0)
      throw new Error(
        `arbor.py ${args.join(" ")} exited ${res.status}:\n${res.stdout}${res.stderr}`,
      );
    return res.stdout;
  };
  const created = ok("new", "Feature", "--slug", "feat", ...(opts.newArgs ?? []));
  const taskDir = created.match(/^created (.+)$/m)?.[1] ?? "";
  const task = path.basename(taskDir);
  fs.writeFileSync(
    path.join(taskDir, "contract.md"),
    opts.contract ?? CONTRACT,
  );
  if (opts.start ?? true) ok("start");
  return {
    tmp,
    repo,
    task,
    taskDir,
    run,
    ok,
    sync: () => JSON.parse(ok("sync", "--json")),
    taskJson: () =>
      JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")),
    node: (id, front, brief = `Do ${id}.`) =>
      writeFile(
        taskDir,
        `nodes/${id}.md`,
        `---\n${Object.entries(front)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}\n---\n${brief}\n`,
      ),
    plan: (spec) =>
      fs.writeFileSync(path.join(tmp, "fake.json"), JSON.stringify(spec)),
    orcaRepos: (paths) =>
      fs.writeFileSync(path.join(tmp, "orca-repos.json"), JSON.stringify(paths)),
    cleanup: () =>
      fs.rmSync(tmp, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      }),
  };
}

/** The request record of a started node (`key`: `n1`, `n1.r2`). */
export function request(p: Project, key: string): Json {
  return JSON.parse(
    fs.readFileSync(
      path.join(p.repo, ".arbor/.runtime/workers", p.task, `${key}.json`),
      "utf-8",
    ),
  );
}

/** The fake Orca state file of a started worker. */
export function orcaState(p: Pick<Project, "tmp">, orcaDispatch: string): string {
  return path.join(p.tmp, "orca", `${orcaDispatch}.json`);
}

/** Merge `patch` into the fake Orca state of a started worker. */
export function setOrcaState(
  p: Pick<Project, "tmp">,
  orcaDispatch: string,
  patch: Json,
): void {
  const file = orcaState(p, orcaDispatch);
  const state = JSON.parse(fs.readFileSync(file, "utf-8"));
  fs.writeFileSync(file, JSON.stringify({ ...state, ...patch }));
}

/** Every call the driver made to the fake Orca CLI (argv without `--json`). */
export function orcaCalls(p: Pick<Project, "tmp">): string[][] {
  const file = path.join(p.tmp, "orca", "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

export interface Work {
  /** Files written and committed (one commit). */
  write?: File[];
  /** Files left uncommitted. */
  dirty?: File[];
  /** The report; default "done\n". `""` writes none. */
  report?: string;
  /** How the worker settles in Orca; default "completed". `null`: keep it running. */
  settle?: "completed" | "failed" | null;
  message?: string;
}

/** Play the worker of a started node: change its worktree, write the report, settle it in the fake Orca. */
export function work(p: Project, key: string, w: Work = {}): void {
  const rec = request(p, key);
  const wt = rec.worktree as string;
  for (const f of w.write ?? []) {
    writeFile(wt, f.path, f.content);
    git(wt, "add", f.path);
  }
  if (w.write?.length)
    git(wt, "commit", "-q", "-m", w.message ?? `${p.task}/${key}: work`);
  for (const f of w.dirty ?? []) writeFile(wt, f.path, f.content);
  const report = w.report ?? "done\n";
  if (report) fs.writeFileSync(rec.report_path, report);
  const settle = w.settle === undefined ? "completed" : w.settle;
  if (settle)
    setOrcaState(p, rec.orca.dispatch_id, {
      dispatch: {
        id: rec.orca.dispatch_id,
        status: settle,
        ...(settle === "failed" ? { terminationReason: "worker said it failed" } : {}),
      },
    });
}

/** `arbor.py <args>` as a child process that runs alongside others. */
export function runAsync(p: Project, ...args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "python3",
      [path.join(p.repo, ".arbor/scripts/arbor.py"), ...args],
      { cwd: p.repo },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
