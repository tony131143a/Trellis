import { describe, expect, it } from "vitest";
import { DIR_NAMES, FILE_NAMES, PATHS } from "../../src/constants/paths.js";

// =============================================================================
// DIR_NAMES — constant structure
// =============================================================================

describe("DIR_NAMES", () => {
  it("has all expected keys", () => {
    expect(DIR_NAMES).toHaveProperty("WORKFLOW");
    expect(DIR_NAMES).toHaveProperty("WORKSPACE");
    expect(DIR_NAMES).toHaveProperty("TASKS");
    expect(DIR_NAMES).toHaveProperty("SPEC");
    expect(DIR_NAMES).toHaveProperty("SCRIPTS");
  });

  it("WORKFLOW is .arbor", () => {
    expect(DIR_NAMES.WORKFLOW).toBe(".arbor");
  });

  it("all values are non-empty strings", () => {
    for (const value of Object.values(DIR_NAMES)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// FILE_NAMES — constant structure
// =============================================================================

describe("FILE_NAMES", () => {
  it("has all expected keys", () => {
    expect(FILE_NAMES).toHaveProperty("AGENTS");
    expect(FILE_NAMES).toHaveProperty("CLAUDE");
  });

  it("all values are non-empty strings", () => {
    for (const value of Object.values(FILE_NAMES)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// PATHS — derived from DIR_NAMES + FILE_NAMES
// =============================================================================

describe("PATHS", () => {
  it("all paths start with DIR_NAMES.WORKFLOW", () => {
    for (const value of Object.values(PATHS)) {
      expect(value.startsWith(DIR_NAMES.WORKFLOW)).toBe(true);
    }
  });

  it("WORKSPACE is WORKFLOW/workspace", () => {
    expect(PATHS.WORKSPACE).toBe(
      `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.WORKSPACE}`,
    );
  });

  it("TASKS is WORKFLOW/tasks", () => {
    expect(PATHS.TASKS).toBe(`${DIR_NAMES.WORKFLOW}/${DIR_NAMES.TASKS}`);
  });

  it("SPEC is WORKFLOW/spec", () => {
    expect(PATHS.SPEC).toBe(`${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SPEC}`);
  });

  it("SCRIPTS is WORKFLOW/scripts", () => {
    expect(PATHS.SCRIPTS).toBe(`${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SCRIPTS}`);
  });

  it("uses / separator (not backslash)", () => {
    for (const value of Object.values(PATHS)) {
      expect(value).not.toContain("\\");
    }
  });
});
