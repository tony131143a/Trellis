/**
 * Ownership-aware removal planning used by `uninstall`.
 *
 * The template hash manifest is the ownership boundary. This module deliberately
 * keeps planning pure with respect to mutations: it reads manifest-listed files,
 * runs the pure scrubbers below, and returns the exact post-removal content.
 *
 * Structured config files (settings.json / AGENTS.md / CLAUDE.md) go through a
 * scrubber that strips just the arbor fields, leaving user-added neighbors
 * intact. Each scrubber returns `{ content, fullyEmpty }`:
 * - `content` is the post-scrub text to write back if the file should remain.
 * - `fullyEmpty` is true when, after stripping every arbor-managed value,
 *   nothing meaningful is left. The caller deletes the file in that case.
 */

import fs from "node:fs";
import path from "node:path";

import { DIR_NAMES, FILE_NAMES } from "../constants/paths.js";
import { ALL_MANAGED_DIRS } from "../configurators/index.js";
import {
  cleanupEmptyDirs,
  ARBOR_BLOCK_END,
  ARBOR_BLOCK_START,
} from "./managed-paths.js";

export interface ScrubResult {
  content: string;
  fullyEmpty: boolean;
}

/**
 * Test whether a hook command string references any of the given manifest paths.
 *
 * Arbor-emitted hook commands always have the shape
 *   `<python-cmd> <manifest-path>`
 * so the trailing whitespace-delimited token is the script path. We compare
 * that last token (with surrounding quotes stripped) against the manifest
 * delete-set. This is intentionally stricter than substring matching: a
 * user-added hook whose body merely mentions a deleted path inside an `echo`
 * or comment argument (`echo "see .claude/hooks/session-start.py"`) does NOT
 * match, because the trailing token is `inspiration"` (or similar) — not the
 * path. We also accept absolute-path variants like
 * `/Users/me/proj/.claude/hooks/session-start.py` via `endsWith("/" + p)`.
 */
function commandMatchesDeletedPath(
  command: string,
  deletedPaths: readonly string[],
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  const tokens = trimmed.split(/\s+/);
  const lastToken = tokens[tokens.length - 1].replace(/^["']|["']$/g, "");
  if (lastToken.length === 0) return false;

  for (const p of deletedPaths) {
    if (lastToken === p || lastToken.endsWith("/" + p)) {
      return true;
    }
  }
  return false;
}

/** Read the `command` string out of an arbitrary hook entry. */
function getEntryCommand(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object") {
    return null;
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  return null;
}

const CLAUDE_ARBOR_STATUSLINE = ".claude/hooks/statusline.py";

function isArborClaudeStatusLine(
  value: unknown,
  deletedPaths: readonly string[],
): boolean {
  if (!deletedPaths.includes(CLAUDE_ARBOR_STATUSLINE)) return false;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const command = getEntryCommand(value);
  return (
    command !== null &&
    commandMatchesDeletedPath(command, [CLAUDE_ARBOR_STATUSLINE])
  );
}

/**
 * Scrub a Claude-style nested hooks settings JSON file:
 * `hooks.{Event}.[ {matcher?, hooks: [ {command,...} ]} ]`.
 *
 * Strips every entry whose command references a path in `deletedPaths`,
 * then bottom-up cleans empty containers (matcher block, event array, hooks
 * object). The exact opt-in Arbor Claude statusLine command is also removed;
 * other keys outside `hooks` (e.g. `env`, `model`, `permissions`) are
 * preserved.
 */
export function scrubHooksJson(
  content: string,
  deletedPaths: readonly string[],
): ScrubResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Malformed JSON — leave it untouched, caller will skip.
    return { content, fullyEmpty: false };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { content, fullyEmpty: false };
  }

  const root = parsed as Record<string, unknown>;
  if (isArborClaudeStatusLine(root.statusLine, deletedPaths)) {
    delete root.statusLine;
  }
  const hooks = root.hooks;

  if (hooks === undefined) {
    // No hooks block — nothing to scrub. Treat as fully empty only if the
    // entire file has no other keys.
    const fullyEmpty = Object.keys(root).length === 0;
    return { content: JSON.stringify(root, null, 2) + "\n", fullyEmpty };
  }

  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    // hooks is some unexpected shape — leave it alone.
    return { content, fullyEmpty: false };
  }

  const hooksObj = hooks as Record<string, unknown>;

  for (const eventName of Object.keys(hooksObj)) {
    const eventArr = hooksObj[eventName];
    if (!Array.isArray(eventArr)) continue;

    const filteredEvent: unknown[] = [];

    for (const entry of eventArr) {
      // entry is { matcher?, hooks: [...] }
      if (entry === null || typeof entry !== "object") {
        filteredEvent.push(entry);
        continue;
      }
      const matcherBlock = entry as Record<string, unknown>;
      const inner = matcherBlock.hooks;
      if (!Array.isArray(inner)) {
        filteredEvent.push(entry);
        continue;
      }

      const filteredInner = inner.filter((sub) => {
        const cmd = getEntryCommand(sub);
        return !(cmd !== null && commandMatchesDeletedPath(cmd, deletedPaths));
      });

      if (filteredInner.length === 0) {
        // Whole matcher block is now empty → drop the block.
        continue;
      }

      // Reconstruct the block with the filtered inner list.
      const rebuilt: Record<string, unknown> = { ...matcherBlock };
      rebuilt.hooks = filteredInner;
      filteredEvent.push(rebuilt);
    }

    if (filteredEvent.length === 0) {
      // Drop the whole event array.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete hooksObj[eventName];
    } else {
      hooksObj[eventName] = filteredEvent;
    }
  }

  // If hooks is empty → drop the key.
  if (Object.keys(hooksObj).length === 0) {
    delete root.hooks;
  } else {
    root.hooks = hooksObj;
  }

  const fullyEmpty = Object.keys(root).length === 0;
  return {
    content: JSON.stringify(root, null, 2) + "\n",
    fullyEmpty,
  };
}

