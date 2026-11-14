/**
 * Regression Tests — Historical Bug Prevention
 *
 * Each test references a specific version where the bug was introduced/fixed.
 * Prevents recurrence of bugs from beta.2 through beta.16.
 *
 * Categories:
 * 1. Windows / Encoding (beta.2, beta.7, beta.10, beta.11, beta.12, beta.16)
 * 2. Path Issues (0.2.14, 0.2.15, beta.13)
 * 3. Semver / Migration Engine (beta.5, beta.14, beta.16)
 * 4. Template Integrity (beta.0, beta.7, beta.12)
 * 5. Platform Registry (beta.9, beta.13, beta.16)
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearManifestCache,
  getAllMigrations,
  getAllMigrationVersions,
  getMigrationsForVersion,
  hasPendingMigrations,
} from "../src/migrations/index.js";
import { isManagedPath } from "../src/configurators/index.js";
import { AI_TOOLS } from "../src/types/ai-tools.js";
import { PATHS } from "../src/constants/paths.js";
import { getStatuslineHook } from "../src/templates/claude/index.js";
import { getSkillTemplates } from "../src/templates/common/index.js";
import {
  commonInit,
  arborScript,
  addSessionScript,
  commonDeveloper,
  commonConfig,
  commonArborConfig,
  getAllScripts,
} from "../src/templates/arbor/index.js";
import {
  collectPlatformTemplates,
  PLATFORM_IDS,
} from "../src/configurators/index.js";
import {
  guidesIndexContent,
  workspaceIndexContent,
} from "../src/templates/markdown/index.js";
import * as markdownExports from "../src/templates/markdown/index.js";

afterEach(() => {
  clearManifestCache();
});

// =============================================================================
// 1. Windows / Encoding Regressions
// =============================================================================

describe("regression: Windows encoding (beta.10, beta.11, beta.16)", () => {
  it("[beta.10] common/__init__.py has _configure_stream function", () => {
    expect(commonInit).toContain("def _configure_stream");
  });

  it('[beta.10] common/__init__.py has reconfigure(encoding="utf-8") pattern', () => {
    expect(commonInit).toContain('reconfigure(encoding="utf-8"');
  });

  it("[beta.10] common/__init__.py has TextIOWrapper fallback", () => {
    expect(commonInit).toContain("TextIOWrapper");
  });

  it('[beta.10] common/__init__.py has sys.platform == "win32" guard', () => {
    expect(commonInit).toContain('sys.platform == "win32"');
  });

  it("[beta.10] common/__init__.py configures both stdout AND stderr", () => {
    expect(commonInit).toContain("sys.stdout");
    expect(commonInit).toContain("sys.stderr");
  });

  it("[beta.16] _configure_stream handles stream with reconfigure method", () => {
    // The function should try reconfigure() first, then fallback to detach()
    expect(commonInit).toContain('hasattr(stream, "reconfigure")');
    expect(commonInit).toContain('hasattr(stream, "detach")');
  });

  it("[beta.16] _configure_stream is idempotent (won't crash on double call)", () => {
    // The reconfigure pattern is safe to call multiple times
    // The function should NOT use detach() unconditionally (beta.16 bug root cause)
    // It should check hasattr(stream, "reconfigure") FIRST
    const reconfigureIndex = commonInit.indexOf(
      'hasattr(stream, "reconfigure")',
    );
    const detachIndex = commonInit.indexOf('hasattr(stream, "detach")');
    expect(reconfigureIndex).toBeLessThan(detachIndex);
  });

  it("[beta.10] common/__init__.py has centralized encoding fix", () => {
    // Encoding fix was centralized from individual scripts to common/__init__.py (#67)
    expect(commonInit).toContain('sys.platform == "win32"');
    expect(commonInit).toContain("reconfigure");
  });

  it("[beta.10] arbor.py imports from common (gets encoding fix via __init__.py)", () => {
    expect(arborScript).toContain("from common");
  });

  it("[rc.2] add_session.py table separator detection uses regex (not startswith)", () => {
    // Bug: startswith("|---") breaks when formatters add spaces: "| ---- |"
    // Fix: use re.match with a character-class pattern to allow optional whitespace/spaces
    expect(addSessionScript).not.toContain('startswith("|---")');
    expect(addSessionScript).toContain(
      String.raw`re.match(r"^\|[-| ]+\|\s*$", line)`,
    );
  });
});

describe("regression: branch context in session records (issue-106)", () => {
  it("[issue-106] add_session.py accepts --branch CLI arg", () => {
    expect(addSessionScript).toContain("--branch");
    expect(addSessionScript).not.toContain("--base-branch");
  });

  it("[issue-106] add_session.py auto-detects branch via git branch --show-current", () => {
    expect(addSessionScript).toContain("branch --show-current");
  });

  it("[issue-106] add_session.py session content includes **Branch** field only", () => {
    expect(addSessionScript).toContain("**Branch**");
    expect(addSessionScript).not.toContain("**Base Branch**");
  });

  it("[issue-106] add_session.py index table header has 5 columns including Branch", () => {
    expect(addSessionScript).toContain(
      "| # | Date | Title | Commits | Branch |",
    );
    expect(addSessionScript).not.toContain(
      "| # | Date | Title | Commits | Branch | Base Branch |",
    );
  });

  it("[issue-106] add_session.py migrates old 4/6-column headers to 5-column", () => {
    expect(addSessionScript).toMatch(
      /re\.match\(\r?\n\s+r"\^\\\|\\s\*#\\s\*\\\|\\s\*Date\\s\*\\\|\\s\*Title\\s\*\\\|\\s\*Commits\\s\*\\\|\\s\*Branch\\s\*\\\|\\s\*Base Branch\\s\*\\\|\\s\*\$",/,
    );
    expect(addSessionScript).toContain(
      String.raw`re.match(r"^\|\s*#\s*\|\s*Date\s*\|\s*Title\s*\|\s*Commits\s*\|\s*Branch\s*\|\s*$", line)`,
    );
  });

  it("[issue-106] developer.py init template has 5-column session history table", () => {
    expect(commonDeveloper).toContain(
      "| # | Date | Title | Commits | Branch |",
    );
    expect(commonDeveloper).toContain(
      "|---|------|-------|---------|--------|",
    );
  });

  it("[issue-106] workspace-index.md template documents Branch field only for session records", () => {
    expect(workspaceIndexContent).toContain(
      "Branch: Which branch the work was done on",
    );
    expect(workspaceIndexContent).toContain("**Branch**: `{branch-name}`");
    expect(workspaceIndexContent).not.toContain(
      "**Base Branch**: `{base-branch-name}`",
    );
  });
});

describe("regression: add_session.py runtime branch context (issue-106)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-session-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeArborScripts(): void {
    const scriptsDir = path.join(tmpDir, ".arbor", "scripts");
    for (const [relativePath, content] of getAllScripts()) {
      const absPath = path.join(scriptsDir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content);
    }
  }

  function createWorkspaceIndex(
    headerMode: "legacy4" | "legacy6" | "current5",
  ): void {
    let header = "| # | Date | Title | Commits | Branch |";
    let separator = "|---|------|-------|---------|--------|";
    if (headerMode === "legacy4") {
      header = "| # | Date | Title | Commits |";
      separator = "|---|------|-------|---------|";
    } else if (headerMode === "legacy6") {
      header = "| # | Date | Title | Commits | Branch | Base Branch |";
      separator = "|---|------|-------|---------|--------|-------------|";
    }
    const indexContent = `# Workspace Index - test-dev

## Current Status

<!-- @@@auto:current-status -->
- **Active File**: \`journal-1.md\`
- **Total Sessions**: 0
- **Last Active**: -
<!-- @@@/auto:current-status -->

## Active Documents

<!-- @@@auto:active-documents -->
| File | Lines | Status |
|------|-------|--------|
| \`journal-1.md\` | ~0 | Active |
<!-- @@@/auto:active-documents -->

## Session History

<!-- @@@auto:session-history -->
${header}
${separator}
<!-- @@@/auto:session-history -->
`;
    fs.writeFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "index.md"),
      indexContent,
      "utf-8",
    );
  }

  function setupSessionRepo(options?: {
    gitBranch?: string;
    headerMode?: "legacy4" | "legacy6" | "current5";
    taskBranch?: string;
    taskBaseBranch?: string;
  }): void {
    writeArborScripts();

    fs.mkdirSync(path.join(tmpDir, ".arbor", "workspace", "test-dev"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, ".arbor", ".developer"),
      "name=test-dev\ninitialized_at=2026-03-22T00:00:00\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "journal-1.md"),
      "# Journal - test-dev (Part 1)\n\n---\n",
      "utf-8",
    );
    createWorkspaceIndex(options?.headerMode ?? "current5");

    if (options?.taskBranch || options?.taskBaseBranch) {
      const taskDir = path.join(tmpDir, ".arbor", "tasks", "issue-106");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".arbor", ".runtime", "sessions"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpDir, ".arbor", ".runtime", "sessions", "session-a.json"),
        JSON.stringify(
          {
            current_task: ".arbor/tasks/issue-106",
            platform: "test",
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(taskDir, "task.json"),
        JSON.stringify(
          {
            title: "Issue 106 task",
            status: "in_progress",
            package: null,
            branch: options.taskBranch ?? null,
            base_branch: options.taskBaseBranch ?? null,
          },
          null,
          2,
        ),
        "utf-8",
      );
    }

    if (options?.gitBranch) {
      execSync("git init -q", { cwd: tmpDir });
      execSync(`git branch -m ${JSON.stringify(options.gitBranch)}`, {
        cwd: tmpDir,
      });
    }
  }

  function runAddSession(title: string, options?: { branch?: string }): void {
    const command = [
      "python3",
      JSON.stringify(path.join(tmpDir, ".arbor", "scripts", "add_session.py")),
      "--title",
      JSON.stringify(title),
      "--summary",
      JSON.stringify("Regression test session"),
      "--no-commit",
    ];
    if (options?.branch) {
      command.push("--branch", JSON.stringify(options.branch));
    }

    execSync(command.join(" "), {
      cwd: tmpDir,
      encoding: "utf-8",
      env: { ...process.env, ARBOR_CONTEXT_ID: "session-a" },
    });
  }

  it("[issue-106] prefers explicit CLI branch over task.json and git", () => {
    setupSessionRepo({
      gitBranch: "feature/from-git",
      taskBranch: "task/from-task",
      taskBaseBranch: "main",
    });

    runAddSession("CLI branch wins", { branch: "cli/from-arg" });

    const journal = fs.readFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "journal-1.md"),
      "utf-8",
    );
    const index = fs.readFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(journal).toContain("**Branch**: `cli/from-arg`");
    expect(journal).not.toContain("**Base Branch**:");
    expect(journal).not.toContain("task/from-task");
    expect(journal).not.toContain("feature/from-git");
    expect(index).toContain("`cli/from-arg` |");
    expect(index).not.toContain("`task/from-task`");
    expect(index).not.toContain("`feature/from-git`");
  });

  it("[issue-106] falls back to git branch and migrates old 6-column session history", () => {
    setupSessionRepo({
      gitBranch: "feature/from-git",
      headerMode: "legacy6",
    });

    runAddSession("Git branch fallback");

    const journal = fs.readFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "journal-1.md"),
      "utf-8",
    );
    const index = fs.readFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(journal).toContain("**Branch**: `feature/from-git`");
    expect(journal).not.toContain("**Base Branch**:");
    expect(index).toContain("| # | Date | Title | Commits | Branch |");
    expect(index).toContain("|---|------|-------|---------|--------|");
    expect(index).toContain("`feature/from-git` |");
    expect(index).not.toContain(
      "| # | Date | Title | Commits | Branch | Base Branch |\n|---|------|-------|---------|--------|-------------|",
    );
  });

  it("[issue-106] migrates old 4-column session history directly to 5 columns", () => {
    setupSessionRepo({
      headerMode: "legacy4",
    });

    runAddSession("Legacy 4-column migration");

    const index = fs.readFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(index).toContain("| # | Date | Title | Commits | Branch |");
    expect(index).toContain("|---|------|-------|---------|--------|");
    expect(index).not.toContain(
      "| # | Date | Title | Commits |\n|---|------|-------|---------|",
    );
  });

  it("[issue-106] records a session even when no branch information is available", () => {
    setupSessionRepo();

    runAddSession("No branch available");

    const journal = fs.readFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "journal-1.md"),
      "utf-8",
    );
    const index = fs.readFileSync(
      path.join(tmpDir, ".arbor", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(journal).not.toContain("**Branch**:");
    expect(journal).not.toContain("**Base Branch**:");
    expect(index).toContain("`-` |");
    expect(index).toContain("- **Total Sessions**: 1");
  });
});

// Windows subprocess flags tests removed — multi_agent pipeline removed

describe("regression: Windows path separator (beta.12)", () => {
  it("[beta.12] isManagedPath handles Windows backslash paths", () => {
    expect(isManagedPath(".claude\\commands\\foo.md")).toBe(true);
    expect(isManagedPath(".arbor\\spec\\backend")).toBe(true);
    expect(isManagedPath(".codex\\hooks\\session-start.py")).toBe(true);
  });

  it("[beta.12] isManagedPath handles mixed separators", () => {
    expect(isManagedPath(".claude\\commands/foo.md")).toBe(true);
  });
});

// =============================================================================
// 2. Path Issues Regressions
// =============================================================================

describe("regression: task directory paths (0.2.14, 0.2.15, beta.13)", () => {
  it("[0.2.15] PATHS.TASKS is .arbor/tasks (not .arbor/workspace/*/tasks)", () => {
    expect(PATHS.TASKS).toBe(".arbor/tasks");
    expect(PATHS.TASKS).not.toContain("workspace");
  });

  it("[0.2.15] no script templates contain hardcoded 'taosu' in path patterns", () => {
    const scripts = getAllScripts();
    for (const [name, content] of scripts) {
      // Check for hardcoded username in path patterns (workspace/taosu, /Users/taosu)
      // but allow usage examples like "python3 status.py -a taosu"
      expect(
        content,
        `${name} should not contain hardcoded username in paths`,
      ).not.toMatch(/workspace\/taosu|\/Users\/taosu/);
    }
  });
});

