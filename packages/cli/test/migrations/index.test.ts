import { RETIRED_PLATFORM_PATHS } from "../../src/utils/retired-platforms.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearManifestCache,
  getAllMigrations,
  getAllMigrationVersions,
  getConfigSectionsAddedBetween,
  getMigrationMetadata,
  getMigrationsForVersion,
  getMigrationSummary,
  hasPendingMigrations,
} from "../../src/migrations/index.js";
import { compareVersions } from "../../src/utils/compare-versions.js";
import { computeHash } from "../../src/utils/template-hash.js";
import { extractConfigSection } from "../../src/commands/update.js";
import { configYamlTemplate } from "../../src/templates/arbor/index.js";
import { VERSION } from "../../src/constants/version.js";

// Clear manifest cache before each test to ensure clean state
afterEach(() => {
  clearManifestCache();
});

// =============================================================================
// getAllMigrationVersions — loads from real manifest files
// =============================================================================

describe("getAllMigrationVersions", () => {
  it("returns an array of version strings", () => {
    const versions = getAllMigrationVersions();
    expect(Array.isArray(versions)).toBe(true);
    for (const v of versions) {
      expect(typeof v).toBe("string");
    }
  });

  it("versions are sorted in ascending order", () => {
    const versions = getAllMigrationVersions();
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1], versions[i])).toBeLessThan(0);
    }
  });

  it("includes known versions from manifests", () => {
    const versions = getAllMigrationVersions();
    // The project has manifest files — at least some versions should exist
    expect(versions.length).toBeGreaterThan(0);
  });

  it("returns consistent results across calls (cache works)", () => {
    const versions1 = getAllMigrationVersions();
    const versions2 = getAllMigrationVersions();
    expect(versions1).toEqual(versions2);
  });
});

// =============================================================================
// getAllMigrations — all migration items from all manifests
// =============================================================================

describe("getAllMigrations", () => {
  it("returns an array of migration items", () => {
    const migrations = getAllMigrations();
    expect(Array.isArray(migrations)).toBe(true);
  });

  it("each migration has required type and from fields", () => {
    const migrations = getAllMigrations();
    for (const m of migrations) {
      expect(["rename", "rename-dir", "delete", "safe-file-delete"]).toContain(
        m.type,
      );
      expect(typeof m.from).toBe("string");
      expect(m.from.length).toBeGreaterThan(0);
    }
  });

  it("rename migrations have a 'to' field", () => {
    const migrations = getAllMigrations();
    const renames = migrations.filter(
      (m) => m.type === "rename" || m.type === "rename-dir",
    );
    for (const m of renames) {
      expect(m.to).toBeDefined();
      expect(typeof m.to).toBe("string");
    }
  });
});

// =============================================================================
// getMigrationsForVersion — version range filtering
// =============================================================================

