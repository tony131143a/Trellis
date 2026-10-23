/**
 * Shared hook templates — platform-independent Python hook scripts.
 *
 * These scripts read only from .arbor/ paths (JSONL, prd.md, spec/) and
 * have no platform-specific placeholders. They can be written as-is to any
 * platform's hooks directory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readTemplate(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf-8");
}

export interface HookScript {
  /** Filename (e.g., "session-start.py") */
  name: string;
  /** Script content — no placeholders, ready to write directly */
  content: string;
}

export type SharedHookName =
  | "session-start.py"
  | "inject-shell-session-context.py"
  | "inject-workflow-state.py"
  | "inject-delegation-context.py"
  | "guard-builtin-agent.py";

export type SharedHookPlatform = "claude" | "star";

/**
 * Which shared hooks each platform actually invokes. Single source of truth
 * for shared-hook distribution — `collectSharedHooks` reads this table, and
 * both `arbor init` and `arbor update` consume the map it returns.
 *
 * Routing rules encoded here:
 * - `session-start.py` — shipped by every platform with a SessionStart
 *   hook event.
 * - `inject-workflow-state.py` — every platform with a UserPromptSubmit
 *   (or equivalent) event.
 * - `inject-delegation-context.py` — PreToolUse on codeg
 *   `delegate_to_agent`: inlines Arbor task context into the delegated
 *   `task` text for the implement / check / research roles.
 * - `guard-builtin-agent.py` — PreToolUse on the built-in `Agent|Task` tool:
 *   denies Arbor role dispatches that bypass codeg.
 * - `inject-shell-session-context.py` — platforms with a hook that fires
 *   *before* a shell command and receives both the session id and the pending
 *   command. That hook is the only channel by which session identity reaches
 *   `task.py`, which runs in the shell child. Declaring a platform here also
 *   requires an entry in its own hook config template — `shared-hooks.test.ts`
 *   fails the build when the two disagree, because a script on disk that
 *   nothing invokes is indistinguishable from success.
 * - Claude Code `statusLine` is intentionally not installed by default.
 *   Users can add their own statusLine command in `.claude/settings.json`,
 *   or opt in to the Arbor one via `arbor init --with-statusline`
 *   (installed from `templates/claude/hooks/`, not from this table — no
 *   other platform has a statusLine event).
 */
export const SHARED_HOOKS_BY_PLATFORM: Record<
  SharedHookPlatform,
  readonly SharedHookName[]
> = {
  claude: [
    "session-start.py",
    "inject-workflow-state.py",
    "inject-delegation-context.py",
    "guard-builtin-agent.py",
  ],
  // StarFactory is a Claude Code-compatible fork and ships the same set as
  // Claude Code. Verified on star 1.0.49: SessionStart, UserPromptSubmit, and
  // PreToolUse all fire, and PreToolUse can rewrite tool input, so the
  // delegation-context and built-in-agent guard hooks work unchanged. It also
  // takes inject-shell-session-context.py: unlike Claude Code, StarFactory
  // exports no session id into its shell children (a live probe of a Bash
  // child found only CLAUDECODE / CLAUDE_CONFIG_DIR / STARFACTORY_*), so
  // PreToolUse matcher Bash is its only route to session identity.
  star: [
    "session-start.py",
    "inject-shell-session-context.py",
    "inject-workflow-state.py",
    "inject-delegation-context.py",
    "guard-builtin-agent.py",
  ],
};

/**
 * Get all shared hook scripts. Content is platform-independent and can be
 * written directly without placeholder resolution.
 */
export function getSharedHookScripts(): HookScript[] {
  const scripts: HookScript[] = [];
  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".py"))
    .sort();

  for (const file of files) {
    scripts.push({ name: file, content: readTemplate(file) });
  }

  return scripts;
}

/**
 * Get the shared hook scripts that a given platform actually registers.
 * Drives `collectSharedHooks` so distribution never drifts from the
 * per-platform capability declared above.
 */
export function getSharedHookScriptsForPlatform(
  platform: SharedHookPlatform,
): HookScript[] {
  const allowed = new Set<string>(SHARED_HOOKS_BY_PLATFORM[platform]);
  return getSharedHookScripts().filter((h) => allowed.has(h.name));
}
