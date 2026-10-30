import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getConfiguredPlatforms,
  configurePlatform,
  collectPlatformTemplates,
  PLATFORM_IDS,
} from "../../src/configurators/index.js";
import { AI_TOOLS } from "../../src/types/ai-tools.js";
import {
  setWriteMode,
  startRecordingWrites,
  stopRecordingWrites,
} from "../../src/utils/file-writer.js";
import { initializeHashes } from "../../src/utils/template-hash.js";
import {
  settingsTemplate as claudeSettingsTemplate,
  getStatuslineHook,
} from "../../src/templates/claude/index.js";
import {
  resolvePlaceholders,
  replacePythonCommandLiterals,
  setResolvedPythonCommand,
  resetResolvedPythonCommand,
} from "../../src/configurators/shared.js";

function readConfiguredFile(root: string, relativePath: string): string {
  return fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf-8");
}

// =============================================================================
// configure ⟷ collectTemplates parity oracle
//
// `collectTemplates` is the single description of a platform's file set;
// `configure` writes it. Both directions must hold, and only the forward one
// ("every collected file is on disk") used to be asserted — which is how
// 0.5.5 shipped `.agents/skills/arbor-start/SKILL.md` from `configureCodex`
// with no matching `collectTemplates` entry, leaving upgraders without the
// file after `arbor update` (see manifests/0.5.7.json).
// =============================================================================

/**
 * Paths `configure` writes on purpose that `collectTemplates` does not
 * describe. Exactly one, and it is deliberate.
 *
 * `.claude/hooks/statusline.py` is written only by
 * `arbor init --with-statusline`. Keeping it out of `collectTemplates` is
 * intentional and separately locked by regression.test.ts
 * "[statusline-opt-in] statusline.py is not in claude's collected templates":
 * `analyzeChanges()` classifies a collected-but-absent file as a new file and
 * would force-install the statusline onto projects that opted out.
 *
 * Known consequence, documented but deliberately NOT fixed here (see
 * `.arbor/tasks/08-06-converge-platform-templates/research/configure-vs-collect-inventory.md`):
 * init records the file in `.template-hashes.json`, then
 * `pruneOrphanManifestKeys` drops it as an orphan because it is in neither
 * `collectTemplates` nor a migration — so an opted-in user's `statusline.py`
 * is frozen after their first `arbor update` and is left behind by
 * `arbor uninstall`.
 */
const CONFIGURE_ONLY_PATHS = new Set([".claude/hooks/statusline.py"]);

/**
 * Directories `configure` creates with no file underneath. A
 * `Map<path, content>` cannot express an empty directory, so each one is
 * named here against the platform that needs it.
 */
const CONFIGURE_ONLY_EMPTY_DIRS: Partial<
  Record<(typeof PLATFORM_IDS)[number], string[]>
> = {};

/** Every file under `root`, as POSIX paths relative to `root`. */
function walkFiles(root: string, rel = ""): string[] {
  const found: string[] = [];
  const absDir = rel ? path.join(root, ...rel.split("/")) : root;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relEntry = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...walkFiles(root, relEntry));
    } else {
      found.push(relEntry);
    }
  }
  return found;
}

/** Directories under `root` with no file anywhere beneath them. */
function walkEmptyDirs(root: string, rel = ""): string[] {
  const found: string[] = [];
  const absDir = rel ? path.join(root, ...rel.split("/")) : root;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relEntry = rel ? `${rel}/${entry.name}` : entry.name;
    if (walkFiles(root, relEntry).length === 0) {
      found.push(relEntry);
    } else {
      found.push(...walkEmptyDirs(root, relEntry));
    }
  }
  return found;
}

/** Snapshot every file under `root` as path → content. */
function snapshotDir(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const relPath of walkFiles(root)) {
    snapshot.set(relPath, readConfiguredFile(root, relPath));
  }
  return snapshot;
}

// =============================================================================
// getConfiguredPlatforms — detects Arbor-owned platform files
// =============================================================================

describe("getConfiguredPlatforms", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-platforms-"));
    setWriteMode("force");
  });

  afterEach(() => {
    stopRecordingWrites();
    setWriteMode("ask");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty set when no platform dirs exist", () => {
    const result = getConfiguredPlatforms(tmpDir);
    expect(result.size).toBe(0);
  });

  it("does not treat native platform directories as Arbor installations", () => {
    for (const id of PLATFORM_IDS) {
      fs.mkdirSync(path.join(tmpDir, AI_TOOLS[id].configDir), {
        recursive: true,
      });
    }

    expect([...getConfiguredPlatforms(tmpDir)]).toEqual([]);
  });

  it("detects every platform from the files Arbor tracked for it", async () => {
    for (const id of PLATFORM_IDS) {
      const platformRoot = path.join(tmpDir, id);
      fs.mkdirSync(platformRoot, { recursive: true });
      const written = startRecordingWrites(platformRoot);
      try {
        await configurePlatform(id, platformRoot);
      } finally {
        stopRecordingWrites();
      }
      fs.mkdirSync(path.join(platformRoot, ".arbor"), { recursive: true });
      initializeHashes(platformRoot, { trackedPaths: written });

      expect([...getConfiguredPlatforms(platformRoot)]).toEqual([id]);
    }
  });

  it("ignores unrelated directories", () => {
    fs.mkdirSync(path.join(tmpDir, ".vscode"));
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const result = getConfiguredPlatforms(tmpDir);
    expect(result.size).toBe(0);
  });
});

