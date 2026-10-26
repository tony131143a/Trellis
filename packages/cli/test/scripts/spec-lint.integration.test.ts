/**
 * Integration tests for `spec.py lint | verify | init-meta`.
 *
 * The scripts live under `src/templates/arbor/scripts/`; this test stamps
 * them into a fixture repo with a hand-built `.arbor/spec` tree and runs
 * the real `python3 spec.py ...` entry point. One fixture doc per rule
 * (L1–L7), each expected to be reported exactly once with `path:line`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/arbor/scripts",
);

// Committer date stamped on every fixture commit; `stale` compares against it.
const SOURCE_COMMIT_DATE = "2026-10-18";
const FRESH = "2026-10-20";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${SOURCE_COMMIT_DATE}T12:00:00Z`,
      GIT_COMMITTER_DATE: `${SOURCE_COMMIT_DATE}T12:00:00Z`,
    },
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (rc=${r.status}): ${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

function write(repo: string, rel: string, lines: string[]): void {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

function read(repo: string, rel: string): string {
  return fs.readFileSync(path.join(repo, rel), "utf-8");
}

function meta(sources: string[], lastVerified: string | null): string[] {
  const out = ["---"];
  if (sources.length === 0) out.push("sources: []");
  else out.push("sources:", ...sources.map((s) => `  - ${s}`));
  if (lastVerified) out.push(`last_verified: ${lastVerified}`);
  out.push("---");
  return out;
}

function setupRepo(tmp: string): void {
  git(tmp, "init", "-q", "-b", "main");
  git(tmp, "config", "user.email", "test@example.com");
  git(tmp, "config", "user.name", "Test");
  const scriptsDest = path.join(tmp, ".arbor", "scripts");
  fs.mkdirSync(scriptsDest, { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, scriptsDest, { recursive: true });
  fs.writeFileSync(path.join(tmp, ".arbor", "config.yaml"), "");
}

/** Build the one-finding-per-rule fixture. Returns expected `rule path:line`. */
function writeFixture(tmp: string): string[] {
  write(tmp, "src/a.ts", ["export const a = 1;"]);
  write(tmp, "src/b.ts", ["export const b = 2;"]);

  // Layer index: links every leaf except unlisted.md; has both sections;
  // one row's Status is "To fill" (line 7).
  write(tmp, ".arbor/spec/backend/index.md", [
    "# Backend", //                                   1
    "", //                                            2
    "| Guide | Description | Status |", //            3
    "|-------|-------------|--------|", //            4
    "| [Good](./good.md) | ok | Done |", //           5
    "| [Dead](./dead.md) | ok | Done |", //           6
    "| [Stale](./stale.md) | ok | To fill |", //      7
    "| [Linky](./linky.md) | ok | Done |", //         8
    "| [Placeholder](./placeholder.md) | ok | Done |",
    "| [No meta](./nometa.md) | ok | Done |",
    "",
    "## Pre-Development Checklist",
    "",
    "- Anything → [good.md](./good.md)",
    "",
    "## Quality Check",
    "",
    "1. Run lint",
  ]);

  write(tmp, ".arbor/spec/backend/good.md", [
    ...meta(["src/a.ts"], FRESH),
    "# Good",
    "",
    "See [index](./index.md) and [a section](./good.md#good).",
    "A `[code link](./ignored.md)` inside a code span is not checked.",
    "",
    "```md",
    "[fenced](./also-ignored.md) To fill",
    "```",
    "",
    "External [site](https://example.com/x.md) and [anchor](#good) are skipped.",
  ]);

  // L2: sources entry on line 3 matches nothing.
  write(tmp, ".arbor/spec/backend/dead.md", [
    ...meta(["src/gone.ts"], FRESH),
    "# Dead",
  ]);

  // L4: sources committed 2026-10-18, doc verified before that (line 4).
  write(tmp, ".arbor/spec/backend/stale.md", [
    ...meta(["src/*.ts"], "2026-09-01"),
    "# Stale",
  ]);

  // L3: broken relative link on line 7.
  write(tmp, ".arbor/spec/backend/linky.md", [
    ...meta(["src/a.ts"], FRESH), //                 1-5
    "# Linky", //                                     6
    "Read [missing](./nope.md#x) first.", //          7
  ]);

  // L5: placeholder phrase on line 7.
  write(tmp, ".arbor/spec/backend/placeholder.md", [
    ...meta(["src/a.ts"], FRESH), //                 1-5
    "# Placeholder", //                               6
    "(To be filled by the team)", //                  7
  ]);

  // L7: valid metadata, not linked from index.md.
  write(tmp, ".arbor/spec/backend/unlisted.md", [
    ...meta(["src/b.ts"], FRESH),
    "# Unlisted",
  ]);

  // L1: no frontmatter at all.
  write(tmp, ".arbor/spec/backend/nometa.md", ["# No meta", "", "body"]);

  // L6: layer index without either section.
  write(tmp, ".arbor/spec/frontend/index.md", [
    "# Frontend",
    "",
    "Nothing here yet.",
  ]);

  // Guides are optional: no metadata, cross-dir link resolves, no findings.
  write(tmp, ".arbor/spec/guides/index.md", ["# Guides", "- [g](./g.md)"]);
  write(tmp, ".arbor/spec/guides/g.md", [
    "# Guide",
    "Pointer: [good](../backend/good.md)",
  ]);

  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", "fixture");

  return [
    "broken-link .arbor/spec/backend/linky.md:7",
    "dead-source .arbor/spec/backend/dead.md:3",
    "missing-metadata .arbor/spec/backend/nometa.md:1",
    "missing-section .arbor/spec/frontend/index.md:0",
    "missing-section .arbor/spec/frontend/index.md:0",
    "placeholder .arbor/spec/backend/index.md:7",
    "placeholder .arbor/spec/backend/placeholder.md:7",
    "stale .arbor/spec/backend/stale.md:4",
    "unlisted-doc .arbor/spec/backend/unlisted.md:0",
  ];
}