describe("regression: JSON read/write failure reporting", () => {
  let tmpDir: string;
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  // chmod is the only way to provoke a read/write failure, and root ignores
  // the mode bits — skip rather than assert something that cannot happen.
  const canProvokePermissionFailure =
    process.platform !== "win32" && process.getuid?.() !== 0;

  function runPython(
    args: string[],
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(pythonCmd, args, {
      cwd: tmpDir,
      encoding: "utf-8",
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  function taskJsonPath(name: string): string {
    return path.join(tmpDir, ".arbor", "tasks", name, "task.json");
  }

  function writeTaskJson(name: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(taskJsonPath(name)), { recursive: true });
    fs.writeFileSync(taskJsonPath(name), content);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-task-json-io-"));
    const scriptsDir = path.join(tmpDir, ".arbor", "scripts");
    for (const [relativePath, content] of getAllScripts()) {
      const absPath = path.join(scriptsDir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf-8");
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[audit] read_json_checked names each failure class instead of raising", () => {
    // UnicodeDecodeError is not an OSError, so a non-UTF-8 file used to escape
    // the handlers and surface as a traceback.
    const dir = path.join(tmpDir, "probe");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ not json");
    fs.writeFileSync(
      path.join(dir, "latin.json"),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    );
    fs.writeFileSync(path.join(dir, "list.json"), "[]");
    fs.writeFileSync(path.join(dir, "empty.json"), "{}");
    fs.writeFileSync(path.join(dir, "ok.json"), '{"a": 1}');

    const probe = [
      "import json, sys",
      "from pathlib import Path",
      "sys.path.insert(0, str(Path.cwd() / '.arbor' / 'scripts'))",
      "from common.io import read_json_checked",
      "d = Path.cwd() / 'probe'",
      "out = {}",
      "for name in ['missing', 'corrupt', 'latin', 'list', 'empty', 'ok']:",
      "    data, reason = read_json_checked(d / f'{name}.json')",
      "    out[name] = [data, reason]",
      "print(json.dumps(out))",
    ].join("\n");
    const r = runPython(["-c", probe]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      missing: [null, "missing"],
      corrupt: [null, "invalid"],
      latin: [null, "undecodable"],
      list: [null, "not-object"],
      empty: [null, "empty"],
      ok: [{ a: 1 }, null],
    });
  });

  it.skipIf(!canProvokePermissionFailure)(
    "[audit] read_json_checked reports an unreadable file as unreadable, not a parse error",
    () => {
      writeTaskJson("ro", '{"a": 1}');
      fs.chmodSync(taskJsonPath("ro"), 0o000);
      try {
        const probe = [
          "import json, sys",
          "from pathlib import Path",
          "sys.path.insert(0, str(Path.cwd() / '.arbor' / 'scripts'))",
          "from common.io import read_json_checked",
          "print(json.dumps(read_json_checked(Path(sys.argv[1]))))",
        ].join("\n");
        const r = runPython(["-c", probe, taskJsonPath("ro")]);
        expect(r.status, r.stderr).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual([null, "unreadable"]);
      } finally {
        fs.chmodSync(taskJsonPath("ro"), 0o644);
      }
    },
  );

  it("[audit] arbor.py on a corrupt or non-UTF-8 task.json names the file and the failure, without a traceback", () => {
    writeTaskJson("08-09-broken", "{ not json");
    writeTaskJson(
      "08-09-latin",
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    );

    for (const [name, reason] of [
      ["08-09-broken", "not valid JSON"],
      ["08-09-latin", "not valid UTF-8"],
    ] as const) {
      const r = runPython([
        path.join(".arbor", "scripts", "arbor.py"),
        "--task",
        name,
        "status",
      ]);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).not.toContain("Traceback");
      expect(r.stderr).toContain(path.join(name, "task.json"));
      expect(r.stderr).toContain(reason);
    }
    // The failed read did not rewrite the file.
    expect(fs.readFileSync(taskJsonPath("08-09-broken"), "utf-8")).toBe(
      "{ not json",
    );
  });

  it("[audit] arbor.py new reports a failed task.json write instead of 'created'", () => {
    // write_json returns False on failure (see the #429 tests); a caller that
    // ignores it prints success over a task that has no task.json.
    fs.mkdirSync(path.join(tmpDir, ".arbor", "tasks"), { recursive: true });
    const probe = [
      "import sys",
      "from pathlib import Path",
      "sys.path.insert(0, str(Path.cwd() / '.arbor' / 'scripts'))",
      "import arbor",
      "arbor.write_json = lambda path, data: False",
      "sys.exit(arbor.main(['new', 'Write fails', '--slug', 'write-fails']))",
    ].join("\n");
    const r = runPython(["-c", probe]);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout).not.toContain("created");
  });
});

