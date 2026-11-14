/**
 * `arbor.py sync`: observe the workers, judge settled writers by the
 * evidence (commits, a clean tree, paths, their checks), merge the good ones
 * into the integration branch, start ready nodes, gate, and name one next step.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  git,
  hasPython,
  orcaCalls,
  orcaState,
  request,
  runAsync,
  setOrcaState,
  setupProject,
  work,
  writeFile,
  type Json,
  type Project,
} from "./driver-helpers";

let p: Project;
const integration = () => p.taskJson().repos["."].worktree as string;
const branches = () => git(p.repo, "branch", "--format=%(refname:short)").split("\n");

function patchRequest(key: string, patch: (r: Json) => void): void {
  const file = path.join(p.repo, ".arbor/.runtime/workers", p.task, `${key}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
  patch(rec);
  fs.writeFileSync(file, JSON.stringify(rec));
}

describe.skipIf(!hasPython())("arbor 1.0 sync", { timeout: 180_000 }, () => {
  afterEach(() => p?.cleanup());

  it("gives a read-only node without a tier the explore tier, a writer the write one", () => {
    p = setupProject({ executor: "    tiers:\n      explore:\n        agent: omp\n" });
    p.node("look", {});
    p.node("edit", { paths: "[src/**]" });
    p.node("pinned", { tier: "write" });
    const out = p.sync();
    expect(out.events).toContain("started look [explore omp]");
    expect(out.events).toContain("started edit [write codex]");
    expect(out.events).toContain("started pinned [write codex]");
  });

  it("starts each kind of work with its agents entry, model and effort", () => {
    p = setupProject({
      executor:
        "    agents:\n      write: codex\n      explore: omp\n      review:\n        agent: claude\n        model: opus\n        effort: high\n",
    });
    p.node("look", {});
    p.node("edit", { paths: "[src/**]" });
    const out = p.sync();
    expect(out.events).toContain("started look [explore omp]");
    expect(out.events).toContain("started edit [write codex]");
    const starts = orcaCalls(p).filter((c) => c[1] === "worker-start");
    expect(starts.some((c) => c.includes("omp") && !c.includes("--model"))).toBe(true);
    expect(starts.some((c) => c.includes("codex") && !c.includes("--effort"))).toBe(true);
  });

  it("passes the model and effort of the review entry to the reviewer worker", () => {
    p = setupProject({ executor: "    agents:\n      write: codex\n      review:\n        agent: claude\n        model: opus\n        effort: high\n" });
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "src/feature.txt", content: "f\n" }] });
    p.sync();
    p.ok("review");
    expect(p.sync().events).toContain("started review-1 [review claude opus high]");
    const start = orcaCalls(p).filter((c) => c[1] === "worker-start" && c.includes("claude"))[0];
    expect(start.slice(start.indexOf("--model"), start.indexOf("--model") + 4)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  it("leaves a read-only node whose agent is the main agent to the main agent, no Orca worker", () => {
    p = setupProject({
      executor: "    main: claude\n    agents:\n      write: codex\n      explore:\n        agent: claude\n        model: sonnet\n",
    });
    p.node("look", {});
    p.node("edit", { paths: "[src/**]" });
    let out = p.sync();
    expect(out.events).toContain("started look [explore claude sonnet] in this session");
    expect(out.events).toContain("started edit [write codex]");
    const starts = orcaCalls(p).filter((c) => c[1] === "worker-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("codex");
    expect(out.nodes.look).toMatchObject({ status: "running", inline: true });
    const spec = fs.readFileSync(out.nodes.look.spec as string, "utf-8");
    expect(spec).toContain("Arbor node:");
    expect(spec).not.toContain("worker_done");

    work(p, "edit", { write: [{ path: "src/a.txt", content: "a\n" }] });
    out = p.sync();
    expect(out.nodes.edit.status).toBe("merged");
    expect(out.next.kind).toBe("inline");
    expect(out.next.text).toContain("look [claude sonnet]");
    expect(out.next.text).toContain("reports/look.md");

    fs.writeFileSync(path.join(p.taskDir, "reports/look.md"), "found it: src/x.ts:3\n");
    out = p.sync();
    expect(out.nodes.look.status).toBe("done");
    expect(out.next.kind).not.toBe("inline");
  });

  it("runs the node in Orca when `main: none` or the main agent is another one", () => {
    for (const main of ["    main: none\n", "    main: codex\n"]) {
      p = setupProject({ executor: `${main}    agents:\n      write: codex\n      explore: claude\n` });
      p.node("look", {});
      const out = p.sync();
      expect(out.events).toContain("started look [explore claude]");
      expect(out.nodes.look.inline).toBeFalsy();
      expect(orcaCalls(p).filter((c) => c[1] === "worker-start")).toHaveLength(1);
      p.cleanup();
    }
  });

  it("a read-only node that left changes behind fails even when the main agent ran it", () => {
    p = setupProject({ executor: "    main: claude\n    agents:\n      write: codex\n      explore: claude\n" });
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "src/a.txt", content: "a\n" }] });
    p.sync();
    p.node("look", {});
    p.sync();
    fs.writeFileSync(path.join(integration(), "stray.txt"), "x\n");
    fs.writeFileSync(path.join(p.taskDir, "reports/look.md"), "done\n");
    const out = p.sync();
    expect(out.nodes.look.status).toBe("failed");
    expect(out.nodes.look.reason).toContain("left changes in");
  });

  it("refuses an effort without a model", () => {
    p = setupProject({
      executor: "    agents:\n      write: codex\n      review:\n        agent: claude\n        effort: high\n",
      start: false,
    });
    const res = p.run("start");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("effort needs a model");
  });

  it("runs a light node on the write agent when the light tier has no agent", () => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]", tier: "light" });
    expect(p.sync().events).toContain("started n1 [light codex]");
  });

  it("names the plan step first and creates the Orca Run once, lazily", () => {
    p = setupProject();
    let out = p.sync();
    expect(out.next).toMatchObject({ kind: "plan" });
    expect(orcaCalls(p).some((c) => c[1] === "run-create")).toBe(false);
    p.node("n1", { paths: "[src/**]" });
    out = p.sync();
    expect(out.status).toBe("active");
    expect(out.events).toContain("started n1 [write codex]");
    expect(out.next.kind).toBe("wait");
    expect(out.next.text).toContain('run "arbor.py sync --wait" in the background');
    p.node("n2", { paths: "[docs/**]" });
    p.sync();
    expect(orcaCalls(p).filter((c) => c[1] === "run-create")).toHaveLength(1);
    const spec = fs.readFileSync(request(p, "n1").spec_path, "utf-8");
    expect(spec.split("\n")[0]).toBe(`Arbor node: ${p.task}/n1`);
    expect(spec).toContain("Paths you own: src/**");
    expect(spec).toContain(`Report file: ${path.join(p.taskDir, "reports", "n1.md")}`);
    expect(spec).toContain("Brief\nDo n1.");
  });

  it("keeps running nodes at max_parallel", () => {
    p = setupProject({ executor: "    max_parallel: 2\n" });
    for (const id of ["a", "b", "c"]) p.node(id, { paths: `[${id}/**]` });
    const out = p.sync();
    expect(["a", "b", "c"].map((id) => out.nodes[id].status)).toEqual([
      "running",
      "running",
      "pending",
    ]);
    work(p, "a", { write: [{ path: "a/x", content: "x\n" }] });
    expect(p.sync().nodes.c.status).toBe("running");
  });

  it("merges a done writer, removes its worktree, gates the integration HEAD and asks for review", () => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]", checks: "[AC-1]" });
    p.sync();
    const node = p.taskJson().nodes.n1;
    expect(node.branch).toBe(`arbor/${p.task}--n1`);
    expect(path.basename(node.worktree)).toBe(`${p.task}-n1`);
    work(p, "n1", { write: [{ path: "src/feature.txt", content: "f\n" }] });
    const out = p.sync();
    const merged = out.nodes.n1;
    expect(merged.status).toBe("merged");
    expect(out.events).toContain(`merged n1 (${merged.merged_sha.slice(0, 7)})`);
    expect(fs.existsSync(node.worktree)).toBe(false);
    expect(branches()).not.toContain(`arbor/${p.task}--n1`);
    expect(git(integration(), "rev-parse", "HEAD")).toBe(merged.merged_sha);
    expect(git(integration(), "log", "-1", "--format=%s")).toBe(`merge ${p.task}/n1`);
    expect(out.repos["."].gate).toMatchObject({ sha: merged.merged_sha, green: true });
    expect(out.next.kind).toBe("review");
    expect(out.next.text).toContain("arbor.py review starts one reviewer per repo");
    expect(p.run("status").stdout).toContain("next: review:");
  });

  it.each([
    ["outside its paths", { write: [{ path: "docs/x.md", content: "x\n" }] }, "outside its paths: docs/x.md"],
    ["no commits", { settle: "failed" as const }, "no commits (the worker settled as failed: worker said it failed)"],
    [
      "uncommitted changes",
      { write: [{ path: "src/a", content: "a\n" }], dirty: [{ path: "src/b", content: "b\n" }] },
      "uncommitted changes",
    ],
  ])("fails a writer with %s and keeps its worktree", (_name, w, reason) => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "n1", { ...w, report: "line one\nline two\n" });
    const out = p.sync();
    expect(out.nodes.n1).toMatchObject({ status: "failed", reason });
    expect(out.events).toContain(`n1 failed: ${reason}`);
    expect(out.events).toContain("  | line one");
    expect(fs.existsSync(out.nodes.n1.worktree)).toBe(true);
    expect(out.next.kind).toBe("decide");
    expect(out.next.text).toContain(`n1: ${reason} (retry n1 | cancel n1 | edit or add nodes)`);
  });

  it("judges a worker that reported failure by its committed work", () => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "src/a", content: "a\n" }], settle: "failed" });
    expect(p.sync().nodes.n1.status).toBe("merged");
  });

  it("fails a writer whose check is red", () => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]", checks: "[AC-1]" });
    p.sync();
    work(p, "n1", { write: [{ path: "src/other.txt", content: "x\n" }] });
    expect(p.sync().nodes.n1).toMatchObject({ status: "failed", reason: "checks red: AC-1" });
  });

  it("fails the second of two conflicting writers with the files", () => {
    p = setupProject();
    p.node("a", { paths: "[src/a.txt]" });
    p.node("b", { paths: "[lib/b.txt]" });
    p.sync();
    // Both write the same file outside the overlap rule's view; b also stays inside its paths.
    work(p, "a", { write: [{ path: "src/a.txt", content: "a\n" }] });
    p.sync();
    const bwt = p.taskJson().nodes.b.worktree;
    writeFile(bwt, "src/a.txt", "b\n");
    git(bwt, "add", "src/a.txt");
    git(bwt, "commit", "-qm", "b");
    p.node("a", { paths: "[src/a.txt]" });
    // b's paths would reject src/a.txt; widen them in task.json to reach the merge.
    const data = p.taskJson();
    data.nodes.b.paths = ["**"];
    fs.writeFileSync(path.join(p.taskDir, "task.json"), JSON.stringify(data));
    work(p, "b", { write: [{ path: "lib/b.txt", content: "b\n" }] });
    const out = p.sync();
    expect(out.nodes.b).toMatchObject({ status: "failed", reason: "merge conflict: src/a.txt" });
    expect(fs.existsSync(bwt)).toBe(true);
    expect(git(integration(), "status", "--porcelain")).toBe("");
  });

  it("stops and merges an idle writer with clean commits; tells how to wake an idle one without", () => {
    p = setupProject();
    p.node("a", { paths: "[a/**]" });
    p.node("b", { paths: "[b/**]" });
    p.sync();
    const idle = { projection: { stage: { activity: "done" }, liveness: { verdict: "live" } } };
    for (const key of ["a", "b"]) {
      setOrcaState(p, `orca-${key}`, idle);
      patchRequest(key, (r) => (r.orca.started = "2020-01-01T00:00:00Z"));
    }
    work(p, "a", { write: [{ path: "a/x", content: "x\n" }], settle: null });
    const out = p.sync();
    expect(out.nodes.a.status).toBe("merged");
    expect(orcaCalls(p).some((c) => c[1] === "worker-stop" && c[3] === "orca-a")).toBe(true);
    expect(out.nodes.b.status).toBe("running");
    expect(out.next.kind).toBe("decide");
    expect(out.next.text).toContain("orca orchestration send --to dispatch:orca-b");
  });

  it("reports a worker waiting for a person", () => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    setOrcaState(p, "orca-n1", { observation: { agentWait: { reason: "approve rm -rf" } } });
    const out = p.sync();
    expect(out.nodes.n1.status).toBe("running");
    expect(out.next.text).toContain("n1: waiting for a person (approve rm -rf)");
  });

  it("recovers a merge whose save was lost", () => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "src/a", content: "a\n" }] });
    git(integration(), "merge", "--no-ff", "-q", "-m", "earlier merge", `arbor/${p.task}--n1`);
    const before = git(integration(), "rev-parse", "HEAD");
    const out = p.sync();
    expect(out.nodes.n1).toMatchObject({ status: "merged", merged_sha: before });
    expect(git(integration(), "rev-parse", "HEAD")).toBe(before);
  });

  it("exits 0 when another sync of the task is running", async () => {
    p = setupProject();
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    const waiting = runAsync(p, "sync", "--wait", "60s");
    const guard = path.join(p.repo, ".arbor/.runtime/sync", p.task, ".lock");
    for (let i = 0; i < 100 && !fs.existsSync(path.join(guard, "pid")); i++)
      await new Promise((r) => setTimeout(r, 100));
    const second = p.run("sync");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("another sync is running");
    work(p, "n1", { write: [{ path: "src/a", content: "a\n" }] });
    const first = await waiting;
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("merged n1");
  });

  it("retries a failed node on a new branch cut from the integration HEAD", () => {
    p = setupProject();
    p.node("base", { paths: "[base/**]" });
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "base", { write: [{ path: "base/x", content: "x\n" }] });
    work(p, "n1", { write: [{ path: "docs/out", content: "x\n" }] });
    let out = p.sync();
    expect(out.nodes.n1.status).toBe("failed");
    const old = out.nodes.n1.worktree;
    expect(p.ok("retry", "n1")).toContain("pending again (attempt 2)");
    expect(fs.existsSync(old)).toBe(false);
    out = p.sync();
    const n1 = out.nodes.n1;
    expect(n1).toMatchObject({ status: "running", attempt: 2, branch: `arbor/${p.task}--n1--r2` });
    expect(path.basename(n1.worktree)).toBe(`${p.task}-n1-r2`);
    expect(n1.base).toBe(out.nodes.base.merged_sha);
    expect(request(p, "n1.r2").report_path).toBe(path.join(p.taskDir, "reports", "n1.r2.md"));
    work(p, "n1.r2", { write: [{ path: "src/x", content: "x\n" }] });
    expect(p.sync().nodes.n1.status).toBe("merged");
    expect(p.run("retry", "n1").status).toBe(1);
  });

  it("retries a failed start on the same Orca Task and fails the node on the third", () => {
    p = setupProject();
    p.plan({ n1: { start: { state: "failed", lastError: "agent did not boot" } } });
    p.node("n1", { paths: "[src/**]" });
    let out = p.sync();
    expect(out.nodes.n1).toMatchObject({ status: "pending", failed_starts: 1 });
    expect(out.next.text).toContain("start failed: worker-start failed: agent did not boot");
    out = p.sync();
    expect(out.nodes.n1.failed_starts).toBe(2);
    const retries = orcaCalls(p).filter((c) => c[1] === "worker-start" && c.includes("--retry-of"));
    expect(retries[0]).toContain("orca-n1");
    expect(orcaCalls(p).filter((c) => c[0] === "worktree" && c[1] === "create")).toHaveLength(2);
    out = p.sync();
    expect(out.nodes.n1.status).toBe("failed");
    expect(out.nodes.n1.reason).toContain("start failed 3 times");
  });

  it("stops at max_nodes and resumes with more", () => {
    p = setupProject({ executor: "    max_nodes: 2\n" });
    for (const id of ["a", "b", "c"]) p.node(id, { paths: `[${id}/**]` });
    let out = p.sync();
    expect(out.next).toMatchObject({ kind: "stopped" });
    expect(out.next.text).toContain("max_nodes budget is used up; arbor.py resume grants more");
    expect(out.nodes.a.status).toBe("pending");
    p.ok("resume");
    out = p.sync();
    expect(out.nodes.c.status).toBe("running");
  });

  it("counts rounds of new writer nodes after the first gate and stops after three", () => {
    p = setupProject();
    p.node("n1", { paths: "[n1/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "n1/x", content: "x\n" }] });
    expect(p.sync().repos["."].gate).toBeTruthy();
    for (const id of ["r1", "r2", "r3"]) {
      p.node(id, { paths: `[${id}/**]` });
      expect(p.sync().nodes[id].status).toBe("running");
    }
    p.node("look", {}, "read only: does not count");
    p.node("r4", { paths: "[r4/**]" });
    let out = p.sync();
    expect(out.rounds ?? p.taskJson().rounds).toBe(4);
    expect(out.next.text).toContain("the rounds budget is used up");
    expect(out.nodes.r4.status).toBe("pending");
    p.ok("resume");
    out = p.sync();
    expect(out.nodes.r4.status).toBe("running");
  });

  it("names fix when a gate is red, and reports contract changes", () => {
    p = setupProject();
    p.node("n1", { paths: "[docs/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "docs/a", content: "a\n" }] });
    const out = p.sync();
    expect(out.repos["."].gate).toMatchObject({ green: false, failing: ["AC-1"] });
    expect(out.next).toEqual({
      kind: "fix",
      text: ". red on AC-1; add fix nodes (their brief names the failing check)".replace(/^/, "fix: "),
    });
    fs.appendFileSync(path.join(p.taskDir, "contract.md"), "\nmore\n");
    expect(p.ok("sync")).toContain(
      "contract.md changed since it was approved: get it re-approved, then arbor.py start --reapprove",
    );
  });

  it("runs read-only nodes before start in the main checkout and keeps writers pending", () => {
    p = setupProject({ start: false });
    p.node("look", {}, "Explore the repo.");
    p.node("w", { paths: "[src/**]" });
    let out = p.sync();
    expect(out.status).toBe("planning");
    expect(out.nodes.look).toMatchObject({ status: "running", worktree: p.repo });
    expect(out.nodes.w.status).toBe("pending");
    expect(orcaCalls(p).some((c) => c[0] === "worktree")).toBe(false);
    const spec = fs.readFileSync(request(p, "look").spec_path, "utf-8");
    expect(spec).toContain(`You work read-only in ${p.repo}: you may run commands`);
    expect(JSON.parse(fs.readFileSync(orcaState(p, "orca-look"), "utf-8")).worktree).toBe(p.repo);
    work(p, "look", { report: "found it\n" });
    out = p.sync();
    expect(out.nodes.look.status).toBe("done");
    expect(out.next.kind).toBe("contract");
    expect(out.next.text).toContain("get the user's approval, then arbor.py start");
  });

  it("runs read-only nodes while the draft contract does not parse", () => {
    p = setupProject({ start: false });
    fs.writeFileSync(
      path.join(p.taskDir, "contract.md"),
      "# Draft\n\n## Verification map\n\n| id | kind | check |\n| AC-1 | auto |\n",
    );
    p.node("look", {}, "Explore.");
    let out = p.sync();
    expect(out.events.some((e: string) => e.includes("contract.md") && e.includes("read-only nodes run anyway"))).toBe(true);
    expect(out.nodes.look.status).toBe("running");
    work(p, "look");
    out = p.sync();
    expect(out.nodes.look.status).toBe("done");
  });

  it("fails a read-only node without a report or that leaves changes in the integration worktree", () => {
    p = setupProject();
    p.node("w", { paths: "[src/**]" });
    p.sync();
    work(p, "w", { write: [{ path: "src/a", content: "a\n" }] });
    p.sync();
    p.node("quiet", {}, "say nothing");
    p.node("messy", {}, "leave a file");
    let out = p.sync();
    expect(out.nodes.messy.worktree).toBe(integration());
    work(p, "quiet", { report: "" });
    writeFile(integration(), "scratch.txt", "left\n");
    work(p, "messy");
    out = p.sync();
    expect(out.nodes.quiet).toMatchObject({ status: "failed", reason: "no report" });
    expect(out.nodes.messy).toMatchObject({ status: "failed", reason: `left changes in ${integration()}` });
  });

  it("cancels a running node only when Orca proves the stop", () => {
    p = setupProject();
    p.plan({ b: { stop: "unknown" } });
    p.node("a", { paths: "[a/**]" });
    p.node("b", { paths: "[b/**]" });
    p.sync();
    const cancelled = p.ok("cancel", "a");
    expect(cancelled).toContain("a cancelled; its worktree stays");
    expect(p.run("cancel", "b").status).toBe(1);
    expect(p.taskJson().nodes.b.status).toBe("running");
  });

  it("refuses a task.json of arbor < 1.0", () => {
    p = setupProject();
    fs.writeFileSync(
      path.join(p.taskDir, "task.json"),
      JSON.stringify({ id: "feat", status: "in_progress", state: "BUILD" }),
    );
    const res = p.run("--task", p.task, "sync");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${p.task} was started by arbor < 1.0: finish it with that version`);
  });
});
