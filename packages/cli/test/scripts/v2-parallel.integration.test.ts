/**
 * arbor.py reader batches: the REVIEW candidate readers (standard: 2) get
 * their dispatch ids up front, are all delegated through codeg MCP before
 * any is collected, and may be collected in any order; the step completes
 * when the last reader is in.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  TASK,
  complete,
  dispatch,
  git,
  hasPython,
  setupFixture,
  writeFile,
  type Fixture,
} from "./v2-driver-helpers";

const finding = (
  file: string,
  line: number,
  verdict: string,
  summary = "off by one",
) => ({
  file,
  line,
  angle: "A",
  summary,
  failure_scenario: "x -> y",
  verdict,
  evidence: "two",
  fix: "z",
});
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;
const FINDING_ID = "src/app.txt:2:off by one";

/** Commit a source change and jump to REVIEW/candidates: the candidate batch opens. */
function seedCandidates(f: Fixture): void {
  writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
  git(f.wt, "add", "src/app.txt");
  git(
    f.wt,
    "commit",
    "-q",
    "-m",
    `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`,
  );
  expect(
    f.run("override", "--reason", "test setup", "--to", "REVIEW/candidates")
      .status,
  ).toBe(0);
  expect(f.taskJson()).toMatchObject({
    state: "REVIEW",
    step: "candidates",
    batch: { key: "REVIEW/candidates", ids: ["d-001", "d-002"] },
  });
}