describe("regression: write_json fd ownership and cleanup (issue #429)", () => {
  let tmpDir: string;
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-write-json-"));
    const scriptsDir = path.join(tmpDir, ".arbor", "scripts");
    for (const [relativePath, content] of getAllScripts()) {
      const absPath = path.join(scriptsDir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf-8");
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runProbe(probeBody: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const probe = `
import json
import os
import sys
from pathlib import Path
from unittest import mock

root = Path.cwd()
sys.path.insert(0, str(root / ".arbor" / "scripts"))
from common.io import write_json

${probeBody}
`;
    const result = spawnSync(pythonCmd, ["-c", probe], {
      cwd: tmpDir,
      encoding: "utf-8",
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it("[issue-429] closes the raw fd itself when fdopen fails, and leaves no temp file", () => {
    const { status, stdout, stderr } = runProbe(`
target = root / "out.json"
real_close = os.close
closed_fds = []

def fake_close(fd):
    closed_fds.append(fd)
    real_close(fd)

def fake_fdopen(fd, *a, **kw):
    # fdopen never took ownership: caller must close fd itself.
    raise OSError("simulated fdopen failure")

with mock.patch("os.close", side_effect=fake_close), \\
     mock.patch("os.fdopen", side_effect=fake_fdopen):
    result = write_json(target, {"a": 1})

leftover_tmp = [p.name for p in root.glob("*.tmp")] + [p.name for p in root.glob(".out.json.*")]
print(json.dumps({
    "result": result,
    "fd_closed": len(closed_fds) == 1,
    "target_exists": target.exists(),
    "leftover_tmp": leftover_tmp,
}))
`);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      result: false,
      fd_closed: true,
      target_exists: false,
      leftover_tmp: [],
    });
  });

  it("[issue-429] cleans up the temp file when os.replace fails, without masking the write as a success", () => {
    const { status, stdout, stderr } = runProbe(`
target = root / "out.json"

with mock.patch("os.replace", side_effect=OSError("simulated replace failure")):
    result = write_json(target, {"a": 1})

leftover_tmp = [p.name for p in root.glob(".out.json.*")]
print(json.dumps({
    "result": result,
    "target_exists": target.exists(),
    "leftover_tmp": leftover_tmp,
}))
`);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      result: false,
      target_exists: false,
      leftover_tmp: [],
    });
  });

  it("[issue-429] a cleanup failure after a write failure does not raise — still reports False", () => {
    const { status, stdout, stderr } = runProbe(`
target = root / "out.json"

with mock.patch("os.replace", side_effect=OSError("simulated replace failure")), \\
     mock.patch("os.unlink", side_effect=OSError("simulated cleanup failure")):
    result = write_json(target, {"a": 1})

print(json.dumps({"result": result}))
`);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ result: false });
  });

  it("[issue-429] a successful write is atomic and leaves no leftover temp file", () => {
    const { status, stdout, stderr } = runProbe(`
target = root / "out.json"
result = write_json(target, {"a": 1, "b": "text"})
leftover_tmp = [p.name for p in root.glob(".out.json.*")]
print(json.dumps({
    "result": result,
    "content": json.loads(target.read_text(encoding="utf-8")),
    "leftover_tmp": leftover_tmp,
}))
`);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      result: true,
      content: { a: 1, b: "text" },
      leftover_tmp: [],
    });
  });
});

// =============================================================================
// 3. Semver / Migration Engine Regressions
// =============================================================================

describe("regression: semver prerelease handling (beta.5)", () => {
  it("[beta.5] prerelease version sorts before release version", () => {
    // 0.3.0-beta.1 < 0.3.0 (prerelease is less than release)
    const versions = getAllMigrationVersions();
    const betaVersions = versions.filter((v) => v.includes("beta"));
    const releaseVersions = versions.filter(
      (v) => !v.includes("beta") && !v.includes("alpha"),
    );

    if (betaVersions.length > 0 && releaseVersions.length > 0) {
      // All beta versions should appear before their corresponding release versions
      const lastBeta = betaVersions[betaVersions.length - 1];
      const firstRelease = releaseVersions[0];
      const lastBetaIdx = versions.indexOf(lastBeta);
      const firstReleaseIdx = versions.indexOf(firstRelease);
      // Only compare if they share the same base version
      if (lastBeta.startsWith(firstRelease.split("-")[0])) {
        expect(lastBetaIdx).toBeLessThan(firstReleaseIdx);
      }
    }
  });

  it("[beta.5] prerelease numeric parts compare numerically (beta.2 < beta.10)", () => {
    // getMigrationsForVersion relies on correct version ordering
    // beta.2 should be before beta.10 (numeric, not lexicographic)
    const versions = getAllMigrationVersions();
    const beta2Idx = versions.indexOf("0.3.0-beta.2");
    const beta10Idx = versions.indexOf("0.3.0-beta.10");
    if (beta2Idx !== -1 && beta10Idx !== -1) {
      expect(beta2Idx).toBeLessThan(beta10Idx);
    }
  });

  it("[beta.5] getMigrationsForVersion returns empty for equal versions", () => {
    expect(getMigrationsForVersion("0.3.0-beta.5", "0.3.0-beta.5")).toEqual([]);
  });

  it("[beta.5] getMigrationsForVersion correctly handles beta range", () => {
    // beta.0 to beta.2 should include beta.1 and beta.2 migrations
    getMigrationsForVersion("0.3.0-beta.0", "0.3.0-beta.2");
    // Should not include beta.0 itself (only > fromVersion)
    const versions = getAllMigrationVersions();
    if (versions.includes("0.3.0-beta.1")) {
      expect(
        hasPendingMigrations("0.3.0-beta.0", "0.3.0-beta.2"),
      ).toBeDefined();
    }
  });
});