describe("getMigrationsForVersion", () => {
  it("returns empty array when from === to", () => {
    const migrations = getMigrationsForVersion(
      "0.3.0-beta.16",
      "0.3.0-beta.16",
    );
    expect(migrations).toEqual([]);
  });

  it("returns empty array when from > to", () => {
    const migrations = getMigrationsForVersion("99.0.0", "0.1.0");
    expect(migrations).toEqual([]);
  });

  it("returns migrations for a known version range", () => {
    const versions = getAllMigrationVersions();
    if (versions.length >= 2) {
      const from = versions[0];
      const to = versions[versions.length - 1];
      const migrations = getMigrationsForVersion(from, to);
      // Should include migrations from all versions after 'from' up to and including 'to'
      expect(migrations.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns empty array for versions before any manifest", () => {
    const migrations = getMigrationsForVersion("0.0.1", "0.0.2");
    expect(migrations).toEqual([]);
  });

  it("returns empty array for prerelease→stable when all migrations already applied", () => {
    // rc.6 users already have all beta.0 migrations applied
    const migrations = getMigrationsForVersion("0.3.0-rc.6", "0.3.0");
    expect(migrations).toEqual([]);
  });
});

// =============================================================================
// hasPendingMigrations — boolean wrapper
// =============================================================================

describe("hasPendingMigrations", () => {
  it("returns false for same version", () => {
    expect(hasPendingMigrations("0.3.0-beta.16", "0.3.0-beta.16")).toBe(false);
  });

  it("returns boolean type", () => {
    const result = hasPendingMigrations("0.1.0", "99.0.0");
    expect(typeof result).toBe("boolean");
  });
});

// =============================================================================
// getMigrationSummary — counts by type
// =============================================================================

describe("getMigrationSummary", () => {
  it("returns object with renames, deletes, and safeFileDeletes counts", () => {
    const summary = getMigrationSummary("0.1.0", "99.0.0");
    expect(typeof summary.renames).toBe("number");
    expect(typeof summary.deletes).toBe("number");
    expect(typeof summary.safeFileDeletes).toBe("number");
    expect(summary.renames).toBeGreaterThanOrEqual(0);
    expect(summary.deletes).toBeGreaterThanOrEqual(0);
    expect(summary.safeFileDeletes).toBeGreaterThanOrEqual(0);
  });

  it("returns zero counts for same version", () => {
    const summary = getMigrationSummary("0.3.0-beta.16", "0.3.0-beta.16");
    expect(summary.renames).toBe(0);
    expect(summary.deletes).toBe(0);
    expect(summary.safeFileDeletes).toBe(0);
  });

  it("counted types sum <= total migrations count", () => {
    const from = "0.1.0";
    const to = "99.0.0";
    const summary = getMigrationSummary(from, to);
    const migrations = getMigrationsForVersion(from, to);
    // getMigrationSummary counts "rename", "delete", and "safe-file-delete"
    // but not "rename-dir" — so sum may be less than total
    expect(
      summary.renames + summary.deletes + summary.safeFileDeletes,
    ).toBeLessThanOrEqual(migrations.length);
  });
});

// =============================================================================
// getMigrationMetadata — aggregated metadata
// =============================================================================

describe("getMigrationMetadata", () => {
  it("returns correct shape", () => {
    const metadata = getMigrationMetadata("0.1.0", "99.0.0");
    expect(Array.isArray(metadata.changelog)).toBe(true);
    expect(typeof metadata.breaking).toBe("boolean");
    expect(typeof metadata.recommendMigrate).toBe("boolean");
    expect(Array.isArray(metadata.migrationGuides)).toBe(true);
  });

  it("returns empty data for same version", () => {
    const metadata = getMigrationMetadata("0.3.0-beta.16", "0.3.0-beta.16");
    expect(metadata.changelog).toEqual([]);
    expect(metadata.breaking).toBe(false);
    expect(metadata.recommendMigrate).toBe(false);
    expect(metadata.migrationGuides).toEqual([]);
  });

  it("migration guides have version and guide fields", () => {
    const metadata = getMigrationMetadata("0.1.0", "99.0.0");
    for (const guide of metadata.migrationGuides) {
      expect(typeof guide.version).toBe("string");
      expect(typeof guide.guide).toBe("string");
    }
  });
});

// =============================================================================
// clearManifestCache — cache reset
// =============================================================================

describe("clearManifestCache", () => {
  it("allows re-loading manifests after clear", () => {
    const v1 = getAllMigrationVersions();
    clearManifestCache();
    const v2 = getAllMigrationVersions();
    expect(v1).toEqual(v2);
  });
});

// =============================================================================
// 0.2.0 — v2 driver: v1 dispatch files cleaned up, v2 config sections added
// =============================================================================

describe("0.2.0 manifest", () => {
  it("is reached from 0.1.0", () => {
    expect(getAllMigrationVersions()).toContain("0.2.0");
    const paths = getMigrationsForVersion("0.1.0", "0.2.0").map((m) => m.from);
    expect(paths).toEqual([
      ".arbor/scripts/dispatch.py",
      ".claude/hooks/inject-delegation-context.py",
      ".starFactory/hooks/inject-delegation-context.py",
      ".arbor/.runtime/dispatch-target",
      ...RETIRED_PLATFORM_PATHS,
    ]);
  });

  it("deletes the v1 files only by hash", () => {
    for (const m of getMigrationsForVersion("0.1.0", "0.2.0")) {
      expect(m.type).toBe("safe-file-delete");
      expect(m.allowed_hashes?.length).toBeGreaterThan(0);
      for (const hash of m.allowed_hashes ?? []) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    const target = getMigrationsForVersion("0.1.0", "0.2.0").find(
      (m) => m.from === ".arbor/.runtime/dispatch-target",
    );
    expect(target?.allowed_hashes).toContain(computeHash("pi\n"));
  });

  it("every added config section still shipped exists in the bundled config.yaml", () => {
    const sections = getConfigSectionsAddedBetween("0.1.0", "0.2.0");
    expect(sections.map((s) => s.sentinel)).toEqual([
      "executors:",
      "gate:",
      "worktree:",
      "test_paths:",
    ]);
    for (const s of sections) {
      const body = extractConfigSection(configYamlTemplate, s.sectionHeading);
      if (s.sentinel === "test_paths:") {
        // 0.8.0 dropped the test role and with it the test_paths section.
        expect(body).toBeNull();
        continue;
      }
      expect(body, s.sectionHeading).not.toBeNull();
      expect(body).toContain(s.sentinel);
    }
  });
});

// =============================================================================
// 0.3.0 — parallel child tasks, round caps restored (the conductor it added is gone in 0.4.0)
// =============================================================================

describe("0.3.0 manifest", () => {
  it("is reached from 0.2.0 with no file migrations", () => {
    expect(getAllMigrationVersions()).toContain("0.3.0");
    expect(getMigrationsForVersion("0.2.0", "0.3.0")).toEqual([]);
    expect(getMigrationMetadata("0.2.0", "0.3.0").breaking).toBe(false);
  });

  it("recorded the conductor config section, which 0.4.0 no longer ships", () => {
    const sections = getConfigSectionsAddedBetween("0.2.0", "0.3.0");
    expect(sections.map((s) => s.sentinel)).toEqual(["conductor:"]);
    expect(
      extractConfigSection(configYamlTemplate, sections[0].sectionHeading),
    ).toBeNull();
  });
});

// =============================================================================
// 0.4.0 — the conductor is gone; one main-agent session per task, codeg MCP by default
// =============================================================================

describe("0.4.0 manifest", () => {
  it("is reached from 0.3.0 and retires the conductor files", () => {
    expect(getAllMigrationVersions()).toContain("0.4.0");
    const migrations = getMigrationsForVersion("0.3.0", "0.4.0");
    expect(migrations.map((m) => [m.type, m.from])).toEqual([
      ["safe-file-delete", ".arbor/scripts/common/driver/conductor.py"],
      ["safe-file-delete", ".arbor/agents/conductor.md"],
    ]);
    expect(getMigrationMetadata("0.3.0", "0.4.0").breaking).toBe(false);
    expect(getConfigSectionsAddedBetween("0.3.0", "0.4.0")).toEqual([]);
    expect(configYamlTemplate).not.toContain("conductor");
  });
});

// =============================================================================
// 0.5.0 — delegation sync hook, mandate
// =============================================================================

describe("0.5.0 manifest", () => {
  it("is reached from 0.4.0 and adds the mandate config section", () => {
    expect(getAllMigrationVersions()).toContain("0.5.0");
    expect(getMigrationsForVersion("0.4.0", "0.5.0")).toEqual([]);
    expect(getMigrationMetadata("0.4.0", "0.5.0").breaking).toBe(false);
    const sections = getConfigSectionsAddedBetween("0.4.0", "0.5.0");
    expect(sections).toEqual([
      {
        file: ".arbor/config.yaml",
        sentinel: "mandate:",
        sectionHeading: "Mandate",
      },
    ]);
    const section = extractConfigSection(configYamlTemplate, "Mandate");
    expect(section).toContain("mandate:");
    expect(section).toContain("auto_merge_max_lines: 200");
  });
});

// =============================================================================
// 0.6.0 — parallel reader batches, test || implement lanes
// =============================================================================

describe("0.6.0 manifest", () => {
  it("is reached from 0.5.0, with no migrations and no config section", () => {
    expect(getAllMigrationVersions()).toContain("0.6.0");
    expect(getMigrationsForVersion("0.5.0", "0.6.0")).toEqual([]);
    expect(getMigrationMetadata("0.5.0", "0.6.0").breaking).toBe(false);
    expect(getConfigSectionsAddedBetween("0.5.0", "0.6.0")).toEqual([]);
  });
});

// =============================================================================
// 0.7.0 — ready set, integration branch, merge checks, merge asks by default
// =============================================================================

describe("0.7.0 manifest", () => {
  it("is reached from 0.6.0 without migrations, and the light mandate asks before merging", () => {
    expect(getAllMigrationVersions()).toContain("0.7.0");
    expect(getMigrationsForVersion("0.6.0", "0.7.0")).toEqual([]);
    expect(getMigrationMetadata("0.6.0", "0.7.0").breaking).toBe(false);
    expect(getConfigSectionsAddedBetween("0.6.0", "0.7.0")).toEqual([]);
    const section = extractConfigSection(configYamlTemplate, "Mandate");
    expect(section).toMatch(/light:\n(?: {4}\w+: \w+\n)*? {4}merge: ask\n/);
    expect(
      section
        .split("\n")
        .filter((l) => !l.startsWith("#"))
        .join("\n"),
    ).not.toContain("merge: auto");
  });
});

// =============================================================================
// 0.8.0 — v5: no test role, one REVIEW stage, codeg MCP only
// =============================================================================

describe("0.8.0 manifest", () => {
  it("is reached from 0.7.0 and retires the test role", () => {
    expect(getAllMigrationVersions()).toContain("0.8.0");
    expect(
      getMigrationsForVersion("0.7.0", "0.8.0").map((m) => [m.type, m.from]),
    ).toEqual([["safe-file-delete", ".arbor/agents/test.md"]]);
    expect(getMigrationMetadata("0.7.0", "0.8.0").breaking).toBe(true);
    expect(getConfigSectionsAddedBetween("0.7.0", "0.8.0")).toEqual([]);
    expect(configYamlTemplate).not.toMatch(/^test_paths:/m);
    expect(configYamlTemplate).not.toContain("codeg-cli");
    const mandate = extractConfigSection(configYamlTemplate, "Mandate");
    expect(mandate).not.toMatch(/^ {4}stop:/m);
  });
});

// =============================================================================
// 0.9.0 — lean REVIEW (no simplify step, recheck after a fix), task.py integrate
// =============================================================================

describe("0.9.0 manifest", () => {
  it("is reached from 0.8.0, with no file migrations", () => {
    expect(getAllMigrationVersions()).toContain("0.9.0");
    expect(getMigrationsForVersion("0.8.0", "0.9.0")).toEqual([]);
    const metadata = getMigrationMetadata("0.8.0", "0.9.0");
    expect(metadata.breaking).toBe(true);
    expect(metadata.changelog.join("\n")).toContain("task.py integrate");
    expect(getConfigSectionsAddedBetween("0.8.0", "0.9.0")).toEqual([]);
    expect(configYamlTemplate).toContain('#     - "pnpm test"');
  });
});

// =============================================================================
// 0.9.1 — review verifies its own findings, repros, light -> standard escalation, lessons.jsonl
// =============================================================================

describe("0.9.1 manifest", () => {
  it("is reached from 0.9.0, breaking, and deletes the verify role", () => {
    expect(getAllMigrationVersions()).toContain("0.9.1");
    const migrations = getMigrationsForVersion("0.9.0", "0.9.1");
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      type: "safe-file-delete",
      from: ".arbor/agents/verify.md",
    });
    const metadata = getMigrationMetadata("0.9.0", "0.9.1");
    expect(metadata.breaking).toBe(true);
    expect(metadata.recommendMigrate).toBe(true);
    const changelog = metadata.changelog.join("\n");
    for (const term of [
      "repro",
      "REPRO-n",
      "tier_lock",
      "lessons.jsonl",
      "max_parallel",
    ])
      expect(changelog).toContain(term);
    expect(getConfigSectionsAddedBetween("0.9.0", "0.9.1")).toEqual([]);
    expect(configYamlTemplate).toContain("max_parallel: 5");
  });
});

// =============================================================================
// 0.10.0 — roles run as Orca workers; codeg MCP, bind / collect and the sync hook are gone
// =============================================================================

describe("0.10.0 manifest", () => {
  it("is the package version, reached from 0.9.1, breaking, and deletes the codeg handoff", () => {
    expect(VERSION).toBe("0.10.0");
    expect(getAllMigrationVersions()).toContain("0.10.0");
    expect(
      getMigrationsForVersion("0.9.1", "0.10.0").map((m) => [m.type, m.from]),
    ).toEqual([
      ["safe-file-delete", ".arbor/scripts/common/driver/mcp.py"],
      ["safe-file-delete", ".claude/hooks/sync-delegation.py"],
      ["safe-file-delete", ".codex/hooks/sync-delegation.py"],
    ]);
    const metadata = getMigrationMetadata("0.9.1", "0.10.0");
    expect(metadata.breaking).toBe(true);
    expect(metadata.recommendMigrate).toBe(true);
    const changelog = metadata.changelog.join("\n");
    for (const term of ["worker-start", "arbor.py sync", "Report:", "workers"])
      expect(changelog).toContain(term);
    expect(getConfigSectionsAddedBetween("0.9.1", "0.10.0")).toEqual([]);
    expect(configYamlTemplate).toContain("default: orca\n");
    expect(configYamlTemplate).toContain("type: orca\n");
  });
});
