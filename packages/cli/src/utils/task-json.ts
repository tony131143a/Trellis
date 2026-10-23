/**
 * Canonical task.json shape — single source of truth shared by all TS
 * writers.
 *
 * The runtime Python writer is `.trellis/scripts/common/task_store.py`
 * (`cmd_create`). The 24-field shape and field order below mirror that
 * writer exactly so every TS and Python entry point produces structurally
 * identical task.json files.
 */

export interface TrellisTaskRecord {
  id: string;
  name: string;
  title: string;
  description: string;
  status: string;
  dev_type: string | null;
  scope: string | null;
  package: string | null;
  priority: string;
  creator: string;
  assignee: string;
  createdAt: string;
  completedAt: string | null;
  branch: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  commit: string | null;
  pr_url: string | null;
  subtasks: string[];
  children: string[];
  parent: string | null;
  relatedFiles: string[];
  notes: string;
  meta: Record<string, unknown>;
}

/**
 * Produce a fully-populated canonical-shape {@link TrellisTaskRecord}.
 *
 * All 24 fields are present in canonical order. `overrides` shallow-merges
 * over the defaults — callers supply per-task values (id, name, title,
 * assignee, createdAt, etc.) and leave null-default fields untouched
 * unless they have a real value.
 */
export function emptyTaskRecord(
  overrides: Partial<TrellisTaskRecord> = {},
): TrellisTaskRecord {
  const today = new Date().toISOString().split("T")[0] ?? "";
  const base: TrellisTaskRecord = {
    id: "",
    name: "",
    title: "",
    description: "",
    status: "planning",
    dev_type: null,
    scope: null,
    package: null,
    priority: "P2",
    creator: "",
    assignee: "",
    createdAt: today,
    completedAt: null,
    branch: null,
    base_branch: null,
    worktree_path: null,
    commit: null,
    pr_url: null,
    subtasks: [],
    children: [],
    parent: null,
    relatedFiles: [],
    notes: "",
    meta: {},
  };
  const record = { ...base, ...overrides };
  if (overrides.subtasks !== undefined) {
    record.subtasks = [...overrides.subtasks];
  }
  if (overrides.children !== undefined) {
    record.children = [...overrides.children];
  }
  if (overrides.relatedFiles !== undefined) {
    record.relatedFiles = [...overrides.relatedFiles];
  }
  if (overrides.meta !== undefined) {
    record.meta = cloneJsonObject(overrides.meta, "task.meta");
  }
  return record;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function cloneJsonObject(
  value: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = cloneJsonValue(child, `${path}.${key}`);
  }
  return out;
}

function cloneJsonValue(value: unknown, path: string): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite JSON number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      cloneJsonValue(item, `${path}[${index}]`),
    );
  }
  if (isPlainObject(value)) {
    return cloneJsonObject(value, path);
  }
  throw new Error(`${path} must contain only JSON values`);
}

export type TaskJson = TrellisTaskRecord;

export const emptyTaskJson = emptyTaskRecord;
