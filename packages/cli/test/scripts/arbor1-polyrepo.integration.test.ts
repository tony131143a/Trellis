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

describe.skipIf(!hasPython())("arbor 1.0 polyrepo", { timeout: 240_000 }, () => {
  afterEach(() => p?.cleanup());

  it("refuses start for a repo Orca does not know and prints how to add it", () => {
    setup();
    const res = p.run("start");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`orca repo add --path ${api()}`);
    expect(res.stderr).toContain(`orca repo add --path ${web()}`);
    expect(res.stderr).not.toContain(`orca repo add --path ${p.repo}\n`);
    p.orcaRepos([p.repo, api(), web()]);
    expect(p.ok("start")).toContain("is active");
  });

  it("runs nodes of three repos in parallel, gates each repo by its map rows, and merges per repo", () => {
    setup();
    p.orcaRepos([p.repo, api(), web()]);
    p.ok("start");
    p.node("a", { repo: "api", paths: "[src/**]", checks: "[AC-1]" });
    p.node("w", { repo: "web", paths: "[src/**]" });
    p.node("c", { paths: "[docs/**]" });
    let out = p.sync();
    for (const id of ["a", "w", "c"]) expect(out.nodes[id].status).toBe("running");
    const devApi = git(api(), "rev-parse", "dev");
    expect(out.repos.api).toMatchObject({ branch: `arbor/${p.task}`, base: devApi, merge_target: "dev" });
    expect(out.repos.web.merge_target).toBe("dev");
    expect(out.repos["."].merge_target).toBe("main");
    expect(git(api(), "branch", "--list", `arbor/${p.task}--a`)).not.toBe("");

    work(p, "a", { write: [{ path: "src/a.txt", content: "a\n" }] });
    work(p, "w", { write: [{ path: "src/other.txt", content: "w\n" }] });
    work(p, "c", { write: [{ path: "docs/c.md", content: "c\n" }] });
    out = p.sync();
    for (const id of ["a", "w", "c"]) expect(out.nodes[id].status).toBe("merged");
    expect(out.repos.api.gate).toMatchObject({ green: true, failing: [] });
    expect(out.repos.web.gate).toMatchObject({ green: false, failing: ["AC-2"] });
    expect(out.repos["."].gate.green).toBe(true);
    expect(out.next.text).toBe("fix: web red on AC-2; add fix nodes (their brief names the failing check)");

    p.node("w2", { repo: "web", paths: "[src/**]" });
    p.sync();
    work(p, "w2", { write: [{ path: "src/w.txt", content: "w\n" }] });
    out = p.sync();
    expect(out.repos.web.gate.green).toBe(true);
    expect(out.next.kind).toBe("review");

    p.ok("review", "--pass");
    const fin = p.ok("finish");
    expect(fin).toContain("AC-3: look at it");
    for (const [key, root] of [[".", p.repo], ["api", api()], ["web", web()]]) {
      const target = key === "." ? "main" : "dev";
      expect(fin).toContain(`${key}: git -C ${root} merge --no-ff arbor/${p.task}   (with ${target} checked out in ${root})`);
    }
    expect(fin.match(/merge --no-ff/g)).toHaveLength(3);
    for (const root of [p.repo, api(), web()]) git(root, "merge", "--no-ff", "-q", "-m", "merge", `arbor/${p.task}`);
    const done = p.ok("finish");
    expect(done).toContain("journal entry written");
    expect(done).toContain(`${p.task}: done`);
    for (const root of [api(), web()]) expect(git(root, "branch", "--list", `arbor/${p.task}*`)).toBe("");
    expect(orcaCalls(p).filter((c) => c[1] === "run-create")).toHaveLength(1);
  });
});