describe.skipIf(!hasPython())(
  "arbor.py parallel readers",
  { timeout: 120_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("standard candidates: two readers get ids up front, both run before either is collected, findings unite", () => {
      f = setupFixture({ tier: "standard" });
      seedCandidates(f);
      const next = f.next();
      expect(next).toMatchObject({
        state: "REVIEW",
        needs: "brief",
        role: "review",
        mode: "candidates",
        dispatch: "d-001",
      });
      expect(next.batch.map((b: { dispatch: string }) => b.dispatch)).toEqual([
        "d-001",
        "d-002",
      ]);
      expect(next.batch[1].brief_path).toBe(
        path.join(f.taskDir, "briefs/d-002.md"),
      );
      expect(next.summary).toContain("may run concurrently");
      // The ready set lists every reader of the batch as its own item.
      expect(
        next.items.map(
          (i: { role: string; dispatch: string; brief_path: string }) => [
            i.role,
            i.dispatch,
            i.brief_path,
          ],
        ),
      ).toEqual([
        ["review", "d-001", path.join(f.taskDir, "briefs/d-001.md")],
        ["review", "d-002", path.join(f.taskDir, "briefs/d-002.md")],
      ]);

      f.plan({
        "d-001": { reply: reviewReply("PASS", []) },
        "d-002": {
          reply: reviewReply("FAIL", [finding("src/app.txt", 2, "PLAUSIBLE")]),
        },
      });
      f.brief("d-001", "Angles: A, Acceptance");
      f.brief("d-002", "Angles: B, Conventions");
      // The printed prompt of the second reader is available before it runs.
      expect(
        f.run("prompt", "--dispatch", "d-002", "--print").stdout,
      ).toContain("Angles: B, Conventions");
      const second = f.run("run", "--dispatch", "d-002");
      const first = f.run("run", "--dispatch", "d-001");
      expect(f.taskJson().batch).toMatchObject({
        ids: [],
        running: { "d-001": { external: true }, "d-002": { external: true } },
      });
      const a = complete(f, second);
      expect(a.status, a.stdout + a.stderr).toBe(0);
      expect(
        fs.readFileSync(path.join(f.tmp, "received/d-002.md"), "utf-8"),
      ).toContain("Mode: candidates");
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { candidates_done: 1, candidate_dispatches: ["d-002"] },
      });
      const b = complete(f, first);
      expect(b.status, b.stdout + b.stderr).toBe(0);

      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "plausible",
        counters: { review: 1 },
        cycle_ids: [FINDING_ID],
      });
      expect(data.cycle.candidate_dispatches).toEqual(["d-002", "d-001"]);
      expect(data.mcp_pending).toEqual({});
      expect(
        data.dispatches.map((d: { id: string; status: string }) => [
          d.id,
          d.status,
        ]),
      ).toEqual([
        ["d-002", "ok"],
        ["d-001", "ok"],
      ]);
      // The reader that completed the batch carries the prefilter note.
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
      ).toContain("### Prefilter");
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-002.md"), "utf-8"),
      ).not.toContain("### Prefilter");
      const gate = f.next();
      expect(gate).toMatchObject({
        needs: "human",
        human: { kind: "plausible" },
      });
      expect(gate.readers_running).toBeUndefined();
      expect(gate.batch).toBeUndefined();
    });

    it("standard candidates: run one reader at a time without --dispatch; nothing kept -> FINISH", () => {
      f = setupFixture({ tier: "standard" });
      seedCandidates(f);
      f.plan({
        "d-001": { reply: reviewReply("PASS", []) },
        "d-002": { reply: reviewReply("PASS", []) },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { candidates_done: 1 },
      });
      expect(f.next()).toMatchObject({
        role: "review",
        mode: "candidates",
        dispatch: "d-002",
      });
      expect(f.next().batch).toBeUndefined(); // one reader left
      f.brief("d-002");
      const r = complete(f, f.run("run"));
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "FINISH",
        counters: { review: 0 },
        cycle_ids: [],
      });
      expect(data.cycle).toBeUndefined();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(f.taskDir, "reports/candidates-r1.json"),
            "utf-8",
          ),
        ).kept,
      ).toEqual([]);
    });

    it("a reader id outside the batch is refused; a finished reader is not started twice", () => {
      f = setupFixture({ tier: "standard" });
      seedCandidates(f);
      f.brief("d-005");
      const r = f.run("run", "--dispatch", "d-005");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("d-001 (or one of d-001, d-002), not d-005");
      f.plan({ "d-001": { reply: reviewReply("PASS", []) } });
      expect(dispatch(f, "d-001").status).toBe(0);
      const again = f.run("run", "--dispatch", "d-001");
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("the next dispatch is d-002, not d-001");
      expect(f.taskJson().cycle.candidates_done).toBe(1);
    });

    it("codeg MCP: next lists the delegated reader beside the other's brief; collected out of order", () => {
      f = setupFixture({ tier: "standard" });
      writeFile(
        f.repo,
        ".arbor/config.yaml",
        "executors:\n  default: codeg\n  codeg:\n    type: codeg-mcp\n    assistant: arbor-{role}\n    max_parallel: 3\n" +
          "mandate:\n  standard:\n    contract: ask\n    plausible: ask\n    merge: ask\n",
      );
      seedCandidates(f);
      f.brief("d-001");
      f.brief("d-002");
      const first = JSON.parse(f.run("run", "--dispatch", "d-001").stdout);
      expect(first).toMatchObject({ needs: "delegation", dispatch: "d-001" });
      expect(first.mcp.arguments.task).toContain(
        `Prompt: ${first.prompt_path}`,
      );
      const between = f.next();
      expect(between).toMatchObject({
        needs: "brief",
        dispatch: "d-002",
        readers_running: ["d-001"],
      });
      expect(
        between.pending_delegations.map(
          (d: { dispatch: string }) => d.dispatch,
        ),
      ).toEqual(["d-001"]);
      // Ready set: the unsent delegation of d-001 and d-002's brief, side by side.
      expect(
        between.items.map((i: { needs: string; dispatch: string }) => [
          i.needs,
          i.dispatch,
        ]),
      ).toEqual([
        ["delegation", "d-001"],
        ["brief", "d-002"],
      ]);
      // `run` without --dispatch starts the next reader instead of repeating d-001's envelope.
      const second = JSON.parse(f.run("run").stdout);
      expect(second).toMatchObject({ needs: "delegation", dispatch: "d-002" });
      const both = f.next();
      expect(both).toMatchObject({ needs: "delegation" });
      expect(
        both.items.map((i: { needs: string; dispatch: string }) => [
          i.needs,
          i.dispatch,
        ]),
      ).toEqual([
        ["delegation", "d-001"],
        ["delegation", "d-002"],
      ]);
      expect(both.running).toEqual([]);
      // Asking for d-001 again returns its own envelope, not a new delegation.
      expect(
        JSON.parse(f.run("run", "--dispatch", "d-001").stdout),
      ).toMatchObject({ dispatch: "d-001", request_path: first.request_path });
      // A third reader does not exist: the gate and decisions wait for the batch.
      expect(f.run("gate").stderr).toContain("an MCP dispatch is pending");

      const collect = (
        p: { request_path: string },
        id: string,
        text: string,
      ) => {
        expect(
          f.run("bind", "--request", p.request_path, "--task-id", id).status,
        ).toBe(0);
        const bound = f.next();
        expect(
          bound.running.map((r: { dispatch: string; task_id: string }) => [
            r.dispatch,
            r.task_id,
          ]),
        ).toContainEqual([p === first ? "d-001" : "d-002", id]);
        const file = path.join(f.tmp, `${id}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify({
            tasks: [{ task_id: id, status: "completed", text }],
          }),
        );
        const r = f.run(
          "collect",
          "--request",
          p.request_path,
          "--result",
          file,
        );
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain(
          `${p === first ? "d-001" : "d-002"} review: ok; report:`,
        );
      };
      collect(
        second,
        "codeg-2",
        reviewReply("FAIL", [finding("src/app.txt", 2, "PLAUSIBLE")]),
      );
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { candidates_done: 1 },
      });
      collect(first, "codeg-1", reviewReply("PASS", []));
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "plausible",
        mcp_pending: {},
        cycle_ids: [FINDING_ID],
      });
      expect(
        f.results().map((r) => [r.dispatch, r.executor, r.status]),
      ).toEqual([
        ["d-002", "codeg", "ok"],
        ["d-001", "codeg", "ok"],
      ]);
    });
  },
);