describe("regression: migration data integrity (beta.14)", () => {
  it("[beta.14] all migrations have non-undefined 'from' field", () => {
    const allMigrations = getAllMigrations();
    for (const m of allMigrations) {
      expect(
        m.from,
        `migration should have 'from' field defined`,
      ).toBeDefined();
      expect(typeof m.from).toBe("string");
      expect(m.from.length).toBeGreaterThan(0);
    }
  });

  it("[beta.14] all migrations have valid type field", () => {
    const allMigrations = getAllMigrations();
    const validTypes = ["rename", "rename-dir", "delete", "safe-file-delete"];
    for (const m of allMigrations) {
      expect(validTypes).toContain(m.type);
    }
  });

  it("[beta.1-040] safe-file-delete migrations have allowed_hashes", () => {
    const allMigrations = getAllMigrations();
    const safeDeletes = allMigrations.filter(
      (m) => m.type === "safe-file-delete",
    );
    for (const m of safeDeletes) {
      expect(
        m.allowed_hashes,
        `safe-file-delete for '${m.from}' should have allowed_hashes`,
      ).toBeDefined();
      expect(Array.isArray(m.allowed_hashes)).toBe(true);
      expect(
        (m.allowed_hashes as string[]).length,
        `safe-file-delete for '${m.from}' should have at least one hash`,
      ).toBeGreaterThan(0);
      for (const hash of m.allowed_hashes as string[]) {
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it("[beta.15] Claude Code statusline is not safe-deleted on update", () => {
    const claudeStatusLineDeletes = getAllMigrations().filter(
      (m) =>
        m.type === "safe-file-delete" &&
        m.from === ".claude/hooks/statusline.py",
    );

    expect(claudeStatusLineDeletes).toEqual([]);
  });

  it("[statusline-opt-in] statusline.py is not in claude's collected templates (update must not force-install it)", () => {
    // The opt-in statusline (`arbor init --with-statusline`) must stay out
    // of the unconditional template walk: analyzeChanges() classifies any
    // collected-but-absent file as `newFiles` and installs it on update,
    // which would force statusline onto opted-out projects.
    const templates = collectPlatformTemplates("claude-code");
    expect(templates).toBeDefined();
    expect([...(templates?.keys() ?? [])]).not.toContain(
      ".claude/hooks/statusline.py",
    );
  });

  it("[beta.14] rename/rename-dir migrations have 'to' field", () => {
    const allMigrations = getAllMigrations();
    const renames = allMigrations.filter(
      (m) => m.type === "rename" || m.type === "rename-dir",
    );
    for (const m of renames) {
      expect(
        m.to,
        `rename migration from '${m.from}' should have 'to'`,
      ).toBeDefined();
      expect(typeof m.to).toBe("string");
      expect((m.to as string).length).toBeGreaterThan(0);
    }
  });

  it("[beta.14] all manifest versions are valid semver-like strings", () => {
    const versions = getAllMigrationVersions();
    for (const v of versions) {
      expect(v).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });
});

describe("regression: update only configured platforms (beta.16)", () => {
  it("[beta.16] collectPlatformTemplates returns Map for platforms with tracking", () => {
    const withTracking = ["claude-code", "codex"] as const;
    for (const id of withTracking) {
      const result = collectPlatformTemplates(id);
      expect(result, `${id} should have template tracking`).toBeInstanceOf(Map);
    }
  });
});

// dispatch agent removed — parallel/worktree now handled by platform-native features

// =============================================================================
// 4. Template Integrity Regressions
// =============================================================================

describe("regression: shell to Python migration (beta.0)", () => {
  it("[beta.0] no .sh scripts remain in arbor templates", () => {
    const scripts = getAllScripts();
    for (const [name] of scripts) {
      expect(name.endsWith(".sh"), `${name} should not end with .sh`).toBe(
        false,
      );
    }
  });

  it("[beta.0] all script keys end with .py", () => {
    const scripts = getAllScripts();
    for (const [name] of scripts) {
      expect(name.endsWith(".py"), `${name} should end with .py`).toBe(true);
    }
  });

  it("[beta.3] getAllScripts covers every .py file in templates/arbor/scripts/", () => {
    // Bug: update.ts had a hand-maintained file list that missed 11 scripts.
    // Fix: update.ts now uses getAllScripts() directly. This test ensures
    // getAllScripts() itself stays in sync with the filesystem.
    const scriptsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/templates/arbor/scripts",
    );
    const fsFiles = new Set<string>();
    function walk(dir: string, prefix: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith(".py")) {
          fsFiles.add(`${prefix}${entry.name}`);
        }
      }
    }
    walk(scriptsDir, "");

    const scripts = getAllScripts();
    const registeredKeys = new Set(scripts.keys());

    // Known exclusions: files intentionally not in getAllScripts()
    const excluded = new Set(["hooks/linear_sync.py"]);

    for (const file of fsFiles) {
      if (excluded.has(file)) continue;
      expect(
        registeredKeys.has(file),
        `${file} exists on disk but is missing from getAllScripts()`,
      ).toBe(true);
    }
  });
});

describe("regression: issue #252 shared Git runner timeout", () => {
  let tmpDir: string;
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-polyrepo-git-"));
    const scriptsDir = path.join(tmpDir, ".arbor", "scripts");
    for (const [relativePath, content] of getAllScripts()) {
      const absPath = path.join(scriptsDir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf-8");
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes probe timeouts through the shared Git runner", () => {
    const runnerPath = path.join(tmpDir, "run-git-timeout.py");
    fs.writeFileSync(
      runnerPath,
      [
        "import json",
        "import subprocess",
        "import sys",
        "from pathlib import Path",
        "sys.path.insert(0, str(Path.cwd() / '.arbor' / 'scripts'))",
        "from common.git import run_git",
        "captured = {}",
        "def fake_run(*args, **kwargs):",
        "    captured['timeout'] = kwargs.get('timeout')",
        "    raise subprocess.TimeoutExpired(args[0], kwargs.get('timeout'))",
        "subprocess.run = fake_run",
        "rc, out, err = run_git(['status'], timeout=0.25)",
        "print(json.dumps({'rc': rc, 'out': out, 'err': err, **captured}))",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = JSON.parse(
      execSync(`${pythonCmd} ${JSON.stringify(runnerPath)}`, {
        cwd: tmpDir,
        encoding: "utf-8",
      }),
    ) as {
      rc: number;
      out: string;
      err: string;
      timeout: number;
    };

    expect(result).toEqual(
      expect.objectContaining({
        rc: 1,
        out: "",
        timeout: 0.25,
      }),
    );
    expect(result.err).toContain("timed out");
  });
});

describe("regression: Claude statusline (opt-in)", () => {
  let tmpDir: string;
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-statusline-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProjectFile(relativePath: string, content: string): void {
    const absPath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
  }

  function setupRepo(): void {
    writeProjectFile(
      path.join(".arbor", ".developer"),
      "name=test-dev\ninitialized_at=2026-03-27T00:00:00\n",
    );
  }

  function runPython(
    relativeScriptPath: string,
    input?: string,
    envOverrides: NodeJS.ProcessEnv = {},
  ): string {
    const scriptPath = path.join(tmpDir, relativeScriptPath);
    return execSync(`${pythonCmd} ${JSON.stringify(scriptPath)}`, {
      cwd: tmpDir,
      input,
      encoding: "utf-8",
      env: { ...process.env, ...envOverrides },
    });
  }

  function runPythonWithLegacyStdinLocale(
    relativeScriptPath: string,
    input: string,
  ): string {
    const scriptPath = path.join(tmpDir, relativeScriptPath);
    const result = spawnSync(
      pythonCmd,
      [
        "-c",
        "import runpy, sys; sys.stdout.reconfigure(encoding='utf-8', errors='replace'); runpy.run_path(sys.argv[1], run_name='__main__')",
        scriptPath,
      ],
      {
        cwd: tmpDir,
        input,
        encoding: "utf-8",
        env: { ...process.env, PYTHONIOENCODING: "gbk" },
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
    return result.stdout;
  }

  it("[statusline-opt-in] Claude statusline reads UTF-8 stdin under a legacy (GBK) locale", () => {
    setupRepo();
    writeProjectFile(
      path.join(".claude", "hooks", "statusline.py"),
      getStatuslineHook(),
    );

    const nowSecs = Math.floor(Date.now() / 1000);
    const output = runPythonWithLegacyStdinLocale(
      path.join(".claude", "hooks", "statusline.py"),
      JSON.stringify({
        session_id: "status-a",
        model: { display_name: "中文模型" },
        context_window: { used_percentage: 1, context_window_size: 1000 },
        cost: { total_duration_ms: 0 },
        rate_limits: {
          five_hour: {
            used_percentage: 17,
            resets_at: nowSecs + 4 * 3600 + 31 * 60 + 60,
          },
          seven_day: {
            used_percentage: 19,
            resets_at: nowSecs + 2 * 86400 + 11 * 3600 + 60,
          },
        },
      }),
    );

    expect(output).toContain("中文模型");
    // Rate-limit display with reset countdown (opt-in statusline enhancement)
    expect(output).toContain("5h 17%");
    expect(output).toMatch(/\(reset 4h3[12]m\)/);
    expect(output).toContain("7d 19%");
    expect(output).toContain("(reset 2d11h)");
  });

  it("[statusline-opt-in] Claude statusline tolerates ISO-8601 resets_at and missing seven_day (no crash)", () => {
    setupRepo();
    writeProjectFile(
      path.join(".claude", "hooks", "statusline.py"),
      getStatuslineHook(),
    );

    // resets_at wire format is not pinned across Claude Code versions:
    // epoch seconds and ISO-8601 strings have both been observed. The
    // statusline must render the countdown for ISO too — and never crash.
    const isoReset = new Date(
      Date.now() + (4 * 3600 + 31 * 60 + 90) * 1000,
    ).toISOString();
    const output = runPython(
      path.join(".claude", "hooks", "statusline.py"),
      JSON.stringify({
        model: { display_name: "Test" },
        context_window: { used_percentage: 1, context_window_size: 1000 },
        cost: { total_duration_ms: 0 },
        rate_limits: {
          five_hour: { used_percentage: 17, resets_at: isoReset },
          // seven_day intentionally absent
        },
      }),
    );

    expect(output).toContain("5h 17%");
    expect(output).toMatch(/\(reset 4h3[12]m\)/);
    expect(output).not.toContain("7d");
  });

  function statuslineRateLimitPayload(): string {
    const nowSecs = Math.floor(Date.now() / 1000);
    return JSON.stringify({
      model: { display_name: "Test" },
      context_window: { used_percentage: 1, context_window_size: 1000 },
      cost: { total_duration_ms: 0 },
      rate_limits: {
        five_hour: {
          used_percentage: 17,
          resets_at: nowSecs + 4 * 3600 + 31 * 60 + 60,
        },
        seven_day: {
          used_percentage: 19,
          resets_at: nowSecs + 2 * 86400 + 11 * 3600 + 60,
        },
      },
    });
  }

  it("[statusline-opt-in] Claude statusline moves rate limits to their own line when COLUMNS is narrow", () => {
    setupRepo();
    writeProjectFile(
      path.join(".claude", "hooks", "statusline.py"),
      getStatuslineHook(),
    );

    // COLUMNS is injected by Claude Code v2.1.153+. The split must be an
    // explicit "\n": the status bar counts only newlines for its height,
    // so relying on terminal auto-wrap misaligns rows.
    const output = runPython(
      path.join(".claude", "hooks", "statusline.py"),
      statuslineRateLimitPayload(),
      { COLUMNS: "60" },
    );

    const lines = output.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    const [infoLine, rateLine] = lines;
    expect(infoLine).not.toContain("5h");
    expect(infoLine).not.toContain("7d");
    expect(rateLine).toContain("5h 17%");
    expect(rateLine).toContain("7d 19%");
  });

  it("[statusline-opt-in] Claude statusline stays single-line when COLUMNS is wide or unset", () => {
    setupRepo();
    writeProjectFile(
      path.join(".claude", "hooks", "statusline.py"),
      getStatuslineHook(),
    );

    for (const env of [{ COLUMNS: "500" }, { COLUMNS: undefined }]) {
      const output = runPython(
        path.join(".claude", "hooks", "statusline.py"),
        statuslineRateLimitPayload(),
        env,
      );
      const lines = output.trimEnd().split("\n");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("5h 17%");
      expect(lines[0]).toContain("7d 19%");
    }
  });
});

describe("regression: backslash in markdown templates (beta.12)", () => {
  it("[beta.12] Common skill templates do not contain problematic backslash sequences", () => {
    for (const tmpl of getSkillTemplates()) {
      expect(tmpl.content).not.toContain("\\--");
      expect(tmpl.content).not.toContain("\\->");
    }
  });
});

// =============================================================================
// 5. Platform Registry Regressions
// =============================================================================

describe("regression: platform additions (beta.9, beta.13, beta.16)", () => {
  it("[beta.9] all platforms have consistent required fields", () => {
    for (const id of PLATFORM_IDS) {
      const tool = AI_TOOLS[id];
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.configDir.startsWith(".")).toBe(true);
      expect(tool.cliFlag.length).toBeGreaterThan(0);
      expect(Array.isArray(tool.templateDirs)).toBe(true);
      expect(tool.templateDirs).toContain("common");
      expect(typeof tool.defaultChecked).toBe("boolean");
      expect(typeof tool.hasPythonHooks).toBe("boolean");
    }
  });
});

describe("regression: cli_adapter platform support (beta.9, beta.13, beta.16)", () => {
  it("[codex] only Claude Code and Codex are registered", () => {
    expect(Object.keys(AI_TOOLS)).toEqual(["claude-code", "codex"]);
    expect(AI_TOOLS.codex.configDir).toBe(".codex");
    expect(AI_TOOLS.codex.supportsAgentSkills).toBe(true);
    expect(AI_TOOLS.codex.templateContext.cmdRefPrefix).toBe("$");
  });

  // v0.5.0-beta.12 removed `task.py init-context`; jsonl manifests are now
  // curated during planning when needed. The subparser, cmd_init_context, and get_check_context
  // helpers are all gone. task.py still guards against old invocations with
  // a clear deprecation message so users who muscle-memory-type the old
  // command get pointed at the new workflow.
  it("[migrate-flow-bugs] all breaking+recommendMigrate manifests include migrationGuide", () => {
    // Enforce going forward: every historical manifest where both
    // breaking=true AND recommendMigrate=true must have a non-empty
    // migrationGuide. create-manifest.js also rejects new ones without it.
    const manifestsDir = path.join(
      path.resolve(__dirname, ".."),
      "src/migrations/manifests",
    );
    const files = fs
      .readdirSync(manifestsDir)
      .filter((f) => f.endsWith(".json"));
    const offenders: string[] = [];
    for (const file of files) {
      const m = JSON.parse(
        fs.readFileSync(path.join(manifestsDir, file), "utf-8"),
      );
      if (m.breaking && m.recommendMigrate && !m.migrationGuide) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// 6. Cross-version Migration Consistency
// =============================================================================

describe("regression: prerelease→stable version stamp (rc.6→0.3.0)", () => {
  it("[0.3.0] rc→stable upgrade returns no migrations (all already applied)", () => {
    const migrations = getMigrationsForVersion("0.3.0-rc.6", "0.3.0");
    expect(migrations).toEqual([]);
  });
});

describe("regression: migration manifest consistency", () => {
  it("all manifest JSON files are loaded", () => {
    const manifestDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/migrations/manifests",
    );
    const jsonFiles = fs
      .readdirSync(manifestDir)
      .filter((f) => f.endsWith(".json"));
    const versions = getAllMigrationVersions();
    expect(versions.length).toBe(jsonFiles.length);
    expect(versions.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// YAML Quote Stripping (0.3.8)
// =============================================================================

describe("regression: parse_simple_yaml uses _unquote not greedy strip (0.3.8)", () => {
  // 0.6.x: the parser was consolidated into arbor_config.py (config.py now
  // imports it), so these source assertions follow it there. config.py must
  // not grow a second copy back.
  it("arbor_config.py defines _unquote helper", () => {
    expect(commonArborConfig).toContain("def _unquote(value: str) -> str:");
  });

  it("arbor_config.py uses _unquote for list items, not .strip('\"')", () => {
    // The bug: .strip('"').strip("'") greedily eats nested quotes
    // e.g. "echo 'hello'" -> strip("'") -> echo 'hello (broken!)
    expect(commonArborConfig).not.toContain(".strip('\"').strip(\"'\")");
    expect(commonArborConfig).toContain("_unquote(stripped[2:].strip())");
  });

  it("arbor_config.py uses _unquote for key-value, not .strip('\"')", () => {
    // 0.5.11: parse path strips inline comments first, then unquotes, so YAML
    // `key: false  # comment` parses correctly. The forbidden
    // `.strip('"').strip("'")` greedy chain still must not appear.
    expect(commonArborConfig).not.toContain(".strip('\"').strip(\"'\")");
    expect(commonArborConfig).toContain("_unquote(value)");
    expect(commonArborConfig).toContain("_strip_inline_comment(value)");
  });

  it("config.py imports the parser instead of redefining it", () => {
    expect(commonConfig).toContain(
      "from .arbor_config import parse_simple_yaml",
    );
    expect(commonConfig).not.toContain("def parse_simple_yaml(");
    expect(commonConfig).not.toContain("def _parse_yaml_block(");
    expect(commonConfig).not.toContain("def _unquote(");
  });
});

describe("regression: parse_simple_yaml Python execution (0.3.8)", () => {
  // arbor_config.py imports nothing from the package (hooks load it as a
  // single file), so it runs standalone as-is — no source extraction needed.
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  let tmpDir: string;

  beforeEach(() => {
    expect(commonArborConfig).toContain("def parse_simple_yaml(");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-yaml-py-"));
    fs.writeFileSync(path.join(tmpDir, "yaml_parser.py"), commonArborConfig);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run parse_simple_yaml via Python subprocess, returning result + stderr */
  function runPythonYamlFull(yamlContent: string): {
    result: unknown;
    stderr: string;
  } {
    const scriptFile = path.join(tmpDir, "_test.py");
    const script = [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(tmpDir)})`,
      "from yaml_parser import parse_simple_yaml",
      `result = parse_simple_yaml(${JSON.stringify(yamlContent)})`,
      "print(json.dumps(result))",
    ].join("\n");
    fs.writeFileSync(scriptFile, script);
    const proc = spawnSync(pythonCmd, [scriptFile], { encoding: "utf-8" });
    expect(proc.status, proc.stderr).toBe(0);
    return {
      result: JSON.parse((proc.stdout ?? "").trim()),
      stderr: proc.stderr ?? "",
    };
  }

  function runPythonYaml(yamlContent: string): unknown {
    return runPythonYamlFull(yamlContent).result;
  }

  it("nested single quotes inside double quotes are preserved", () => {
    const result = runPythonYaml("key: \"echo 'hello'\"");
    expect(result).toEqual({ key: "echo 'hello'" });
  });

  it("nested double quotes inside single quotes are preserved", () => {
    const result = runPythonYaml("key: 'say \"hi\"'");
    expect(result).toEqual({ key: 'say "hi"' });
  });

  it("list items with nested quotes are preserved", () => {
    const result = runPythonYaml(
      "hooks:\n  after_create:\n    - \"echo 'Task created'\"",
    );
    expect(result).toEqual({
      hooks: { after_create: ["echo 'Task created'"] },
    });
  });

  it("simple quoted values work", () => {
    const result = runPythonYaml("a: \"hello\"\nb: 'world'");
    expect(result).toEqual({ a: "hello", b: "world" });
  });

  it("unquoted values are unchanged", () => {
    const result = runPythonYaml("key: plain value");
    expect(result).toEqual({ key: "plain value" });
  });

  it("mismatched quotes are left as-is", () => {
    const result = runPythonYaml("key: \"hello'");
    expect(result).toEqual({ key: "\"hello'" });
  });

  // ---------------------------------------------------------------------
  // Unsupported constructs are reported, not silently mis-parsed (audit §4)
  // ---------------------------------------------------------------------

  it("a mapping inside a list is not hoisted into the parent dict", () => {
    // Was: {"packages": ["name: cli"], "path": "packages/cli"} — the nested
    // `path` key silently became a top-level config key.
    const { result, stderr } = runPythonYamlFull(
      "packages:\n  - name: cli\n    path: packages/cli\n",
    );
    expect(result).not.toHaveProperty("path");
    expect(result).toEqual({ packages: ["name: cli"] });
    expect(stderr).toContain("mappings inside a list are not supported");
    expect(stderr).toContain("path: packages/cli");
  });

  it("block scalars are reported and their body is not leaked", () => {
    // Was: {"notes": "|"} — the marker became the value, body dropped.
    const { result, stderr } = runPythonYamlFull(
      "notes: |\n  line one\n  key: not-a-real-key\nkeep: ok\n",
    );
    expect(result).toEqual({ keep: "ok" });
    expect(stderr).toContain("block scalars are not supported");
    expect(stderr).toContain(":1:");
  });

  it("anchors, aliases, merge keys and flow collections are reported", () => {
    const { result, stderr } = runPythonYamlFull(
      "base: &b\nuse: *b\nlist: [a, b]\nmap: {a: 1}\nkeep: ok\n",
    );
    expect(result).toEqual({ keep: "ok" });
    expect(stderr).toContain("YAML anchors are not supported");
    expect(stderr).toContain("YAML aliases are not supported");
    expect(stderr).toContain("flow sequences are not supported");
    expect(stderr).toContain("flow mappings are not supported");
  });

  it("quoted values that look like YAML constructs stay untouched", () => {
    // A hook command is a plain string; only unquoted scalars are inspected.
    const { result, stderr } = runPythonYamlFull(
      'cmd: "a | b"\nglob: "*.py"\nflowish: "[a, b]"\n',
    );
    expect(result).toEqual({
      cmd: "a | b",
      glob: "*.py",
      flowish: "[a, b]",
    });
    expect(stderr).toBe("");
  });

  it("a well-formed config parses with no warnings", () => {
    const { result, stderr } = runPythonYamlFull(
      [
        "session_auto_commit: false  # off for this project",
        "packages:",
        "  cli:",
        "    path: packages/cli",
        "    git: yes",
        "hooks:",
        "  after_create:",
        "    - echo one",
        "  after_archive:",
        "    - echo two",
        "",
      ].join("\n"),
    );
    expect(result).toEqual({
      session_auto_commit: "false",
      packages: { cli: { path: "packages/cli", git: "yes" } },
      hooks: { after_create: ["echo one"], after_archive: ["echo two"] },
    });
    expect(stderr).toBe("");
  });
});

// =============================================================================
// 8. Dead Code / Template Content Regressions
// =============================================================================

// =============================================================================
// S4: Submodule + PR Awareness (beta.1)
// =============================================================================

// submodule awareness in multi_agent scripts tests removed — multi_agent pipeline removed

describe("regression: cross-platform-thinking-guide dead code removed (0.3.1)", () => {
  it("[0.3.1] guidesCrossPlatformThinkingGuideContent is not exported from markdown/index", () => {
    expect(markdownExports).not.toHaveProperty(
      "guidesCrossPlatformThinkingGuideContent",
    );
  });

  it("[0.3.1] guides index.md does not reference cross-platform-thinking-guide", () => {
    expect(guidesIndexContent).not.toContain("cross-platform-thinking-guide");
    expect(guidesIndexContent).not.toContain("Cross-Platform Thinking Guide");
  });
});

describe("regression: templates/markdown/spec contains only .md.txt files (0.5.0-beta.9)", () => {
  // Invariant: packages/cli/src/templates/markdown/spec/ is for user-facing
  // placeholder templates only — markdown/index.ts reads .md.txt via
  // readLocalTemplate, so bare .md files there are orphans (ship to dist as
  // dead weight, never land on user disks). Documented in
  // .arbor/spec/cli/backend/directory-structure.md "Don't: Leak dogfood
  // spec into templates/markdown/spec/". Captured while cleaning up ~2-year-old
  // leakage in task 04-21-task-schema-unify.
  it("every file under templates/markdown/spec ends in .md.txt", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile()) out.push(full);
      }
      return out;
    }
    const __dirname3 = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname3, "../../..");
    const specRoot = path.join(
      repoRoot,
      "packages/cli/src/templates/markdown/spec",
    );
    const files = walk(specRoot);
    const orphans = files.filter((f) => !f.endsWith(".md.txt"));
    expect(
      orphans,
      `Orphan non-.md.txt files in templates/markdown/spec/: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});

describe("regression: configSectionsAdded (issue-codex-dispatch-mode)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-config-section-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[config-sections] extractConfigSection returns content between matching separator and next separator", async () => {
    const { extractConfigSection } = await import("../src/commands/update.js");
    const fake = [
      "# Header preamble",
      "",
      "#-------------------------------------------------------------------------------",
      "# First Section",
      "#-------------------------------------------------------------------------------",
      "first_key: value",
      "",
      "#-------------------------------------------------------------------------------",
      "# Second Section",
      "#-------------------------------------------------------------------------------",
      "# second_key: comment",
      "second_key: 2",
      "",
      "#-------------------------------------------------------------------------------",
      "# Third Section",
      "#-------------------------------------------------------------------------------",
      "third_key: 3",
    ].join("\n");

    const second = extractConfigSection(fake, "Second Section");
    expect(second).not.toBeNull();
    expect(second).toContain("# Second Section");
    expect(second).toContain("second_key: 2");
    // Must stop before the next separator block
    expect(second).not.toContain("Third Section");
    expect(second).not.toContain("third_key: 3");

    // Last section runs to EOF
    const third = extractConfigSection(fake, "Third Section");
    expect(third).not.toBeNull();
    expect(third).toContain("third_key: 3");

    // Missing heading returns null
    expect(extractConfigSection(fake, "Nonexistent Section")).toBeNull();
  });

  it("[config-sections] applyConfigSectionsAdded appends section when sentinel missing, idempotent on rerun", async () => {
    const { applyConfigSectionsAdded } =
      await import("../src/commands/update.js");
    const arborDir = path.join(tmpDir, ".arbor");
    fs.mkdirSync(arborDir, { recursive: true });
    const userConfigPath = path.join(arborDir, "config.yaml");
    const userConfig = [
      "# Arbor Configuration",
      'session_commit_message: "chore: record journal"',
      "",
    ].join("\n");
    fs.writeFileSync(userConfigPath, userConfig);

    const bundledTemplate = [
      "# Arbor Configuration",
      'session_commit_message: "chore: record journal"',
      "",
      "#-------------------------------------------------------------------------------",
      "# Codex (sub-agent dispatch behavior)",
      "#-------------------------------------------------------------------------------",
      "# codex:",
      "#   dispatch_mode: sub-agent",
      "",
    ].join("\n");

    const entries = [
      {
        file: ".arbor/config.yaml",
        sentinel: "codex:",
        sectionHeading: "Codex (sub-agent dispatch behavior)",
      },
    ];
    const bundled = new Map<string, string>([
      [".arbor/config.yaml", bundledTemplate],
    ]);

    const first = applyConfigSectionsAdded(entries, tmpDir, bundled);
    expect(first.appended).toBe(1);
    const after = fs.readFileSync(userConfigPath, "utf-8");
    expect(after).toContain("# Codex (sub-agent dispatch behavior)");
    expect(after).toContain("codex:");
    expect(after).toContain("dispatch_mode: sub-agent");

    // Rerun: sentinel now present, no append.
    const second = applyConfigSectionsAdded(entries, tmpDir, bundled);
    expect(second.appended).toBe(0);
    const after2 = fs.readFileSync(userConfigPath, "utf-8");
    expect(after2).toBe(after);
  });

  it("[config-sections] applyConfigSectionsAdded skips when target file does not exist", async () => {
    const { applyConfigSectionsAdded } =
      await import("../src/commands/update.js");
    const result = applyConfigSectionsAdded(
      [
        {
          file: ".arbor/config.yaml",
          sentinel: "codex:",
          sectionHeading: "Codex (sub-agent dispatch behavior)",
        },
      ],
      tmpDir,
      new Map<string, string>([[".arbor/config.yaml", "# fake template"]]),
    );
    expect(result.appended).toBe(0);
  });
});

// =============================================================================
// safe-commit: gitignored .arbor/ recovery (0.5.10 → 0.5.11)
// =============================================================================
//
// Real user incident: project .gitignore listed `.arbor/`. add_session.py's
// auto-commit ran `git add .arbor/workspace .arbor/tasks`, got `ignored
// by .gitignore`, fell back to a hint suggesting `git add .arbor &&
// commit`. The AI agent driving the workflow extrapolated that to
// `git add -f .arbor/`, which forced in `.arbor/.backup-*/`,
// `.arbor/worktrees/`, `.arbor/.template-hashes.json`, etc. — 548 files
// / 83474 lines of caches/backups committed.
//
// 0.5.10 fix (since reverted):
//   - Scripts only stage SPECIFIC product paths.
//   - On `ignored by` the scripts retried with `git add -f <specific paths>`.
// That auto-`-f` was an over-fix — when a user gitignores `.arbor/` they
// mean "keep .arbor/ local-only", and forcing the commit through (even on
// narrow paths) violates user intent. Group-chat report: a finish-work auto
// committed `.arbor/workspace/` straight into a repo whose .gitignore
// excluded `.arbor/`.
//
// 0.5.11 fix (current):
//   - Plain `git add <specific>` is tried once. On `ignored by`, the script
//     warns and skips the auto-commit — never `-f`.
//   - New `session_auto_commit: false` config opts the user out of auto-stage
//     and auto-commit entirely (issue #245).
//   - The warning explicitly says ``Do NOT use `git add -f .arbor/```` so
//     AI re-reading the log doesn't reinvent the bug, and points at the new
//     `session_auto_commit: false` knob.
//
// These tests synthesize a tmp git repo with `.arbor/` gitignored and
// verify (a) on `ignored by` the script warns + skips (no commit, no -f),
// (b) `session_auto_commit: false` skips git entirely in any state, and
// (c) the negative-rule warning + new config hint are reachable.
// =============================================================================

describe("regression: safe auto-commit when .arbor/ is gitignored (0.5.10 → 0.5.11)", () => {
  let tmpDir: string;
  const pyCmd = process.platform === "win32" ? "python" : "python3";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-safe-commit-"));
    execSync("git init -q -b main", { cwd: tmpDir });
    // Configure user so git commit succeeds in CI sandboxes.
    execSync('git config user.email "test@arbor.local"', { cwd: tmpDir });
    execSync('git config user.name "Arbor Test"', { cwd: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }

  function writeArborScripts(): void {
    const scriptsDir = path.join(tmpDir, ".arbor", "scripts");
    for (const [rel, content] of getAllScripts()) {
      const abs = path.join(scriptsDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
    }
  }

  function writeWorkspaceIndex(): void {
    writeFile(
      ".arbor/workspace/test-dev/index.md",
      [
        "# Workspace Index - test-dev",
        "",
        "## Current Status",
        "",
        "<!-- @@@auto:current-status -->",
        "- **Active File**: `journal-1.md`",
        "- **Total Sessions**: 0",
        "- **Last Active**: -",
        "<!-- @@@/auto:current-status -->",
        "",
        "## Active Documents",
        "",
        "<!-- @@@auto:active-documents -->",
        "| File | Lines | Status |",
        "|------|-------|--------|",
        "| `journal-1.md` | ~0 | Active |",
        "<!-- @@@/auto:active-documents -->",
        "",
        "## Session History",
        "",
        "<!-- @@@auto:session-history -->",
        "| # | Date | Title | Commits | Branch |",
        "|---|------|-------|---------|--------|",
        "<!-- @@@/auto:session-history -->",
        "",
      ].join("\n"),
    );
  }

  function setupRepo(options?: { gitignoreArbor?: boolean }): void {
    writeArborScripts();
    writeFile(
      ".arbor/.developer",
      "name=test-dev\ninitialized_at=2026-05-09T00:00:00\n",
    );
    writeFile(
      ".arbor/workspace/test-dev/journal-1.md",
      "# Journal - test-dev (Part 1)\n\n---\n",
    );
    writeWorkspaceIndex();
    // Ignored caches/backups must exist on disk to prove they don't get
    // staged when -f is forced on specific paths.
    writeFile(
      ".arbor/.backup-2026-05-09/should-not-be-committed.txt",
      "secret-backup\n",
    );
    writeFile(
      ".arbor/worktrees/wt-a/should-not-be-committed.txt",
      "secret-worktree\n",
    );
    writeFile(
      ".arbor/.template-hashes.json",
      '{"_": "should-not-be-committed"}\n',
    );
    writeFile(".arbor/.runtime/sessions/should-not-be-committed.json", "{}\n");

    if (options?.gitignoreArbor) {
      writeFile(".gitignore", ".arbor/\n");
    }
    // Seed an initial commit so HEAD exists.
    writeFile("README.md", "test\n");
    execSync("git add README.md", { cwd: tmpDir });
    if (options?.gitignoreArbor) {
      execSync("git add .gitignore", { cwd: tmpDir });
    }
    execSync('git commit -q -m "init"', { cwd: tmpDir });
  }

  function runAddSession(): { stdout: string; stderr: string } {
    const scriptPath = path.join(tmpDir, ".arbor", "scripts", "add_session.py");
    const result = spawnSync(
      pyCmd,
      [scriptPath, "--title", "Test", "--summary", "Test"],
      {
        cwd: tmpDir,
        encoding: "utf-8",
        env: { ...process.env, ARBOR_CONTEXT_ID: "session-a" },
      },
    );
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function listCommittedFiles(): string[] {
    const out = execSync("git ls-tree -r --name-only HEAD", {
      cwd: tmpDir,
      encoding: "utf-8",
    });
    return out.split("\n").filter((l) => l.length > 0);
  }

  it("[gitignore-arbor] add_session warns and skips when .arbor/ is ignored (default mode)", () => {
    setupRepo({ gitignoreArbor: true });
    const { stderr } = runAddSession();

    // Plain add fails with "ignored by". 0.5.11 must NOT retry with -f.
    // Instead the script warns and skips the entire auto-commit. So no
    // "Auto-committed" line, and the warning fires.
    expect(stderr).not.toContain("Auto-committed");
    expect(stderr).toContain("ignored by your .gitignore");
    expect(stderr).toContain("Do NOT use `git add -f .arbor/`");
    expect(stderr).toContain("session_auto_commit: false");

    // Nothing under .arbor/ should be tracked: the user's .gitignore
    // intent is preserved.
    const tracked = listCommittedFiles();
    for (const tracked_path of tracked) {
      expect(
        tracked_path.startsWith(".arbor/"),
        `should not commit anything under .arbor/ (got: ${tracked_path})`,
      ).toBe(false);
    }

    // The journal + index files are still on disk (the script wrote them
    // before attempting auto-commit) — only git was untouched.
    expect(
      fs.existsSync(
        path.join(tmpDir, ".arbor/workspace/test-dev/journal-1.md"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".arbor/workspace/test-dev/index.md")),
    ).toBe(true);
  });

  it("[gitignore-arbor] add_session works normally when .arbor/ is NOT ignored", () => {
    // Regression guard: pre-existing behavior must not change for users
    // whose .gitignore does not exclude .arbor/.
    setupRepo({ gitignoreArbor: false });
    const { stderr } = runAddSession();
    expect(stderr).toContain("Auto-committed");

    const tracked = listCommittedFiles();
    expect(tracked).toContain(".arbor/workspace/test-dev/journal-1.md");
  });

  it("[gitignore-arbor] safe_commit module ships and contains the negative warning + new config hint", () => {
    // The warning's exact text matters because AI agents read it.
    // Specifically the negative example must appear verbatim so any future
    // refactor that removes it will fail this test. 0.5.11 also adds the
    // new session_auto_commit hint.
    const safeCommit = getAllScripts().get("common/safe_commit.py");
    expect(safeCommit).toBeTruthy();
    expect(safeCommit).toContain("Do NOT use `git add -f .arbor/`");
    expect(safeCommit).toContain("safe_arbor_paths_to_add");
    expect(safeCommit).toContain("safe_archive_paths_to_add");
    expect(safeCommit).toContain("safe_git_add");
    // 0.5.11: new hint pointing users at the config knob.
    expect(safeCommit).toContain("session_auto_commit: false");
    // 0.5.11: auto -f retry must be gone. The function body should no
    // longer issue `git add -f`.
    expect(safeCommit).not.toMatch(/\["add", "-f", "--",/);
  });

  // ===========================================================================
  // 0.5.11: session_auto_commit config (issue #245 + screenshot user)
  // ===========================================================================

  function writeConfigYaml(content: string): void {
    writeFile(".arbor/config.yaml", content);
  }

  it("[session_auto_commit=false] add_session skips git entirely (no add, no commit)", () => {
    // User wants journal/task files written to disk but no auto-staging
    // and no auto-commit. Issue #245 + screenshot user use case.
    setupRepo({ gitignoreArbor: false });
    writeConfigYaml("session_auto_commit: false\n");

    const { stderr } = runAddSession();
    expect(stderr).not.toContain("Auto-committed");
    expect(stderr).toContain("session_auto_commit: false");

    // No new commits beyond the initial "init" commit.
    const log = execSync("git log --oneline", {
      cwd: tmpDir,
      encoding: "utf-8",
    });
    expect(log.trim().split("\n").length).toBe(1);

    // No staged changes either — `git add` was never called.
    const staged = execSync("git diff --cached --name-only", {
      cwd: tmpDir,
      encoding: "utf-8",
    });
    expect(staged.trim()).toBe("");

    // Files were still written to disk.
    expect(
      fs.existsSync(
        path.join(tmpDir, ".arbor/workspace/test-dev/journal-1.md"),
      ),
    ).toBe(true);
  });

  it("[session_auto_commit] inline comment is stripped before parsing", () => {
    // YAML inline-comment trap: `key: false  # comment` previously broke in
    // common/config.py because parse_simple_yaml didn't strip ` #`. This
    // verifies the helper is shared with arbor_config.py's parser.
    setupRepo({ gitignoreArbor: false });
    writeConfigYaml("session_auto_commit: false  # disable for this project\n");

    const { stderr } = runAddSession();
    expect(stderr).toContain("session_auto_commit: false");
    expect(stderr).not.toContain("Auto-committed");
    expect(stderr).not.toContain("invalid session_auto_commit");

    const log = execSync("git log --oneline", {
      cwd: tmpDir,
      encoding: "utf-8",
    });
    expect(log.trim().split("\n").length).toBe(1);
  });

  it("[session_auto_commit] string variants resolve to false", () => {
    // The helper must accept lowercase / uppercase / synonym forms.
    // Spot-check `FALSE` (uppercase) and `no` here; `0` and `off` follow
    // the same code path (the lowercase set in get_session_auto_commit).
    for (const variant of ["FALSE", "no", "off", "0"]) {
      setupRepo({ gitignoreArbor: false });
      writeConfigYaml(`session_auto_commit: ${variant}\n`);

      const { stderr } = runAddSession();
      expect(
        stderr.includes("session_auto_commit: false"),
        `variant=${variant}`,
      ).toBe(true);

      // Reset for next iteration.
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-safe-commit-"));
      execSync("git init -q -b main", { cwd: tmpDir });
      execSync('git config user.email "test@arbor.local"', { cwd: tmpDir });
      execSync('git config user.name "Arbor Test"', { cwd: tmpDir });
    }
  });

  it("[session_auto_commit] invalid value falls back to true with stderr warn", () => {
    setupRepo({ gitignoreArbor: false });
    writeConfigYaml("session_auto_commit: maybe\n");

    const { stderr } = runAddSession();
    // Warning fires.
    expect(stderr).toContain("invalid session_auto_commit value");
    // Falls back to true → auto-commit happens.
    expect(stderr).toContain("Auto-committed");
  });
});

// =============================================================================
// regression: transient .git/index.lock during archive auto-commit
// =============================================================================
//
// `task.py archive` moves the task directory on disk BEFORE it stages and
// commits. Another process holding `.git/index.lock` for a fraction of a
// second (IDE git integration, status daemon, a parallel session) made that
// auto-commit fail outright, leaving the user with a completed move and a git
// error to untangle.
//
// Fix: `run_git_retry_index_lock` retries ONLY index.lock failures — three
// attempts over ~1.5s. `task.py` is gone in arbor 1.0; the retry semantics of
// `common/git.py` are still pinned below.
// =============================================================================

describe("regression: bounded index.lock retry on archive auto-commit", () => {
  let tmpDir: string;
  const pyCmd = process.platform === "win32" ? "python" : "python3";
  const taskName = "issue-lock";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-index-lock-"));
    execSync("git init -q -b main", { cwd: tmpDir });
    execSync('git config user.email "test@arbor.local"', { cwd: tmpDir });
    execSync('git config user.name "Arbor Test"', { cwd: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }

  function setupRepo(): void {
    const scriptsDir = path.join(tmpDir, ".arbor", "scripts");
    for (const [rel, content] of getAllScripts()) {
      const abs = path.join(scriptsDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
    }
    writeFile(
      ".arbor/.developer",
      "name=test-dev\ninitialized_at=2026-08-09T00:00:00\n",
    );
    writeFile(
      `.arbor/tasks/${taskName}/task.json`,
      JSON.stringify(
        { title: "Locked archive", status: "in_progress", package: null },
        null,
        2,
      ),
    );
    writeFile(`.arbor/tasks/${taskName}/prd.md`, "# PRD\n");
    writeFile("README.md", "test\n");
    // The task must be tracked: an untracked task dir makes a failed
    // auto-commit inconsequential, which is not the case under test.
    execSync("git add -A", { cwd: tmpDir });
    execSync('git commit -q -m "init"', { cwd: tmpDir });
  }

  it("[index-lock] retries only index.lock failures, bounded by the attempt count", () => {
    // Deterministic cover for the retry semantics themselves (no wall-clock
    // timing involved).
    setupRepo();
    const probe = `
import json
import sys
from pathlib import Path

root = Path.cwd()
sys.path.insert(0, str(root / ".arbor" / "scripts"))
import common.git as g

# Real backoff would make this probe sleep for its whole runtime.
g.INDEX_LOCK_RETRY_BACKOFF = (0, 0)
lock_err = "fatal: Unable to create '/repo/.git/index.lock': File exists."
calls = []

def transient(args, cwd=None, timeout=None):
    calls.append(args)
    if len(calls) < g.INDEX_LOCK_RETRY_ATTEMPTS:
        return 1, "", lock_err
    return 0, "done", ""

def stuck(args, cwd=None, timeout=None):
    calls.append(args)
    return 1, "", lock_err

def unrelated(args, cwd=None, timeout=None):
    calls.append(args)
    return 1, "", "fatal: pathspec 'nope' did not match any files"

g.run_git = transient
transient_rc, transient_out, _ = g.run_git_retry_index_lock(["commit", "-m", "x"])
transient_calls = len(calls)

calls.clear()
g.run_git = stuck
stuck_rc, _, stuck_err = g.run_git_retry_index_lock(["commit", "-m", "x"])
stuck_calls = len(calls)

calls.clear()
g.run_git = unrelated
unrelated_rc, _, _ = g.run_git_retry_index_lock(["add", "nope"])
unrelated_calls = len(calls)

print(json.dumps({
    "attempts": g.INDEX_LOCK_RETRY_ATTEMPTS,
    "transient_rc": transient_rc,
    "transient_out": transient_out,
    "transient_calls": transient_calls,
    "stuck_rc": stuck_rc,
    "stuck_calls": stuck_calls,
    "stuck_named_lock": g.stderr_indicates_index_lock(stuck_err),
    "unrelated_rc": unrelated_rc,
    "unrelated_calls": unrelated_calls,
}))
`;
    const result = spawnSync(pyCmd, ["-c", probe], {
      cwd: tmpDir,
      encoding: "utf-8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      attempts: 3,
      // A lock released before the last attempt ends in success.
      transient_rc: 0,
      transient_out: "done",
      transient_calls: 3,
      // A lock that never clears stops at the bound instead of hanging.
      stuck_rc: 1,
      stuck_calls: 3,
      stuck_named_lock: true,
      // Anything that is not a lock failure must not be retried — looping
      // over a real error only delays it.
      unrelated_rc: 1,
      unrelated_calls: 1,
    });
  });
});

// =============================================================================
// regression: dogfood ↔ shipped Python script parity
// =============================================================================

describe("regression: .arbor/scripts stays byte-identical to templates/arbor/scripts", () => {
  // `.arbor/scripts/` is Arbor's own dogfood copy;
  // `packages/cli/src/templates/arbor/scripts/` is what ships to users.
  // They are two physical copies of the same 28 files and nothing enforced
  // parity, so one-sided edits landed silently — PR #390 changed the template's
  // `common/session_context.py` upgrade hint and left the dogfood copy on the
  // old wording for a month. This test turns that whole class of drift into a
  // build failure.
  const __dirnameParity = path.dirname(fileURLToPath(import.meta.url));
  const parityRepoRoot = path.resolve(__dirnameParity, "../../..");
  const dogfoodScriptsRoot = path.join(parityRepoRoot, ".arbor", "scripts");
  const templateScriptsRoot = path.join(
    parityRepoRoot,
    "packages/cli/src/templates/arbor/scripts",
  );

  function listPyFiles(root: string): string[] {
    const found: string[] = [];
    function walk(dir: string, prefix: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === "__pycache__") continue;
          walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith(".py")) {
          found.push(`${prefix}${entry.name}`);
        }
      }
    }
    walk(root, "");
    return found.sort();
  }

  const templateFiles = listPyFiles(templateScriptsRoot);

  it("both trees hold the same set of .py files", () => {
    const dogfoodFiles = listPyFiles(dogfoodScriptsRoot);
    expect(
      dogfoodFiles,
      "`.arbor/scripts/` and `packages/cli/src/templates/arbor/scripts/` " +
        "must hold the same .py files — a script added to (or deleted from) " +
        "one tree must be mirrored in the other.",
    ).toEqual(templateFiles);
  });

  for (const relativePath of templateFiles) {
    it(`${relativePath} is byte-identical in both trees`, () => {
      const dogfoodPath = path.join(dogfoodScriptsRoot, relativePath);
      expect(
        fs.existsSync(dogfoodPath),
        `.arbor/scripts/${relativePath} is missing (template has it)`,
      ).toBe(true);
      const dogfoodBytes = fs.readFileSync(dogfoodPath);
      const templateBytes = fs.readFileSync(
        path.join(templateScriptsRoot, relativePath),
      );
      expect(
        dogfoodBytes.equals(templateBytes),
        `.arbor/scripts/${relativePath} has drifted from ` +
          `packages/cli/src/templates/arbor/scripts/${relativePath}. ` +
          `Edit both copies, never one.`,
      ).toBe(true);
    });
  }
});

describe("regression: a linked worktree inherits developer identity", () => {
  // `.arbor/.developer` is gitignored (it carries a personal identity), so a
  // fresh `git worktree add` used to start with no identity at all and every
  // script failed with "No developer set" until init_developer.py was re-run
  // per worktree — which blocks worktree-per-worker parallel runs.
  const pyCmd = process.platform === "win32" ? "python" : "python3";
  let tmpDir: string;
  let mainDir: string;
  let worktreeDir: string;

  function git(cwd: string, ...args: string[]): void {
    const proc = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (proc.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    }
  }

  function writeScripts(root: string): void {
    for (const [rel, content] of getAllScripts()) {
      const abs = path.join(root, ".arbor", "scripts", rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
    }
  }

  /** A committed repo at `mainDir` plus a linked worktree at `worktreeDir`. */
  function buildRepo(developerName: string | null): void {
    writeScripts(mainDir);
    fs.writeFileSync(
      path.join(mainDir, ".gitignore"),
      ".arbor/.developer\n",
      "utf-8",
    );
    if (developerName !== null) {
      fs.writeFileSync(
        path.join(mainDir, ".arbor", ".developer"),
        `name=${developerName}\ninitialized_at=2026-08-09T00:00:00\n`,
        "utf-8",
      );
    }
    git(mainDir, "init", "-q", "-b", "main", ".");
    git(mainDir, "config", "user.email", "test@example.com");
    git(mainDir, "config", "user.name", "test");
    git(mainDir, "add", "-A");
    git(mainDir, "commit", "-qm", "init");
    git(mainDir, "worktree", "add", "-q", worktreeDir, "-b", "wt");
  }

  function runScript(
    cwd: string,
    script: string,
    args: string[] = [],
    envOverrides: NodeJS.ProcessEnv = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const env = { ...process.env, ...envOverrides };
    // Inherited identity must come from the repo, never from the environment
    // of the machine running the suite.
    if (envOverrides.ARBOR_DEVELOPER === undefined) {
      delete env.ARBOR_DEVELOPER;
    }
    const proc = spawnSync(
      pyCmd,
      [path.join(cwd, ".arbor", "scripts", script), ...args],
      { cwd, encoding: "utf-8", env },
    );
    return {
      status: proc.status,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    };
  }

  /** The identity get_developer.py resolves in `cwd`, or null when it fails. */
  function developerIn(
    cwd: string,
    envOverrides: NodeJS.ProcessEnv = {},
  ): string | null {
    const r = runScript(cwd, "get_developer.py", [], envOverrides);
    expect(r.stderr).not.toContain("Traceback");
    return r.status === 0 ? r.stdout.trim() : null;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-wt-identity-"));
    mainDir = path.join(tmpDir, "main");
    worktreeDir = path.join(tmpDir, "linked");
    fs.mkdirSync(mainDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[worktree-identity] a fresh worktree resolves the main checkout's identity with no manual setup", () => {
    buildRepo("main-dev");

    // The premise: git did not carry the gitignored identity file across.
    expect(fs.existsSync(path.join(worktreeDir, ".arbor", ".developer"))).toBe(
      false,
    );

    expect(developerIn(worktreeDir)).toBe("main-dev");

    // Inheritance is read-only: copying the file in would go stale and shadow
    // later changes made in the main checkout.
    expect(fs.existsSync(path.join(worktreeDir, ".arbor", ".developer"))).toBe(
      false,
    );
  });

  it("[worktree-identity] a later main-checkout change is picked up, because nothing was copied", () => {
    buildRepo("main-dev");
    expect(developerIn(worktreeDir)).toBe("main-dev");

    fs.writeFileSync(
      path.join(mainDir, ".arbor", ".developer"),
      "name=renamed-dev\ninitialized_at=2026-08-09T00:00:00\n",
      "utf-8",
    );

    expect(developerIn(worktreeDir)).toBe("renamed-dev");
  });

  it("[worktree-identity] precedence: ARBOR_DEVELOPER > local file > main checkout", () => {
    buildRepo("main-dev");

    // 3. main checkout, in the worktree that has no file of its own
    expect(developerIn(worktreeDir)).toBe("main-dev");

    // 2. a local file in the worktree wins over the main checkout
    fs.writeFileSync(
      path.join(worktreeDir, ".arbor", ".developer"),
      "name=local-dev\ninitialized_at=2026-08-09T00:00:00\n",
      "utf-8",
    );
    expect(developerIn(worktreeDir)).toBe("local-dev");

    // 1. the env var wins over both files
    expect(developerIn(worktreeDir, { ARBOR_DEVELOPER: "env-dev" })).toBe(
      "env-dev",
    );
  });

  it("[worktree-identity] the env var alone is enough in the main checkout too", () => {
    buildRepo(null);
    expect(developerIn(mainDir, { ARBOR_DEVELOPER: "env-dev" })).toBe(
      "env-dev",
    );
  });

  it("[worktree-identity] a whitespace-only env var does not count as an identity", () => {
    buildRepo("main-dev");
    expect(developerIn(worktreeDir, { ARBOR_DEVELOPER: "   " })).toBe(
      "main-dev",
    );
  });

  it("[worktree-identity] with no identity anywhere, the error names all three sources", () => {
    buildRepo(null);

    for (const cwd of [mainDir, worktreeDir]) {
      expect(developerIn(cwd)).toBeNull();

      const session = runScript(cwd, "add_session.py", [
        "--title",
        "nobody",
        "--no-commit",
      ]);
      expect(session.status).not.toBe(0);
      expect(session.stderr).toContain("Developer not initialized");
      expect(session.stderr).toContain("init_developer.py");
      expect(session.stderr).toContain("ARBOR_DEVELOPER");
      expect(session.stderr).toContain("linked git worktree");
    }
  });

  it("[worktree-identity] a linked worktree of a bare repo inherits nothing", () => {
    buildRepo("main-dev");
    const bareDir = path.join(tmpDir, "bare.git");
    const bareWt = path.join(tmpDir, "bare-wt");
    git(tmpDir, "clone", "-q", "--bare", mainDir, bareDir);
    git(bareDir, "worktree", "add", "-q", bareWt, "wt");
    writeScripts(bareWt);

    const r = runScript(bareWt, "get_developer.py");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Developer not initialized");
    expect(r.stderr).not.toContain("Traceback");
  });

  it("[worktree-identity] a bare repo nested inside an unrelated checkout does not leak that checkout's identity", () => {
    // Deriving the main root as the parent of `--git-common-dir` picks up
    // `outer/` here — a real checkout with a real `.developer` — so the wrong
    // answer looks exactly like a right one. git must name the main worktree.
    buildRepo("main-dev");
    const outerDir = path.join(tmpDir, "outer");
    fs.mkdirSync(path.join(outerDir, ".arbor"), { recursive: true });
    fs.writeFileSync(
      path.join(outerDir, ".arbor", ".developer"),
      "name=unrelated-stranger\ninitialized_at=2026-08-09T00:00:00\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(outerDir, "README.md"), "outer\n", "utf-8");
    git(outerDir, "init", "-q", "-b", "main", ".");
    git(outerDir, "config", "user.email", "test@example.com");
    git(outerDir, "config", "user.name", "test");
    git(outerDir, "add", "README.md");
    git(outerDir, "commit", "-qm", "outer");

    const nestedBare = path.join(outerDir, "nested.git");
    const nestedWt = path.join(tmpDir, "nested-wt");
    git(tmpDir, "clone", "-q", "--bare", mainDir, nestedBare);
    git(nestedBare, "worktree", "add", "-q", nestedWt, "wt");
    writeScripts(nestedWt);

    const r = runScript(nestedWt, "get_developer.py");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).not.toContain("unrelated-stranger");
    expect(r.stderr).toContain("Developer not initialized");
  });

  it("[worktree-identity] a directory that is not a git repo fails normally, never crashes", () => {
    writeScripts(mainDir);

    const r = runScript(mainDir, "get_developer.py");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Developer not initialized");
    expect(r.stderr).not.toContain("Traceback");
  });
});

// =============================================================================
// arbor: no upstream brand leaks into shipped templates
// =============================================================================

describe("arbor: shipped templates carry no upstream Trellis identifiers", () => {
  const templatesRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/templates",
  );

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  }

  it("no template path or content contains 'trellis' (case-insensitive)", () => {
    const offenders: string[] = [];
    for (const file of walk(templatesRoot)) {
      const rel = path.relative(templatesRoot, file);
      if (/trellis/i.test(rel)) {
        offenders.push(`${rel} (path)`);
        continue;
      }
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (/trellis/i.test(line))
          offenders.push(`${rel}:${idx + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
