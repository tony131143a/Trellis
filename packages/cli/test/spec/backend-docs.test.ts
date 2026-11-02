import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const docNames = [
  "commands-dispatch",
  "dispatch",
  "platform-integration",
  "workflow-state-contract",
  "index",
] as const;

function docPath(name: string): string {
  return `.arbor/spec/cli/backend/${name}.md`;
}

function readDoc(name: string): string {
  return fs.readFileSync(path.resolve(repoRoot, docPath(name)), "utf-8");
}

describe("backend driver documentation", () => {
  it("AC-1", () => {
    const forbidden = [
      "dispatch.py",
      "arbor dispatch",
      "inject-delegation-context",
      "codeg-setup",
      "codeg-assistants.json",
      "dispatch-target",
      "prd.md",
    ];
    const violations: string[] = [];
    for (const name of docNames) {
      readDoc(name)
        .split(/\r?\n/)
        .forEach((line, index) => {
          const tokens = forbidden.filter((token) => line.includes(token));
          // Retired names are allowed only in an explicit removal note.
          if (
            tokens.length > 0 &&
            !(/\bremoved\b/i.test(line) && /\b0\.2\.0\b/.test(line))
          ) {
            violations.push(`${docPath(name)}:${index + 1}: ${line}`);
          }
        });
    }
    expect(violations).toEqual([]);
  });

  it("AC-2", () => {
    const doc = readDoc("commands-dispatch");
    const commands = [
      "next",
      "run",
      "gate",
      "decide",
      "canary",
      "override",
      "status",
      "resume",
      "abandon",
      "prompt",
      "bind",
      "collect",
      "finish",
      "conduct",
      "children",
    ];
    const options = ["--task", "--executor", "--as-conductor"];
    const conductOptions = ["--brief", "--collect", "--cancel", "--dry-run"];
    const missing: string[] = [];
    if (!doc.includes("arbor.py")) missing.push("arbor.py entry point");
    for (const command of commands) {
      // Command names must be code tokens, signature words, or table cells.
      // Ordinary prose such as 'run that text' does not document a command.
      const pattern = new RegExp(
        "(?:`|\\|\\s*|arbor\\.py[^\\n]*\\s)" + command + "(?=`|\\s|\\[|$)",
        "m",
      );
      if (!pattern.test(doc)) missing.push(`subcommand ${command}`);
    }
    for (const option of options) {
      if (!new RegExp(`${option}(?![\\w-])`).test(doc)) {
        missing.push(`option ${option}`);
      }
    }
    // Other commands mentioning an option cannot document conduct's surface.
    const conductSignature = /^conduct[ \t]+[^\r\n]*$/m.exec(doc)?.[0] ?? "";
    for (const option of conductOptions) {
      if (!new RegExp(`${option}(?![\\w-])`).test(conductSignature)) {
        missing.push(`conduct option ${option}`);
      }
    }
    // Exit codes must be documented as table cells, not incidental digits.
    for (const code of [0, 1, 2]) {
      if (!new RegExp(`\\|\\s*\u0060?${code}\u0060?\\s*\\|`).test(doc)) {
        missing.push(`exit code ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("AC-3", () => {
    const doc = readDoc("dispatch");
    const blocks = Array.from(
      doc.matchAll(/```[^\n]*\n([\s\S]*?)```/g),
      (match) => match[1],
    );
    const missing: string[] = [];
    for (const [kind, fields] of [
      ["role", ["Active task:", "Role:", "Mode:", "Range:", "Dispatch:"]],
      ["conductor", ["Active task:", "Conductor:", "Executor:", "Run:"]],
    ] as const) {
      if (
        !blocks.some((block) => fields.every((field) => block.includes(field)))
      ) {
        missing.push(`${kind} header: ${fields.join(", ")}`);
      }
    }
    // Keep the context sequence together in one section, allowing prose,
    // arrows, numbered lists, or bullets without pinning exact wording.
    const artifacts = ["jsonl", "contract.md", "design.md", "waves.md"];
    const hasContextOrder = doc.split(/^#{1,6} /m).some((section) => {
      let offset = 0;
      for (const artifact of artifacts) {
        const index = section.indexOf(artifact, offset);
        if (index < 0) return false;
        offset = index + artifact.length;
      }
      return true;
    });
    if (!hasContextOrder)
      missing.push(`context order: ${artifacts.join(" → ")}`);
    for (const retired of ["prd.md", "implement.md"]) {
      if (doc.includes(retired))
        missing.push(`retired context artifact ${retired}`);
    }
    expect(missing).toEqual([]);
  });

  it("AC-4", () => {
    const lines = readDoc("platform-integration").split(/\r?\n/);
    const hookRows = lines.filter((line) => /^\s*\|/.test(line));
    const guardRows = hookRows.filter((line) =>
      line.includes("guard-builtin-agent.py"),
    );
    const violations: string[] = [];
    if (
      hookRows.some((line) => line.includes("inject-delegation-context.py"))
    ) {
      violations.push("retired inject-delegation-context.py hook row");
    }
    if (guardRows.length === 0)
      violations.push("missing guard-builtin-agent.py row");
    for (const row of guardRows) {
      for (const header of ["Role:", "Conductor:"]) {
        if (!row.includes(header))
          violations.push(`guard row missing ${header}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("AC-5", () => {
    const result = spawnSync("python3", [".arbor/scripts/spec.py", "lint"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error, "spec lint must execute successfully").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/spec lint: \d+ docs,/);

    const scope = new Set<string>(docNames.map(docPath));
    const errors = result.stdout.split(/\r?\n/).filter((line) => {
      const finding = /^ERROR\s+\S+\s+(.+?):\d+\s/.exec(line);
      return finding !== null && scope.has(finding[1]);
    });
    const violations = [...errors];
    for (const name of docNames) {
      const doc = readDoc(name);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(doc);
      if (!frontmatter) {
        violations.push(`${docPath(name)}: missing frontmatter`);
        continue;
      }
      const block = frontmatter[1];
      if (!/^last_verified: \d{4}-\d{2}-\d{2}\r?$/m.test(block)) {
        violations.push(`${docPath(name)}: missing last_verified date`);
      }
      const sources = /^sources:\s*\r?\n((?:[ \t]+-[^\n]*(?:\n|$))*)/m.exec(
        block,
      );
      if (!sources || sources[1].trim() === "") {
        violations.push(`${docPath(name)}: missing sources list`);
        continue;
      }
      for (const item of sources[1].matchAll(/^[ \t]+-\s+(.+?)\s*$/gm)) {
        const source = item[1].replace(/^(["'])(.*)\1$/, "$2");
        if (!fs.existsSync(path.resolve(repoRoot, source))) {
          violations.push(`${docPath(name)}: source does not exist: ${source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
