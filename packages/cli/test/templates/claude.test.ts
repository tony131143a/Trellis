import { describe, expect, it } from "vitest";
import {
  arborSkillTemplate,
  settingsTemplate,
  getSettingsTemplate,
} from "../../src/templates/claude/index.js";

// =============================================================================
// settingsTemplate — module-level constant
// =============================================================================

describe("settingsTemplate", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(settingsTemplate)).not.toThrow();
  });

  it("is a non-empty string", () => {
    expect(settingsTemplate.length).toBeGreaterThan(0);
  });

  // v0.5.0-beta.8: pin CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 at the project
  // level so Bash tool cwd changes don't leak into subsequent hook invocations.
  // Without this, a user who runs `cd frontend/` via Bash tool leaves cwd stuck
  // in `frontend/`, and the next UserPromptSubmit hook (which resolves
  // `.claude/hooks/inject-workflow-state.py` relative to cwd) crashes with
  // ENOENT. We can't fix this via command-string rewriting because
  // $CLAUDE_PROJECT_DIR doesn't expand on Windows shells (see CC issue #6023).
  // The env-var approach is read by CC internally, identical on all platforms.
  it("sets CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 in env", () => {
    const settings = JSON.parse(settingsTemplate) as {
      env?: Record<string, string>;
    };
    expect(settings.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
  });
});

// =============================================================================
// settingsTemplate — no hooks (arbor 1.0)
// =============================================================================

describe("settingsTemplate hooks", () => {
  it("registers no hooks and no statusLine", () => {
    const settings = JSON.parse(settingsTemplate) as Record<string, unknown>;
    expect(settings.hooks).toBeUndefined();
    expect(settings.statusLine).toBeUndefined();
    expect(settingsTemplate).not.toContain(".claude/hooks/");
  });
});

// =============================================================================
// arborSkillTemplate — body of the main-agent skill `arbor`
// =============================================================================

describe("arborSkillTemplate", () => {
  it("is the skill body: no frontmatter, driver via {{PYTHON_CMD}}", () => {
    expect(arborSkillTemplate.startsWith("# Arbor\n")).toBe(true);
    expect(arborSkillTemplate).toContain(
      "{{PYTHON_CMD}} ./.arbor/scripts/arbor.py",
    );
    for (const marker of [
      "arbor sync --wait",
      "nodes/<id>.md",
      "arbor review --pass",
    ]) {
      expect(arborSkillTemplate).toContain(marker);
    }
  });
});

// =============================================================================
// getSettingsTemplate — returns settings as SettingsTemplate
// =============================================================================

describe("getSettingsTemplate", () => {
  it("returns correct shape with valid JSON", () => {
    const result = getSettingsTemplate();
    expect(result.targetPath).toBe("settings.json");
    expect(result.content.length).toBeGreaterThan(0);
    expect(() => JSON.parse(result.content)).not.toThrow();
  });
});
