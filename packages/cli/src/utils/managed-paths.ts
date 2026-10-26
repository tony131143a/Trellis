import fs from "node:fs";
import path from "node:path";

import { isManagedPath, isManagedRootDir } from "../configurators/index.js";

export const ARBOR_BLOCK_START = "<!-- ARBOR:START -->";
export const ARBOR_BLOCK_END = "<!-- ARBOR:END -->";

/** Remove empty managed parents without deleting a managed root directory. */
export function cleanupEmptyDirs(cwd: string, dirPath: string): void {
  const dirPosix = dirPath.replace(/\\/g, "/");
  const segments = dirPosix.split("/");

  if (
    path.posix.isAbsolute(dirPosix) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    !isManagedPath(dirPosix) ||
    isManagedRootDir(dirPosix)
  ) {
    return;
  }

  const canonicalCwd = fs.realpathSync(cwd);
  const fullPath = path.resolve(canonicalCwd, ...segments);
  const relative = path.relative(canonicalCwd, fullPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return;
  }
  if (!fs.existsSync(fullPath)) return;

  try {
    const canonicalFullPath = fs.realpathSync(fullPath);
    const canonicalRelative = path.relative(canonicalCwd, canonicalFullPath);
    if (
      canonicalRelative === "" ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    ) {
      return;
    }

    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;

    if (fs.readdirSync(fullPath).length === 0) {
      fs.rmdirSync(fullPath);
      const parent = path.posix.dirname(dirPosix);
      if (parent !== "." && parent !== dirPosix && !isManagedRootDir(parent)) {
        cleanupEmptyDirs(cwd, parent);
      }
    }
  } catch {
    // Cleanup is best-effort; permission/race failures leave the directory.
  }
}

function getManagedBlock(
  content: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const start = content.indexOf(startMarker);
  if (start === -1) {
    return null;
  }

  const end = content.indexOf(endMarker, start);
  if (end === -1) {
    return null;
  }

  return content.slice(start, end + endMarker.length);
}

function replaceManagedBlock(
  existingContent: string,
  templateContent: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const existingStart = existingContent.indexOf(startMarker);
  if (existingStart === -1) {
    return null;
  }

  const existingEnd = existingContent.indexOf(endMarker, existingStart);
  if (existingEnd === -1) {
    return null;
  }

  const templateBlock = getManagedBlock(
    templateContent,
    startMarker,
    endMarker,
  );
  if (!templateBlock) {
    return null;
  }

  return (
    existingContent.slice(0, existingStart) +
    templateBlock +
    existingContent.slice(existingEnd + endMarker.length)
  );
}

/**
 * Merge the template's managed block into an existing root file: replace the
 * block in place when the file has one, otherwise append it below the user's
 * text. Text outside the block is never touched.
 */
export function mergeManagedBlockContent(
  existingContent: string,
  templateContent: string,
  startMarker: string,
  endMarker: string,
): string {
  const replaced = replaceManagedBlock(
    existingContent,
    templateContent,
    startMarker,
    endMarker,
  );
  if (replaced !== null) {
    return replaced;
  }

  const templateBlock = getManagedBlock(
    templateContent,
    startMarker,
    endMarker,
  );
  if (!templateBlock) {
    return templateContent;
  }

  const trimmed = existingContent.replace(/\s+$/, "");
  return `${trimmed}\n\n${templateBlock}\n`;
}
