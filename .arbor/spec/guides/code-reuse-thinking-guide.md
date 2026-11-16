---
sources: []
last_verified: 2026-11-13
---
# Code Reuse Thinking Guide

> **Purpose**: Stop and think before creating new code: does it already exist?

Duplicated code is the main source of inconsistency bugs: fixes do not propagate and behavior diverges.

## Before Writing New Code

Search first (`grep -r` for similar names and logic), then ask:

- Does a similar function exist? Use or extend it.
- Is this pattern used elsewhere? Follow it.
- Could this be a shared utility? Create it in the right place.
- Am I copying code from another file? Stop and extract it.
- Am I defining a constant that exists elsewhere? Keep one source of truth.
- Is a new component 80% like an existing one? Extend it with props or variants.

## When to Abstract

- Abstract when the same code appears 3+ times, the logic is complex enough to have bugs, or several people need it.
- Do not abstract a one-off, a trivial one-liner, or when the abstraction would be more complex than the duplication.

## Shared Contracts

- Is the same untyped payload field read in 2+ places with local casts? Put a type guard, normalizer or projection next to the data owner before adding a third reader.
- Is state derived from action-like values (`action`, `kind`, `status`, `phase`)? One reducer with one `switch` owns the transitions; display code and commands do not duplicate pieces of that replay model.
- Adding a value to a Python `Literal` type? Python has no exhaustive check, so search every `if/elif/else` chain that switches on it and add an explicit branch; an unknown value raises instead of falling into `else`.
- Do two mechanisms have to produce the same output (a directory copy and a hand-kept list)? Make one call the other; if the asymmetry cannot be removed, add a test comparing both outputs. When moving a directory structure, search for every code path that references the old one.

## Arbor Template Scripts

- A new file under `packages/cli/src/templates/arbor/scripts/` is registered once, in `getAllScripts()` (`src/templates/arbor/index.ts`); `commands/update.ts` iterates that map, and an unregistered script is never synced to user projects.
- `.arbor/scripts/` and the template tree stay identical (test-enforced, see `cli/backend/script-conventions.md` → "Two script trees, one content"). Edit the template, then sync, double-checking source and destination:

```bash
rsync -av --delete --exclude='__pycache__' packages/cli/src/templates/arbor/scripts/ .arbor/scripts/
```

## After Batch Modifications

Did you catch all instances? Grep for any you missed, and consider whether the change should be abstracted.

## Checklist Before Commit

- [ ] Searched for existing similar code
- [ ] No copy-pasted logic that should be shared
- [ ] No repeated untyped payload field extraction outside a shared decoder
- [ ] Constants defined in one place
- [ ] Similar patterns follow the same structure
- [ ] Reducer/action transitions live in one reducer or command dispatcher
