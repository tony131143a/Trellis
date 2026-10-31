import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONTRACT, FEATURE, RED_TEST, SESSION, TASK, dispatch, git, setupFixture, writeFile, type Fixture } from "./v2-driver-helpers";

let f: Fixture;
let product: string;
let execution: string;
function prepare(contract?: string, gate: string[] = []): void {
  f = setupFixture({ start: false, contract });
  product = path.join(f.repo, "product");
  fs.mkdirSync(product);
  git(product, "init", "-q", "-b", "dev");
  git(product, "config", "user.name", "tester");
  git(product, "config", "user.email", "test@example.invalid");
  writeFile(product, "product.txt", "product only\n");
  git(product, "add", ".");
  git(product, "commit", "-qm", "product base");
  fs.appendFileSync(path.join(f.repo, ".arbor/config.yaml"), "\npackages:\n  app:\n    path: product\n    git: true\n");
  if (gate.length) {
    fs.appendFileSync(path.join(f.repo, ".arbor/config.yaml"),
      `    execution:\n      gate:\n        commands:\n${gate.map((command) => `          - "${command}"`).join("\n")}\n`);
  }
  writeFile(f.repo, ".gitignore", "/product/\n.arbor/.runtime/\n**/__pycache__/\n");
  git(f.repo, "add", ".gitignore", ".arbor/scripts", ".arbor/config.yaml", ".arbor/spec");
  git(f.repo, "commit", "-qm", "control infrastructure");
  const data = f.taskJson();
  data.package = "app";
  writeFile(f.taskDir, "task.json", JSON.stringify(data));
}
function start(...args: string[]) {
  return spawnSync("python3", [".arbor/scripts/task.py", "start", TASK, ...args], {
    cwd: f.repo, encoding: "utf8", env: { ...process.env, ...SESSION },
  });
}
function started(contract?: string, gate?: string[]): void {
  prepare(contract, gate);
  const r = start("--execution", "package", "--base-ref", "dev", "--merge-target", "dev");
  expect(r.status, r.stdout + r.stderr).toBe(0);
  f.taskDir = path.join(f.wt, ".arbor/tasks", TASK);
  f.taskJson = () => JSON.parse(fs.readFileSync(path.join(f.taskDir, "task.json"), "utf8"));
  f.brief = (id, text = "Implement the contract") => writeFile(f.taskDir, `briefs/${id}.md`, text);
  execution = f.taskJson().worktree_path;
}
function finishBuild(): void {
  f.plan({ "d-001": { write: [RED_TEST] }, "d-002": { write: [FEATURE] } });
  for (const id of ["d-001", "d-002"]) {
    const r = dispatch(f, id);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  const gate = f.run("gate");
  expect(gate.status, gate.stdout + gate.stderr).toBe(0);
  const review = dispatch(f, "d-003");
  expect(review.status, review.stdout + review.stderr).toBe(0);
  expect(f.taskJson().state).toBe("FINISH");
}

describe("central polyrepo execution", { timeout: 90000 }, () => {
  afterEach(() => f?.cleanup());
  it("rejects an empty product gate and records the failure without advancing to review", () => {
    started(CONTRACT.replace("| AC-1 | auto |", "| AC-1 | manual |"));
    writeFile(f.taskDir, "task.json", JSON.stringify({ ...f.taskJson(), state: "GATE", step: "gate" }));
    const result = f.run("gate");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("GATE-EMPTY");
    expect(f.taskJson().state).toBe("GATE");
    expect(fs.readFileSync(path.join(f.taskDir, "reports/gate-1.md"), "utf8")).toContain("product gate has no commands or auto checks");
  });

  it.each([
    { command: "test -f product.txt", status: 0, state: "REVIEW" },
    { command: "exit 7", status: 1, state: "GATE" },
  ])("respects a command-only product gate: $command", ({ command, status, state }) => {
    started(CONTRACT.replace("| AC-1 | auto |", "| AC-1 | manual |"), [command]);
    writeFile(f.taskDir, "task.json", JSON.stringify({ ...f.taskJson(), state: "GATE", step: "gate" }));
    const result = f.run("gate");
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(result.stdout).not.toContain("GATE-EMPTY");
    expect(f.taskJson().state).toBe(state);
  });

  it("preserves legacy control-task empty-gate behavior", () => {
    f = setupFixture({ contract: CONTRACT.replace("| AC-1 | auto |", "| AC-1 | manual |") });
    writeFile(f.taskDir, "task.json", JSON.stringify({ ...f.taskJson(), state: "GATE", step: "gate" }));
    const result = f.run("gate");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.taskJson().state).toBe("REVIEW");
  });

  it("creates control tasks without default-package inheritance and start uses the saved mode", () => {
    prepare();
    fs.appendFileSync(path.join(f.repo, ".arbor/config.yaml"), "default_package: app\n");
    const create = (...args: string[]) => spawnSync("python3", [".arbor/scripts/task.py", "create", "Central maintenance",
      "--description", "Review central driver", "--slug", "central-mode", "--tier", "light", "--no-start", ...args],
      { cwd: f.repo, encoding: "utf8" });
    const wrong = create("--package", "control");
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("Replace --package control with --execution control");
    expect(fs.readdirSync(path.join(f.repo, ".arbor/tasks")).some((name) => name.endsWith("central-mode"))).toBe(false);
    const created = create("--execution", "control");
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const name = fs.readdirSync(path.join(f.repo, ".arbor/tasks")).find((item) => item.endsWith("central-mode"));
    if (!name) throw new Error("control task was not created");
    const dir = path.join(f.repo, ".arbor/tasks", name);
    const data = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    expect(data).toMatchObject({ package: null, execution_mode: "control" });
    writeFile(f.repo, ".arbor/spec/app/backend/index.md", "# Product spec\n");
    const seeded = spawnSync("python3", [".arbor/scripts/task.py", "seed-context", name], { cwd: f.repo, encoding: "utf8" });
    expect(seeded.status, seeded.stdout + seeded.stderr).toBe(0);
    const manifest = fs.readFileSync(path.join(dir, "implement.jsonl"), "utf8");
    expect(manifest).toContain(".arbor/spec/guides/index.md");
    expect(manifest).not.toContain(".arbor/spec/app/");
    fs.copyFileSync(path.join(f.taskDir, "contract.md"), path.join(dir, "contract.md"));
    const result = spawnSync("python3", [".arbor/scripts/task.py", "start", name, "--allow-empty-context"],
      { cwd: f.repo, encoding: "utf8", env: { ...process.env, ...SESSION } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const wt = path.join(f.tmp, "proj-wt", name);
    const started = JSON.parse(fs.readFileSync(path.join(wt, ".arbor/tasks", name, "task.json"), "utf8"));
    expect(started.execution_mode).toBe("control");
    expect(started.execution_binding).toBeUndefined();
    expect(git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(f.repo, ".git"));
  });

  it("inherits saved product mode and still requires an explicit source", () => {
    prepare();
    const data = f.taskJson();
    data.execution_mode = "package";
    writeFile(f.taskDir, "task.json", JSON.stringify(data));
    expect(start().stdout).toContain("requires --base-ref and --merge-target");
    expect(start("--no-worktree").stdout).toContain("requires an isolated worktree");
    const result = start("--base-ref", "dev", "--merge-target", "dev");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const saved = JSON.parse(fs.readFileSync(path.join(f.wt, ".arbor/tasks", TASK, "task.json"), "utf8"));
    expect(saved.execution_binding.package).toBe("app");
  });

  it("requires an explicit execution choice and valid source before creating worktrees", () => {
    prepare();
    expect(start().stdout).toContain("requires explicit");
    const r = start("--execution", "package", "--base-ref", "missing", "--merge-target", "dev");
    expect(r.status).toBe(1);
    expect(fs.existsSync(f.wt)).toBe(false);
    expect(git(product, "branch", "--list", "arbor/*")).toBe("");
  });
  it("writes code and gates in product, artifacts in control, and finishes only after both merges", () => {
    started();
    expect(execution).not.toBe(f.wt);
    expect(fs.existsSync(path.join(execution, "product.txt"))).toBe(true);
    expect(fs.existsSync(path.join(execution, ".arbor"))).toBe(false);
    expect(f.taskJson().base).toBe(git(product, "rev-parse", "dev"));
    finishBuild();
    expect(fs.existsSync(path.join(execution, FEATURE.path))).toBe(true);
    expect(fs.existsSync(path.join(f.wt, FEATURE.path))).toBe(false);
    expect(git(f.wt, "ls-files", `.arbor/tasks/${TASK}/reports`)).toContain("d-003.md");
    const prompt = fs.readFileSync(path.join(f.tmp, "received/d-003.md"), "utf8");
    expect(prompt).toContain("# Guides");
    expect(prompt).toContain("+feature");
    expect(prompt).toContain(`Execution repository: ${execution}`);
    expect(f.run("finish").status).toBe(0);
    expect(f.next().summary).toContain("merge product first");
    git(product, "merge", "--no-ff", "-qm", "merge product", `arbor/${TASK}`);
    const evidence = f.run("finish");
    expect(evidence.status, evidence.stdout + evidence.stderr).toBe(0);
    expect(f.taskJson().product_merge.repo).toBe(product);
    expect(fs.existsSync(execution)).toBe(true);
    expect(fs.existsSync(f.wt)).toBe(true);
    git(f.repo, "merge", "--no-ff", "-qm", "merge control", `arbor/${TASK}`);
    const done = f.run("--task", TASK, "finish");
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(fs.existsSync(execution)).toBe(false);
    expect(fs.existsSync(f.wt)).toBe(false);
    expect(done.stdout).toContain("DONE");
  });
  it("creates, dispatches and merges partition worktrees in the product repository", () => {
    const contract = `# Split feature
## Goal
Build two components.
## Acceptance criteria
- AC-1: Given source When built Then feature exists
- AC-2: Given data When built Then fixture exists
## Verification map
| id | kind | check | file |
| --- | --- | --- | --- |
| AC-1 | auto | sh src/ac1.test.sh | src/ac1.test.sh |
| AC-2 | auto | sh tests/ac2.sh | tests/ac2.sh |
## Interface pins
- stable
## Test paths
- src/**/*.test.sh
- tests/**/*.sh
## Partitions
- impl: src/**
- data: tests/**
## Waves
- 1: [impl, data]
`;
    started(contract);
    expect(f.run("run").status).toBe(0);
    const partitions = f.taskJson().partitions;
    for (const part of Object.values(partitions) as { worktree: string }[]) {
      expect(git(part.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(product, ".git"));
    }
    f.plan({
      "d-001": { write: [{ path: "src/ac1.test.sh", content: "test -f src/feature.txt\n" }] },
      "d-002": { write: [{ path: "tests/ac2.sh", content: "test -f tests/data/fixture.txt\n" }] },
      "d-003": { write: [FEATURE] },
      "d-004": { write: [{ path: "tests/data/fixture.txt", content: "fixture\n" }] },
    });
    for (const [id, partition] of [["d-001", "impl"], ["d-002", "data"], ["d-003", "impl"], ["d-004", "data"]]) {
      f.brief(id);
      const r = f.run("run", "--partition", partition, "--dispatch", id);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
    const merged = f.run("run");
    expect(merged.status, merged.stdout + merged.stderr).toBe(0);
    expect(fs.existsSync(path.join(execution, "src/feature.txt"))).toBe(true);
    expect(fs.existsSync(path.join(execution, "tests/data/fixture.txt"))).toBe(true);
    expect(fs.existsSync(partitions.impl.worktree)).toBe(false);
    expect(f.run("gate").status).toBe(0);
  });

  it("prepares and collects MCP work in the product while protecting control metadata", () => {
    started();
    const cfg = path.join(f.repo, ".arbor/config.yaml");
    fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace("  fake:\n", "  fake:\n    type: codeg-mcp\n    assistant: arbor-{role}\n"));
    f.brief("d-001");
    const prepared = f.run("run");
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const request = JSON.parse(prepared.stdout);
    expect(request.mcp.arguments.working_dir).toBe(execution);
    expect(f.run("bind", "--request", request.request_path, "--task-id", "child-1").status).toBe(0);
    const prompt = path.join(f.tmp, "prompt.md");
    fs.writeFileSync(prompt, request.mcp.arguments.task);
    f.plan({ "d-001": { write: [RED_TEST] } });
    const child = spawnSync("python3", [path.join(f.tmp, "fake_exec.py"), "test", prompt, execution, TASK, "d-001"], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    const result = path.join(f.tmp, "result.json");
    fs.writeFileSync(result, JSON.stringify({ task_id: "child-1", status: "completed", text: child.stdout }));
    const collect = f.run("collect", "--request", request.request_path, "--result", result);
    expect(collect.status, collect.stdout + collect.stderr).toBe(0);
    expect(f.next().role).toBe("implement");
    expect(f.run("collect", "--request", request.request_path, "--result", result).status).toBe(1);
    f.brief("d-002");
    const second = JSON.parse(f.run("run").stdout);
    expect(f.run("bind", "--request", second.request_path, "--task-id", "child-2").status).toBe(0);
    const data = f.taskJson();
    data.title = "unauthorized change";
    writeFile(f.taskDir, "task.json", JSON.stringify(data));
    const rejected = f.run("collect", "--request", second.request_path, "--result", result);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("repository changed during product delegation");
  });

  it("refuses a binding redirected to the control repository", () => {
    started();
    const data = f.taskJson();
    data.execution_binding.repo = f.repo;
    writeFile(f.taskDir, "task.json", JSON.stringify(data));
    const r = f.run("next", "--json");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("repository or execution policy changed");
  });
  it("detects changes to already dirty control files and preserves evidence", () => {
    started();
    writeFile(f.repo, "dirty.txt", "original");
    const relative = path.relative(execution, path.join(f.repo, "dirty.txt"));
    f.plan({ "d-001": { dirty: [{ path: relative, content: "overwritten" }] } });
    const r = dispatch(f, "d-001");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("repository changed during product delegation");
    expect(fs.readFileSync(path.join(f.repo, "dirty.txt"), "utf8")).toBe("overwritten");
  });
});