export function scrubManagedMarkdownBlock(
  content: string,
  startMarker: string,
  endMarker: string,
): ScrubResult {
  const start = content.indexOf(startMarker);
  if (start === -1) {
    return { content, fullyEmpty: false };
  }

  const end = content.indexOf(endMarker, start);
  if (end === -1) {
    return { content, fullyEmpty: false };
  }

  const blockEnd = end + endMarker.length;
  const result = (content.slice(0, start) + content.slice(blockEnd))
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  const normalized = result.length > 0 ? `${result}\n` : "";

  return {
    content: normalized,
    fullyEmpty: normalized.trim().length === 0,
  };
}

export interface StructuredFileSpec {
  /** Manifest path (POSIX). */
  posixPath: string;
  /** Human-readable reason for the mixed-file edit. */
  reason: string;
  /** Pure scrubber for this path. */
  scrub: (content: string, deletedPaths: readonly string[]) => ScrubResult;
}

export interface PlannedDeletion {
  posixPath: string;
  absPath: string;
  missing: boolean;
}

export interface PlannedModification {
  posixPath: string;
  absPath: string;
  reason: string;
  result: ScrubResult;
}

export interface ManagedRemovalPlan {
  deletions: PlannedDeletion[];
  modifications: PlannedModification[];
  removeArborDir: boolean;
  allPosixPaths: string[];
}

export interface BuildManagedRemovalPlanOptions {
  /** Strict path/symlink handling (validates manifest keys, refuses escapes). */
  strictPaths?: boolean;
}

/** A safe lstat that distinguishes an absent path from a filesystem error. */
export function lstatIfPresent(absPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(absPath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function assertWithinProject(projectRoot: string, absPath: string): void {
  let root = path.resolve(projectRoot);
  let resolved = path.resolve(absPath);
  if (process.platform === "win32") {
    root = root.toLowerCase();
    resolved = resolved.toLowerCase();
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Managed path escapes project root: ${absPath}`);
  }
}

/**
 * Validate a manifest key before it reaches path.join/path.resolve.
 * Manifest keys are intentionally stricter than generic relative paths: empty,
 * dot, dotdot, NUL, absolute, and Windows-separator segments are not ownership
 * claims that Arbor can safely act on.
 */
export function validateManagedRelativePath(posixPath: string): void {
  if (
    posixPath.length === 0 ||
    posixPath.includes("\0") ||
    posixPath.includes("\\") ||
    path.posix.isAbsolute(posixPath) ||
    path.win32.isAbsolute(posixPath) ||
    /^[A-Za-z]:/.test(posixPath)
  ) {
    throw new Error(
      `Invalid managed manifest path: ${JSON.stringify(posixPath)}`,
    );
  }

  const segments = posixPath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Invalid managed manifest path: ${JSON.stringify(posixPath)}`,
    );
  }
}

/**
 * Reject parent symlink traversal outside the project while allowing a leaf
 * symlink to be treated as an opaque managed entry.
 */
export function assertSafeManagedPath(
  projectRoot: string,
  posixPath: string,
): string {
  validateManagedRelativePath(posixPath);
  const root = path.resolve(projectRoot);
  const segments = posixPath.split("/");
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    assertWithinProject(root, current);
    const stat = lstatIfPresent(current);
    if (!stat || index === segments.length - 1) continue;
    if (stat.isSymbolicLink()) {
      const realParent = fs.realpathSync(current);
      assertWithinProject(root, realParent);
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error(`Managed path parent is not a directory: ${posixPath}`);
    }
  }

  return current;
}

/**
 * Build the structured-file registry used by uninstall. Path ownership and
 * scrubber behavior both live in this module.
 */
