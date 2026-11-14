/**
 * 0.11.0 → 1.0.0: one skill, no hooks / role files / workflow.md / commands.
 *
 * The 1.0.0 manifest's delete list is derived from two real installs: every
 * path a 0.11 install tracked (fixture `install-0.11.0.json`, claude + codex)
 * that a 1.0 install no longer ships. These tests pin that derivation and the
 * update behavior around it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "ARBOR") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
  execFileSync: vi.fn().mockReturnValue(""),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
}));

import { execSync } from "node:child_process";
import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";
import { VERSION } from "../../src/constants/version.js";
import { getMigrationsForVersion } from "../../src/migrations/index.js";
import { computeHash, loadHashes } from "../../src/utils/template-hash.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/install-0.11.0.json",
);
const SCRIPTS = ".arbor/scripts/";
const isScript = (p: string) => p.startsWith(SCRIPTS);

const deletes = getMigrationsForVersion("0.11.0", "1.0.0").map((m) => {
  expect(m.type).toBe("delete");
  return m.from;
});

/** The 0.11 Claude Code hook entries, as `.claude/settings.json` carried them. */
const CLAUDE_011_HOOKS = {
  SessionStart: [
    {
      matcher: "startup",
      hooks: [
        {
          type: "command",
          command: "python3 .claude/hooks/session-start.py",
          timeout: 30,
        },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: "^(Agent|Task)$",
      hooks: [
        {
          type: "command",
          command: "python3 .claude/hooks/guard-builtin-agent.py",
          timeout: 10,
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command: "python3 .claude/hooks/inject-workflow-state.py",
          timeout: 15,
        },
      ],
    },
  ],
};

const codexHook = (name: string) => ({
  type: "command",
  command: `python3 -X utf8 "$(git rev-parse --show-toplevel)/.codex/hooks/${name}"`,
  timeout: 30,
});

/** The 0.11 `.codex/hooks.json`. */
const CODEX_011_HOOKS_JSON = {
  hooks: {
    SessionStart: [{ hooks: [codexHook("session-start.py")] }],
    UserPromptSubmit: [{ hooks: [codexHook("inject-workflow-state.py")] }],
  },
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("1.0.0 migration", () => {
  let tmpDir: string;

  const abs = (p: string) => path.join(tmpDir, ...p.split("/"));
  const read = (p: string) => fs.readFileSync(abs(p), "utf-8");
  const write = (p: string, content: string) => {
    fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
    fs.writeFileSync(abs(p), content);
  };
  const hashFile = () => abs(".arbor/.template-hashes.json");
  const setHashes = (entries: Record<string, string>) => {
    const data = JSON.parse(fs.readFileSync(hashFile(), "utf-8")) as {
      hashes: Record<string, string>;
    };
    Object.assign(data.hashes, entries);
    fs.writeFileSync(hashFile(), JSON.stringify(data, null, 2));
  };

  /**
   * Turn a fresh 1.0 install into the shape a 0.11 install leaves: every
   * deleted path present and recorded with the hash of its content, the 0.11
   * hooks in `.claude/settings.json`, `.version` 0.11.0. `modified` paths get
   * different content on disk than their recorded hash.
   */
  function simulate011(modified: Record<string, string> = {}): void {
    const entries: Record<string, string> = {};
    for (const p of deletes) {
      if (fs.existsSync(abs(p))) continue; // a script the 1.0 build still ships
      const content =
        p === ".codex/hooks.json" ? json(CODEX_011_HOOKS_JSON) : `# 0.11 ${p}\n`;
      write(p, content);
      entries[p] = computeHash(content);
    }
    const settings = JSON.parse(read(".claude/settings.json")) as Record<
      string,
      unknown
    >;
    const settings011 = json({ ...settings, hooks: CLAUDE_011_HOOKS });
    write(".claude/settings.json", settings011);
    entries[".claude/settings.json"] = computeHash(settings011);
    setHashes(entries);
    for (const [p, content] of Object.entries(modified)) write(p, content);
    fs.writeFileSync(abs(".arbor/.version"), "0.11.0");
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-mig-100-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const noop = () => {};
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.mocked(execSync).mockImplementation(((cmd: string) =>
      cmd.endsWith("--version") ? "Python 3.11.12" : "") as typeof execSync);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: VERSION }),
      }),
    );
    await init({ yes: true, claude: true, codex: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes exactly the non-script paths 0.11 installed and 1.0 does not", () => {
    const installed011 = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as string[];
    const installed100 = new Set(Object.keys(loadHashes(tmpDir)));
    const removed = installed011.filter(
      (p) => !isScript(p) && !installed100.has(p),
    );
    // A mismatch means a template was added or removed without updating
    // src/migrations/manifests/1.0.0.json (or the 0.11 fixture is stale).
    expect(deletes.filter((p) => !isScript(p)).sort()).toEqual(removed.sort());
    // Every delete entry was a real 0.11 install path.
    for (const p of deletes) expect(installed011, p).toContain(p);
  });

  it("deletes no script the 1.0 driver still installs, and every 0.11 script it dropped", () => {
    const installed011 = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as string[];
    const installed100 = new Set(Object.keys(loadHashes(tmpDir)));
    const stillInstalled = deletes.filter(
      (p) => isScript(p) && installed100.has(p),
    );
    const droppedWithoutEntry = installed011.filter(
      (p) => isScript(p) && !installed100.has(p) && !deletes.includes(p),
    );
    // Both lists must be empty once the 1.0 driver scripts land. A path here
    // means src/templates/arbor/scripts and the script half of the 1.0.0
    // manifest disagree: fix the manifest, not this test.
    expect({ stillInstalled, droppedWithoutEntry }).toEqual({
      stillInstalled: [],
      droppedWithoutEntry: [],
    });
  });

  it("--migrate removes unmodified files and their empty directories, keeps a modified one under -s", async () => {
    simulate011({ ".arbor/agents/fix.md": "# my fix role\n" });

    await update({ migrate: true, skipAll: true });

    for (const p of deletes.filter((d) => !isScript(d))) {
      if (p === ".arbor/agents/fix.md") continue;
      expect(fs.existsSync(abs(p)), p).toBe(false);
      expect(loadHashes(tmpDir), p).not.toHaveProperty(p);
    }
    expect(read(".arbor/agents/fix.md")).toBe("# my fix role\n");
    for (const dir of [
      ".claude/hooks",
      ".claude/commands",
      ".claude/skills/arbor-meta",
      ".codex/hooks",
      ".agents/skills/arbor-start",
    ]) {
      expect(fs.existsSync(abs(dir)), dir).toBe(false);
    }
    // The unmodified 0.11 settings.json is replaced by the 1.0 template.
    const settings = JSON.parse(read(".claude/settings.json")) as Record<
      string,
      unknown
    >;
    expect(settings).not.toHaveProperty("hooks");
    expect(read(".arbor/.version")).toBe(VERSION);
  });

  it("scrubs the Arbor hooks from a user-modified settings.json and keeps the user's own", async () => {
    simulate011();
    const userHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "./scripts/lint-bash.sh" }],
    };
    const settings = JSON.parse(read(".claude/settings.json")) as {
      hooks: Record<string, unknown[]>;
      permissions?: unknown;
    };
    settings.hooks.PreToolUse.push(userHook);
    settings.permissions = { allow: ["Bash(git:*)"] };
    write(".claude/settings.json", json(settings));

    await update({ migrate: true, force: true });

    const after = JSON.parse(read(".claude/settings.json")) as Record<
      string,
      unknown
    >;
    expect(after.hooks).toEqual({ PreToolUse: [userHook] });
    expect(after.permissions).toEqual({ allow: ["Bash(git:*)"] });
    expect(after.env).toEqual({ CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1" });
    expect(read(".claude/settings.json")).not.toContain(".claude/hooks/");
    expect(fs.existsSync(abs(".claude/hooks"))).toBe(false);
  });

  it("keeps a user-modified .codex/hooks.json with only the user's entries; deletes an unmodified one", async () => {
    simulate011();
    expect(fs.existsSync(abs(".codex/hooks.json"))).toBe(true);
    await update({ migrate: true, force: true });
    expect(fs.existsSync(abs(".codex/hooks.json"))).toBe(false);
    // Nothing of the user's was under .codex/, so the directory goes too.
    expect(fs.existsSync(abs(".codex"))).toBe(false);

    // Second project: the user added a hook of their own.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir);
    await init({ yes: true, claude: true, codex: true, force: true });
    const userHook = { type: "command", command: "./scripts/notify.sh" };
    const modified = structuredClone(CODEX_011_HOOKS_JSON) as {
      hooks: Record<string, { hooks: unknown[] }[]>;
    };
    modified.hooks.Stop = [{ hooks: [userHook] }];
    simulate011({ ".codex/hooks.json": json(modified) });

    await update({ migrate: true, force: true });

    const after = JSON.parse(read(".codex/hooks.json")) as unknown;
    expect(after).toEqual({ hooks: { Stop: [{ hooks: [userHook] }] } });
    expect(fs.existsSync(abs(".codex/hooks"))).toBe(false);
  });

  it("never rewrites .arbor/config.yaml, not even with --migrate --force", async () => {
    const config = `${read(".arbor/config.yaml")}\n# team note\nmax_journal_lines: 900\n`;
    write(".arbor/config.yaml", config);
    simulate011();

    await update({ migrate: true, force: true });
    expect(read(".arbor/config.yaml")).toBe(config);

    await update({ force: true });
    expect(read(".arbor/config.yaml")).toBe(config);
  });

  it("a fresh init installs the 1.0 target state", () => {
    const tracked = Object.keys(loadHashes(tmpDir))
      .filter((p) => !isScript(p))
      .sort();
    const bootstrap = [
      "SKILL.md",
      "references/mcp-setup.md",
      "references/repository-analysis.md",
      "references/spec-task-planning.md",
      "references/spec-writing.md",
    ];
    expect(tracked).toEqual(
      [
        ...bootstrap.map((f) => `.agents/skills/arbor-spec-bootstrap/${f}`),
        ".agents/skills/arbor-update-spec/SKILL.md",
        ".arbor/config.yaml",
        ".claude/settings.json",
        ...bootstrap.map((f) => `.claude/skills/arbor-spec-bootstrap/${f}`),
        ".claude/skills/arbor-update-spec/SKILL.md",
        ".claude/skills/arbor/SKILL.md",
        "AGENTS.md",
        "CLAUDE.md",
      ].sort(),
    );
    expect(read(".claude/skills/arbor/SKILL.md")).toMatch(
      /^---\nname: arbor\ndescription: /,
    );
    const settings = JSON.parse(read(".claude/settings.json")) as Record<
      string,
      unknown
    >;
    expect(settings).not.toHaveProperty("hooks");
    for (const absent of [
      ".claude/agents",
      ".claude/hooks",
      ".claude/commands",
      ".codex",
      ".arbor/agents",
      ".arbor/workflow.md",
    ]) {
      expect(fs.existsSync(abs(absent)), absent).toBe(false);
    }
    expect(fs.readdirSync(abs(".arbor/tasks"))).toEqual([]);
  });
});
