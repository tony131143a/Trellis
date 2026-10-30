import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scripts = path.resolve(__dirname, "../../src/templates/arbor/scripts");
const guard = path.resolve(
  __dirname,
  "../../src/templates/shared-hooks/guard-builtin-agent.py",
);

describe("Codex host integration", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-codex-host-"));
    fs.mkdirSync(path.join(root, ".arbor/agents"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function python(code: string, overrides: NodeJS.ProcessEnv = {}) {
    const env = { ...process.env, ...overrides };
    delete env.CLAUDE_CODE_SESSION_ID;
    const result = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        `import sys\nsys.path.insert(0, ${JSON.stringify(scripts)})\n${code}`,
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  it("matches hook and shell identity and keeps separate threads isolated", () => {
    const result = python(
      `
import json, os
from common.active_task import resolve_context_key
hook = resolve_context_key({"session_id": "thread-one"}, platform="codex", allow_environment_context=False)
shell = resolve_context_key(platform="codex")
os.environ["CODEX_THREAD_ID"] = "thread-two"
other = resolve_context_key(platform="codex")
os.environ["ARBOR_CONTEXT_ID"] = "explicit-child"
override = resolve_context_key(platform="codex")
print(json.dumps(dict(hook=hook, shell=shell, other=other, override=override)))
`,
      { CODEX_THREAD_ID: "thread-one" },
    );
    expect(result.hook).toBe(result.shell);
    expect(result.shell).toMatch(/^codex_/);
    expect(result.other).not.toBe(result.shell);
    expect(result.override).toBe("explicit-child");
  });

  it("does not give an executor the parent Arbor or host session", () => {
    const result = python(
      `
import json, os, shlex
from pathlib import Path
from common.driver.executor import Executor, run_executor
code = 'import os,json; print(json.dumps({k:os.environ.get(k) for k in ("ARBOR_CONTEXT_ID","CODEX_THREAD_ID")}))'
executor = Executor("probe", "python3 -c " + shlex.quote(code), 10)
reply = run_executor(executor, role="review", prompt_path=Path("unused"), worktree=Path.cwd(), task="probe", dispatch="d-001")
print(json.dumps(dict(ok=reply.ok, child=json.loads(reply.stdout), parent=os.environ.get("ARBOR_CONTEXT_ID"))))
`,
      { ARBOR_CONTEXT_ID: "parent-task", CODEX_THREAD_ID: "parent-thread" },
    );
    expect(result.ok).toBe(true);
    expect(result.child).toEqual({
      ARBOR_CONTEXT_ID: null,
      CODEX_THREAD_ID: null,
    });
    expect(result.parent).toBe("parent-task");
  });

  it("inlines role instructions while keeping the dispatch header first", () => {
    const instructions =
      "Role boundary: inspect only. Report: findings and essential files.";
    fs.writeFileSync(path.join(root, ".arbor/agents/explore.md"), instructions);
    const result = python(`
import json
from pathlib import Path
from common.dispatch_context import DispatchHeader, DispatchRequest, build_dispatch_prompt
header = DispatchHeader(task_dir=None, role="explore", mode=None, body="Find the entry point.")
reply = build_dispatch_prompt(DispatchRequest(repo_root=Path.cwd(), role="explore", task_dir=None, header=header, original_text=header.body))
print(json.dumps(dict(prompt=reply.text)))
`);
    expect(result.prompt).toMatch(/^Role: explore\n/);
    expect(result.prompt).toContain(instructions);
    expect(result.prompt).toContain("Find the entry point.");
  });

  it("guards Codex spawn_agent messages while allowing unrelated delegation", () => {
    for (const [message, deny] of [
      ["Role: implement\nDo the task.", true],
      ["Summarize this ordinary note.", false],
    ] as const) {
      const result = spawnSync("python3", ["-B", guard], {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify({
          cwd: root,
          tool_name: "spawn_agent",
          tool_input: { message, agent_type: "default" },
        }),
      });
      expect(result.status, result.stderr).toBe(0);
      if (deny) {
        expect(
          JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
        ).toBe("deny");
      } else {
        expect(result.stdout).toBe("");
      }
    }
  });
});
