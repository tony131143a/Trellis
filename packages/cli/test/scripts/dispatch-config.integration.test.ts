/**
 * Integration tests for the dispatch configuration surface:
 *   - `common/config.py`: `get_dispatch_config` / `resolve_dispatch_target`
 *     over the shipped `config.yaml` template's `dispatch:` block
 *   - `shared-hooks/session-start.py`: the `<dispatch>` section and the
 *     tier lines of `<task-status>`
 *   - `shared-hooks/inject-workflow-state.py`: the breadcrumb key chain
 *     (`<status>-parallel` for full + parallel, `<status>-<tier>`, `<status>`)
 *     and the `· Tier:` header segment
 *
 * Scripts are stamped into a fresh temp dir and run under real `python3`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATES = path.resolve(__dirname, "../../src/templates");
const TEMPLATE_SCRIPTS = path.join(TEMPLATES, "arbor", "scripts");
const CONFIG_TEMPLATE = path.join(TEMPLATES, "arbor", "config.yaml");
const SHARED_HOOKS = path.join(TEMPLATES, "shared-hooks");

const ROLES = [
  "explore",
  "architect",
  "implement",
  "review",
  "verify",
  "fix",
  "simplify",
] as const;

function roleNames(target: string): Record<string, string> {
  return Object.fromEntries(ROLES.map((role) => [role, `arbor-${role}-${target}`]));
}

const SHIPPED_DISPATCH = {
  default_target: "star",
  max_parallel: 3,
  guard_builtin_agent: true,
  hook_decision: "allow",
  codeg_cli: "",
  permissions: "allow",
  timeout: "90m",
  targets: {
    star: {
      agent_type: "custom:star",
      mode_id: null,
      options: {},
      assistants: roleNames("star"),
    },
    pi: {
      agent_type: "pi",
      mode_id: null,
      options: { model: "deepseek/DeepSeek-V4.1-Flash", thought_level: "max" },
      assistants: roleNames("pi"),
    },
    codex: {
      agent_type: "codex",
      mode_id: "agent-full-access",
      options: {},
      assistants: roleNames("codex"),
    },
  },
};

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("ARBOR_") ||
      key.startsWith("CLAUDE") ||
      key.startsWith("STARFACTORY")
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...overrides };
}

describe.skipIf(!hasPython())("dispatch configuration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-dispatch-config-")),
    );
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".arbor", "scripts"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    fs.writeFileSync(path.join(tmp, ".arbor", "config.yaml"), yaml, "utf-8");
  }

  /** Run a snippet with common.config imported; returns {stdout, stderr}. */
  function probe(
    code: string,
    env: NodeJS.ProcessEnv = {},
  ): { stdout: string; stderr: string } {
    const probePath = path.join(tmp, "probe.py");
    fs.writeFileSync(
      probePath,
      `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(tmp, ".arbor", "scripts"))})
from pathlib import Path
from common.config import get_dispatch_config, get_dispatch_target, resolve_dispatch_target
REPO_ROOT = Path(${JSON.stringify(tmp)})
${code}
`,
      "utf-8",
    );
    const r = spawnSync("python3", [probePath], {
      cwd: tmp,
      encoding: "utf-8",
      env: cleanEnv(env),
    });
    if (r.status !== 0) throw new Error(`probe failed: ${r.stderr}`);
    return { stdout: r.stdout, stderr: r.stderr };
  }

  function dispatchConfig(): unknown {
    return JSON.parse(
      probe("print(json.dumps(get_dispatch_config(REPO_ROOT)))").stdout,
    );
  }

  describe("common/config.py: get_dispatch_config", () => {
    it("parses the shipped config.yaml dispatch block with no warnings", () => {
      fs.copyFileSync(CONFIG_TEMPLATE, path.join(tmp, ".arbor", "config.yaml"));
      const { stdout, stderr } = probe(
        "print(json.dumps(get_dispatch_config(REPO_ROOT)))",
      );
      expect(JSON.parse(stdout)).toEqual(SHIPPED_DISPATCH);
      expect(stderr).toBe("");
    });

    it("the template block is a plain indented mapping the subset parser reads", () => {
      const r = spawnSync(
        "python3",
        [
          "-c",
          [
            "import json, sys",
            `sys.path.insert(0, ${JSON.stringify(path.join(tmp, ".arbor", "scripts"))})`,
            "from common.arbor_config import parse_simple_yaml",
            `content = open(${JSON.stringify(CONFIG_TEMPLATE)}, encoding='utf-8').read()`,
            "print(json.dumps(parse_simple_yaml(content)['dispatch']))",
          ].join("\n"),
        ],
        { encoding: "utf-8" },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toBe("");
      const parsed = JSON.parse(r.stdout) as {
        targets: Record<string, Record<string, string>>;
      };
      expect(parsed.targets.star).toEqual({
        agent_type: "custom:star",
        ...roleNames("star"),
      });
      expect(parsed.targets.pi.thought_level).toBe("max");
    });

    it("returns the shipped defaults when config.yaml is absent", () => {
      expect(dispatchConfig()).toEqual(SHIPPED_DISPATCH);
    });

    it("fills missing role names with arbor-<role>-<target> for a custom target", () => {
      writeConfig(
        [
          "dispatch:",
          "  default_target: gemini",
          "  targets:",
          "    gemini:",
          "      agent_type: gemini",
          "      mode_id: read-only",
          "      implement: my-implementer",
          "      model: gpt",
        ].join("\n"),
      );
      const cfg = dispatchConfig() as typeof SHIPPED_DISPATCH & {
        targets: Record<
          string,
          { agent_type: string; mode_id: string | null; options: object; assistants: object }
        >;
      };
      expect(cfg.default_target).toBe("gemini");
      expect(cfg.targets.gemini).toEqual({
        agent_type: "gemini",
        mode_id: "read-only",
        options: { model: "gpt" },
        assistants: { ...roleNames("gemini"), implement: "my-implementer" },
      });
      // Shipped targets stay available next to the custom one.
      expect(cfg.targets.star).toEqual(SHIPPED_DISPATCH.targets.star);
    });

    it("ignores retired check / research role keys instead of passing them as options", () => {
      writeConfig(
        [
          "dispatch:",
          "  targets:",
          "    pi:",
          "      agent_type: pi",
          "      check: arbor-check-pi",
          "      research: arbor-research-pi",
        ].join("\n"),
      );
      const cfg = dispatchConfig() as typeof SHIPPED_DISPATCH;
      expect(cfg.targets.pi.options).toEqual(SHIPPED_DISPATCH.targets.pi.options);
      expect(cfg.targets.pi.assistants).toEqual(roleNames("pi"));
    });

    it("coerces types and falls back with a warning on invalid values", () => {
      writeConfig(
        [
          "dispatch:",
          "  default_target: nowhere",
          "  max_parallel: lots",
          "  guard_builtin_agent: off",
          "  hook_decision: maybe",
          "  timeout: 45m",
        ].join("\n"),
      );
      const { stdout, stderr } = probe(
        "print(json.dumps(get_dispatch_config(REPO_ROOT)))",
      );
      const cfg = JSON.parse(stdout) as typeof SHIPPED_DISPATCH;
      expect(cfg.default_target).toBe("star");
      expect(cfg.max_parallel).toBe(3);
      expect(cfg.guard_builtin_agent).toBe(false);
      expect(cfg.hook_decision).toBe("allow");
      expect(cfg.timeout).toBe("45m");
      expect(stderr).toContain("dispatch.default_target");
      expect(stderr).toContain("dispatch.max_parallel");
      expect(stderr).toContain("dispatch.hook_decision");
    });
  });

  describe("common/config.py: dispatch target precedence", () => {
    it("session file > runtime file > ARBOR_DISPATCH_TARGET > default_target", () => {
      const read = (env: NodeJS.ProcessEnv = {}): string[] =>
        JSON.parse(
          probe("print(json.dumps(resolve_dispatch_target(REPO_ROOT)))", env)
            .stdout,
        ) as string[];

      expect(read()).toEqual(["star", "config"]);
      expect(read({ ARBOR_DISPATCH_TARGET: "pi" })).toEqual([
        "pi",
        "ARBOR_DISPATCH_TARGET",
      ]);

      fs.mkdirSync(path.join(tmp, ".arbor", ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".arbor", ".runtime", "dispatch-target"),
        "star\n",
      );
      expect(read({ ARBOR_DISPATCH_TARGET: "pi" })).toEqual([
        "star",
        ".arbor/.runtime/dispatch-target",
      ]);

      // This session's file (identified like the active task) outranks all of
      // the above; another session, or no session identity, does not see it.
      const sessions = path.join(tmp, ".arbor", ".runtime", "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, "claude_s1.dispatch-target"), "codex\n");
      expect(read({ ARBOR_CONTEXT_ID: "claude_s1", ARBOR_DISPATCH_TARGET: "pi" })).toEqual([
        "codex",
        ".arbor/.runtime/sessions/claude_s1.dispatch-target",
      ]);
      expect(read({ ARBOR_CONTEXT_ID: "claude_s2" })).toEqual([
        "star",
        ".arbor/.runtime/dispatch-target",
      ]);
      expect(read()).toEqual(["star", ".arbor/.runtime/dispatch-target"]);
    });

    it("skips an unknown override with a warning", () => {
      fs.mkdirSync(path.join(tmp, ".arbor", ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".arbor", ".runtime", "dispatch-target"),
        "bogus\n",
      );
      const { stdout, stderr } = probe(
        "print(get_dispatch_target(REPO_ROOT))",
        { ARBOR_DISPATCH_TARGET: "pi" },
      );
      expect(stdout.trim()).toBe("pi");
      expect(stderr).toContain("unknown dispatch target 'bogus'");
    });
  });

  describe("session-start.py <dispatch> section", () => {
    function sessionStart(env: NodeJS.ProcessEnv = {}): string {
      fs.writeFileSync(path.join(tmp, ".arbor", "workflow.md"), "# Workflow\n");
      const r = spawnSync("python3", [path.join(SHARED_HOOKS, "session-start.py")], {
        cwd: tmp,
        encoding: "utf-8",
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          cwd: tmp,
          session_id: "dispatch-section",
        }),
        env: cleanEnv({ CLAUDE_PROJECT_DIR: tmp, ...env }),
      });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      return out.hookSpecificOutput.additionalContext;
    }

    it("names the effective target, per-role assistants, and the routing rule", () => {
      const context = sessionStart();
      const section = /<dispatch>\n([\s\S]*?)\n<\/dispatch>/.exec(context)?.[1];
      expect(section, "missing <dispatch> section").toBeDefined();
      expect(section).toContain("Target: star (source: config)");
      const unknown =
        "(id unknown — run python3 ./.arbor/scripts/dispatch.py codeg-setup)";
      expect(section).toContain(
        [
          "Assistants:",
          ...ROLES.map((role) => `- ${role}: arbor-${role}-star ${unknown}`),
        ].join("\n"),
      );
      expect(section).toContain(
        "If `mcp__codeg-mcp__delegate_to_agent` is among your tools, call it; otherwise run `python3 ./.arbor/scripts/dispatch.py run --role <role>`. Never use the built-in Agent/Task tool for arbor roles.",
      );
      // The section sits after the workflow overview, which stays intact.
      expect(context.indexOf("</arbor-workflow>")).toBeLessThan(
        context.indexOf("<dispatch>"),
      );
    });

    it("follows the runtime target override", () => {
      const section = sessionStart({ ARBOR_DISPATCH_TARGET: "pi" });
      expect(section).toContain("Target: pi (source: ARBOR_DISPATCH_TARGET)");
      expect(section).toContain("- implement: arbor-implement-pi (id unknown");
    });

    it("follows this session's target, not another session's", () => {
      // The hook's session id is `dispatch-section` under platform claude.
      const sessions = path.join(tmp, ".arbor", ".runtime", "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, "claude_dispatch-section.dispatch-target"), "codex\n");
      fs.writeFileSync(path.join(sessions, "claude_other.dispatch-target"), "pi\n");
      const section = sessionStart({ ARBOR_DISPATCH_TARGET: "pi" });
      expect(section).toContain(
        "Target: codex (source: .arbor/.runtime/sessions/claude_dispatch-section.dispatch-target)",
      );
      expect(section).toContain("- implement: arbor-implement-codex (id unknown");
    });

    it("prints assistant ids from the codeg-setup registry", () => {
      fs.mkdirSync(path.join(tmp, ".arbor", ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".arbor", ".runtime", "codeg-assistants.json"),
        JSON.stringify({
          by_name: { "arbor-implement-pi": 12, "arbor-review-pi": 13 },
          by_id: {
            "12": { role: "implement", target: "pi" },
            "13": { role: "review", target: "pi" },
          },
        }),
      );
      const section = sessionStart({ ARBOR_DISPATCH_TARGET: "pi" });
      expect(section).toContain("- implement: arbor-implement-pi (id 12)");
      expect(section).toContain("- review: arbor-review-pi (id 13)");
      // A role missing from the registry still points at codeg-setup.
      expect(section).toContain(
        "- verify: arbor-verify-pi (id unknown — run python3 ./.arbor/scripts/dispatch.py codeg-setup)",
      );
    });
  });

  describe("session-start.py <task-status> tier", () => {
    const TASK = "10-28-tier";

    function writeTask(
      meta: Record<string, string>,
      status: string,
      files: string[],
    ): void {
      const taskDir = path.join(tmp, ".arbor", "tasks", TASK);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, "task.json"),
        JSON.stringify({ id: TASK, title: "Tier task", status, meta }) + "\n",
      );
      for (const name of files) {
        fs.writeFileSync(path.join(taskDir, name), `# ${name}\n`);
      }
      fs.mkdirSync(path.join(tmp, ".arbor", ".runtime", "sessions"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmp, ".arbor", ".runtime", "sessions", "claude_tier-status.json"),
        JSON.stringify({ current_task: `.arbor/tasks/${TASK}`, platform: "claude" }),
      );
    }

    function taskStatus(): string {
      fs.writeFileSync(path.join(tmp, ".arbor", "workflow.md"), "# Workflow\n");
      const r = spawnSync("python3", [path.join(SHARED_HOOKS, "session-start.py")], {
        cwd: tmp,
        encoding: "utf-8",
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          cwd: tmp,
          session_id: "tier-status",
        }),
        env: cleanEnv({ CLAUDE_PROJECT_DIR: tmp }),
      });
      expect(r.status, r.stderr).toBe(0);
      const context = (
        JSON.parse(r.stdout) as {
          hookSpecificOutput: { additionalContext: string };
        }
      ).hookSpecificOutput.additionalContext;
      const section = /<task-status>\n([\s\S]*?)\n<\/task-status>/.exec(context)?.[1];
      expect(section, "missing <task-status> section").toBeDefined();
      return section ?? "";
    }

    it("a planning task pinned to standard without design.md needs design.md", () => {
      writeTask({ tier: "standard" }, "planning", ["prd.md"]);
      const status = taskStatus();
      expect(status).toContain(`Task: Tier task\nTier: standard\n`);
      expect(status).toContain("Tier standard needs design.md before start");
      expect(status).toContain("task.py set-meta <task> tier <t>");
      expect(status).not.toContain("(inferred)");
    });

    it("complete artifacts with empty manifests ask for approval and seed-context", () => {
      writeTask({}, "planning", ["prd.md", "implement.jsonl", "check.jsonl"]);
      const status = taskStatus();
      expect(status).toContain("Tier: light (inferred)");
      expect(status).toContain(
        "Planning artifacts for tier light are present; present the final planning summary",
      );
      expect(status).toContain("`task.py seed-context <task>`");
      expect(status).not.toContain("needs");
    });

    it("warns that parallel execution below tier full is refused at start", () => {
      writeTask({ tier: "standard", execution: "parallel" }, "planning", [
        "prd.md",
        "design.md",
      ]);
      expect(taskStatus()).toContain(
        "meta.execution=parallel requires tier full; `task.py start` refuses it while the tier is standard",
      );
    });

    it("an in_progress legacy task infers its tier and points at that tier's block", () => {
      writeTask({}, "in_progress", ["prd.md", "design.md"]);
      const status = taskStatus();
      expect(status).toContain("Tier: standard (inferred)");
      expect(status).toContain("Follow the <workflow-state> block for tier standard.");
      expect(status).toContain("Dispatch context order is jsonl entries");
    });

    it("no active task: classify first and mention the quick path", () => {
      const status = taskStatus();
      expect(status).toContain("Status: NO ACTIVE TASK");
      expect(status).toContain("Quick");
      expect(status).toContain("propose a tier (light / standard / full)");
      expect(status).not.toContain("Tier:");
    });
  });

  describe("inject-workflow-state.py tier and parallel breadcrumb", () => {
    const TASK = "10-24-par";

    function writeWorkflow(blocks: Record<string, string>): void {
      const lines = ["# Workflow", ""];
      for (const [key, body] of Object.entries(blocks)) {
        lines.push(`[workflow-state:${key}]`, body, `[/workflow-state:${key}]`, "");
      }
      fs.writeFileSync(path.join(tmp, ".arbor", "workflow.md"), lines.join("\n"));
    }

    function writeTask(
      meta: Record<string, string>,
      opts: { status?: string; files?: string[]; taskJson?: string } = {},
    ): void {
      const taskDir = path.join(tmp, ".arbor", "tasks", TASK);
      fs.rmSync(taskDir, { recursive: true, force: true });
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, "task.json"),
        opts.taskJson ??
          JSON.stringify({ id: TASK, status: opts.status ?? "in_progress", meta }) + "\n",
      );
      for (const name of opts.files ?? []) {
        fs.writeFileSync(path.join(taskDir, name), `# ${name}\n`);
      }
      fs.mkdirSync(path.join(tmp, ".arbor", ".runtime", "sessions"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmp, ".arbor", ".runtime", "sessions", "claude_par-session.json"),
        JSON.stringify({ current_task: `.arbor/tasks/${TASK}`, platform: "claude" }),
      );
    }

    function setup(meta: Record<string, string>, withParallelBlock: boolean): void {
      writeWorkflow({
        in_progress: "SERIAL BODY",
        ...(withParallelBlock ? { "in_progress-parallel": "PARALLEL BODY" } : {}),
      });
      writeTask(meta);
    }

    function breadcrumb(): string {
      const r = spawnSync(
        "python3",
        [path.join(SHARED_HOOKS, "inject-workflow-state.py")],
        {
          cwd: tmp,
          encoding: "utf-8",
          input: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            cwd: tmp,
            session_id: "par-session",
            prompt: "continue",
          }),
          env: cleanEnv({ CLAUDE_PROJECT_DIR: tmp }),
        },
      );
      expect(r.status, r.stderr).toBe(0);
      return (
        JSON.parse(r.stdout) as {
          hookSpecificOutput: { additionalContext: string };
        }
      ).hookSpecificOutput.additionalContext;
    }

    it("uses the <status>-parallel block for a full-tier meta.execution=parallel task", () => {
      setup({ execution: "parallel", tier: "full" }, true);
      const out = breadcrumb();
      expect(out).toContain(`Task: ${TASK} (in_progress) · Tier: full\n`);
      expect(out).toContain("PARALLEL BODY");
      expect(out).not.toContain("SERIAL BODY");
    });

    it("falls back to the plain status block when workflow.md has neither parallel nor tier block", () => {
      setup({ execution: "parallel", tier: "full" }, false);
      expect(breadcrumb()).toContain("SERIAL BODY");
    });

    it("keeps serial tasks on the plain status block", () => {
      setup({}, true);
      const out = breadcrumb();
      expect(out).toContain("SERIAL BODY");
      expect(out).not.toContain("PARALLEL BODY");
    });

    it("selects the <status>-<tier> block and reports the pinned tier after the status", () => {
      writeWorkflow({
        in_progress: "SERIAL BODY",
        "in_progress-light": "LIGHT BODY",
        "in_progress-standard": "STANDARD BODY",
      });
      writeTask({ tier: "standard" });
      const out = breadcrumb();
      expect(out).toContain(`Task: ${TASK} (in_progress) · Tier: standard\n`);
      expect(out).toContain("STANDARD BODY");
      expect(out).not.toContain("SERIAL BODY");
      expect(out).not.toContain("LIGHT BODY");
    });

    it("falls back to the plain status block when the tier block is missing", () => {
      writeWorkflow({
        in_progress: "SERIAL BODY",
        "in_progress-light": "LIGHT BODY",
      });
      writeTask({ tier: "standard" });
      const out = breadcrumb();
      expect(out).toContain(`Task: ${TASK} (in_progress) · Tier: standard\n`);
      expect(out).toContain("SERIAL BODY");
      expect(out).not.toContain("LIGHT BODY");
    });

    it("infers a legacy task's tier from its artifacts and marks it inferred", () => {
      writeWorkflow({
        in_progress: "SERIAL BODY",
        "in_progress-standard": "STANDARD BODY",
      });
      writeTask({}, { files: ["prd.md", "design.md"] });
      const out = breadcrumb();
      expect(out).toContain(`Task: ${TASK} (in_progress) · Tier: standard (inferred)\n`);
      expect(out).toContain("STANDARD BODY");
    });

    it("ignores meta.execution=parallel below tier full", () => {
      writeWorkflow({
        in_progress: "SERIAL BODY",
        "in_progress-standard": "STANDARD BODY",
        "in_progress-parallel": "PARALLEL BODY",
      });
      writeTask({ tier: "standard", execution: "parallel" });
      const out = breadcrumb();
      expect(out).toContain("STANDARD BODY");
      expect(out).not.toContain("PARALLEL BODY");
    });

    it("keeps a planning task on the plain planning block", () => {
      writeWorkflow({
        planning: "PLANNING BODY",
        "in_progress-full": "FULL BODY",
        "in_progress-parallel": "PARALLEL BODY",
      });
      writeTask({ tier: "full", execution: "parallel" }, { status: "planning" });
      const out = breadcrumb();
      expect(out).toContain(`Task: ${TASK} (planning) · Tier: full\n`);
      expect(out).toContain("PLANNING BODY");
      expect(out).not.toContain("FULL BODY");
      expect(out).not.toContain("PARALLEL BODY");
    });

    it("task_error headers carry no tier", () => {
      writeWorkflow({ task_error: "REPAIR BODY" });
      writeTask({}, { taskJson: "{not json" });
      const out = breadcrumb();
      expect(out).toContain(`Task: ${TASK} (task_error)\n`);
      expect(out).not.toContain("Tier:");
      expect(out).toContain("REPAIR BODY");
    });

    describe("shipped workflow.md", () => {
      const shipped = (): string =>
        fs.readFileSync(path.join(TEMPLATES, "arbor", "workflow.md"), "utf-8");
      const bodyOf = (status: string): string => {
        const m = new RegExp(
          `\\[workflow-state:${status}\\]\\s*\\n([\\s\\S]*?)\\n\\s*\\[/workflow-state:${status}\\]`,
        ).exec(shipped());
        expect(m, `shipped workflow.md lacks [workflow-state:${status}]`).not.toBeNull();
        return (m?.[1] ?? "").trim();
      };
      const shippedBreadcrumb = (
        meta: Record<string, string>,
        files: string[] = [],
      ): string => {
        writeTask(meta, { files });
        fs.copyFileSync(
          path.join(TEMPLATES, "arbor", "workflow.md"),
          path.join(tmp, ".arbor", "workflow.md"),
        );
        return breadcrumb();
      };

      it("selects in_progress-parallel for full + parallel and in_progress-light for a serial legacy task", () => {
        const parallelBody = bodyOf("in_progress-parallel");
        const lightBody = bodyOf("in_progress-light");

        const parallelOut = shippedBreadcrumb({ execution: "parallel", tier: "full" });
        expect(parallelOut).toContain(parallelBody);
        expect(parallelOut).not.toContain(lightBody);

        const serialOut = shippedBreadcrumb({ execution: "serial" });
        expect(serialOut).toContain(lightBody);
        expect(serialOut).not.toContain(parallelBody);
      });

      it("emits only the task's own tier block", () => {
        const tiers = ["light", "standard", "full"] as const;
        const bodies = Object.fromEntries(
          [...tiers.map((t) => `in_progress-${t}`), "in_progress-parallel", "in_progress"].map(
            (key) => [key, bodyOf(key)],
          ),
        );
        for (const tier of tiers) {
          const out = shippedBreadcrumb({ tier });
          expect(out).toContain(`Task: ${TASK} (in_progress) · Tier: ${tier}\n`);
          for (const [key, body] of Object.entries(bodies)) {
            if (key === `in_progress-${tier}`) {
              expect(out, `${tier} must read ${key}`).toContain(body);
            } else {
              expect(out, `${tier} must not read ${key}`).not.toContain(body);
            }
          }
        }
      });
    });
  });
});
