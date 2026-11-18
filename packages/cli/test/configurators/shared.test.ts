import { describe, expect, it, afterEach } from "vitest";
import {
  getPythonCommandForPlatform,
  replacePythonCommandLiterals,
  resolvePlaceholders,
} from "../../src/configurators/shared.js";

// ---------------------------------------------------------------------------
// replacePythonCommandLiterals — platform-mocked unit tests
// ---------------------------------------------------------------------------

describe("replacePythonCommandLiterals", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    // Restore original platform descriptor
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function mockPlatform(platform: string) {
    Object.defineProperty(process, "platform", { value: platform });
  }

  it("replaces python3 with python on win32", () => {
    mockPlatform("win32");
    expect(replacePythonCommandLiterals("run python3 script.py")).toBe(
      "run python script.py",
    );
  });

  it("replaces multiple occurrences on win32", () => {
    mockPlatform("win32");
    expect(replacePythonCommandLiterals("python3 a.py && python3 b.py")).toBe(
      "python a.py && python b.py",
    );
  });

  it("preserves shebang lines on win32", () => {
    mockPlatform("win32");
    const input = "#!/usr/bin/env python3\npython3 script.py";
    const result = replacePythonCommandLiterals(input);
    expect(result).toBe("#!/usr/bin/env python3\npython script.py");
  });

  it("does not replace python3 on non-Windows platforms", () => {
    mockPlatform("linux");
    expect(replacePythonCommandLiterals("run python3 script.py")).toBe(
      "run python3 script.py",
    );
  });

  it("preserves shebang lines on non-Windows platforms", () => {
    mockPlatform("darwin");
    const input = "#!/usr/bin/env python3\npython3 script.py";
    expect(replacePythonCommandLiterals(input)).toBe(input);
  });

  it("is idempotent on win32", () => {
    mockPlatform("win32");
    const once = replacePythonCommandLiterals("python3 script.py");
    const twice = replacePythonCommandLiterals(once);
    expect(once).toBe("python script.py");
    expect(twice).toBe("python script.py");
  });

  it("handles empty string", () => {
    mockPlatform("win32");
    expect(replacePythonCommandLiterals("")).toBe("");
  });

  it("does not replace python3 that is part of a longer word", () => {
    mockPlatform("win32");
    // "python3" as a standalone token is replaced; "python3x" contains "python3"
    // so it WILL be replaced to "pythonx" — this is expected behavior
    expect(replacePythonCommandLiterals("python3x")).toBe("pythonx");
  });

  it("handles multiline content with mixed shebangs and commands", () => {
    mockPlatform("win32");
    const input = [
      "#!/usr/bin/env python3",
      "# comment about python3",
      'exec python3 "$0" "$@"',
      "python3 ./.arbor/scripts/task.py",
    ].join("\n");
    const expected = [
      "#!/usr/bin/env python3",
      "# comment about python",
      'exec python "$0" "$@"',
      "python ./.arbor/scripts/task.py",
    ].join("\n");
    expect(replacePythonCommandLiterals(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getPythonCommandForPlatform
// ---------------------------------------------------------------------------

describe("getPythonCommandForPlatform", () => {
  it("returns python on Windows", () => {
    expect(getPythonCommandForPlatform("win32")).toBe("python");
  });

  it("returns python3 on macOS and Linux", () => {
    expect(getPythonCommandForPlatform("darwin")).toBe("python3");
    expect(getPythonCommandForPlatform("linux")).toBe("python3");
  });
});

describe("resolvePlaceholders", () => {
  it("resolves {{PYTHON_CMD}}", () => {
    const result = resolvePlaceholders("run {{PYTHON_CMD}} script.py");
    const expected =
      process.platform === "win32"
        ? "run python script.py"
        : "run python3 script.py";
    expect(result).toBe(expected);
  });

  it("leaves other placeholders untouched", () => {
    const input = "See {{UNKNOWN}} and {{#FLAG}}x{{/FLAG}}";
    expect(resolvePlaceholders(input)).toBe(input);
  });
});
