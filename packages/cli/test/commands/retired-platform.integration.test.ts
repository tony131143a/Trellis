import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { update } from "../../src/commands/update.js";
import { uninstall } from "../../src/commands/uninstall.js";
import {
  computeHash,
  loadHashes,
  saveHashes,
} from "../../src/utils/template-hash.js";

const historical = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../fixtures/retired-star.json"),
    "utf8",
  ),
) as Record<string, string>;

describe("retired StarFactory ownership", () => {
  let root: string;
  let previous: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-retired-platform-"));
    previous = process.cwd();
    process.chdir(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    fs.mkdirSync(path.join(root, ".arbor"));
    fs.writeFileSync(path.join(root, ".arbor/.version"), "0.2.0");
    const hashes: Record<string, string> = {};
    for (const [name, content] of Object.entries(historical)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
      hashes[name] = computeHash(content);
    }
    saveHashes(root, hashes);
    fs.writeFileSync(
      path.join(root, ".starFactory/user-notes.md"),
      "Keep this user file.",
    );
  });
  afterEach(() => {
    process.chdir(previous);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("backs up and removes unchanged historical files without claiming user files", async () => {
    await update({ force: true });
    expect(
      fs.existsSync(
        path.join(root, ".starFactory/hooks/guard-builtin-agent.py"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(root, ".starFactory/user-notes.md"), "utf8"),
    ).toBe("Keep this user file.");
    const backup = fs
      .readdirSync(path.join(root, ".arbor"))
      .find((name) => name.startsWith(".backup-"));
    expect(backup).toBeDefined();
    expect(
      fs.existsSync(
        path.join(
          root,
          ".arbor",
          backup ?? "",
          ".starFactory/hooks/guard-builtin-agent.py",
        ),
      ),
    ).toBe(true);
    await update({ force: true });
    expect(fs.existsSync(path.join(root, ".starFactory/user-notes.md"))).toBe(
      true,
    );
  });

  it("preserves modified settings during update and their ownership until uninstall", async () => {
    const settingsPath = path.join(root, ".starFactory/settings.json");
    const settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf8"),
    ) as Record<string, unknown>;
    settings.userPreference = "keep";
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    await update({ force: true });
    expect(
      JSON.parse(fs.readFileSync(settingsPath, "utf8")).userPreference,
    ).toBe("keep");
    expect(loadHashes(root)).toHaveProperty(".starFactory/settings.json");
    await uninstall({ yes: true });
    expect(
      JSON.parse(fs.readFileSync(settingsPath, "utf8")).userPreference,
    ).toBe("keep");
    expect(fs.existsSync(path.join(root, ".starFactory/user-notes.md"))).toBe(
      true,
    );
  });
});
