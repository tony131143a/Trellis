/**
 * Integration tests for the v2 contract layer.
 *
 * Templates under test (copied into a tmp repo and run through `python3`):
 *   - `common/contract.py` — `parse_contract`, `validate_contract`,
 *     `path_matches`, `find_contract`, the contract.md template
 *   - `common/tasks.py` — tier inference by contract.md / design.md / waves.md
 *   - `common/dispatch_context.py` — `Range:` / `Dispatch:` header lines,
 *     `git diff <range>` inlining and contract-first artifact inlining
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/arbor/scripts",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PRELUDE = `
import json, sys
sys.path.insert(0, ".arbor/scripts")
from pathlib import Path
`;

const VALID_CONTRACT = `# Add widget

## Goal

Widgets render.

## Scope

- in: the widget module
- out: the legacy renderer

## Acceptance criteria

- AC-1: Given a widget When rendered Then it shows its name
- AC-2: Given a broken widget When rendered Then it reports an error

## Verification map

| id   | kind   | check                                        | file |
|------|--------|----------------------------------------------|------|
| AC-1 | auto   | \`pnpm vitest run test/widget.test.ts -t AC-1\` | test/widget.test.ts |
| AC-2 | manual | open the page and look                       |      |

## Interface pins

- \`export function render(w: Widget): string\` — src/widget.ts

## Test paths

- test/**

## Partitions

- impl: src/**
- tests: test/**

## Waves

- 1: [tests]
- 2: [impl]
`;

describe.skipIf(!hasPython())("v2 contract", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-v2-contract-")),
    );
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".arbor", "scripts"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function py(code: string, ...args: string[]): unknown {
    const r = spawnSync("python3", ["-c", PRELUDE + code, ...args], {
      cwd: tmp,
      encoding: "utf-8",
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  /** validate_contract errors for a contract text, default test paths ["test/**"]. */
  function validate(text: string): string[] {
    fs.writeFileSync(path.join(tmp, "c.md"), text);
    return py(`
from common.contract import load_contract, validate_contract
print(json.dumps(validate_contract(load_contract(Path("c.md")), Path("."), ["test/**"])))
`) as string[];
  }

  /** VALID_CONTRACT with one section body replaced. */
  function withSection(name: string, body: string): string {
    const re = new RegExp(`(## ${name}\\n\\n)[\\s\\S]*?(?=\\n## |$)`);
    expect(VALID_CONTRACT).toMatch(re);
    return VALID_CONTRACT.replace(re, `$1${body}\n`);
  }

  describe("parse_contract", () => {
    it("round-trips the contract.md template and validates it once the placeholders are filled", () => {
      const out = py(`
from common.contract import default_contract_content, parse_contract, validate_contract
text = default_contract_content("  My task ", "Ship the thing.")
c = parse_contract(text, Path("contract.md"))
filled = parse_contract(
    text.replace("<test file path>", "test/a.test.ts"), Path("contract.md")
)
print(json.dumps({
    "title_line": text.splitlines()[0],
    "goal": c.goal,
    "scope_in": c.scope_in,
    "scope_out": c.scope_out,
    "criteria": [[x.id, x.text] for x in c.criteria],
    "map": [[e.id, e.kind, e.check, e.file] for e in c.verification_map],
    "pins": c.interface_pins,
    "test_paths": c.test_paths,
    "partitions": [[p.name, p.paths] for p in c.partitions],
    "waves": c.waves,
    "template_errors": validate_contract(c, Path("."), ["test/**"]),
    "filled_errors": validate_contract(filled, Path("."), ["test/**"]),
}))
`);
      expect(out).toEqual({
        title_line: "# My task",
        goal: "Ship the thing.",
        scope_in: ["<what this task changes>"],
        scope_out: ["<what it deliberately leaves alone>"],
        criteria: [
          [
            "AC-1",
            "Given <precondition> When <action> Then <observable result>",
          ],
        ],
        map: [
          [
            "AC-1",
            "auto",
            "<command that fails before, passes after>",
            "<test file path>",
          ],
        ],
        pins: ["existing interfaces"],
        test_paths: [],
        partitions: [["default", ["**"]]],
        waves: [["default"]],
        template_errors: [
          "Verification map: AC-1 file <test file path> does not exist and is outside the test paths (test/**)",
        ],
        filled_errors: [],
      });
    });

    it("parses every section, strips code spans, keeps escaped pipes, ignores HTML comments", () => {
      const text = `# T

## Waves
- impl, tests

## acceptance criteria
- AC-1: Given a
  When b Then c

<!-- - AC-9: commented out -->

## Verification map
| ID | Kind | Check | File |
|:---|------|-------|-----:|
| AC-1 | Auto | \`grep x \\| wc -l\` | \`test/a.test.ts\` |

## Partitions
- impl: src/**, docs/**
- tests: \`test/**\`

## Scope
- free text
- OUT: nope
`;
      fs.writeFileSync(path.join(tmp, "c.md"), text);
      const out = py(`
from common.contract import load_contract
c = load_contract(Path("c.md"))
print(json.dumps({
    "goal": c.goal,
    "scope": [c.scope_in, c.scope_out],
    "criteria": [[x.id, x.text] for x in c.criteria],
    "map": [[e.id, e.kind, e.check, e.file] for e in c.verification_map],
    "partitions": [[p.name, p.paths] for p in c.partitions],
    "waves": c.waves,
    "auto": [e.id for e in c.auto_checks()],
}))
`);
      expect(out).toEqual({
        goal: "",
        scope: [["free text"], ["nope"]],
        criteria: [["AC-1", "Given a When b Then c"]],
        map: [["AC-1", "auto", "grep x | wc -l", "test/a.test.ts"]],
        partitions: [
          ["impl", ["src/**", "docs/**"]],
          ["tests", ["test/**"]],
        ],
        waves: [["impl", "tests"]],
        auto: ["AC-1"],
      });
    });

    it("parses a legacy prd.md to an empty contract with default partition and wave", () => {
      const task = path.join(tmp, "task");
      fs.mkdirSync(task);
      fs.writeFileSync(
        path.join(task, "prd.md"),
        "# Old task\n\nLegacy description\nsecond line\n\nMore.\n\n## Requirements\n\n- do it\n",
      );
      const out = py(
        `
from common.contract import find_contract, load_contract
task = Path(sys.argv[1])
legacy = find_contract(task)
c = load_contract(legacy)
(task / "contract.md").write_text("## Goal\\n\\nNew.\\n")
print(json.dumps({
    "legacy": legacy.name,
    "goal": c.goal,
    "empty": [c.criteria, c.verification_map, c.interface_pins, c.test_paths],
    "partitions": [[p.name, p.paths] for p in c.partitions],
    "waves": c.waves,
    "preferred": find_contract(task).name,
    "none": find_contract(Path(sys.argv[2])),
}))
`,
        task,
        tmp,
      );
      expect(out).toEqual({
        legacy: "prd.md",
        goal: "Legacy description\nsecond line",
        empty: [[], [], [], []],
        partitions: [["default", ["**"]]],
        waves: [["default"]],
        preferred: "contract.md",
        none: null,
      });
    });

    it("raises ContractError for unreadable sections", () => {
      const cases = {
        kind: withSection(
          "Verification map",
          "| id | kind | check | file |\n|---|---|---|---|\n| AC-1 | maybe | x | |",
        ),
        columns: withSection(
          "Verification map",
          "| id | check |\n|---|---|\n| AC-1 | x |",
        ),
        separator: withSection(
          "Verification map",
          "| id | kind | check | file |\n| AC-1 | auto | x | |",
        ),
        cells: withSection(
          "Verification map",
          "| id | kind | check | file |\n|---|---|---|---|\n| AC-1 | auto |",
        ),
        criterion: withSection("Acceptance criteria", "- just prose"),
        partition: withSection("Partitions", "- impl:"),
        wave: withSection("Waves", "- 1: []"),
      };
      fs.writeFileSync(path.join(tmp, "cases.json"), JSON.stringify(cases));
      const out = py(`
from common.contract import ContractError, parse_contract
result = {}
for name, text in json.loads(Path("cases.json").read_text()).items():
    try:
        parse_contract(text, Path("c.md"))
        result[name] = None
    except ContractError as exc:
        result[name] = str(exc)
print(json.dumps(result))
`) as Record<string, string | null>;
      expect(out.kind).toContain("AC-1 has kind 'maybe'");
      expect(out.columns).toContain("lacks column(s) kind");
      expect(out.separator).toContain("separator");
      expect(out.cells).toContain("row has 2 cells, header has 4");
      expect(out.criterion).toContain(
        "Acceptance criteria: expected '- <name>: …'",
      );
      expect(out.partition).toContain("Partitions: impl lists no paths");
      expect(out.wave).toContain("Waves: wave names no partition");
    });
  });

  describe("validate_contract", () => {
    it("accepts a complete contract", () => {
      expect(validate(VALID_CONTRACT)).toEqual([]);
    });

    it.each([
      [
        "no criteria",
        withSection("Acceptance criteria", "").replace(/\| AC-[12] .*\n/g, ""),
        [
          "Acceptance criteria: none (add at least one '- AC-1: Given … When … Then …')",
        ],
      ],
      [
        "bad criterion id",
        VALID_CONTRACT.replace("- AC-2:", "- ac2:").replace(
          "| AC-2 |",
          "| ac2 |",
        ),
        ["Acceptance criteria: id 'ac2' does not match AC-<number>"],
      ],
      [
        "duplicate criterion id",
        VALID_CONTRACT.replace("- AC-2:", "- AC-1:").replace(
          "| AC-2 |",
          "| AC-1 |",
        ),
        ["Acceptance criteria: duplicate id AC-1"],
      ],
      [
        "criterion without map entry",
        VALID_CONTRACT.replace(/\| AC-2 .*\n/, ""),
        ["Verification map: AC-2 has no entry"],
      ],
      [
        "map entry without criterion",
        VALID_CONTRACT.replace(
          "| AC-2 | manual",
          "| AC-2 | manual | x | |\n| AC-7 | manual",
        ),
        ["Verification map: entry AC-7 names no acceptance criterion"],
      ],
      [
        "auto entry with empty check",
        VALID_CONTRACT.replace(
          "| `pnpm vitest run test/widget.test.ts -t AC-1` |",
          "|  |",
        ),
        ["Verification map: AC-1 is auto but its check is empty"],
      ],
      [
        "auto entry file outside test paths and missing",
        VALID_CONTRACT.replace("| test/widget.test.ts |", "| src/nope.ts |"),
        [
          "Verification map: AC-1 file src/nope.ts does not exist and is outside the test paths (test/**)",
        ],
      ],
      [
        "empty interface pins",
        withSection("Interface pins", ""),
        [
          "Interface pins: empty (list the signatures tests will call, or the single line '- existing interfaces')",
        ],
      ],
      [
        "existing-interfaces line mixed with pins",
        withSection("Interface pins", "- Existing Interfaces\n- `foo()`"),
        [
          "Interface pins: 'existing interfaces' must be the only pin when present",
        ],
      ],
      [
        "duplicate partition name",
        withSection(
          "Partitions",
          "- impl: src/**\n- impl: lib/**\n- tests: test/**",
        ),
        ["Partitions: duplicate name impl"],
      ],
      [
        "overlapping partitions",
        withSection(
          "Partitions",
          "- impl: src/**\n- tests: test/**, src/widget/*.ts",
        ),
        ["Partitions: impl (src/**) overlaps tests (src/widget/*.ts)"],
      ],
      [
        "wave names an unknown partition",
        withSection("Waves", "- 1: [tests, docs]\n- 2: [impl]"),
        ["Waves: wave 1 names unknown partition 'docs'"],
      ],
      [
        "partition in no wave",
        withSection("Waves", "- 1: [tests]"),
        ["Waves: partition impl is in no wave"],
      ],
      [
        "partition in two waves",
        withSection("Waves", "- 1: [tests, impl]\n- 2: [impl]"),
        ["Waves: partition impl is listed 2 times (once expected)"],
      ],
    ])("%s", (_name, text, expected) => {
      expect(validate(text)).toEqual(expected);
    });

    it("accepts an auto file that exists outside the test paths, and the single existing-interfaces pin", () => {
      fs.mkdirSync(path.join(tmp, "scripts"));
      fs.writeFileSync(path.join(tmp, "scripts", "check.sh"), "#!/bin/sh\n");
      const text = withSection(
        "Interface pins",
        "- existing interfaces",
      ).replace("| test/widget.test.ts |", "| scripts/check.sh |");
      expect(validate(text)).toEqual([]);
    });

    it("uses the config defaults when the contract has no Test paths", () => {
      const text = withSection("Test paths", "<!-- none -->").replace(
        "| test/widget.test.ts |",
        "| spec/widget.spec.ts |",
      );
      expect(validate(text)).toEqual([
        "Verification map: AC-1 file spec/widget.spec.ts does not exist and is outside the test paths (test/**)",
      ]);
    });
  });

  it("path_matches: ** spans directories, * and ? stay in one segment", () => {
    const cases: [string, string[], boolean][] = [
      ["packages/cli/test/a/b.test.ts", ["packages/*/test/**"], true],
      ["packages/cli/test", ["packages/*/test/**"], true],
      ["packages/cli/src/test/x.ts", ["packages/*/test/**"], false],
      ["a.test.ts", ["**/*.test.ts"], true],
      ["x/y/a.test.ts", ["**/*.test.ts"], true],
      ["x/y/a.ts", ["**/*.test.ts"], false],
      ["src/a/b.ts", ["src/*"], false],
      ["src/a.ts", ["src/*"], true],
      ["src/a/b/c.ts", ["src/**/c.ts"], true],
      ["src/c.ts", ["src/**/c.ts"], true],
      ["./docs/x.md", ["docs/"], true],
      ["a1.ts", ["a?.ts"], true],
      ["a/1.ts", ["a?.ts"], false],
      ["a+b.ts", ["a+b.ts"], true],
      ["anything/at/all", ["**"], true],
      ["src/x.ts", [], false],
      ["src/x.ts", ["lib/**", "src/**"], true],
    ];
    fs.writeFileSync(path.join(tmp, "cases.json"), JSON.stringify(cases));
    const out = py(`
from common.contract import path_matches
cases = json.loads(Path("cases.json").read_text())
print(json.dumps([path_matches(rel, patterns) for rel, patterns, _ in cases]))
`);
    expect(out).toEqual(cases.map(([, , expected]) => expected));
  });

  it("tier inference and missing artifacts use contract.md / design.md / waves.md, with legacy names", () => {
    const names = [
      "empty",
      "contract",
      "prd",
      "design",
      "waves",
      "legacy-full",
    ];
    const files: Record<string, string[]> = {
      empty: [],
      contract: ["contract.md"],
      prd: ["prd.md"],
      design: ["contract.md", "design.md"],
      waves: ["contract.md", "design.md", "waves.md"],
      "legacy-full": ["prd.md", "design.md", "implement.md"],
    };
    for (const name of names) {
      fs.mkdirSync(path.join(tmp, name));
      for (const file of files[name])
        fs.writeFileSync(path.join(tmp, name, file), "x\n");
    }
    const out = py(
      `
from common.tasks import infer_tier, missing_tier_artifacts
print(json.dumps({
    name: [infer_tier(Path(name)), missing_tier_artifacts(Path(name), "full")]
    for name in sys.argv[1:]
}))
`,
      ...names,
    );
    expect(out).toEqual({
      empty: ["light", ["contract.md", "design.md", "waves.md"]],
      contract: ["light", ["design.md", "waves.md"]],
      prd: ["light", ["design.md", "waves.md"]],
      design: ["standard", ["waves.md"]],
      waves: ["full", []],
      "legacy-full": ["full", []],
    });
  });

  describe("dispatch_context", () => {
    it("parses Range: and Dispatch:; a retired Diff: line ends the header", () => {
      const out = py(`
from common.dispatch_context import DispatchHeader, parse_dispatch_header
h = parse_dispatch_header(
    "\\nActive task: /w/.arbor/tasks/t\\nrole: Implement now\\nRANGE: abc..HEAD\\n"
    "Dispatch: d-007\\nRange: ignored..x\\nDiff: /x.diff\\n\\nDo it."
)
plain = parse_dispatch_header("Role: review\\n\\nGo.")
print(json.dumps({
    "role": h.role, "range": h.range, "dispatch": h.dispatch, "body": h.body,
    "plain": [plain.range, plain.dispatch],
    "fields": sorted(DispatchHeader.__dataclass_fields__),
}))
`);
      expect(out).toEqual({
        role: "implement",
        range: "abc..HEAD",
        dispatch: "d-007",
        body: "Diff: /x.diff\n\nDo it.",
        plain: [null, null],
        fields: ["body", "dispatch", "mode", "range", "role", "task_dir"],
      });
    });

    describe("build_dispatch_prompt", () => {
      const TASK = "10-30-widget";
      let worktree: string;
      let taskDir: string;

      function git(...args: string[]): string {
        return execFileSync(
          "git",
          [
            "-C",
            worktree,
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          { encoding: "utf-8" },
        ).trim();
      }

      beforeEach(() => {
        // The task worktree: a checkout with its own .arbor/tasks/<task>,
        // distinct from the repo root the prompt is assembled for.
        worktree = path.join(tmp, "wt");
        taskDir = path.join(worktree, ".arbor", "tasks", TASK);
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(
          path.join(taskDir, "prd.md"),
          "LEGACY CONTRACT BODY\n",
        );
        fs.writeFileSync(
          path.join(taskDir, "implement.md"),
          "LEGACY WAVES BODY\n",
        );
        fs.writeFileSync(path.join(worktree, "a.txt"), "one\n");
        git("init", "-q");
        git("add", ".");
        git("commit", "-qm", "base");
        fs.appendFileSync(path.join(worktree, "a.txt"), "RANGE ADDED LINE\n");
        fs.mkdirSync(path.join(taskDir, "briefs"));
        fs.writeFileSync(
          path.join(taskDir, "briefs", "d-001.md"),
          "BRIEF NOT IN DIFF\n",
        );
        git("add", ".");
        git(
          "commit",
          "-qm",
          "implement(10-30-widget): add line\n\nArbor-Dispatch: d-001",
        );
      });

      function build(
        text: string,
        role: string,
      ): { ok: boolean; text?: string; error?: string } {
        fs.writeFileSync(path.join(tmp, "dispatch.txt"), text);
        return py(
          `
from common.dispatch_context import DispatchRequest, build_dispatch_prompt, parse_dispatch_header
text = Path("dispatch.txt").read_text()
header = parse_dispatch_header(text)
try:
    prompt = build_dispatch_prompt(
        DispatchRequest(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]), header, text)
    )
    print(json.dumps({"ok": True, "text": prompt.text}))
except ValueError as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`,
          worktree,
          role,
          taskDir,
        ) as { ok: boolean; text?: string; error?: string };
      }

      it("inlines git diff <range> from the task worktree, without .arbor/, and re-emits Range/Dispatch", () => {
        const out = build(
          `Active task: ${taskDir}\nRole: review\nRange: HEAD~1..HEAD\nDispatch: d-002\n\nReview it.`,
          "review",
        );
        expect(out.ok, out.error).toBe(true);
        const text = out.text ?? "";
        expect(
          text.startsWith(
            `Active task: ${taskDir}\nRole: review\nMode: self-check\nRange: HEAD~1..HEAD\nDispatch: d-002\n\n`,
          ),
        ).toBe(true);
        expect(text).toContain("=== git diff HEAD~1..HEAD ===\n```diff\n");
        expect(text).toContain("+RANGE ADDED LINE");
        expect(text).not.toContain("BRIEF NOT IN DIFF");
        expect(text).toContain("## Your Task\n\nReview it.");
      });

      it("labels a legacy prd.md as contract.md and implement.md as waves.md", () => {
        const out = build(
          `Active task: ${taskDir}\nRole: test\nDispatch: d-003\n\nWrite tests.`,
          "test",
        );
        expect(out.ok, out.error).toBe(true);
        const rel = `.arbor/tasks/${TASK}`;
        expect(out.text).toContain(
          `=== ${rel}/contract.md (Contract) ===\nLEGACY CONTRACT BODY`,
        );
        expect(out.text).toContain(
          `=== ${rel}/waves.md (Waves) ===\nLEGACY WAVES BODY`,
        );
        expect(out.text).not.toContain("prd.md (");
      });

      it("prefers contract.md and waves.md over the legacy files", () => {
        fs.writeFileSync(
          path.join(taskDir, "contract.md"),
          "NEW CONTRACT BODY\n",
        );
        fs.writeFileSync(path.join(taskDir, "waves.md"), "NEW WAVES BODY\n");
        const out = build(
          `Active task: ${taskDir}\nRole: implement\n\nGo.`,
          "implement",
        );
        expect(out.ok, out.error).toBe(true);
        expect(out.text).toContain("NEW CONTRACT BODY");
        expect(out.text).toContain("NEW WAVES BODY");
        expect(out.text).not.toContain("LEGACY CONTRACT BODY");
        expect(out.text).not.toContain("LEGACY WAVES BODY");
      });

      it("reports a failing git diff in the prompt instead of inlining", () => {
        const out = build(
          `Active task: ${taskDir}\nRole: fix\nRange: nosuch..HEAD\n\nFix.`,
          "fix",
        );
        expect(out.ok, out.error).toBe(true);
        expect(out.text).toContain(
          "[Arbor: diff not inlined — `git diff nosuch..HEAD` failed in",
        );
      });

      it("rejects Range: for explore/architect and a range that is not <base>..<head>", () => {
        expect(
          build(
            `Active task: ${taskDir}\nRole: architect\nRange: a..b\n\nX.`,
            "architect",
          ).error,
        ).toBe("Range: does not apply to role 'architect'");
        expect(
          build(
            `Active task: ${taskDir}\nRole: review\nRange: --output=/tmp/x\n\nX.`,
            "review",
          ).error,
        ).toBe("Range: expected <base>..<head>, got '--output=/tmp/x'");
      });
    });
  });
});
