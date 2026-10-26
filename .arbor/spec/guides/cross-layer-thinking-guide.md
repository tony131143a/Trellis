# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:

- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:

- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary              | Common Issues                     |
| --------------------- | --------------------------------- |
| API ↔ Service         | Type mismatches, missing fields   |
| Service ↔ Database    | Format conversions, null handling |
| Backend ↔ Frontend    | Serialization, date formats       |
| Component ↔ Component | Props shape changes               |

### Step 3: Define Contracts

For each boundary:

- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

### Mistake 4: Every Consumer Parses The Same Payload

**Bad**: A command reads `task.json` and casts fields inline:

```typescript
const branch = (data as { branch?: string }).branch;
const children = (data as { children?: string[] }).children;
```

This looks local, but it means every consumer owns a private version of the
`task.json` contract. The next field change will update one command and miss
another.

**Good**: Decode once at the data boundary, then export typed projections. On
the Python side that owner is `tasks.py:load_task`, which returns a typed
`TaskInfo`; on the TypeScript side it is `utils/task-json.ts`:

```python
task = load_task(task_dir)
if task is None:
    return False
return task.branch == wanted_branch
```

**Rule**: For append-only logs, JSON streams, RPC payloads, or config files,
create one owner for:

- event / payload type definitions
- type guards and normalization from `unknown`
- metadata projections used by UI commands
- reducers that replay state from the source of truth

Rendering code may format fields, but it must not redefine the payload contract.

---

## Checklist for Cross-Layer Features

Before implementation:

- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens

After implementation:

- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip
- [ ] Checked that consumers import shared decoders / projections instead of
      casting payload fields locally
- [ ] Checked that derived state points back to the source event identifier
      (`seq`, `id`, `version`) instead of inventing a second position marker

---

## Cross-Platform Template Consistency

Arbor installs for two main-agent platforms, Claude Code (`.claude/`) and StarFactory (`.starFactory/`). Command and skill bodies live once under `packages/cli/src/templates/common/` and are rendered per platform by `resolveCommands` / `resolveSkills`. Only the platform's `settings.json` (`templates/claude/`, `templates/star/`) and the hook list in `templates/shared-hooks/index.ts` are written separately. That pair is the cross-layer boundary.

### Checklist: After Modifying A Hook Or Settings Template

- [ ] Edit the shared source (`common/` or `shared-hooks/`) once, not a rendered copy
- [ ] Compare `templates/claude/settings.json` and `templates/star/settings.json`; a difference must be intentional (StarFactory registers `inject-shell-session-context.py`, Claude Code does not)
- [ ] Check `SHARED_HOOKS_BY_PLATFORM` agrees with what each settings file invokes
- [ ] Mirror the change into this repo's installed `.claude/` copy

**Real-world example**: StarFactory needs the shell-ticket hook because it exports no session id into shell children, while Claude Code resolves identity through `CLAUDE_ENV_FILE`. Copying Claude's hook list verbatim into the StarFactory settings would have left `task.py start` without a session.

---

## Generated Runtime Template Upgrade Consistency

Some generated files are both documentation and runtime input. In Arbor,
`.arbor/workflow.md` is parsed by `get_context.py`, `workflow_phase.py`,
SessionStart filters, and per-turn hooks. Template changes must be validated
against both fresh init and upgrade paths.

### Checklist: After Modifying A Runtime-Parsed Template

- [ ] Identify every runtime parser that reads the template, not just the file
      writer that installs it
- [ ] Check whether relevant syntax lives outside obvious managed regions
      such as tag blocks
- [ ] Verify fresh `init` output and a versioned `update` scenario that writes
      the older `.arbor/.version`
- [ ] Add an upgrade regression using an older pristine template fixture, then
      assert the installed file reaches the current packaged shape
- [ ] Update the backend spec that owns the runtime contract

**Real-world example**: Workflow platform markers (`[Claude Code, StarFactory]` blocks) changed in a template. Fresh init was correct, but an `arbor update` that only merged `[workflow-state:*]` blocks preserved stale markers outside those blocks. Result: upgraded projects got new hook scripts but old workflow routing, so `get_context.py --mode phase --platform star` could return empty step detail. The fix was whole-file `workflow.md` updates; see `cli/backend/migrations.md`.

---

## Remote Probe Checklist

When a script probes a remote resource to make a decision (for example the update-hint check in session scripts):

- [ ] 404 vs transient error are distinguished — don't treat both as "not found"
- [ ] Transient errors **abort or retry**, never silently switch behavior
- [ ] Optional probes stay silent on failure and never consume once-per-session markers
- [ ] Metadata reads consume a complete response or use a streaming parser — never parse a fixed-size prefix as full JSON

**Real-world example**: Agent-session update hints fetched npm `latest` metadata with `response.read(4096)` and then parsed it as complete JSON. The `@tony131143a/arbor` package metadata exceeded 4 KB, so the JSON was truncated, parse failed silently, and the first session injection showed no update hint. Fix: read the complete response before parsing, and add a regression where `version` is followed by an 8 KB metadata tail.

---

## When to Create Flow Documentation

Create detailed flow docs when:

- Feature spans 3+ layers
- Multiple teams are involved
- Data format is complex
- Feature has caused bugs before
