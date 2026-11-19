/**
 * Polyrepo: a control repository holds `.arbor/`; two package repositories
 * below it (`packages.<name>.git: true`) each get their own integration
 * branch from `execution.base_ref`, their own gate (the map's `repo` column)
 * and their own merge command into `execution.merge_target`.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  git,
  hasPython,
  initRepo,
  orcaCalls,
  request,
  setupProject,
  work,
  writeFile,
  type Project,
} from "./driver-helpers";

const CONTRACT = `# Polyrepo

## Goal

Change both packages.

## Acceptance criteria

- AC-1: api has a.txt
- AC-2: web has w.txt
- AC-3: a person likes it

## Verification map

| id   | kind   | check               | file | repo |
|------|--------|---------------------|------|------|
| AC-1 | auto   | \`test -f src/a.txt\` | -    | api  |
| AC-2 | auto   | \`test -f src/w.txt\` | -    | web  |
| AC-3 | manual | look at it          | -    |      |
`;

const PACKAGES = `packages:
  api:
    path: api
    git: true
    execution:
      base_ref: dev
      merge_target: dev
      gate:
        commands:
          - "test -f api.txt"
  web:
    path: web
    git: true
    execution:
      base_ref: dev
      merge_target: dev
`;

let p: Project;
const api = () => path.join(p.repo, "api");
const web = () => path.join(p.repo, "web");

function setup(): void {
  p = setupProject({
    config: PACKAGES,
    contract: CONTRACT,
    start: false,
    before: (repo) => {
      for (const name of ["api", "web"]) {
        const dir = path.join(repo, name);
        initRepo(dir, "dev");
        if (name === "api") {
          writeFile(dir, "api.txt", "api\n");
          git(dir, "add", "api.txt");
          git(dir, "commit", "-qm", "api marker");
        }
      }
      fs.appendFileSync(path.join(repo, ".gitignore"), "/api/\n/web/\n");
    },
  });
}

describe.skipIf(!hasPython())(
  "arbor 1.0 polyrepo",
  { timeout: 240_000 },
  () => {
    afterEach(() => p?.cleanup());

    it("start adds the repos Orca does not know; a refused add refuses the start", () => {
      setup();
      p.plan({ repo_add: "fail" });
      const res = p.run("start");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(
        `\`orca repo add --path ${api()}\` failed: invalid_argument: not a git repository`,
      );
      expect(p.taskJson().status).toBe("planning");

      p.plan({});
      const out = p.ok("start");
      expect(out).toContain(`added ${api()} to Orca`);
      expect(out).toContain(`added ${web()} to Orca`);
      expect(out).not.toContain(`added ${p.repo} to Orca`);
      expect(out).toContain("is active");
      const known = JSON.parse(
        fs.readFileSync(path.join(p.tmp, "orca-repos.json"), "utf-8"),
      );
      expect(known).toEqual([p.repo, api(), web()]);
    });

    it("sync adds the repo of a node that start did not name", () => {
      p = setupProject({
        config: PACKAGES,
        start: false,
        before: (repo) => {
          initRepo(path.join(repo, "web"), "dev");
          fs.appendFileSync(path.join(repo, ".gitignore"), "/web/\n");
        },
      });
      p.ok("start");
      p.node("w", { repo: "web", paths: "[src/**]" });
      const out = p.sync();
      expect(out.events).toContain(`added ${web()} to Orca`);
      expect(out.nodes.w.status).toBe("running");
    });

    it("runs nodes of three repos in parallel, gates each repo by its map rows, and merges per repo", () => {
      setup();
      p.orcaRepos([p.repo, api(), web()]);
      p.ok("start");
      p.node("a", { repo: "api", paths: "[src/**]", checks: "[AC-1]" });
      p.node("w", { repo: "web", paths: "[src/**]" });
      p.node("c", { paths: "[docs/**]" });
      let out = p.sync();
      for (const id of ["a", "w", "c"])
        expect(out.nodes[id].status).toBe("running");
      const devApi = git(api(), "rev-parse", "dev");
      expect(out.repos.api).toMatchObject({
        branch: `arbor/${p.task}`,
        base: devApi,
        merge_target: "dev",
      });
      expect(out.repos.web.merge_target).toBe("dev");
      expect(out.repos["."].merge_target).toBe("main");
      expect(git(api(), "branch", "--list", `arbor/${p.task}--a`)).not.toBe("");

      work(p, "a", { write: [{ path: "src/a.txt", content: "a\n" }] });
      work(p, "w", { write: [{ path: "src/other.txt", content: "w\n" }] });
      work(p, "c", { write: [{ path: "docs/c.md", content: "c\n" }] });
      out = p.sync();
      for (const id of ["a", "w", "c"])
        expect(out.nodes[id].status).toBe("merged");
      expect(out.repos.api.gate).toMatchObject({ green: true, failing: [] });
      expect(out.repos.web.gate).toMatchObject({
        green: false,
        failing: ["AC-2"],
      });
      expect(out.repos["."].gate.green).toBe(true);
      expect(out.next.text).toBe(
        `fix: web red on AC-2; fix every failure in the integration worktree (web: ${out.repos.web.worktree}) and commit, then arbor.py sync (a fix node only for large independent work)`,
      );

      p.node("w2", { repo: "web", paths: "[src/**]" });
      p.sync();
      work(p, "w2", { write: [{ path: "src/w.txt", content: "w\n" }] });
      out = p.sync();
      expect(out.repos.web.gate.green).toBe(true);
      expect(out.next.kind).toBe("review");

      p.ok("review", "--pass");
      const fin = p.ok("finish");
      expect(fin).toContain("AC-3: look at it");
      for (const [key, root] of [
        [".", p.repo],
        ["api", api()],
        ["web", web()],
      ]) {
        const target = key === "." ? "main" : "dev";
        expect(fin).toContain(
          `${key}: git -C ${root} merge --no-ff arbor/${p.task}   (with ${target} checked out in ${root})`,
        );
      }
      expect(fin.match(/merge --no-ff/g)).toHaveLength(3);
      for (const root of [p.repo, api(), web()])
        git(root, "merge", "--no-ff", "-q", "-m", "merge", `arbor/${p.task}`);
      const done = p.ok("finish");
      expect(done).toContain("journal entry written");
      expect(done).toContain(`${p.task}: done`);
      for (const root of [api(), web()])
        expect(git(root, "branch", "--list", `arbor/${p.task}*`)).toBe("");
      expect(orcaCalls(p).filter((c) => c[1] === "run-create")).toHaveLength(1);
    });
  },
);

const WEB_CONTRACT = `# Submodule

## Goal

Change web, a submodule, and the control repo's docs.

## Acceptance criteria

- AC-1: web has w.txt
- AC-2: the control repo has docs/c.md
- AC-3: a person likes it

## Verification map

| id   | kind   | check               | file | repo |
|------|--------|---------------------|------|------|
| AC-1 | auto   | \`test -f src/w.txt\` | -    | web  |
| AC-2 | auto   | \`test -f docs/c.md\` | -    | .    |
| AC-3 | manual | look at it          | -    |      |
`;

const SUBMODULE = `packages:
  web:
    path: web
    git: true
`;

/** A source repo in the tmp dir, added to `repo` as the submodule `dir` (on its branch main). */
function addSubmodule(repo: string, dir: string): void {
  const source = path.join(path.dirname(repo), `${dir}-src`);
  initRepo(source);
  git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "--quiet",
    "add",
    source,
    dir,
  );
  for (const [key, value] of [
    ["user.email", "t@example.com"],
    ["user.name", "tester"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
  ])
    git(path.join(repo, dir), "config", key, value);
}

