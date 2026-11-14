/**
 * `review --pass` and `finish`: the review record is tied to the integration
 * HEADs, `finish` hands the merge to the human, then cleans up (resumably),
 * archives the task directory in one commit and writes the journal.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  git,
  hasPython,
  setupProject,
  work,
  writeFile,
  type Project,
} from "./driver-helpers";

let p: Project;
let counter: string;

/** n1 adds the feature; returns once it is merged and gated. */
function built(opts: { commitTask?: boolean } = {}): void {
  // The gate runs in the integration worktree; it counts its runs next to it.
  p = setupProject({ gate: ["echo run >> ../gate-count"] });
  if (opts.commitTask) {
    git(p.repo, "add", ".arbor/tasks");
    git(p.repo, "commit", "-qm", "task");
  }
  p.node("n1", { paths: "[src/**]", title: "Add the feature" });
  p.sync();
  work(p, "n1", { write: [{ path: "src/feature.txt", content: "f\n" }] });
  const out = p.sync();
  expect(out.repos["."].gate.green, JSON.stringify(out)).toBe(true);
  counter = path.join(path.dirname(out.repos["."].worktree), "gate-count");
}

const wt = () => p.taskJson().repos["."].worktree as string;
const branch = () => `arbor/${p.task}`;

describe.skipIf(!hasPython())("arbor 1.0 review and finish", { timeout: 180_000 }, () => {
  afterEach(() => p?.cleanup());

  it("gates each integration HEAD once", () => {
    built();
    p.sync();
    p.sync();
    expect(fs.readFileSync(counter, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  it("refuses finish without a review; a later merge makes the review stale", () => {
    built();
    let res = p.run("finish");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no review of the current integration HEADs");
    expect(p.ok("review", "--pass")).toContain("next: arbor.py finish");
    expect(p.sync().next).toEqual({ kind: "finish", text: "finish: arbor.py finish" });
    p.node("n2", { paths: "[docs/**]" });
    p.sync();
    work(p, "n2", { write: [{ path: "docs/a", content: "a\n" }] });
    expect(p.sync().next.kind).toBe("review");
    res = p.run("finish");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no review of the current integration HEADs");
  });

  it("reviews on the write agent, not the explore one, when no review tier exists", () => {
    p = setupProject({ executor: "    tiers:\n      explore:\n        agent: omp\n" });
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "src/feature.txt", content: "f\n" }] });
    p.sync();
    p.ok("review");
    expect(fs.readFileSync(path.join(p.taskDir, "nodes/review-1.md"), "utf-8")).toContain("tier: write");
    expect(p.sync().events).toContain("started review-1 [write codex]");
  });

  it("writes one reviewer node per repo with the range and the review tier", () => {
    p = setupProject({ executor: "    tiers:\n      review:\n        agent: claude\n" });
    p.node("n1", { paths: "[src/**]" });
    p.sync();
    work(p, "n1", { write: [{ path: "src/feature.txt", content: "f\n" }] });
    const gated = p.sync();
    const repo = gated.repos["."];
    const head = gated.nodes.n1.merged_sha as string;
    const out = p.ok("review");
    expect(out).toContain("review-1.md");
    expect(out).toContain("next: arbor.py sync");
    const text = fs.readFileSync(path.join(p.taskDir, "nodes/review-1.md"), "utf-8");
    expect(text).toContain(`title: Review . ${repo.base.slice(0, 7)}..${head.slice(0, 7)}`);
    expect(text).toContain("tier: review");
    expect(text).toContain(`Diff: git diff ${repo.base}..${head}`);
    expect(text).toContain("AC-1: test -f src/feature.txt");
    expect(p.ok("review")).toContain("nothing to review");
    let s = p.sync();
    expect(s.nodes["review-1"]).toMatchObject({ status: "running", tier: "review", worktree: repo.worktree });
    expect(s.events).toContain("started review-1 [review claude]");
    work(p, "review-1", { report: "findings: 0\n" });
    s = p.sync();
    expect(s.next.kind).toBe("review");
    expect(s.next.text).toContain(`review: read ${path.join(p.taskDir, "reports/review-1.md")}`);
  });

  it("prints the manual rows and the merge command, then cleans up, archives and journals", () => {
    built();
    p.ok("review", "--pass");
    const out = p.ok("finish");
    expect(out).toContain("AC-2: read src/feature.txt");
    expect(out).toContain(`.: git -C ${p.repo} merge --no-ff ${branch()}   (with main checked out in ${p.repo})`);
    expect(p.ok("finish")).toContain("merge --no-ff");
    git(p.repo, "merge", "--no-ff", "-q", "-m", "merge feature", branch());
    const integration = wt();
    const done = p.ok("finish");
    expect(done).toContain("journal entry written");
    expect(fs.existsSync(integration)).toBe(false);
    expect(git(p.repo, "branch", "--list", branch())).toBe("");
    const month = new Date().toISOString().slice(0, 7);
    const archived = path.join(p.repo, ".arbor/tasks/archive", month, p.task);
    expect(fs.existsSync(path.join(archived, "task.json"))).toBe(true);
    expect(fs.existsSync(p.taskDir)).toBe(false);
    const data = JSON.parse(fs.readFileSync(path.join(archived, "task.json"), "utf-8"));
    expect(data.status).toBe("done");
    const files = git(p.repo, "log", "--format=", "--name-only", "-1", "--grep", "archive").split("\n");
    expect(files.every((f) => f.startsWith(`.arbor/tasks/archive/${month}/${p.task}/`))).toBe(true);
    expect(git(p.repo, "status", "--porcelain", "--", ".arbor/tasks")).toBe("");
    const journal = fs.readFileSync(path.join(p.repo, ".arbor/workspace/tester/journal-1.md"), "utf-8");
    expect(journal).toContain("Feature");
    expect(journal).toContain("Add the feature");
    // A rerun is harmless and writes no second journal entry.
    expect(p.ok("--task", p.task, "finish")).toContain(`${p.task}: done`);
    expect(
      fs.readFileSync(path.join(p.repo, ".arbor/workspace/tester/journal-1.md"), "utf-8").split("<!-- arbor-session:").length,
    ).toBe(journal.split("<!-- arbor-session:").length);
  });

  it("commits the move of a task directory that was already committed", () => {
    built({ commitTask: true });
    p.ok("review", "--pass");
    p.ok("finish");
    git(p.repo, "merge", "--no-ff", "-q", "-m", "merge feature", branch());
    p.ok("finish");
    const files = git(p.repo, "show", "--name-status", "--format=", "HEAD~1").split("\n");
    expect(files.some((f) => f.startsWith("D") || f.startsWith("R"))).toBe(true);
    expect(git(p.repo, "status", "--porcelain", "--", ".arbor/tasks")).toBe("");
  });

  it("resumes a cleanup that stopped at a dirty integration worktree; leftovers do not block", () => {
    built();
    p.node("bad", { paths: "[lib/**]" });
    p.sync();
    work(p, "bad", { write: [{ path: "elsewhere/x", content: "x\n" }] });
    expect(p.sync().nodes.bad.status).toBe("failed");
    const badWt = p.taskJson().nodes.bad.worktree;
    writeFile(badWt, "untracked.txt", "keep me\n");
    p.ok("cancel", "bad");
    p.sync();
    p.ok("review", "--pass");
    p.ok("finish");
    git(p.repo, "merge", "--no-ff", "-q", "-m", "merge", branch());
    const integration = wt();
    writeFile(integration, "stray.txt", "x\n");
    const res = p.run("finish");
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(`leftover: bad worktree ${badWt}`);
    expect(p.taskJson().cleanup.done).toEqual(["leftovers"]);
    fs.rmSync(path.join(integration, "stray.txt"));
    const out = p.ok("finish");
    expect(fs.existsSync(badWt)).toBe(true);
    expect(fs.existsSync(integration)).toBe(false);
    expect(out).toContain(`${p.task}: done`);
  });

  it("completes a cleanup that stopped after the archive move", () => {
    built();
    p.ok("review", "--pass");
    p.ok("finish");
    git(p.repo, "merge", "--no-ff", "-q", "-m", "merge", branch());
    // The first finish stopped right after moving the task directory.
    const dest = path.join(p.repo, ".arbor/tasks/archive/2000-01", p.task);
    const data = p.taskJson();
    for (const [, repo] of Object.entries(data.repos) as [string, { root: string; worktree: string }][])
      git(repo.root, "worktree", "remove", repo.worktree);
    data.cleanup = { done: ["leftovers", "repo:."], archive: dest };
    fs.writeFileSync(path.join(p.taskDir, "task.json"), JSON.stringify(data));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(p.taskDir, dest);
    const out = p.ok("--task", p.task, "finish");
    expect(out).toContain(`committed the archive move of ${p.task}`);
    expect(JSON.parse(fs.readFileSync(path.join(dest, "task.json"), "utf-8")).status).toBe("done");
    expect(git(p.repo, "status", "--porcelain", "--", ".arbor/tasks")).toBe("");
  });

  it("refuses a pre-1.0 task.json", () => {
    p = setupProject();
    fs.writeFileSync(path.join(p.taskDir, "task.json"), JSON.stringify({ id: "x", state: "FINISH" }));
    const res = p.run("--task", p.task, "finish");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("was started by arbor < 1.0: finish it with that version");
  });
});
