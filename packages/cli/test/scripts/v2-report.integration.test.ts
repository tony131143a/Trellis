import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEMPLATE_SCRIPTS, hasPython } from "./v2-driver-helpers";

const finding = { file: "a.py", line: 3, summary: "Missing guard", verdict: "CONFIRMED" };
const report = (verdict: string, findings: unknown) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\n`;
const check = (input: string, cwd?: string) => spawnSync("python3", [
  path.join(TEMPLATE_SCRIPTS, "check_report.py"),
], { input, cwd, encoding: "utf8" });

describe.skipIf(!hasPython())("review report preflight", () => {
  it.each([
    ["empty", ""],
    ["worklog-style prose before findings", `Review complete.\n${report("FAIL", [finding])}`],
    ["worklog-style clean review without verdict", "No correctness defect found.\n```json\n[]\n```"],
    ["missing JSON", "PASS\nAll good."],
    ["broken JSON", "PASS\n```json\n[{broken]\n```"],
    ["missing finding fields", report("FAIL", [{ verdict: "CONFIRMED" }])],
    ["invalid line", report("FAIL", [{ ...finding, line: true }])],
    ["empty file", report("FAIL", [{ ...finding, file: " " }])],
    ["empty summary", report("FAIL", [{ ...finding, summary: null }])],
    ["invalid verdict", report("FAIL", [{ ...finding, verdict: "MAYBE" }])],
    ["contradictory PASS", report("PASS", [finding])],
  ])("rejects %s with an actionable diagnostic", (_, input) => {
    const result = check(input);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, problem: expect.any(String) });
  });

  it("retains findings on a format error and accepts the author's corrected report", () => {
    const draft = `Review complete.\n${report("FAIL", [finding])}`;
    const rejected = JSON.parse(check(draft).stdout);
    expect(rejected.findings).toEqual([finding]);
    expect(rejected.problem).toContain("do not repeat the review");
    const corrected = check(report("FAIL", rejected.findings));
    expect(corrected.status, corrected.stderr).toBe(0);
    expect(JSON.parse(corrected.stdout)).toMatchObject({ ok: true, verdict: "FAIL", findings: [finding] });
  });

  it("accepts a clean report without touching task state, files or bytecode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-report-"));
    try {
      const scripts = path.join(tmp, "scripts");
      fs.cpSync(TEMPLATE_SCRIPTS, scripts, {
        recursive: true, filter: (file) => path.basename(file) !== "__pycache__",
      });
      fs.writeFileSync(path.join(tmp, "task.json"), '{"state":"REVIEW"}');
      const before = fs.readdirSync(tmp, { recursive: true }).sort();
      const result = spawnSync("python3", [path.join(scripts, "check_report.py")], {
        input: report("**PASS**", []), cwd: tmp, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, verdict: "PASS", findings: [] });
      expect(fs.readdirSync(tmp, { recursive: true }).sort()).toEqual(before);
      expect(fs.readFileSync(path.join(tmp, "task.json"), "utf8")).toBe('{"state":"REVIEW"}');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