describe.skipIf(!hasPython())(
  "arbor 1.0 polyrepo: a git submodule as a git: true package",
  { timeout: 240_000 },
  () => {
    afterEach(() => p?.cleanup());

    const setupSubmodule = (contract = WEB_CONTRACT): void => {
      p = setupProject({
        config: SUBMODULE,
        contract,
        start: false,
        before: (repo) => addSubmodule(repo, "web"),
      });
    };

    it("merges a web node into the submodule's integration branch, gates it there and prints its merge", () => {
      setupSubmodule();
      expect(git(p.repo, "ls-files", "--stage", "--", "web")).toMatch(
        /^160000 /,
      );
      expect(p.ok("start")).toContain(`added ${web()} to Orca`);
      p.node("w", { repo: "web", paths: "[src/**]", checks: "[AC-1]" });
      p.node("c", { paths: "[docs/**]", checks: "[AC-2]" });
      let out = p.sync();
      expect(out.nodes.w.status).toBe("running");
      const branch = `arbor/${p.task}`;
      expect(out.repos.web).toMatchObject({
        root: web(),
        branch,
        base: git(web(), "rev-parse", "main"),
        merge_target: "main",
      });
      work(p, "w", { write: [{ path: "src/w.txt", content: "w\n" }] });
      work(p, "c", { write: [{ path: "docs/c.md", content: "c\n" }] });
      out = p.sync();
      expect(out.nodes.w.status).toBe("merged");
      expect(out.events.join("\n")).not.toContain("worktree kept");
      expect(git(web(), "ls-tree", "-r", "--name-only", branch)).toContain(
        "src/w.txt",
      );
      expect(out.repos.web.gate).toMatchObject({ green: true, failing: [] });
      expect(out.repos["."].gate).toMatchObject({ green: true, failing: [] });
      expect(out.next.kind).toBe("review");

      p.ok("review", "--pass");
      const fin = p.ok("finish");
      expect(fin).toContain(
        `web: git -C ${web()} merge --no-ff ${branch}   (with main checked out in ${web()})`,
      );
      expect(fin).toContain(
        `.: git -C ${p.repo} merge --no-ff ${branch}   (with main checked out in ${p.repo})`,
      );
      expect(fin).toContain(
        `then: git -C ${p.repo} commit -m "web: ${p.task}" -- web   (web is a submodule; the control repository records its commit)`,
      );
      git(web(), "merge", "--no-ff", "-q", "-m", "merge", branch);
      git(p.repo, "merge", "--no-ff", "-q", "-m", "merge", branch);
      // the control repo now sees web at a new commit
      expect(git(p.repo, "status", "--porcelain", "--", "web")).toBe("M web");
      const merged = git(p.repo, "rev-parse", "HEAD");
      const done = p.ok("finish");
      expect(done).toContain(`${p.task}: done`);
      // the archive and journal commits leave the gitlink to the user
      expect(git(p.repo, "log", "--format=%s", `${merged}..HEAD`)).toContain(
        `chore(task): archive ${p.task}`,
      );
      expect(
        git(p.repo, "log", "--format=", "--name-only", `${merged}..HEAD`).split(
          "\n",
        ),
      ).not.toContain("web");
      expect(git(p.repo, "status", "--porcelain", "--", "web")).toBe("M web");
      expect(git(web(), "branch", "--list", `${branch}*`)).toBe("");
    });

    it("takes base and merge target from the submodule's checkout: detached refuses, a branch is both", () => {
      setupSubmodule();
      // the state `git submodule update` leaves: HEAD detached at the recorded commit
      git(p.repo, "submodule", "--quiet", "deinit", "-f", "web");
      git(
        p.repo,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "--quiet",
        "update",
        "--init",
        "web",
      );
      expect(git(web(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      p.ok("start");
      p.node("w", { repo: "web", paths: "[src/**]" });
      let out = p.sync();
      const detached =
        "repo web: the main checkout is detached; set packages.<repo>.execution.merge_target " +
        "or check out the branch the task merges into";
      expect(out.nodes.w).toMatchObject({
        status: "pending",
        start_error: detached,
      });
      expect(
        out.events.some(
          (e: string) =>
            e.startsWith("w start failed (1/") && e.endsWith(detached),
        ),
      ).toBe(true);
      expect(out.repos.web).toBeUndefined();

      git(web(), "checkout", "-q", "main");
      out = p.sync();
      expect(out.nodes.w.status).toBe("running");
      expect(out.repos.web).toMatchObject({
        base: git(web(), "rev-parse", "main"),
        base_ref: "HEAD",
        merge_target: "main",
      });
    });

    it("keeps the control repo usable: worktree checks pass beside the submodule", () => {
      setupSubmodule();
      p.ok("start");
      p.node("w", { repo: "web", paths: "[src/**]", checks: "[AC-1]" });
      p.node("c", { paths: "[docs/**]", checks: "[AC-2]" });
      p.sync();
      const control = request(p, "c").worktree as string;
      // a worktree of the control repo holds web as an empty, uninitialised gitlink
      expect(fs.readdirSync(path.join(control, "web"))).toEqual([]);
      expect(
        git(control, "status", "--porcelain", "--untracked-files=all"),
      ).toBe("");
      work(p, "w", { write: [{ path: "src/w.txt", content: "w\n" }] });
      work(p, "c", { write: [{ path: "docs/c.md", content: "c\n" }] });
      let out = p.sync();
      expect(out.nodes.c.status).toBe("merged");
      expect(out.nodes.w.status).toBe("merged");
      expect(
        git(
          p.repo,
          "status",
          "--porcelain",
          "--ignore-submodules=none",
          "--",
          "web",
        ),
      ).toBe("");

      // reviewers are read-only: sync fails one that left changes in its integration worktree
      p.ok("review");
      out = p.sync();
      expect(out.nodes["review-1-1"]).toMatchObject({
        status: "running",
        repo: ".",
      });
      expect(out.nodes["review-1-2"]).toMatchObject({
        status: "running",
        repo: "web",
      });
      work(p, "review-1-1", { report: "findings: 0\n" });
      work(p, "review-1-2", { report: "findings: 0\n" });
      out = p.sync();
      expect(out.nodes["review-1-1"].status).toBe("done");
      expect(out.nodes["review-1-2"].status).toBe("done");
      expect(p.ok("review", "--pass")).toContain("next: arbor.py finish");
    });

    it("runs a control-only task while another git: true package is an uninitialised submodule", () => {
      p = setupProject({
        config: SUBMODULE,
        start: false,
        before: (repo) => addSubmodule(repo, "web"),
      });
      // a clone without --recurse-submodules: web is an empty directory listed in .gitmodules
      git(p.repo, "submodule", "--quiet", "deinit", "-f", "web");
      fs.rmSync(path.join(p.repo, ".git/modules/web"), { recursive: true });
      expect(fs.readdirSync(web())).toEqual([]);
      expect(
        fs.readFileSync(path.join(p.repo, ".gitmodules"), "utf-8"),
      ).toContain("path = web");
      expect(p.ok("start")).toContain("is active");
      p.node("n1", { paths: "[src/**]", checks: "[AC-1]" });
      let out = p.sync();
      expect(out.nodes.n1.status).toBe("running");
      work(p, "n1", { write: [{ path: "src/feature.txt", content: "f\n" }] });
      out = p.sync();
      expect(out.nodes.n1.status).toBe("merged");
      expect(Object.keys(out.repos)).toEqual(["."]);
      expect(out.repos["."].gate.green).toBe(true);
      expect(out.next.kind).toBe("review");
    });
  },
);
