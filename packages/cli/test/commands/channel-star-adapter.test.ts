import { describe, expect, it } from "vitest";

import {
  getAdapter,
  isProvider,
  listProviders,
} from "../../src/commands/channel/adapters/index.js";

// StarFactory (`star`) is a Claude Code-compatible fork. The adapter must be
// registered as its own provider (so `--provider star` resolves and the
// supervisor spawns the `star` binary) while reusing Claude's arg builder,
// parser, and encoders verbatim.
describe("star channel adapter registry", () => {
  it("is registered alongside claude and codex", () => {
    expect(isProvider("star")).toBe(true);
    expect(listProviders()).toEqual(
      expect.arrayContaining(["claude", "codex", "star"]),
    );
    expect(getAdapter("star").provider).toBe("star");
    // Registering star must not disturb the existing providers.
    expect(getAdapter("claude").provider).toBe("claude");
    expect(getAdapter("codex").provider).toBe("codex");
  });

  it("has no handshake and is ready immediately, like claude", () => {
    const star = getAdapter("star");
    expect(star.handshake).toBeUndefined();
    expect(star.isReady(star.createCtx())).toBe(true);
  });
});

describe("star channel adapter buildArgs", () => {
  const base = { cwd: "/repo" };

  it("builds the Claude-compatible stream-json print invocation", () => {
    const args = getAdapter("star").buildArgs({
      ...base,
      systemPrompt: "agent body",
    });
    expect(args).toContain("-p");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("agent body");
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("uses --append-system-prompt-file when the supervisor wrote a prompt file", () => {
    // star registers --append-system-prompt-file with hideHelp(); a probe with a
    // missing path fails with "Append system prompt file not found", so the
    // flag is honoured and oversized prompts can take the file route.
    const args = getAdapter("star").buildArgs({
      ...base,
      systemPrompt: "x".repeat(300_000),
      systemPromptFile: "/tmp/worker.system-prompt.md",
    });
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(
      "/tmp/worker.system-prompt.md",
    );
    expect(args).not.toContain("--append-system-prompt");
  });

  it("passes model and resume through", () => {
    const args = getAdapter("star").buildArgs({
      ...base,
      systemPrompt: "",
      model: "star-model-x",
      resume: "sess-123",
    });
    expect(args[args.indexOf("--model") + 1]).toBe("star-model-x");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-123");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("produces the same args as the claude adapter for the same view", () => {
    const view = {
      ...base,
      systemPrompt: "role",
      model: "m",
      resume: "r",
    };
    expect(getAdapter("star").buildArgs(view)).toEqual(
      getAdapter("claude").buildArgs(view),
    );
  });
});

describe("star channel adapter wire protocol", () => {
  it("parses Claude-shaped stream-json lines", () => {
    const star = getAdapter("star");
    const ctx = star.createCtx();
    const init = star.parseLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      ctx,
    );
    expect(init.side?.persistSessionId).toBe("s-1");

    const text = star.parseLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
      ctx,
    );
    expect(text.events).toEqual([
      { kind: "message", payload: { text: "hi" } },
    ]);
  });

  it("encodes user messages exactly like the claude adapter", () => {
    const star = getAdapter("star");
    const claude = getAdapter("claude");
    expect(star.encodeUserMessage("hello", star.createCtx())).toBe(
      claude.encodeUserMessage("hello", claude.createCtx()),
    );
  });

  it("encodes interrupts as a control_request followed by the user message", () => {
    // The interrupt frame carries a random request_id, so compare shape
    // rather than bytes.
    const star = getAdapter("star");
    const [control, user, trailing] = star
      .encodeInterruptMessage("stop", star.createCtx())
      .split("\n");
    expect(JSON.parse(control)).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    expect(user + "\n").toBe(star.encodeUserMessage("stop", star.createCtx()));
    expect(trailing).toBe("");
  });
});