export function buildStructuredFileSpecs(): Map<string, StructuredFileSpec> {
  const specs: StructuredFileSpec[] = [
    ...(
      [
        ".claude/settings.json",
        ".codex/hooks.json",
        ".starFactory/settings.json",
      ] as const
    ).map(
      (posixPath): StructuredFileSpec => ({
        posixPath,
        reason: "Strip arbor hooks; preserve user fields",
        scrub: (content, deletedPaths) => scrubHooksJson(content, deletedPaths),
      }),
    ),
    ...([FILE_NAMES.AGENTS, FILE_NAMES.CLAUDE] as const).map(
      (posixPath): StructuredFileSpec => ({
        posixPath,
        reason: "Strip Arbor managed block; preserve user instructions",
        scrub: (content) =>
          scrubManagedMarkdownBlock(
            content,
            ARBOR_BLOCK_START,
            ARBOR_BLOCK_END,
          ),
      }),
    ),
  ];

  return new Map(specs.map((spec) => [spec.posixPath, spec]));
}

/**
 * Build a removal plan from the authoritative v2 manifest. Structured files
 * are scrubbed only when they are regular files; a leaf symlink is opaque and
 * is therefore unlinked rather than dereferenced.
 */
export function buildManagedRemovalPlan(
  cwd: string,
  hashes: Record<string, string>,
  options: BuildManagedRemovalPlanOptions = {},
): ManagedRemovalPlan {
  const structured = buildStructuredFileSpecs();
  const allPosixPaths = Object.keys(hashes);
  const deletions: PlannedDeletion[] = [];
  const modifications: PlannedModification[] = [];

  for (const posixPath of allPosixPaths) {
    const absPath = options.strictPaths
      ? assertSafeManagedPath(cwd, posixPath)
      : path.join(cwd, ...posixPath.split("/"));
    const stat = options.strictPaths ? lstatIfPresent(absPath) : null;
    const spec = structured.get(posixPath);

    if (!spec) {
      deletions.push({
        posixPath,
        absPath,
        missing: options.strictPaths ? stat === null : !fs.existsSync(absPath),
      });
      continue;
    }

    if (options.strictPaths) {
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
        deletions.push({ posixPath, absPath, missing: stat === null });
        continue;
      }
    } else if (!fs.existsSync(absPath)) {
      deletions.push({ posixPath, absPath, missing: true });
      continue;
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const result = spec.scrub(content, allPosixPaths);
    if (
      options.strictPaths &&
      !result.fullyEmpty &&
      result.content === content
    ) {
      throw new Error(
        `Cannot prove Arbor content was removed from structured file: ${posixPath}`,
      );
    }
    if (result.fullyEmpty) {
      deletions.push({ posixPath, absPath, missing: false });
    } else {
      modifications.push({
        posixPath,
        absPath,
        reason: spec.reason,
        result,
      });
    }
  }

  return {
    deletions,
    modifications,
    removeArborDir: true,
    allPosixPaths,
  };
}

/**
 * Execute a removal plan: write scrubbed files, unlink deletions, remove
 * `.arbor/`, then clean up directories that became empty.
 */
export function executeManagedRemovalPlan(
  cwd: string,
  plan: ManagedRemovalPlan,
): { deletedFiles: number; modifiedFiles: number; deletedDirs: number } {
  let deletedFiles = 0;
  let modifiedFiles = 0;

  for (const modification of plan.modifications) {
    fs.writeFileSync(modification.absPath, modification.result.content);
    modifiedFiles += 1;
  }

  const deletedDirCandidates = new Set<string>();
  for (const deletion of plan.deletions) {
    if (deletion.missing) continue;
    try {
      fs.unlinkSync(deletion.absPath);
      deletedFiles += 1;
      deletedDirCandidates.add(path.posix.dirname(deletion.posixPath));
    } catch {
      // Preserve uninstall's best-effort behavior for individual unlink errors.
    }
  }

  let deletedDirs = 0;
  if (plan.removeArborDir) {
    const arborDir = path.join(cwd, DIR_NAMES.WORKFLOW);
    if (lstatIfPresent(arborDir)) {
      fs.rmSync(arborDir, { recursive: true, force: true });
      deletedDirs += 1;
    }
  }

  for (const dirPosix of deletedDirCandidates) {
    if (dirPosix === "." || dirPosix === "") continue;
    cleanupEmptyDirs(cwd, dirPosix);
  }

  const sortedManagedDirs = [...ALL_MANAGED_DIRS]
    .filter((dir) => dir !== DIR_NAMES.WORKFLOW)
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const managedDir of sortedManagedDirs) {
    const abs = path.join(cwd, ...managedDir.split("/"));
    if (!fs.existsSync(abs)) continue;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) continue;
      if (fs.readdirSync(abs).length !== 0) continue;
      fs.rmdirSync(abs);
      deletedDirs += 1;

      let parentPosix = path.posix.dirname(managedDir);
      while (parentPosix !== "." && parentPosix.length > 0) {
        const parentAbs = path.join(cwd, ...parentPosix.split("/"));
        if (!fs.existsSync(parentAbs)) break;
        if (fs.readdirSync(parentAbs).length !== 0) break;
        fs.rmdirSync(parentAbs);
        deletedDirs += 1;
        parentPosix = path.posix.dirname(parentPosix);
      }
    } catch {
      // Preserve uninstall's best-effort directory cleanup semantics.
    }
  }

  return { deletedFiles, modifiedFiles, deletedDirs };
}
