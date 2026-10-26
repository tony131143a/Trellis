/**
 * Integration tests for `.arbor/scripts/dispatch.py`, the terminal dispatch
 * of the implement / check / research roles to codeg assistants.
 *
 * Scripts, assistant instruction sources and the shipped `config.yaml` are
 * stamped into a fresh temp project and run under the real `python3`.
 * `dispatch.codeg_cli` points at a fake `codeg-cli` shell script that records
 * its argv and stdin, so neither the real codeg-cli nor the real codeg
 * database is ever touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATES = path.resolve(__dirname, "../../src/templates");
const TEMPLATE_SCRIPTS = path.join(TEMPLATES, "arbor", "scripts");
const TEMPLATE_AGENTS = path.join(TEMPLATES, "arbor", "agents");
const CONFIG_TEMPLATE = path.join(TEMPLATES, "arbor", "config.yaml");
const HOOK_PATH = path.join(
  TEMPLATES,
  "shared-hooks",
  "inject-delegation-context.py",
);
const TOOL_NAME = "mcp__codeg-mcp__delegate_to_agent";
const MARKER = "<!-- arbor-hook-injected -->";
const TASK = "10-24-foo";
const TASK_REL = `.arbor/tasks/${TASK}`;

// Records argv (one line per arg) and stdin of every call as
// calls/<n>.argv / calls/<n>.stdin; `-o FILE` gets "REPLY <n>".
// assistants: prints assistants.json if present, else fails like an
// unreachable codeg (exit 4). result: exits 6 once when still-running is
// present (then deletes it), else writes the -o file.
const FAKE_CODEG_CLI = `#!/bin/sh
dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dir/calls"
n=$(ls "$dir/calls" | grep -c '\\.argv$')
n=$((n + 1))
: > "$dir/calls/$n.argv"
for a in "$@"; do printf '%s\\n' "$a" >> "$dir/calls/$n.argv"; done
out=""; prev=""; cmd=""; detach=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$a" = "--detach" ] && detach=1
  if [ -z "$cmd" ]; then
    case "$a" in run|result|assistants) cmd="$a";; esac
  fi
  prev="$a"
done
case "$cmd" in
  assistants)
    if [ -f "$dir/assistants.json" ]; then cat "$dir/assistants.json"; exit 0; fi
    echo "error: no Codeg is running" >&2; exit 4;;
  result)
    if [ -f "$dir/still-running" ]; then rm "$dir/still-running"; exit 6; fi
    [ -n "$out" ] && echo "REPLY $n" > "$out"
    echo "REPLY $n"; exit 0;;
  run)
    cat > "$dir/calls/$n.stdin"
    if [ -n "$detach" ]; then echo "8d0c7c2e-aaaa-bbbb"; exit 0; fi
    [ -n "$out" ] && echo "REPLY $n" > "$out"
    echo "REPLY $n"; exit 0;;
esac
exit 2
`;

const ASSISTANT_COLUMNS_SQL =
  "CREATE TABLE assistant (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE," +
  " name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL," +
  " agent_type TEXT NOT NULL, agent_options TEXT NOT NULL, label_snapshot TEXT NOT NULL," +
  " instructions TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT 1," +
  " sort_order INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1," +
  " created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Host env without anything that would leak a real session or codeg. */