function writeCleanFixture(tmp: string): void {
  write(tmp, "src/a.ts", ["export const a = 1;"]);
  write(tmp, ".arbor/spec/backend/index.md", [
    "# Backend",
    "| Guide | Description | Status |",
    "|-------|-------------|--------|",
    "| [Good](./good.md) | ok | Done |",
    "## Pre-Development Checklist",
    "## Quality Check",
  ]);
  write(tmp, ".arbor/spec/backend/good.md", [
    ...meta(["src/a.ts"], FRESH),
    "# Good",
  ]);
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", "clean fixture");
}

function runSpec(repo: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync("python3", [".arbor/scripts/spec.py", ...args], {
    cwd: repo,
    encoding: "utf-8",
  });
}

interface JsonFinding {
  rule: string;
  severity: string;
  path: string;
  line: number;
  message: string;
  detail: Record<string, unknown>;
}

interface JsonReport {
  docs: number;
  findings: JsonFinding[];
  summary: { errors: number; warnings: number; info: number };
  provenance?: Record<
    string,
    { task: string; completedAt: string | null; source: string }[]
  >;
}

/** spec.py stamps `date.today()` (local date); match it instead of UTC. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe.skipIf(!hasPython())("spec.py lint", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-spec-lint-"));
    setupRepo(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("AC1: reports each rule L1-L7 exactly once with path:line (text)", () => {
    const expected = writeFixture(tmp);
    const r = runSpec(tmp, "lint");
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");

    const lines = r.stdout.trimEnd().split("\n");
    const summary = lines.pop();
    expect(summary).toBe("spec lint: 11 docs, 2 errors, 5 warnings, 2 info");

    const got = lines
      .map((l: string) => {
        const m = /^(ERROR|WARN|INFO)\s+(\S+)\s+(\S+?):(\d+)\s{2}\S/.exec(l);
        expect(m, `unparseable finding line: ${l}`).not.toBeNull();
        return `${(m as RegExpExecArray)[2]} ${(m as RegExpExecArray)[3]}:${(m as RegExpExecArray)[4]}`;
      })
      .sort();
    expect(got).toEqual(expected);

    // Severity ordering: every ERROR precedes every WARN precedes every INFO.
    const sevs = lines.map((l: string) => l.split(/\s+/)[0]);
    const rank = { ERROR: 0, WARN: 1, INFO: 2 } as Record<string, number>;
    for (let i = 1; i < sevs.length; i++) {
      expect(rank[sevs[i]]).toBeGreaterThanOrEqual(rank[sevs[i - 1]]);
    }

    // Messages carry the remediation named in design.md §3.
    expect(r.stdout).toContain("src/gone.ts matches no file");
    expect(r.stdout).toContain(
      `sources changed ${SOURCE_COMMIT_DATE} after last_verified 2026-09-01 (src/a.ts)`,
    );
    expect(r.stdout).toContain(
      "run spec.py init-meta .arbor/spec/backend/nometa.md",
    );
    expect(r.stdout).toContain("link target ./nope.md#x does not exist");
  });

  it("AC1: --json carries the same findings, summary, and detail", () => {
    const expected = writeFixture(tmp);
    const r = runSpec(tmp, "lint", "--json");
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as JsonReport;

    expect(report.docs).toBe(11);
    expect(report.summary).toEqual({ errors: 2, warnings: 5, info: 2 });
    expect(report.provenance).toBeUndefined();
    expect(
      report.findings.map((f) => `${f.rule} ${f.path}:${f.line}`).sort(),
    ).toEqual(expected);

    const dead = report.findings.find((f) => f.rule === "dead-source");
    expect(dead?.severity).toBe("error");
    expect(dead?.detail).toEqual({ source: "src/gone.ts" });
    const stale = report.findings.find((f) => f.rule === "stale");
    expect(stale?.severity).toBe("warn");
    expect(stale?.detail).toEqual({
      changed: SOURCE_COMMIT_DATE,
      last_verified: "2026-09-01",
      source: "src/a.ts",
    });
    const sections = report.findings
      .filter((f) => f.rule === "missing-section")
      .map((f) => f.detail.section)
      .sort();
    expect(sections).toEqual(["Pre-Development Checklist", "Quality Check"]);
  });

  it("AC1: exit 0 by default, 1 with --strict when errors exist", () => {
    writeFixture(tmp);
    expect(runSpec(tmp, "lint").status).toBe(0);
    expect(runSpec(tmp, "lint", "--strict").status).toBe(1);
    expect(runSpec(tmp, "lint", "--strict", "--json").status).toBe(1);
  });

  it("AC2: a clean tree prints exactly one summary line", () => {
    writeCleanFixture(tmp);
    const r = runSpec(tmp, "lint", "--strict");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("spec lint: 2 docs, 0 findings\n");
  });

  it("--strict passes when only warnings/info remain", () => {
    writeFixture(tmp);
    // Repair the two errors; warnings and info stay.
    write(tmp, ".arbor/spec/backend/dead.md", [
      ...meta(["src/a.ts"], FRESH),
      "# Dead",
    ]);
    write(tmp, ".arbor/spec/backend/linky.md", [
      ...meta(["src/a.ts"], FRESH),
      "# Linky",
    ]);
    const r = runSpec(tmp, "lint", "--strict");
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe(
      "spec lint: 11 docs, 0 errors, 5 warnings, 2 info",
    );
  });

  it("PATH filters to the given file or directory; --package to spec/<pkg>", () => {
    writeFixture(tmp);
    const one = runSpec(tmp, "lint", "--json", ".arbor/spec/backend/dead.md");
    const oneReport = JSON.parse(one.stdout) as JsonReport;
    expect(oneReport.docs).toBe(1);
    expect(oneReport.findings.map((f) => f.rule)).toEqual(["dead-source"]);

    const dir = runSpec(tmp, "lint", "--json", ".arbor/spec/frontend");
    const dirReport = JSON.parse(dir.stdout) as JsonReport;
    expect(dirReport.docs).toBe(1);
    expect(dirReport.findings.map((f) => f.rule)).toEqual([
      "missing-section",
      "missing-section",
    ]);

    // Monorepo: --package scopes to spec/<pkg>/ and <pkg>/<layer>/ is a layer.
    fs.writeFileSync(
      path.join(tmp, ".arbor", "config.yaml"),
      "packages:\n  api:\n    path: packages/api\n",
    );
    write(tmp, ".arbor/spec/api/backend/index.md", [
      "# API",
      "## Pre-Development Checklist",
      "## Quality Check",
    ]);
    write(tmp, ".arbor/spec/api/backend/orphan.md", ["# Orphan"]);
    const pkg = runSpec(tmp, "lint", "--json", "--package", "api");
    const pkgReport = JSON.parse(pkg.stdout) as JsonReport;
    expect(pkgReport.docs).toBe(2);
    expect(
      pkgReport.findings.map((f) => `${f.rule} ${f.path}:${f.line}`).sort(),
    ).toEqual([
      "missing-metadata .arbor/spec/api/backend/orphan.md:1",
      "unlisted-doc .arbor/spec/api/backend/orphan.md:0",
    ]);
  });

  it("exit 2 on usage/IO failure: no spec dir, path outside spec, bad --date", () => {
    expect(runSpec(tmp, "lint").status).toBe(2);
    writeCleanFixture(tmp);
    const outside = runSpec(tmp, "lint", "src/a.ts");
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain("not under .arbor/spec");
    const badDate = runSpec(
      tmp,
      "verify",
      ".arbor/spec/backend/good.md",
      "--date",
      "2026-13-40",
    );
    expect(badDate.status).toBe(2);
    expect(badDate.stderr).toContain("--date");
  });

  it("stale falls back to file mtime when git is not available", () => {
    writeFixture(tmp);
    fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    const future = new Date("2027-03-04T12:00:00Z");
    fs.utimesSync(path.join(tmp, "src", "a.ts"), future, future);
    fs.utimesSync(path.join(tmp, "src", "b.ts"), future, future);
    const r = runSpec(tmp, "lint", "--json");
    const report = JSON.parse(r.stdout) as JsonReport;
    const stale = report.findings.filter((f) => f.rule === "stale");
    // good/linky/placeholder (src/a.ts), unlisted (src/b.ts), stale (src/*.ts)
    // are all older than the bumped mtime now.
    expect(stale.map((f) => f.path).sort()).toEqual([
      ".arbor/spec/backend/good.md",
      ".arbor/spec/backend/linky.md",
      ".arbor/spec/backend/placeholder.md",
      ".arbor/spec/backend/stale.md",
      ".arbor/spec/backend/unlisted.md",
    ]);
    expect(stale[0].detail.changed).toBe("2027-03-04");
  });

  it("invalid frontmatter is an error naming the line, not a silent skip", () => {
    writeCleanFixture(tmp);
    write(tmp, ".arbor/spec/backend/good.md", [
      "---",
      "sources: [src/a.ts]",
      "last_verified: yesterday",
      "nested:",
      "  deeper: 1",
      "---",
      "# Good",
    ]);
    const r = runSpec(tmp, "lint", "--json");
    const report = JSON.parse(r.stdout) as JsonReport;
    expect(report.findings.map((f) => `${f.rule}:${f.line}`).sort()).toEqual([
      "invalid-metadata:3",
      "invalid-metadata:5",
    ]);
    expect(runSpec(tmp, "lint", "--strict").status).toBe(1);
  });

  it("invalid-source rejects absolute paths and `..` segments", () => {
    writeCleanFixture(tmp);
    write(tmp, ".arbor/spec/backend/good.md", [
      ...meta(["/etc/passwd", "../outside.ts", "src/a.ts"], FRESH),
      "# Good",
    ]);
    const r = runSpec(tmp, "lint", "--json");
    const report = JSON.parse(r.stdout) as JsonReport;
    expect(report.findings.map((f) => `${f.rule}:${f.line}`).sort()).toEqual([
      "invalid-source:3",
      "invalid-source:4",
    ]);
  });

  it("--provenance reads spec_changes from archived task.json (R6)", () => {
    writeCleanFixture(tmp);
    write(tmp, ".arbor/tasks/archive/2026-10/10-01-older/task.json", [
      JSON.stringify({
        completedAt: "2026-10-02",
        spec_changes: [".arbor/spec/backend/good.md"],
        spec_changes_source: "since-created",
      }),
    ]);
    write(tmp, ".arbor/tasks/archive/2026-10/10-20-newer/task.json", [
      JSON.stringify({
        completedAt: "2026-10-21",
        spec_changes: [
          ".arbor/spec/backend/good.md",
          ".arbor/spec/backend/gone.md",
        ],
        spec_changes_source: "branch-diff",
      }),
    ]);

    const j = runSpec(tmp, "lint", "--json", "--provenance");
    const report = JSON.parse(j.stdout) as JsonReport;
    expect(report.provenance).toEqual({
      ".arbor/spec/backend/good.md": [
        {
          task: "10-20-newer",
          completedAt: "2026-10-21",
          source: "branch-diff",
        },
        {
          task: "10-01-older",
          completedAt: "2026-10-02",
          source: "since-created",
        },
      ],
    });

    const t = runSpec(tmp, "lint", "--provenance");
    expect(t.stdout).toContain(
      ".arbor/spec/backend/good.md  last changed by 10-20-newer (2026-10-21)",
    );
    expect(t.stdout).not.toContain("gone.md");
  });
});

describe.skipIf(!hasPython())("spec.py verify", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-spec-verify-"));
    setupRepo(tmp);
    writeFixture(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("AC3: changes only the last_verified line", () => {
    const rel = ".arbor/spec/backend/stale.md";
    const before = read(tmp, rel).split("\n");
    const r = runSpec(tmp, "verify", rel, "--date", "2026-10-19");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`verified ${rel} (last_verified: 2026-10-19)`);

    const after = read(tmp, rel).split("\n");
    expect(after.length).toBe(before.length);
    const changed = before
      .map((line, i) => (line === after[i] ? null : i))
      .filter((i): i is number => i !== null);
    expect(changed).toEqual([3]);
    expect(after[3]).toBe("last_verified: 2026-10-19");

    // The stale finding is gone; nothing else about the doc moved.
    const lint = runSpec(tmp, "lint", "--json", rel);
    expect((JSON.parse(lint.stdout) as JsonReport).findings).toEqual([]);
  });

  it("inserts last_verified after the sources block when absent", () => {
    const rel = ".arbor/spec/backend/good.md";
    write(tmp, rel, [
      "---",
      "sources:",
      "  - src/a.ts",
      "  - src/b.ts",
      "owner: me",
      "---",
      "# Good",
    ]);
    const r = runSpec(tmp, "verify", rel, "--date", "2026-10-19");
    expect(r.status).toBe(0);
    expect(read(tmp, rel)).toBe(
      [
        "---",
        "sources:",
        "  - src/a.ts",
        "  - src/b.ts",
        "last_verified: 2026-10-19",
        "owner: me",
        "---",
        "# Good",
        "",
      ].join("\n"),
    );
  });

  it("defaults to today, is idempotent, and refuses paths outside .arbor/spec", () => {
    const rel = ".arbor/spec/backend/good.md";
    const today = localToday();
    const first = runSpec(tmp, "verify", rel);
    expect(first.status).toBe(0);
    expect(read(tmp, rel)).toContain(`last_verified: ${today}`);
    const second = runSpec(tmp, "verify", rel);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("unchanged");

    const outside = runSpec(tmp, "verify", "src/a.ts");
    expect(outside.status).toBe(2);
    expect(read(tmp, "src/a.ts")).toBe("export const a = 1;\n");
  });

  it("keeps CRLF line endings through lint, verify, and init-meta", () => {
    const rel = ".arbor/spec/backend/good.md";
    const file = path.join(tmp, rel);
    const crlf =
      [
        "---",
        "sources:",
        "  - src/a.ts",
        "last_verified: 2026-09-01",
        "---",
        "# Good",
        "",
        "Body.",
      ].join("\r\n") + "\r\n";
    fs.writeFileSync(file, crlf);

    // Parse: the block is recognised (no invalid-metadata / missing-metadata)
    // and the date is read, so only the genuine stale finding remains.
    const lint = JSON.parse(
      runSpec(tmp, "lint", "--json", rel).stdout,
    ) as JsonReport;
    expect(lint.findings.map((f) => f.rule)).toEqual(["stale"]);

    const r = runSpec(tmp, "verify", rel, "--date", "2026-10-19");
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toBe(
      crlf.replace("last_verified: 2026-09-01", "last_verified: 2026-10-19"),
    );

    // A CRLF doc without a block gets a CRLF block, nothing else rewritten.
    const bareRel = ".arbor/spec/backend/nometa.md";
    const bare = path.join(tmp, bareRel);
    fs.writeFileSync(bare, "# No meta\r\n\r\nbody\r\n");
    expect(runSpec(tmp, "init-meta", bareRel).status).toBe(0);
    const seeded = fs.readFileSync(bare, "utf-8");
    expect(seeded.startsWith("---\r\nsources: []\r\nlast_verified: ")).toBe(
      true,
    );
    expect(seeded.endsWith("---\r\n# No meta\r\n\r\nbody\r\n")).toBe(true);
    expect(seeded).not.toMatch(/[^\r]\n/);
  });
});

describe.skipIf(!hasPython())("spec.py init-meta", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-spec-init-meta-"));
    setupRepo(tmp);
    writeFixture(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("AC4: seeds sources from a `Sources:` bullet list and last_verified from git", () => {
    const rel = ".arbor/spec/backend/nometa.md";
    const body = [
      "# No meta",
      "",
      "Sources:",
      "",
      "- `src/a.ts`",
      "- `src/b.ts` (helpers)",
      "",
      "Body text.",
      "- not a source",
    ];
    write(tmp, rel, body);
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "sources list");

    const dry = runSpec(tmp, "init-meta", "--dry-run", rel);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`would seed ${rel} (2 sources)`);
    expect(read(tmp, rel)).toBe(body.join("\n") + "\n");

    const r = runSpec(tmp, "init-meta", rel);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`seeded ${rel} (2 sources)`);
    expect(read(tmp, rel)).toBe(
      [
        "---",
        "sources:",
        "  - src/a.ts",
        "  - src/b.ts",
        `last_verified: ${SOURCE_COMMIT_DATE}`,
        "---",
        ...body,
        "",
      ].join("\n"),
    );

    // Running again is a no-op: the doc now has a block.
    const again = runSpec(tmp, "init-meta", rel);
    expect(again.stdout).toContain("seeded 0 docs");
    expect(runSpec(tmp, "lint", "--json", rel).stdout).toContain(
      '"findings": []',
    );
  });

  it("directory scan seeds only required leaf docs; explicit files seed any kind", () => {
    const r = runSpec(tmp, "init-meta");
    expect(r.status).toBe(0);
    // nometa.md is the only leaf without a block; index.md / guides are skipped.
    expect(r.stdout).toContain("seeded 1 doc\n");
    expect(
      read(tmp, ".arbor/spec/backend/nometa.md").startsWith(
        "---\nsources: []\n",
      ),
    ).toBe(true);
    expect(read(tmp, ".arbor/spec/frontend/index.md").startsWith("---")).toBe(
      false,
    );
    expect(read(tmp, ".arbor/spec/guides/g.md").startsWith("---")).toBe(
      false,
    );

    const explicit = runSpec(tmp, "init-meta", ".arbor/spec/guides/g.md");
    expect(explicit.stdout).toContain(
      "seeded .arbor/spec/guides/g.md (0 sources)",
    );
    expect(
      read(tmp, ".arbor/spec/guides/g.md").startsWith("---\nsources: []\n"),
    ).toBe(true);
  });

  it("falls back to today for last_verified when the doc has no git history", () => {
    fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    const today = localToday();
    runSpec(tmp, "init-meta", ".arbor/spec/backend/nometa.md");
    expect(read(tmp, ".arbor/spec/backend/nometa.md")).toContain(
      `last_verified: ${today}`,
    );
  });
});
