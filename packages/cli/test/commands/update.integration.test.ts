/**
 * Integration tests for the update() command.
 *
 * Tests the full update flow in real temp directories with minimal mocking.
 * Only external dependencies are mocked: figlet, inquirer, child_process, fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";

// === External dependency mocks (hoisted by vitest) ===

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "ARBOR") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    const py = process.platform === "win32" ? "python" : "python3";
    return cmd === `${py} --version` ? "Python 3.11.12" : "";
  }),
}));

// === Imports ===

import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";
import { VERSION } from "../../src/constants/version.js";
import { DIR_NAMES, FILE_NAMES, PATHS } from "../../src/constants/paths.js";
import { computeHash } from "../../src/utils/template-hash.js";
import { workflowMdTemplate } from "../../src/templates/arbor/index.js";
import { claudeMdContent } from "../../src/templates/markdown/index.js";
import { replacePythonCommandLiterals } from "../../src/configurators/shared.js";

// A managed template file that update always handles (Python script)
const MANAGED_FILE = `${PATHS.SCRIPTS}/get_context.py`;

/** Remove a key from a hash object (avoids eslint no-dynamic-delete) */
function removeHashEntry(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

/**
 * Read the v2 hashes file and return the inner `hashes` map.
 * Tests manipulate this map then write it back via `writeHashesV2`.
 */
function readHashesV2(hashFile: string): Record<string, string> {
  const raw = JSON.parse(fs.readFileSync(hashFile, "utf-8")) as {
    __version?: number;
    hashes?: Record<string, string>;
  };
  return raw.hashes ?? {};
}

/** Write a v2-shaped hashes file. */
function writeHashesV2(hashFile: string, hashes: Record<string, string>): void {
  fs.writeFileSync(hashFile, JSON.stringify({ __version: 2, hashes }, null, 2));
}

function removeSubagentsSection(content: string): string {
  return content.replace(
    "\n## Subagents\n\n" +
      "- ALWAYS wait for all subagents to complete before yielding.\n" +
      "- Spawn subagents automatically when:\n" +
      "  - Parallelizable work (e.g., install + verify, npm test + typecheck, multiple tasks from plan)\n" +
      "  - Long-running or blocking tasks where a worker can run independently.\n" +
      "  - Isolation for risky changes or checks\n",
    "",
  );
}

describe("update() integration", () => {
  let tmpDir: string;

  /** Initialize a fresh project in tmpDir */
  async function setupProject(): Promise<void> {
    await init({ yes: true, force: true });
  }

  function projectFile(relativePath: string): string {
    return path.join(tmpDir, relativePath);
  }

  function hashFilePath(): string {
    return projectFile(`${DIR_NAMES.WORKFLOW}/.template-hashes.json`);
  }

  function versionFilePath(): string {
    return projectFile(`${DIR_NAMES.WORKFLOW}/.version`);
  }

  function readProjectFile(relativePath: string): string {
    return fs.readFileSync(projectFile(relativePath), "utf-8");
  }

  function writeProjectFile(relativePath: string, content: string): void {
    const fullPath = projectFile(relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-update-int-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const noop = () => {};
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    // Mock fetch for npm registry
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: VERSION }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("#1 same version update is a true no-op (zero file changes, no backup)", async () => {
    await setupProject();

    // Full snapshot before update
    const snapshotBefore = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else
          snapshotBefore.set(
            path.relative(tmpDir, full),
            fs.readFileSync(full, "utf-8"),
          );
      }
    };
    walk(tmpDir);

    await update({});

    // Full snapshot after update
    const snapshotAfter = new Map<string, string>();
    const walk2 = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk2(full);
        else
          snapshotAfter.set(
            path.relative(tmpDir, full),
            fs.readFileSync(full, "utf-8"),
          );
      }
    };
    walk2(tmpDir);

    // No files added or removed
    const addedFiles = [...snapshotAfter.keys()].filter(
      (k) => !snapshotBefore.has(k),
    );
    const removedFiles = [...snapshotBefore.keys()].filter(
      (k) => !snapshotAfter.has(k),
    );
    expect(addedFiles).toEqual([]);
    expect(removedFiles).toEqual([]);

    // No file contents changed
    const changedFiles: string[] = [];
    for (const [filePath, content] of snapshotBefore) {
      if (snapshotAfter.get(filePath) !== content) {
        changedFiles.push(filePath);
      }
    }
    expect(changedFiles).toEqual([]);

    // No backup directory created
    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    expect(entries.filter((e) => e.startsWith(".backup-")).length).toBe(0);
  });

  it("#2 dry run makes no file changes even when changes exist", async () => {
    await setupProject();

    // Delete hash + file to simulate a truly new template file
    const target = path.join(tmpDir, MANAGED_FILE);
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      MANAGED_FILE,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);
    fs.unlinkSync(target);

    await update({ dryRun: true });

    // File should still be missing (dry run didn't recreate it)
    expect(fs.existsSync(target)).toBe(false);
    // No backup directory created
    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    expect(entries.filter((e) => e.startsWith(".backup-")).length).toBe(0);
  });

  it("#3 user-deleted file (with stored hash) is not re-added on update", async () => {
    await setupProject();

    const target = path.join(tmpDir, MANAGED_FILE);
    expect(fs.existsSync(target)).toBe(true);

    // Delete it (simulating user deletion; hash still exists in .template-hashes.json)
    fs.unlinkSync(target);
    expect(fs.existsSync(target)).toBe(false);

    await update({ force: true });

    // File should NOT be re-created (user deleted it, hash still exists)
    expect(fs.existsSync(target)).toBe(false);
  });

  it("#4 auto-updates file when template changed but user did not modify", async () => {
    await setupProject();

    const targetRelative = MANAGED_FILE;
    const targetFull = path.join(tmpDir, targetRelative);
    const templateContent = fs.readFileSync(targetFull, "utf-8");

    // Simulate "old template version": change file + update hash to match
    const oldContent = "# Old version of script\n";
    fs.writeFileSync(targetFull, oldContent);

    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = readHashesV2(hashFile);
    hashes[targetRelative] = computeHash(oldContent);
    writeHashesV2(hashFile, hashes);

    await update({ force: true });

    // File should be auto-updated back to current template
    expect(fs.readFileSync(targetFull, "utf-8")).toBe(templateContent);
  });

  it("#4b auto-updates legacy untracked AGENTS.md and preserves outside content", async () => {
    await setupProject();

    const targetRelative = FILE_NAMES.AGENTS;
    const targetFull = path.join(tmpDir, targetRelative);
    const templateContent = fs.readFileSync(targetFull, "utf-8");
    const oldContent = removeSubagentsSection(templateContent);
    const existingContent = `# Local instructions\n\n${oldContent}\n\n## Project Notes\n\nKeep this.`;
    const expectedContent = `# Local instructions\n\n${templateContent}\n\n## Project Notes\n\nKeep this.`;

    fs.writeFileSync(targetFull, existingContent);

    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      targetRelative,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);

    await update({});

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(expectedContent);
    expect(readHashesV2(hashFile)[targetRelative]).toBe(
      computeHash(expectedContent),
    );
  });

  it("#4c preserves user-modified untracked AGENTS.md managed block", async () => {
    await setupProject();

    const targetRelative = FILE_NAMES.AGENTS;
    const targetFull = path.join(tmpDir, targetRelative);
    const templateContent = fs.readFileSync(targetFull, "utf-8");
    const modifiedOldContent = removeSubagentsSection(templateContent).replace(
      "# Arbor Instructions",
      "# Custom Arbor Instructions",
    );
    fs.writeFileSync(targetFull, modifiedOldContent);

    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      targetRelative,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);

    await update({ skipAll: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(modifiedOldContent);
  });

  it("#4d preserves user AGENTS.md without ARBOR markers by appending the managed block", async () => {
    await setupProject();

    const targetRelative = FILE_NAMES.AGENTS;
    const targetFull = path.join(tmpDir, targetRelative);
    const templateContent = fs.readFileSync(targetFull, "utf-8");

    // User has a hand-written AGENTS.md with no ARBOR:START/END markers at
    // all (predates 0.5.0-beta.18 or was authored by hand). Pre-fix behavior
    // would clobber this content; post-fix should append the managed block.
    const userContent = "# Project notes\n\nThings the team agreed on.\n";
    fs.writeFileSync(targetFull, userContent);

    await update({ force: true });

    const result = fs.readFileSync(targetFull, "utf-8");
    expect(result).toContain("# Project notes");
    expect(result).toContain("Things the team agreed on.");
    expect(result).toContain("<!-- ARBOR:START -->");
    expect(result).toContain("<!-- ARBOR:END -->");
    // Managed block should sit AFTER the user content, not replace it.
    expect(result.indexOf("# Project notes")).toBeLessThan(
      result.indexOf("<!-- ARBOR:START -->"),
    );
    // Tail equals the canonical template (force-applied managed block).
    expect(result.endsWith(templateContent.trimEnd() + "\n")).toBe(true);
  });

  it("#4e CLAUDE.md: update refreshes only the managed block", async () => {
    await setupProject();

    const targetFull = projectFile(FILE_NAMES.CLAUDE);
    const staleBlock = claudeMdContent.replace(
      "# Arbor Instructions (main agent)",
      "# Old Arbor Instructions",
    );
    expect(staleBlock).not.toBe(claudeMdContent);
    fs.writeFileSync(
      targetFull,
      `# My rules\n\nKeep me.\n\n${staleBlock}\n## After\n\nKeep me too.\n`,
    );

    await update({ force: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(
      `# My rules\n\nKeep me.\n\n${claudeMdContent}\n## After\n\nKeep me too.\n`,
    );
  });

  it("#4f CLAUDE.md without markers gets the block appended below the user text", async () => {
    await setupProject();

    const targetFull = projectFile(FILE_NAMES.CLAUDE);
    const userText = "# CLAUDE.md\n\nBehavioral guidelines.\n";
    fs.writeFileSync(targetFull, userText);

    await update({ force: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(
      `${userText}\n${claudeMdContent}`,
    );
    const hashes = readHashesV2(hashFilePath());
    expect(hashes[FILE_NAMES.CLAUDE]).toBe(
      computeHash(`${userText}\n${claudeMdContent}`),
    );
  });

  it("#4g CLAUDE.md is not managed when Claude Code is not configured", async () => {
    await init({ yes: true, star: true, force: true });
    expect(fs.existsSync(projectFile(FILE_NAMES.CLAUDE))).toBe(false);

    await update({ force: true });

    expect(fs.existsSync(projectFile(FILE_NAMES.CLAUDE))).toBe(false);
  });

  it("#5 force overwrites user-modified files", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const templateContent = fs.readFileSync(targetFull, "utf-8");

    // User modifies file (hash won't match)
    fs.writeFileSync(targetFull, "user customized content");

    await update({ force: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(templateContent);
  });

  it("#5b force mode does not prompt for final confirmation", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");
    vi.mocked(inquirer.prompt).mockClear();

    await update({ force: true });

    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it("#6 skipAll preserves user-modified files", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");

    await update({ skipAll: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(
      "user customized content",
    );
  });

  it("#7 createNew creates .new copy without overwriting original", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const templateContent = fs.readFileSync(targetFull, "utf-8");
    fs.writeFileSync(targetFull, "user customized content");

    await update({ createNew: true });

    // Original preserved
    expect(fs.readFileSync(targetFull, "utf-8")).toBe(
      "user customized content",
    );
    // .new file created with template content
    const newFile = targetFull + ".new";
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.readFileSync(newFile, "utf-8")).toBe(templateContent);
  });

  it("#8 updates version file after successful update", async () => {
    await setupProject();

    // Simulate older project version
    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, "0.0.1");

    await update({ force: true });

    // Version is updated even when no file changes are needed
    expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
  });

  it("#9 creates backup directory before applying changes", async () => {
    await setupProject();

    // Simulate "old template version": change file + update hash to match
    // This triggers auto-update (template changed, user didn't modify)
    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const oldContent = "# Old version of script\n";
    fs.writeFileSync(targetFull, oldContent);
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = readHashesV2(hashFile);
    hashes[MANAGED_FILE] = computeHash(oldContent);
    writeHashesV2(hashFile, hashes);

    await update({ force: true });

    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    const backupDirs = entries.filter((e) => e.startsWith(".backup-"));
    expect(backupDirs.length).toBeGreaterThanOrEqual(1);
  });

  it("#10 downgrade protection prevents update when CLI is older", async () => {
    await setupProject();

    // Set project version to future
    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, "99.99.99");

    await update({});

    // Version should NOT be changed
    expect(fs.readFileSync(versionPath, "utf-8")).toBe("99.99.99");
  });

  it("#11 allowDowngrade permits update when CLI is older", async () => {
    await setupProject();

    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, "99.99.99");

    // Remove hash entry + file to simulate a truly new template file
    const target = path.join(tmpDir, MANAGED_FILE);
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      MANAGED_FILE,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);
    fs.unlinkSync(target);

    await update({ allowDowngrade: true, force: true });

    // File recreated (truly new — no stored hash)
    expect(fs.existsSync(target)).toBe(true);
    // Version updated to current
    expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
  });

  it("#12 prerelease→stable upgrade with no file changes still updates .version", async () => {
    await setupProject();

    // Simulate a project at rc.6 (identical templates, just different version stamp)
    const versionPath = versionFilePath();
    fs.writeFileSync(versionPath, "0.1.0-rc.6");

    await update({});

    // .version must be updated to the current CLI version
    expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
  });

  it("#13 user-edited spec/guides files are preserved after update with force", async () => {
    await setupProject();

    // User customizes a spec guides file
    const guidesIndex = path.join(tmpDir, PATHS.SPEC, "guides", "index.md");
    expect(fs.existsSync(guidesIndex)).toBe(true);
    const customContent = "# My Custom Guides\n\nEdited by user.\n";
    fs.writeFileSync(guidesIndex, customContent);

    await update({ force: true });

    // User's customized content must be preserved (update should not touch spec/)
    expect(fs.readFileSync(guidesIndex, "utf-8")).toBe(customContent);
  });

  it("#14 deleted spec directory is NOT recreated by update", async () => {
    await setupProject();

    // User deletes the entire spec directory
    const specDir = path.join(tmpDir, PATHS.SPEC);
    fs.rmSync(specDir, { recursive: true, force: true });
    expect(fs.existsSync(specDir)).toBe(false);

    await update({ force: true });

    // spec/ directory should NOT be recreated by update
    expect(fs.existsSync(specDir)).toBe(false);
  });

  it("#15 truly new file (no stored hash) is still added", async () => {
    await setupProject();

    // The hash file should exist
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      MANAGED_FILE,
    ) as Record<string, string>;

    // Remove a hash entry AND the file (simulates a truly new template)
    const targetPath = path.join(tmpDir, MANAGED_FILE);
    writeHashesV2(hashFile, hashes);
    fs.unlinkSync(targetPath);

    // Run update
    await update({ force: true });

    // File SHOULD be created (no hash = truly new)
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it("#15a backfills .gitattributes journal merge=union rule when missing (#415)", async () => {
    await setupProject();

    const gitattributesPath = path.join(tmpDir, ".gitattributes");
    fs.rmSync(gitattributesPath, { force: true });

    await update({ force: true });

    const content = fs.readFileSync(gitattributesPath, "utf-8");
    expect(content).toContain(".arbor/workspace/*/journal-*.md merge=union");
  });

  it("#15b does not duplicate an existing user journal merge=union rule (#415)", async () => {
    await setupProject();

    const gitattributesPath = path.join(tmpDir, ".gitattributes");
    const userContent =
      "# my own rules\n*.png binary\n.arbor/workspace/*/journal-*.md merge=union\n";
    fs.writeFileSync(gitattributesPath, userContent);

    await update({ force: true });

    expect(fs.readFileSync(gitattributesPath, "utf-8")).toBe(userContent);
  });

  it("#16 config.yaml update.skip prevents file from being updated", async () => {
    await setupProject();

    // Pick a managed template file
    const targetPath = path.join(tmpDir, MANAGED_FILE);

    // Add skip config
    const configPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf-8");
    fs.writeFileSync(
      configPath,
      configContent + `\nupdate:\n  skip:\n    - ${MANAGED_FILE}\n`,
    );

    // Modify the file so it would normally trigger a change
    fs.writeFileSync(targetPath, "# modified by user\n");

    // Run update
    await update({ force: true });

    // File should NOT be overwritten (it's in skip list)
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("# modified by user\n");
  });

  it("#17 config.yaml update.skip with directory path skips all files under it", async () => {
    await setupProject();

    // Add skip config for the scripts/common/ directory
    const configPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf-8");
    const skipDir = `${PATHS.SCRIPTS}/common/`;
    fs.writeFileSync(
      configPath,
      configContent + `\nupdate:\n  skip:\n    - ${skipDir}\n`,
    );

    // Modify a file under the skipped directory
    const targetPath = path.join(tmpDir, PATHS.SCRIPTS, "common", "paths.py");
    expect(fs.existsSync(targetPath)).toBe(true);
    fs.writeFileSync(targetPath, "# user modified paths.py\n");

    // Run update
    await update({ force: true });

    // File should NOT be overwritten (its directory is in skip list)
    expect(fs.readFileSync(targetPath, "utf-8")).toBe(
      "# user modified paths.py\n",
    );
  });

  it("#22 preserves existing Claude statusLine config and hook file on update", async () => {
    await init({ yes: true, force: true, claude: true });

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const statusLinePath = path.join(
      tmpDir,
      ".claude",
      "hooks",
      "statusline.py",
    );
    const expectedPythonCmd =
      process.platform === "win32" ? "python" : "python3";
    const statusLineConfig = {
      type: "command",
      command: `${expectedPythonCmd} .claude/hooks/statusline.py`,
    };

    const settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf-8"),
    ) as Record<string, unknown>;
    settings.statusLine = statusLineConfig;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    fs.writeFileSync(statusLinePath, "# existing local statusline\n");

    await update({ force: true });

    expect(fs.existsSync(statusLinePath)).toBe(true);
    const updatedSettings = JSON.parse(
      fs.readFileSync(settingsPath, "utf-8"),
    ) as Record<string, unknown>;
    expect(updatedSettings.statusLine).toEqual(statusLineConfig);
    expect(updatedSettings.hooks).toBeDefined();
  });

  it("#22a does not install statusline on update for opted-out projects", async () => {
    await init({ yes: true, force: true, claude: true });

    const statusLinePath = path.join(
      tmpDir,
      ".claude",
      "hooks",
      "statusline.py",
    );
    expect(fs.existsSync(statusLinePath)).toBe(false);

    await update({ force: true });

    // statusline.py must NOT enter the template walk as a `newFiles` install
    expect(fs.existsSync(statusLinePath)).toBe(false);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(settings).not.toHaveProperty("statusLine");
  });

  it("#22b preserves a --with-statusline install across update", async () => {
    await init({ yes: true, force: true, claude: true, withStatusline: true });

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const statusLinePath = path.join(
      tmpDir,
      ".claude",
      "hooks",
      "statusline.py",
    );

    expect(fs.existsSync(statusLinePath)).toBe(true);
    const hookContentBefore = fs.readFileSync(statusLinePath, "utf-8");
    const settingsBefore = fs.readFileSync(settingsPath, "utf-8");
    expect(
      (JSON.parse(settingsBefore) as Record<string, unknown>).statusLine,
    ).toBeDefined();

    await update({ force: true });

    expect(fs.existsSync(statusLinePath)).toBe(true);
    expect(fs.readFileSync(statusLinePath, "utf-8")).toBe(hookContentBefore);
    // Byte-identical, not just deep-equal: init's injectStatusLine must
    // produce exactly what preserveExistingClaudeStatusLine re-derives
    // (statusLine appended last). Any drift — even key order — makes update
    // flag a phantom settings.json change on every fresh opted-in project.
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(settingsBefore);
  });

  it("#27 backup skips managed node_modules dependency trees", async () => {
    await setupProject();

    const platformRoot = path.join(tmpDir, ".claude");
    fs.mkdirSync(path.join(platformRoot, "node_modules", "zod"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(platformRoot, "package.json"), "{}\n");
    fs.writeFileSync(
      path.join(platformRoot, "node_modules", "zod", "index.js"),
      "module.exports = {};\n",
    );

    // Trigger an update that creates a backup.
    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");

    await update({ force: true });

    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    const backupDirs = entries.filter((e) => e.startsWith(".backup-"));
    expect(backupDirs.length).toBe(1);

    const backupDir = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      backupDirs[0] as string,
    );
    expect(
      fs.existsSync(path.join(backupDir, ".claude", "package.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(backupDir, ".claude", "node_modules")),
    ).toBe(false);
  });

  it("#v2-0.2.0 removes v1 dispatch leftovers by hash and appends the v2 config sections", async () => {
    await setupProject();
    fs.writeFileSync(versionFilePath(), "0.1.0");
    // v1 runtime override with a shipped target name: removed by hash.
    writeProjectFile(".arbor/.runtime/dispatch-target", "star\n");
    // A dispatch.py whose content matches no shipped version: kept.
    writeProjectFile(".arbor/scripts/dispatch.py", "# locally edited\n");
    // A pre-v2 config.yaml without the gate / worktree / test_paths sections.
    const configPath = ".arbor/config.yaml";
    const config = readProjectFile(configPath);
    const cut = config.indexOf("#-------------------------------------------------------------------------------\n# Gate\n");
    expect(cut).toBeGreaterThan(0);
    writeProjectFile(configPath, config.slice(0, cut));

    await update({});

    expect(fs.existsSync(projectFile(".arbor/.runtime/dispatch-target"))).toBe(false);
    expect(readProjectFile(".arbor/scripts/dispatch.py")).toBe("# locally edited\n");
    const updated = readProjectFile(configPath);
    for (const key of ["gate:", "worktree:", "test_paths:"]) {
      expect(updated).toContain(`\n${key}\n`);
    }
    expect(updated.match(/^executors:$/gm)).toHaveLength(1);
    expect(fs.readFileSync(versionFilePath(), "utf-8")).toBe(VERSION);
  });

  it("#workflow-md-r4 updates workflow.md as one runtime template when hash-tracked", async () => {
    await setupProject();

    const workflowPath = path.join(tmpDir, PATHS.WORKFLOW_GUIDE_FILE);
    const staleWorkflow =
      "# Workflow\n\n" +
      "## Phase Index\n\n" +
      "[workflow-state:in_progress]\nlegacy body\n[/workflow-state:in_progress]\n\n" +
      "#### 2.1 Implement `[required · repeatable]`\n\n" +
      "[Codex]\nSpawn the implement sub-agent:\n[/Codex]\n\n" +
      "[Kilo, Antigravity, Windsurf]\n" +
      "1. Load the `arbor-before-dev` skill to read project guidelines\n" +
      "[/Kilo, Antigravity, Windsurf]\n";

    fs.writeFileSync(workflowPath, staleWorkflow, "utf-8");

    // Simulate an older installed workflow.md that is still pristine relative
    // to the version that installed it. Update must replace the whole file:
    // platform markers outside [workflow-state:*] blocks are runtime-parsed too.
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = readHashesV2(hashFile);
    hashes[PATHS.WORKFLOW_GUIDE_FILE] = computeHash(staleWorkflow);
    writeHashesV2(hashFile, hashes);

    await update({ force: true });

    const updated = fs.readFileSync(workflowPath, "utf-8");
    expect(updated).toBe(replacePythonCommandLiterals(workflowMdTemplate));
    expect(updated).not.toContain("[Codex]");
    expect(updated).not.toContain("[Kilo, Antigravity, Windsurf]");
    expect(updated).not.toContain("legacy body");

    expect(readHashesV2(hashFile)[PATHS.WORKFLOW_GUIDE_FILE]).toBe(
      computeHash(updated),
    );
  });

  describe("receipt repair for files already identical to their template", () => {
    /**
     * Paths whose recorded hash is *expected* to drift: the repository appends
     * its own content after the template is written, so the receipt holds the
     * template's hash while the file on disk is longer. A fix that makes these
     * "match" has broken them.
     */
    const MIXED_OWNERSHIP = [
      FILE_NAMES.AGENTS,
      `${DIR_NAMES.WORKFLOW}/config.yaml`,
    ];

    /**
     * Every receipt entry whose recorded hash disagrees with the file at that
     * path. Enumerated from the receipt itself rather than from a list of
     * paths this test already knows about — a check built from what we expect
     * cannot find the entry we did not expect.
     */
    function mismatchedEntries(): string[] {
      const hashes = readHashesV2(hashFilePath());
      return Object.entries(hashes)
        .filter(([relativePath, recorded]) => {
          const full = projectFile(relativePath);
          if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
            return false;
          }
          return computeHash(fs.readFileSync(full, "utf-8")) !== recorded;
        })
        .map(([relativePath]) => relativePath)
        .filter((relativePath) => !MIXED_OWNERSHIP.includes(relativePath));
    }

    it("records a hash matching the file for every entry, right after init", async () => {
      await setupProject();
      expect(mismatchedEntries()).toEqual([]);
    });

    it("repairs a poisoned entry for a file that matches its template", async () => {
      await setupProject();

      // Poison one entry with a hash of different content, leaving the file
      // itself pristine. This is the shape found in the fleet audit: the
      // recorded value was another platform's template.
      const hashes = readHashesV2(hashFilePath());
      const victim = MANAGED_FILE;
      const correct = hashes[victim];
      expect(correct).toBeDefined();
      hashes[victim] = computeHash("not what is on disk");
      writeHashesV2(hashFilePath(), hashes);
      expect(mismatchedEntries()).toContain(victim);

      await update({ yes: true });

      // One run is enough. Before this fix the file was classified `unchanged`
      // on every run and skipped, so the entry could never be repaired.
      expect(readHashesV2(hashFilePath())[victim]).toBe(correct);
      expect(mismatchedEntries()).toEqual([]);
    });

    it("adds an entry that is missing entirely for a pristine file", async () => {
      await setupProject();

      const hashes = readHashesV2(hashFilePath());
      const correct = hashes[MANAGED_FILE];
      writeHashesV2(
        hashFilePath(),
        removeHashEntry(hashes, MANAGED_FILE) as Record<string, string>,
      );
      expect(readHashesV2(hashFilePath())[MANAGED_FILE]).toBeUndefined();

      await update({ yes: true });

      expect(readHashesV2(hashFilePath())[MANAGED_FILE]).toBe(correct);
    });

    it("does not re-hash a file the user actually customized", async () => {
      await setupProject();

      const pristine = readProjectFile(MANAGED_FILE);
      const recorded = readHashesV2(hashFilePath())[MANAGED_FILE];
      expect(recorded).toBe(computeHash(pristine));

      // A real local edit. `update` may offer to overwrite it; declining must
      // leave the receipt describing the template, not the edit — otherwise
      // the repair path has silently blessed a customization.
      const customized = `${pristine}\n# local customization\n`;
      writeProjectFile(MANAGED_FILE, customized);
      vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: false });

      await update({ yes: false });

      expect(readHashesV2(hashFilePath())[MANAGED_FILE]).not.toBe(
        computeHash(customized),
      );
      expect(readProjectFile(MANAGED_FILE)).toBe(customized);
    });

    it("leaves the mixed-ownership paths free to differ from their recorded hash", async () => {
      await setupProject();
      const before = readHashesV2(hashFilePath());

      // Append repo-owned content, exactly as those files acquire it.
      for (const relativePath of MIXED_OWNERSHIP) {
        if (!fs.existsSync(projectFile(relativePath))) continue;
        writeProjectFile(
          relativePath,
          `${readProjectFile(relativePath)}\n# repo-owned addition\n`,
        );
      }

      await update({ yes: true });

      const after = readHashesV2(hashFilePath());
      for (const relativePath of MIXED_OWNERSHIP) {
        if (before[relativePath] === undefined) continue;
        // The recorded hash must still describe the template, not the file.
        expect(after[relativePath]).not.toBe(
          computeHash(readProjectFile(relativePath)),
        );
      }
    });
  });
});