function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("ARBOR_") ||
      key.startsWith("CLAUDE") ||
      key.startsWith("STARFACTORY") ||
      key.startsWith("CODEG")
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...overrides };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!hasPython())("dispatch.py", () => {
  let tmp: string;
  let taskDir: string;
  let fakeDir: string;
  let fakeCli: string;
  let runsDir: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-dispatch-py-")),
    );
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".arbor", "scripts"), {
      recursive: true,
    });
    fs.cpSync(TEMPLATE_AGENTS, path.join(tmp, ".arbor", "agents"), {
      recursive: true,
    });
    fakeDir = path.join(tmp, "fake");
    fs.mkdirSync(fakeDir);
    fakeCli = path.join(fakeDir, "codeg-cli");
    fs.writeFileSync(fakeCli, FAKE_CODEG_CLI, { mode: 0o755 });
    const config = fs
      .readFileSync(CONFIG_TEMPLATE, "utf-8")
      .replace('codeg_cli: ""', `codeg_cli: "${fakeCli}"`);
    expect(config).toContain(`codeg_cli: "${fakeCli}"`);
    fs.writeFileSync(path.join(tmp, ".arbor", "config.yaml"), config);

    taskDir = path.join(tmp, ".arbor", "tasks", TASK);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ id: TASK, title: TASK, status: "in_progress" }) + "\n",
    );
    fs.writeFileSync(path.join(taskDir, "prd.md"), "# PRD FOO CONTENT\n");
    fs.mkdirSync(path.join(tmp, ".arbor", "spec", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".arbor", "spec", "cli", "guide.md"),
      "SPEC GUIDE CONTENT\n",
    );
    for (const manifest of ["implement.jsonl", "check.jsonl"]) {
      fs.writeFileSync(
        path.join(taskDir, manifest),
        JSON.stringify({ file: ".arbor/spec/cli/guide.md", reason: "guide" }) +
          "\n",
      );
    }
    runsDir = path.join(tmp, ".arbor", ".runtime", "dispatch");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function dispatch(args: string[], input = ""): RunResult {
    const r = spawnSync(
      "python3",
      [path.join(tmp, ".arbor", "scripts", "dispatch.py"), ...args],
      { cwd: tmp, encoding: "utf-8", input, env: cleanEnv() },
    );
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function hookTask(task: string): string {
    const r = spawnSync("python3", [HOOK_PATH], {
      cwd: tmp,
      encoding: "utf-8",
      input: JSON.stringify({
        session_id: "dispatch-py-session",
        cwd: tmp,
        hook_event_name: "PreToolUse",
        tool_name: TOOL_NAME,
        tool_input: { task, assistant_id: 12 },
      }),
      env: cleanEnv(),
    });
    expect(r.status, r.stderr).toBe(0);
    return (
      JSON.parse(r.stdout) as {
        hookSpecificOutput: { updatedInput: { task: string } };
      }
    ).hookSpecificOutput.updatedInput.task;
  }

  /** argv lines and stdin of the n-th fake codeg-cli call (1-based). */
  function fakeCall(n: number): { argv: string[]; stdin: string | null } {
    const argv = fs
      .readFileSync(path.join(fakeDir, "calls", `${n}.argv`), "utf-8")
      .split("\n")
      .slice(0, -1);
    const stdinPath = path.join(fakeDir, "calls", `${n}.stdin`);
    return {
      argv,
      stdin: fs.existsSync(stdinPath)
        ? fs.readFileSync(stdinPath, "utf-8")
        : null,
    };
  }

  function fakeCallCount(): number {
    const dir = path.join(fakeDir, "calls");
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith(".argv")).length;
  }

  function python(script: string, ...args: string[]): string {
    return execFileSync("python3", ["-c", script, ...args], {
      encoding: "utf-8",
    });
  }

  function makeDb(file: string, createSql: string): void {
    python(
      "import sqlite3, sys\nc = sqlite3.connect(sys.argv[1])\nc.execute(sys.argv[2])\nc.commit()",
      file,
      createSql,
    );
  }

  function dbRows(file: string): {
    id: number;
    uid: string;
    name: string;
    agent_type: string;
    agent_options: string;
    label_snapshot: string;
    instructions: string;
    revision: number;
  }[] {
    return JSON.parse(
      python(
        "import json, sqlite3, sys\nc = sqlite3.connect(sys.argv[1])\nc.row_factory = sqlite3.Row\n" +
          "print(json.dumps([dict(r) for r in c.execute('SELECT * FROM assistant ORDER BY id')]))",
        file,
      ),
    ) as ReturnType<typeof dbRows>;
  }

  describe("print-context", () => {
    it("byte-equals the hook's updatedInput.task for implement", () => {
      const hook = hookTask(`Active task: ${taskDir}\nRole: implement\n\nDo X`);
      const r = dispatch([
        "print-context",
        "--role",
        "implement",
        "--task",
        TASK_REL,
        "--prompt",
        "Do X",
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(hook);
      expect(
        r.stdout.startsWith(
          `Active task: ${taskDir}\nRole: implement\n\n${MARKER}`,
        ),
      ).toBe(true);
      expect(r.stdout).toContain("PRD FOO CONTENT");
      expect(r.stdout).toContain("SPEC GUIDE CONTENT");
    });

    it("byte-equals the hook for check --finish", () => {
      const hook = hookTask(
        `Active task: ${taskDir}\nRole: check [finish]\n\nFinal pass.`,
      );
      const r = dispatch(
        ["print-context", "--role", "check", "--finish", "--task", TASK],
        "Final pass.",
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(hook);
      expect(r.stdout).toContain("Role: check [finish]\n");
      expect(r.stdout).toContain("# Finish Agent Task");
    });

    it("byte-equals the hook for research with and without a task", () => {
      const withTask = hookTask(
        `Active task: ${taskDir}\nRole: research\nTarget: pi\n\nFind X`,
      );
      const r1 = dispatch([
        "print-context",
        "--role",
        "research",
        "--task",
        taskDir,
        "--target",
        "pi",
        "-p",
        "Find X",
      ]);
      expect(r1.status, r1.stderr).toBe(0);
      expect(r1.stdout).toBe(withTask);

      const noTask = hookTask("Role: research\n\nSummarize spec layout");
      const r2 = dispatch(
        ["print-context", "--role", "research"],
        "Summarize spec layout",
      );
      expect(r2.status, r2.stderr).toBe(0);
      expect(r2.stdout).toBe(noTask);
      expect(r2.stdout.startsWith(`Role: research\n\n${MARKER}`)).toBe(true);
    });

    it("refuses implement without a task and an unknown task dir", () => {
      const noTask = dispatch([
        "print-context",
        "--role",
        "implement",
        "-p",
        "x",
      ]);
      expect(noTask.status).toBe(2);
      expect(noTask.stderr).toContain("needs a task");
      const missing = dispatch([
        "print-context",
        "--role",
        "implement",
        "--task",
        "10-24-nope",
        "-p",
        "x",
      ]);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain("task directory not found");
    });
  });

  describe("run", () => {
    it("--dry-run prints the codeg-cli argv without running or writing anything", () => {
      const r = dispatch([
        "run",
        "--role",
        "implement",
        "--task",
        TASK,
        "--target",
        "pi",
        "--worktree=feat-a",
        "--dry-run",
        "-p",
        "Do X",
      ]);
      expect(r.status, r.stderr).toBe(0);
      const line = r.stdout.trim();
      const prefix =
        `${fakeCli} run -A arbor-implement-pi -w ${tmp} --permissions allow ` +
        `--timeout 90m --title 'arbor implement ${TASK}' --worktree=feat-a -o `;
      expect(line.startsWith(prefix), line).toBe(true);
      expect(line.slice(prefix.length)).toMatch(
        new RegExp(
          `^${runsDir.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/\\d{8}-\\d{6}-implement\\.result\\.md -p -$`,
        ),
      );
      expect(fakeCallCount()).toBe(0);
      expect(fs.existsSync(runsDir)).toBe(false);
    });

    it("--print-prompt equals print-context plus the effective Target line", () => {
      const printed = dispatch(
        ["run", "--role", "implement", "--task", TASK, "--print-prompt"],
        "Do X",
      );
      expect(printed.status, printed.stderr).toBe(0);
      const context = dispatch(
        [
          "print-context",
          "--role",
          "implement",
          "--task",
          TASK,
          "--target",
          "star",
        ],
        "Do X",
      );
      expect(printed.stdout).toBe(context.stdout);
      expect(printed.stdout).toContain("\nTarget: star\n");
    });

    it("pipes the assembled prompt to codeg-cli and stores prompt + result", () => {
      const r = dispatch(
        [
          "run",
          "--role",
          "check",
          "--task",
          TASK,
          "--target",
          "pi",
          "--workspace",
          tmp,
        ],
        "Review the diff.",
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe("REPLY 1\n");
      expect(fakeCallCount()).toBe(1);

      const files = fs.readdirSync(runsDir).sort();
      expect(files).toHaveLength(2);
      const stamp = files[0]?.replace(/\.md$/, "") ?? "";
      expect(stamp).toMatch(/^\d{8}-\d{6}-check$/);
      expect(files).toEqual([`${stamp}.md`, `${stamp}.result.md`]);

      const call = fakeCall(1);
      expect(call.argv).toEqual([
        "run",
        "-A",
        "arbor-check-pi",
        "-w",
        tmp,
        "--permissions",
        "allow",
        "--timeout",
        "90m",
        "--title",
        `arbor check ${TASK}`,
        "-o",
        path.join(runsDir, `${stamp}.result.md`),
        "-p",
        "-",
      ]);
      const prompt = fs.readFileSync(
        path.join(runsDir, `${stamp}.md`),
        "utf-8",
      );
      expect(call.stdin).toBe(prompt);
      expect(
        prompt.startsWith(
          `Active task: ${taskDir}\nRole: check\nTarget: pi\nWorkspace: ${tmp}\n\n${MARKER}\n# Check Agent Task`,
        ),
      ).toBe(true);
      expect(prompt).toContain("## Your Task\n\nReview the diff.");
      expect(
        fs.readFileSync(path.join(runsDir, `${stamp}.result.md`), "utf-8"),
      ).toBe("REPLY 1\n");
    });

    it("takes header lines at the top of the brief as defaults", () => {
      const r = dispatch(
        ["run", "--role", "implement", "--print-prompt"],
        `Active task: ${TASK_REL}\nRole: implement\nTarget: pi\n\nBuild it.`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(
        r.stdout.startsWith(
          `Active task: ${taskDir}\nRole: implement\nTarget: pi\n\n${MARKER}`,
        ),
      ).toBe(true);
      expect(r.stdout).toContain("## Your Task\n\nBuild it.");
    });

    it("--detach records the run id; --wait collects it, retrying on exit 6", () => {
      fs.writeFileSync(path.join(fakeDir, "still-running"), "");
      const r = dispatch(
        [
          "run",
          "--role",
          "research",
          "--detach",
          "--wait",
          "--url",
          "https://codeg.example:3080",
        ],
        "Summarize spec layout",
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe("8d0c7c2e-aaaa-bbbb\nREPLY 3\n");

      const files = fs.readdirSync(runsDir).sort();
      const stamp = files[0]?.replace(/\.md$/, "") ?? "";
      expect(files).toEqual([
        `${stamp}.md`,
        `${stamp}.result.md`,
        `${stamp}.run`,
      ]);
      expect(fs.readFileSync(path.join(runsDir, `${stamp}.run`), "utf-8")).toBe(
        "8d0c7c2e-aaaa-bbbb\n",
      );

      const run = fakeCall(1);
      expect(run.argv.slice(0, 3)).toEqual([
        "--url",
        "https://codeg.example:3080",
        "run",
      ]);
      expect(run.argv).toContain("--detach");
      expect(run.argv).not.toContain("-o");
      expect(run.argv.slice(-2)).toEqual(["-p", "-"]);
      expect(
        run.stdin?.startsWith(`Role: research\nTarget: star\n\n${MARKER}`),
      ).toBe(true);

      // First result call said "still running" (6); the second collected it.
      expect(fakeCallCount()).toBe(3);
      for (const n of [2, 3]) {
        const argv = fakeCall(n).argv;
        expect(argv.slice(0, 4)).toEqual([
          "--url",
          "https://codeg.example:3080",
          "result",
          "8d0c7c2e-aaaa-bbbb",
        ]);
        expect(argv[4]).toBe("--wait");
        expect(argv[5]).toMatch(/^\d+s$/);
        expect(argv.slice(6)).toEqual([
          "-o",
          path.join(runsDir, `${stamp}.result.md`),
        ]);
      }
    });

    it("wait RUN maps a recorded run id to its <stamp>.result.md", () => {
      const started = dispatch(["run", "--role", "research", "--detach"], "Go");
      expect(started.status, started.stderr).toBe(0);
      const stamp = (
        fs.readdirSync(runsDir).find((f) => f.endsWith(".run")) ?? ""
      ).replace(/\.run$/, "");
      const r = dispatch(["wait", "8d0c7c2e", "--timeout", "30s"]);
      expect(r.status, r.stderr).toBe(0);
      const argv = fakeCall(2).argv;
      expect(argv.slice(0, 4)).toEqual(["result", "8d0c7c2e", "--wait", "30s"]);
      expect(argv.slice(4)).toEqual([
        "-o",
        path.join(runsDir, `${stamp}.result.md`),
      ]);
    });

    it("rejects --standalone with --detach", () => {
      const r = dispatch(
        ["run", "--role", "research", "--standalone", "--detach"],
        "Go",
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--standalone cannot be combined");
      expect(fakeCallCount()).toBe(0);
    });
  });

  describe("resolve and target", () => {
    it("resolve --json reports the assistant and, once known, its id", () => {
      const before = dispatch(["resolve", "--role", "implement", "--json"]);
      expect(before.status, before.stderr).toBe(0);
      expect(JSON.parse(before.stdout)).toEqual({
        role: "implement",
        target: "star",
        target_source: "config",
        assistant: "arbor-implement-star",
        assistant_id: null,
        agent_type: "custom:star",
      });

      fs.mkdirSync(path.join(tmp, ".arbor", ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".arbor", ".runtime", "codeg-assistants.json"),
        JSON.stringify({
          by_name: { "arbor-check-pi": 13 },
          by_id: { "13": { role: "check", target: "pi" } },
        }),
      );
      const after = dispatch([
        "resolve",
        "--role",
        "check",
        "--target",
        "pi",
        "--json",
      ]);
      expect(JSON.parse(after.stdout)).toMatchObject({
        target: "pi",
        target_source: "flag",
        assistant: "arbor-check-pi",
        assistant_id: 13,
      });

      const text = dispatch(["resolve", "--role", "research"]);
      expect(text.stdout).toBe(
        "role: research\ntarget: star (source: config)\nassistant: arbor-research-star\n" +
          "assistant_id: unknown (run python3 ./.arbor/scripts/dispatch.py codeg-setup)\n",
      );
    });

    it("target set / get / clear manage .arbor/.runtime/dispatch-target", () => {
      const file = path.join(tmp, ".arbor", ".runtime", "dispatch-target");
      expect(dispatch(["target"]).stdout).toBe("star (source: config)\n");

      const set = dispatch(["target", "set", "pi"]);
      expect(set.status, set.stderr).toBe(0);
      expect(set.stdout).toBe("pi (source: .arbor/.runtime/dispatch-target)\n");
      expect(fs.readFileSync(file, "utf-8")).toBe("pi\n");
      expect(dispatch(["target", "get"]).stdout).toBe(
        "pi (source: .arbor/.runtime/dispatch-target)\n",
      );
      expect(
        JSON.parse(
          dispatch(["resolve", "--role", "implement", "--json"]).stdout,
        ),
      ).toMatchObject({ target: "pi", assistant: "arbor-implement-pi" });

      const bogus = dispatch(["target", "set", "bogus"]);
      expect(bogus.status).toBe(2);
      expect(bogus.stderr).toContain("unknown dispatch target 'bogus'");
      expect(fs.readFileSync(file, "utf-8")).toBe("pi\n");

      const cleared = dispatch(["target", "clear"]);
      expect(cleared.stdout).toBe("star (source: config)\n");
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  describe("codeg-setup", () => {
    const rendered = (target: string, role: string) =>
      path.join(
        tmp,
        ".arbor",
        ".runtime",
        "codeg-assistants",
        `${target}-${role}.md`,
      );
    const registryPath = () =>
      path.join(tmp, ".arbor", ".runtime", "codeg-assistants.json");

    it("print mode renders three instruction files and the manual steps", () => {
      fs.writeFileSync(
        path.join(fakeDir, "assistants.json"),
        JSON.stringify([
          { id: 12, name: "arbor-implement-pi", agent: "pi", description: "" },
          { id: 13, name: "arbor-check-pi", agent: "pi", description: "" },
          { id: 40, name: "someone-else", agent: "codex", description: "" },
        ]),
      );
      const r = dispatch(["codeg-setup", "--target", "pi"]);
      expect(r.status, r.stderr).toBe(0);

      const dir = path.dirname(rendered("pi", "implement"));
      expect(fs.readdirSync(dir).sort()).toEqual([
        "pi-check.md",
        "pi-implement.md",
        "pi-research.md",
      ]);
      const source = fs
        .readFileSync(path.join(TEMPLATE_AGENTS, "check.md"), "utf-8")
        .trim();
      const instructions = fs.readFileSync(rendered("pi", "check"), "utf-8");
      expect(instructions.startsWith(source)).toBe(true);
      expect(instructions).toContain("`arbor-check-pi`");

      expect(r.stdout).toContain("arbor-implement-pi");
      expect(r.stdout).toContain("Agent:        pi");
      expect(r.stdout).toContain(
        "Options:      model=deepseek/DeepSeek-V4.1-Flash, thought_level=max",
      );
      expect(r.stdout).toContain(
        "Instructions: paste .arbor/.runtime/codeg-assistants/pi-research.md",
      );

      expect(fakeCall(1).argv).toEqual(["assistants", "--json"]);
      const registry = JSON.parse(fs.readFileSync(registryPath(), "utf-8")) as {
        by_name: Record<string, number>;
        by_id: Record<string, unknown>;
      };
      expect(registry.by_name).toEqual({
        "arbor-check-pi": 13,
        "arbor-implement-pi": 12,
      });
      expect(registry.by_id).toEqual({
        "12": { role: "implement", target: "pi" },
        "13": { role: "check", target: "pi" },
      });
    });

    it("skips the id registry when codeg is unreachable", () => {
      const r = dispatch(["codeg-setup"]);
      expect(r.status, r.stderr).toBe(0);
      expect(
        fs.readdirSync(path.dirname(rendered("pi", "check"))),
      ).toHaveLength(6);
      expect(r.stderr).toContain("codeg is not reachable");
      expect(fs.existsSync(registryPath())).toBe(false);
    });

    it("--install upserts three rows idempotently into a 15-column table", () => {
      const db = path.join(tmp, "codeg.db");
      makeDb(db, ASSISTANT_COLUMNS_SQL);

      const first = dispatch([
        "codeg-setup",
        "--target",
        "pi",
        "--install",
        "--db",
        db,
      ]);
      expect(first.status, first.stderr).toBe(0);
      const rows = dbRows(db);
      expect(rows.map((r) => r.name)).toEqual([
        "arbor-implement-pi",
        "arbor-check-pi",
        "arbor-research-pi",
      ]);
      expect(rows.every((r) => r.revision === 1 && r.agent_type === "pi")).toBe(
        true,
      );
      expect(JSON.parse(rows[0]?.agent_options ?? "")).toEqual({
        config_values: {
          model: "deepseek/DeepSeek-V4.1-Flash",
          thought_level: "max",
        },
      });
      const snapshot = JSON.parse(rows[0]?.label_snapshot ?? "") as {
        options: { id: string }[];
      };
      expect(snapshot.options.map((o) => o.id)).toEqual([
        "model",
        "thought_level",
      ]);
      expect(rows[1]?.instructions).toBe(
        fs.readFileSync(rendered("pi", "check"), "utf-8").trimEnd(),
      );

      // codeg-cli unreachable: the registry comes from the database ids.
      const registry = JSON.parse(fs.readFileSync(registryPath(), "utf-8")) as {
        by_name: Record<string, number>;
      };
      expect(registry.by_name).toEqual({
        "arbor-check-pi": rows[1]?.id,
        "arbor-implement-pi": rows[0]?.id,
        "arbor-research-pi": rows[2]?.id,
      });

      const second = dispatch([
        "codeg-setup",
        "--target",
        "pi",
        "--install",
        "--db",
        db,
      ]);
      expect(second.status, second.stderr).toBe(0);
      const again = dbRows(db);
      expect(again.map((r) => [r.id, r.uid])).toEqual(
        rows.map((r) => [r.id, r.uid]),
      );
      expect(again.every((r) => r.revision === 2)).toBe(true);

      const backups = fs.readdirSync(
        path.join(tmp, ".arbor", ".runtime", "codeg-db-backups"),
      );
      expect(backups).toHaveLength(2);
    });

    it("--install appends after existing assistants and labels custom agents by their codeg name", () => {
      const db = path.join(tmp, "codeg.db");
      makeDb(db, ASSISTANT_COLUMNS_SQL);
      makeDb(
        db,
        "INSERT INTO assistant (uid, name, avatar, agent_type, agent_options, label_snapshot," +
          " sort_order, created_at, updated_at) VALUES ('pipeline-uid', 'implementer', '{}', 'pi'," +
          " '{}', '{}', 7, 'now', 'now')",
      );
      makeDb(
        db,
        "CREATE TABLE custom_agent (id INTEGER PRIMARY KEY, registry_id TEXT NOT NULL, name TEXT NOT NULL)",
      );
      makeDb(
        db,
        "INSERT INTO custom_agent (registry_id, name) VALUES ('star', 'StarFactory')",
      );

      const r = dispatch(["codeg-setup", "--install", "--db", db]);
      expect(r.status, r.stderr).toBe(0);
      const rows = dbRows(db) as (ReturnType<typeof dbRows>[number] & {
        sort_order: number;
      })[];
      const pipeline = rows.find((row) => row.name === "implementer");
      expect(pipeline?.sort_order).toBe(7);
      const arbor = rows.filter((row) => row.name.startsWith("arbor-"));
      expect(arbor).toHaveLength(6);
      expect(arbor.map((row) => row.sort_order)).toEqual([8, 9, 10, 11, 12, 13]);

      const star = arbor.filter((row) => row.agent_type === "custom:star");
      expect(star.map((row) => row.name)).toEqual([
        "arbor-implement-star",
        "arbor-check-star",
        "arbor-research-star",
      ]);
      for (const row of star) {
        expect(JSON.parse(row.agent_options)).toEqual({});
        expect(JSON.parse(row.label_snapshot)).toEqual({
          agent: "StarFactory",
          mode: null,
          options: [],
        });
      }

      // Re-running keeps every slot stable.
      const again = dispatch(["codeg-setup", "--install", "--db", db]);
      expect(again.status, again.stderr).toBe(0);
      expect(
        (dbRows(db) as { name: string; sort_order: number }[]).map((row) => [
          row.name,
          row.sort_order,
        ]),
      ).toEqual(rows.map((row) => [row.name, row.sort_order]));
    });

    it("--install refuses a different assistant schema and falls back to print mode", () => {
      const db = path.join(tmp, "codeg.db");
      makeDb(
        db,
        "CREATE TABLE assistant (id INTEGER PRIMARY KEY, uid TEXT, name TEXT)",
      );

      const r = dispatch([
        "codeg-setup",
        "--target",
        "pi",
        "--install",
        "--db",
        db,
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("refusing --install");
      expect(r.stdout).toContain("Create each assistant in codeg");
      expect(dbRows(db)).toEqual([]);
      expect(
        fs.existsSync(path.join(tmp, ".arbor", ".runtime", "codeg-db-backups")),
      ).toBe(false);
    });
  });
});
