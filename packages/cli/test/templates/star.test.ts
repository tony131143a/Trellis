import { describe, expect, it } from "vitest";
import { getSettingsTemplate } from "../../src/templates/star/index.js";
import { collectStarTemplates } from "../../src/configurators/star.js";

// =============================================================================
// settings.json — hook wiring
// =============================================================================

const settings = JSON.parse(getSettingsTemplate().content) as {
  env?: Record<string, string>;
  hooks: Record<
    string,
    { matcher?: string; hooks: { command: string; timeout: number }[] }[]
  >;
};

describe("star settings.json", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(getSettingsTemplate().content)).not.toThrow();
  });

  it("returns the expected template shape", () => {
    const result = getSettingsTemplate();
    expect(result.targetPath).toBe("settings.json");
    expect(result.content.length).toBeGreaterThan(0);
  });

  // Same reason as Claude Code: pin the working directory so a `cd` in the
  // Bash tool does not break the next hook's relative command path.
  it("sets CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 in env", () => {
    expect(settings.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
  });

  it("registers session-start.py on the startup, clear, and compact SessionStart matchers", () => {
    const matchers = settings.hooks.SessionStart.map((e) => e.matcher);
    expect(matchers).toContain("startup");
    expect(matchers).toContain("clear");
    expect(matchers).toContain("compact");
    for (const entry of settings.hooks.SessionStart) {
      expect(entry.hooks[0].command).toContain(
        ".starFactory/hooks/session-start.py",
      );
    }
  });

  it("registers the delegation-context hook on the anchored codeg delegate_to_agent matcher", () => {
    const entry = settings.hooks.PreToolUse.find(
      (e) => e.matcher === "^mcp__codeg[-_]mcp__delegate_to_agent$",
    );
    expect(entry, "PreToolUse must match codeg delegate_to_agent").toBeDefined();
    expect(entry?.hooks[0].command).toContain(
      ".starFactory/hooks/inject-delegation-context.py",
    );
    expect(entry?.hooks[0].timeout).toBe(30);
  });

  it("registers the built-in agent guard on the anchored Agent|Task matcher", () => {
    const entry = settings.hooks.PreToolUse.find(
      (e) => e.matcher === "^(Agent|Task)$",
    );
    expect(entry, "PreToolUse must guard Agent|Task").toBeDefined();
    expect(entry?.hooks[0].command).toContain(
      ".starFactory/hooks/guard-builtin-agent.py",
    );
    expect(entry?.hooks[0].timeout).toBe(10);
    // The pre-dispatch bare Task / Agent matchers are gone.
    const matchers = settings.hooks.PreToolUse.map((e) => e.matcher);
    expect(matchers).not.toContain("Task");
    expect(matchers).not.toContain("Agent");
  });

  // StarFactory exports no session id into its shell children, so the
  // PreToolUse Bash ticket is its only route to session identity.
  it("registers the shell-session ticket hook on the Bash PreToolUse matcher", () => {
    const bashEntry = settings.hooks.PreToolUse.find((e) => e.matcher === "Bash");
    expect(bashEntry, "PreToolUse must have a Bash matcher").toBeDefined();
    expect(bashEntry?.hooks[0].command).toContain(
      ".starFactory/hooks/inject-shell-session-context.py",
    );
  });

  it("registers the workflow-state hook on UserPromptSubmit", () => {
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      ".starFactory/hooks/inject-workflow-state.py",
    );
  });

  it("keeps every hook command on the {{PYTHON_CMD}} placeholder", () => {
    for (const entries of Object.values(settings.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toContain("{{PYTHON_CMD}}");
        }
      }
    }
  });
});

// =============================================================================
// getAllAgents
// =============================================================================

// =============================================================================
// collectStarTemplates — the full on-disk file set
// =============================================================================

describe("collectStarTemplates", () => {
  const files = collectStarTemplates();

  it("writes settings under .starFactory/", () => {
    expect(files.has(".starFactory/settings.json")).toBe(true);
  });

  it("writes the shared hook scripts into .starFactory/hooks/", () => {
    for (const hook of [
      "session-start.py",
      "inject-workflow-state.py",
      "inject-delegation-context.py",
      "guard-builtin-agent.py",
      "inject-shell-session-context.py",
    ]) {
      expect(files.has(`.starFactory/hooks/${hook}`)).toBe(true);
    }
  });

  it("writes session-boundary commands, filtering out the hook-injected start command", () => {
    expect(files.has(".starFactory/commands/arbor/finish-work.md")).toBe(true);
    expect(files.has(".starFactory/commands/arbor/continue.md")).toBe(true);
    // SessionStart injects the workflow; a start command would duplicate it.
    expect(files.has(".starFactory/commands/arbor/start.md")).toBe(false);
  });

  it("writes workflow skills under .starFactory/skills/", () => {
    for (const skill of [
      "arbor-before-dev",
      "arbor-brainstorm",
      "arbor-check",
      "arbor-break-loop",
      "arbor-update-spec",
    ]) {
      expect(files.has(`.starFactory/skills/${skill}/SKILL.md`)).toBe(true);
    }
  });

  // Guards the `collectSkillTemplates(skillRoot, skills, bundledSkills)` third
  // argument: dropping it ships zero bundled skills with no other failure.
  it("writes bundled skill files, including their nested references", () => {
    expect(files.has(".starFactory/skills/arbor-meta/SKILL.md")).toBe(true);
    expect(
      files.has(
        ".starFactory/skills/arbor-meta/references/local-architecture/overview.md",
      ),
    ).toBe(true);
  });

  it("reads nothing from the unusable project-level .claude/ directory", () => {
    for (const key of files.keys()) {
      expect(key.startsWith(".claude/")).toBe(false);
      expect(key.startsWith(".agents/skills/")).toBe(false);
    }
  });
});