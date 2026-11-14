/**
 * The plan: node files under `nodes/`, read on every `sync` until a node
 * starts. Invalid files become `invalid` nodes that never start; two writers
 * of one repo whose paths may overlap run one after the other.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  hasPython,
  orcaCalls,
  setupProject,
  work,
  writeFile,
  type Project,
} from "./driver-helpers";

let p: Project;

describe.skipIf(!hasPython())("arbor 1.0 plan", { timeout: 120_000 }, () => {
  afterEach(() => p?.cleanup());

  it("parses the spec's node example, comments and all list forms", () => {
    p = setupProject({ executor: "    tiers:\n      light:\n        agent: omp\n" });
    writeFile(
      p.taskDir,
      "nodes/n1.md",
      [
        "---",
        "title: Add the redis channel adapter",
        "repo: .      # optional; default: the task's default_repo",
        "paths: [src/channel/**, tests/channel/**]   # globs relative to the repo root",
        "tier: strong                  # optional",
        "checks: [AC-1]                # optional",
        "---",
        "The brief.",
        "",
      ].join("\n"),
    );
    writeFile(
      p.taskDir,
      "nodes/n2.md",
      "---\ntitle: Second\npaths: docs/a.md, docs/b.md\nafter:\n  - n1\ntier: light\n---\nbrief\n",
    );
    const out = p.sync();
    const n1 = out.nodes.n1;
    expect(n1.title).toBe("Add the redis channel adapter");
    expect(n1.paths).toEqual(["src/channel/**", "tests/channel/**"]);
    expect(n1.checks).toEqual(["AC-1"]);
    expect(n1.status).toBe("running");
    expect(out.nodes.n2).toMatchObject({
      paths: ["docs/a.md", "docs/b.md"],
      after: ["n1"],
      tier: "light",
      status: "pending",
    });
  });

  it("marks invalid nodes with the reason and never starts them; fixing the file revalidates", () => {
    p = setupProject();
    p.node("cyc-a", { paths: "a/**", after: "[cyc-b]" });
    p.node("cyc-b", { paths: "b/**", after: "[cyc-a]" });
    p.node("orphan", { paths: "c/**", after: "[ghost]" });
    p.node("badrepo", { repo: "nowhere", paths: "d/**" });
    p.node("badtier", { tier: "huge", paths: "e/**" });
    p.node("badcheck", { paths: "f/**", checks: "[AC-2]" });
    p.node("escape", { paths: "../x/**" });
    writeFile(p.taskDir, "nodes/nofront.md", "just a brief\n");
    writeFile(p.taskDir, "nodes/unknown.md", "---\ncolor: red\n---\nb\n");
    writeFile(p.taskDir, "nodes/Bad_Id.md", "---\ntitle: x\n---\nb\n");
    p.node("fine", { paths: "g/**" });
    const out = p.sync();
    const reason = (id: string) => out.nodes[id].reason as string;
    expect(reason("cyc-a")).toContain("dependency cycle");
    expect(reason("cyc-b")).toContain("dependency cycle");
    expect(reason("orphan")).toContain("unknown node(s) ghost");
    expect(reason("badrepo")).toContain("unknown repo 'nowhere'");
    expect(reason("badtier")).toContain("unknown tier 'huge'");
    expect(reason("badcheck")).toContain("AC-2 is not an auto row");
    expect(reason("escape")).toContain("without '..'");
    expect(reason("nofront")).toContain("no frontmatter");
    expect(reason("unknown")).toContain("unknown frontmatter line");
    expect(reason("Bad_Id")).toContain("bad id");
    for (const id of ["cyc-a", "orphan", "badrepo", "escape", "nofront"])
      expect(out.nodes[id].status).toBe("invalid");
    expect(out.nodes.fine.status).toBe("running");
    expect(out.next.kind).toBe("decide");
    expect(out.next.text).toContain("orphan: after: unknown node(s) ghost");
    const started = orcaCalls(p).filter((c) => c[1] === "worker-start");
    expect(started).toHaveLength(1);

    p.node("orphan", { paths: "c/**" });
    const again = p.sync();
    expect(again.events).toContain("orphan is valid now");
    expect(again.nodes.orphan.status).toBe("running");
  });

  it("runs two writers with overlapping paths one after the other", () => {
    p = setupProject();
    p.node("a", { paths: "[src/**]" });
    p.node("b", { paths: "[src/feature.txt]" });
    p.node("c", { paths: "[docs/**]" });
    let out = p.sync();
    expect(out.nodes.a.status).toBe("running");
    expect(out.nodes.b.status).toBe("pending");
    expect(out.nodes.c.status).toBe("running");
    work(p, "a", { write: [{ path: "src/a.txt", content: "a\n" }] });
    out = p.sync();
    expect(out.nodes.a.status).toBe("merged");
    expect(out.nodes.b.status).toBe("running");
  });

  it("reads edits and deletions of a pending node, ignores a change after start", () => {
    p = setupProject({ executor: "    max_parallel: 1\n" });
    p.node("first", { paths: "a/**" });
    p.node("second", { paths: "b/**" });
    p.node("third", { paths: "c/**" });
    let out = p.sync();
    expect(out.nodes.first.status).toBe("running");
    expect(out.nodes.second.status).toBe("pending");

    p.node("second", { paths: "b2/**", title: "Second, edited" });
    fs.rmSync(path.join(p.taskDir, "nodes/third.md"));
    p.node("first", { paths: "elsewhere/**" });
    out = p.sync();
    expect(out.nodes.second).toMatchObject({ title: "Second, edited", paths: ["b2/**"] });
    expect(out.nodes.third).toBeUndefined();
    expect(out.events).toContain("third removed (its file is gone)");
    expect(out.events).toContain("node first changed after it started; ignored");
    expect(out.nodes.first.paths).toEqual(["a/**"]);
    out = p.sync();
    expect(out.events).not.toContain("node first changed after it started; ignored");
  });
});