// =============================================================================
// configurePlatform — copies templates to target directory
// =============================================================================

describe("configurePlatform", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-configure-"));
    // Use force mode to avoid interactive prompts
    setWriteMode("force");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setWriteMode("ask");
  });

  it("configurePlatform('claude-code') creates .claude directory", async () => {
    await configurePlatform("claude-code", tmpDir);
    expect(fs.existsSync(path.join(tmpDir, ".claude"))).toBe(true);
  });

  it("configurePlatform writes collected templates byte-for-byte for every platform", async () => {
    for (const id of PLATFORM_IDS) {
      const platformDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `arbor-parity-${id}-`),
      );
      try {
        await configurePlatform(id, platformDir);
        const templates = collectPlatformTemplates(id);
        expect(
          templates,
          `${id} should expose template tracking`,
        ).toBeInstanceOf(Map);
        if (!templates) {
          throw new Error(`${id} did not expose template tracking`);
        }

        for (const [relativePath, expectedContent] of templates) {
          const targetPath = path.join(platformDir, ...relativePath.split("/"));
          expect(
            fs.existsSync(targetPath),
            `${id} should write ${relativePath}`,
          ).toBe(true);
          expect(readConfiguredFile(platformDir, relativePath)).toBe(
            expectedContent,
          );
        }
      } finally {
        fs.rmSync(platformDir, { recursive: true, force: true });
      }
    }
  });

  it("configurePlatform writes no file collectTemplates does not describe, for every platform", async () => {
    // The reverse of the assertion above. Without it, "configure writes a file
    // collectTemplates forgot" passes the suite silently — the exact failure
    // mode that shipped in 0.5.5 (codex arbor-start).
    for (const id of PLATFORM_IDS) {
      const platformDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `arbor-reverse-${id}-`),
      );
      try {
        await configurePlatform(id, platformDir);
        const templates = collectPlatformTemplates(id);
        if (!templates) {
          throw new Error(`${id} did not expose template tracking`);
        }

        const undescribed = walkFiles(platformDir).filter(
          (relPath) =>
            !templates.has(relPath) && !CONFIGURE_ONLY_PATHS.has(relPath),
        );
        expect(
          undescribed,
          `${id} wrote files that collectTemplates does not describe`,
        ).toEqual([]);

        expect(
          walkEmptyDirs(platformDir),
          `${id} created empty directories not named in CONFIGURE_ONLY_EMPTY_DIRS`,
        ).toEqual(CONFIGURE_ONLY_EMPTY_DIRS[id] ?? []);

        // Idempotency: init runs configure, update runs collectTemplates, and
        // re-running init must not accumulate or rewrite anything.
        const first = snapshotDir(platformDir);
        await configurePlatform(id, platformDir);
        expect(snapshotDir(platformDir), `${id} is not idempotent`).toEqual(
          first,
        );
      } finally {
        fs.rmSync(platformDir, { recursive: true, force: true });
      }
    }
  });

  it("configurePlatform and collectTemplates agree under Windows python rendering", async () => {
    // `collectPlatformTemplates` rewrites python3 → python for the whole map in
    // one place; `configure` has to reach the same bytes. A site that writes
    // raw content is invisible on macOS/Linux, where the rewrite is a no-op.
    setResolvedPythonCommand("python");
    try {
      for (const id of PLATFORM_IDS) {
        const platformDir = fs.mkdtempSync(
          path.join(os.tmpdir(), `arbor-win-${id}-`),
        );
        try {
          await configurePlatform(id, platformDir);
          const templates = collectPlatformTemplates(id);
          if (!templates) {
            throw new Error(`${id} did not expose template tracking`);
          }

          const onDisk = walkFiles(platformDir);
          expect(
            onDisk.filter(
              (relPath) =>
                !templates.has(relPath) && !CONFIGURE_ONLY_PATHS.has(relPath),
            ),
            `${id} wrote undescribed files under Windows rendering`,
          ).toEqual([]);

          for (const [relativePath, expectedContent] of templates) {
            expect(
              onDisk.includes(relativePath),
              `${id} should write ${relativePath}`,
            ).toBe(true);
            expect(
              readConfiguredFile(platformDir, relativePath),
              `${id}: ${relativePath} differs under Windows rendering`,
            ).toBe(expectedContent);
          }
        } finally {
          fs.rmSync(platformDir, { recursive: true, force: true });
        }
      }
    } finally {
      resetResolvedPythonCommand();
    }
  });

  it("configurePlatform('claude-code', --with-statusline) writes exactly one undescribed file", async () => {
    // The one named exemption, exercised. `--with-statusline` is the only opt-in
    // that adds a file `collectTemplates` does not describe; if it ever adds a
    // second, CONFIGURE_ONLY_PATHS has to grow and say why.
    await configurePlatform("claude-code", tmpDir, { withStatusline: true });
    const templates = collectPlatformTemplates("claude-code");
    if (!templates) {
      throw new Error("claude-code did not expose template tracking");
    }

    const undescribed = walkFiles(tmpDir).filter(
      (relPath) => !templates.has(relPath),
    );
    expect(undescribed).toEqual([...CONFIGURE_ONLY_PATHS]);
    expect(readConfiguredFile(tmpDir, ".claude/hooks/statusline.py")).toBe(
      replacePythonCommandLiterals(getStatuslineHook()),
    );
  });

  it("configurePlatform('codex') installs tracked shared skills and hooks", async () => {
    await configurePlatform("codex", tmpDir);
    const templates = collectPlatformTemplates("codex");
    expect(templates).toBeDefined();
    for (const [relativePath, content] of templates ?? []) {
      expect(readConfiguredFile(tmpDir, relativePath)).toBe(content);
    }
    expect(
      fs.existsSync(path.join(tmpDir, ".agents/skills/arbor-start/SKILL.md")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".agents/skills/arbor-workflow/SKILL.md"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".codex/hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".codex/config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".starFactory"))).toBe(false);
    expect(AI_TOOLS.codex.supportsAgentSkills).toBe(true);
  });

  it("claude-code configuration includes commands directory", async () => {
    await configurePlatform("claude-code", tmpDir);
    expect(fs.existsSync(path.join(tmpDir, ".claude", "commands"))).toBe(true);
  });

  it("claude-code configuration includes settings.json", async () => {
    await configurePlatform("claude-code", tmpDir);
    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    // Should be valid JSON
    const content = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    expect(settings).not.toHaveProperty("statusLine");
    expect(
      fs.existsSync(path.join(tmpDir, ".claude", "hooks", "statusline.py")),
    ).toBe(false);
  });

  it("claude-code default settings.json is byte-identical to the resolved template (statusline off)", async () => {
    await configurePlatform("claude-code", tmpDir, { withStatusline: false });
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      "utf-8",
    );
    expect(content).toBe(resolvePlaceholders(claudeSettingsTemplate));
    expect(content).not.toContain("statusLine");
  });

  it("claude-code with statusline opt-in installs statusline.py and statusLine settings entry", async () => {
    await configurePlatform("claude-code", tmpDir, { withStatusline: true });

    const hookPath = path.join(tmpDir, ".claude", "hooks", "statusline.py");
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.readFileSync(hookPath, "utf-8")).toBe(
      replacePythonCommandLiterals(getStatuslineHook()),
    );

    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "settings.json"),
      "utf-8",
    );
    expect(content).not.toContain("{{PYTHON_CMD}}");
    const settings = JSON.parse(content) as Record<string, unknown>;
    expect(settings.statusLine).toEqual({
      type: "command",
      command: replacePythonCommandLiterals(
        "python3 .claude/hooks/statusline.py",
      ),
    });
    // statusLine is appended at the END — byte-parity with update's
    // preserveExistingClaudeStatusLine (parse → assign → stringify), so a
    // fresh opted-in project shows zero settings.json diff on update
    expect(Object.keys(settings)).toEqual([
      "env",
      "hooks",
      "enabledPlugins",
      "statusLine",
    ]);
    // Everything besides statusLine is unchanged from the default template
    const expected = JSON.parse(
      resolvePlaceholders(claudeSettingsTemplate),
    ) as Record<string, unknown>;
    expect(settings.env).toEqual(expected.env);
    expect(settings.hooks).toEqual(expected.hooks);
    expect(settings.enabledPlugins).toEqual(expected.enabledPlugins);
  });

  it("withStatusline option leaves all other platforms unaffected", async () => {
    for (const id of PLATFORM_IDS) {
      if (id === "claude-code") continue;
      await configurePlatform(id, tmpDir, { withStatusline: true });
    }

    const walk = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...walk(full));
        } else {
          files.push(full);
        }
      }
      return files;
    };

    for (const file of walk(tmpDir)) {
      expect(path.basename(file)).not.toBe("statusline.py");
      if (path.basename(file) === "settings.json") {
        expect(JSON.parse(fs.readFileSync(file, "utf-8"))).not.toHaveProperty(
          "statusLine",
        );
      }
    }
  });

  it("does not throw for any platform", async () => {
    for (const id of PLATFORM_IDS) {
      const platformDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `arbor-cfg-${id}-`),
      );
      try {
        setWriteMode("force");
        await expect(configurePlatform(id, platformDir)).resolves.not.toThrow();
      } finally {
        fs.rmSync(platformDir, { recursive: true, force: true });
      }
    }
  });
});
