# Arbor Brainstorm

## Non-Negotiable Planning Contract

A request to build, implement, fix, refactor, or "go ahead" is not approval to leave planning. Task-creation consent is also not implementation approval.

For every non-trivial task, the user must respond at least once after the initial request before implementation begins. If no clarification is needed, that response must approve the final planning summary described below.

While any user-owned product, scope, UX, compatibility, risk, or acceptance decision remains unresolved, end the turn with the open user-owned questions as ONE numbered list (each with the decision, why it matters, your recommendation, and the trade-off). Do not edit product code, run any build role, or run `task.py start`.

## Non-Negotiable Evidence Rule

If a question can be answered by exploring the codebase, explore the codebase instead.

This is mandatory. Before asking the user a question, first check whether the answer is already available in code, tests, configs, docs, existing specs, or task history.

Do not ask the user to confirm facts that the repository can answer. Ask only for product intent, preference, scope, risk tolerance, acceptance behavior, or decisions that remain ambiguous after inspection.

Repository evidence establishes current behavior and technical constraints. The user's intended behavior, feature scope boundaries, and UX preferences are never answerable by repository evidence alone, even when an existing pattern exists; existing patterns are options and recommendation evidence, not decisions.

---

Use this skill during Phase 1 (CONTRACT) to turn the user's request into an approved `contract.md` and the tier's other artifacts.

## Preconditions

Use this skill only after task-creation consent has been given and the user is ready to enter Arbor planning.

If no task exists yet, create one:

```bash
TASK_DIR=$({{PYTHON_CMD}} ./.arbor/scripts/task.py create "<short task title>" --description "<one-line summary>" --slug <slug> --tier <light|standard|full>)
```

`--tier` is the tier the user agreed to (light / standard / full; see the Tiers table in `.arbor/workflow.md`); omit it to let the tier follow the artifacts. Use a concise title from the user's request. Both the title and `--description` must be non-empty — `create` rejects blanks, and a record with either one empty is refused at archive. Use a slug without a date prefix. `task.py create` adds the `MM-DD-` directory prefix automatically.

`task.py create` writes a `contract.md` skeleton. Fill it with the current understanding before asking follow-up questions.

## Planning Flow

1. Capture the user's request and initial known facts in `contract.md` (Goal, Scope).
2. Inspect available evidence before asking questions:
   - code, tests, fixtures, and configs
   - README files, docs, existing specs, and domain notes
   - related Arbor tasks, research files, and session history when present
   - when a few files you read yourself do not answer it, run `explore` roles with `arbor.py run --role explore` with an explicit `--dispatch <id>` after writing each brief at the `brief_path` from `arbor.py next --role explore --json` (workflow step 1.1; no total quota), one aspect each; afterwards read only the 2-3 files you need for the next brief
3. Separate what you found into:
   - confirmed facts
   - product intent still needed from the user
   - scope or risk decisions still needed from the user
   - likely out-of-scope items
4. If user-owned decisions remain, ask all of them as ONE numbered list, each with your recommendation and trade-off, then stop. Do not perform implementation work in the same turn.
5. After the user's answers, update `contract.md` and ask again only about decisions the answers raised; recompute the decision inventory and repeat from step 2.
6. When no user-owned decision remains: write the acceptance criteria, the Verification map, the Interface pins and the Test paths. Light needs only `contract.md`. Standard: write `design.md` yourself (one `architect` with `Perspective: pragmatic` only if unfamiliar or asked). Full: run 3 `architect` roles, one `arbor.py run --role architect` each (workflow step 1.4), present their trade-offs with your recommendation, and after the user picks a design write `design.md`, the contract's Partitions / Waves, and `waves.md`.
7. Light: check that every acceptance criterion is testable and mapped. Standard / full: run the requirement convergence gate, then the contract convergence pass, then one review `Mode: plan` with `arbor.py run --role review --mode plan` (workflow step 1.6). These CONTRACT-phase dispatches run in the main checkout and commit nothing; read each reply in `reports/<id>.md`.
8. Present the final planning summary and stop. Do not run `task.py start` or edit product code in the same turn.
9. Only a subsequent user message that explicitly approves the latest contract authorizes `task.py start`. If the contract changes materially after approval, repeat the final review.

Do not invent a project-specific product/spec hierarchy. If the repository already has product, domain, or spec docs, use them. If it does not, proceed with the evidence that exists.

## Question Rules

Ask all open questions in one message as ONE numbered list.

Each item must include:

- the decision needed
- why the answer matters
- your recommended answer
- the trade-off if the user chooses differently

Do not ask process questions such as whether to search, inspect files, or continue brainstorming. Do the evidence work directly. Ask the user only when the remaining issue is a product decision, preference, scope boundary, or risk tolerance choice.

Recommendations are not default selections. Never choose a recommended product decision on the user's behalf merely because the user asked for implementation.

Do not manufacture clarification questions when the request and repository evidence already resolve every decision. In that case, proceed directly to the final planning summary, which still requires a subsequent explicit approval.

The final review is a required phase-transition gate, not a prohibited process question. Task-creation consent, the initial implementation request, and approval given before the latest final summary do not satisfy this gate.

## Thinking Framework: First Principles Analysis (standard / full)

When requirements are vague, solutions feel over-engineered, or you're about to add complexity "because everyone does" — decompose to fundamental truths before reasoning upward.

### Step 1: Restate the Problem

Strip away implementation details to one sentence.

> Bad: "We need to add Redis caching to the user profile endpoint"
> Good: "User profile data takes too long to load"

### Step 2: List Fundamental Truths

What is absolutely true (not opinion or convention)?

| Category | Examples |
|----------|----------|
| **Physical constraints** | Network latency ≥ 0, disk I/O has limits |
| **Business rules** | "Users must see their own data" |
| **Technical invariants** | "Data must be consistent" |
| **User needs** | "The user wants X within Y seconds" |

### Step 3: Challenge Assumptions

For each component of the current plan:

- **Fact or convention?** "We always use REST" — why?
- **What if we removed this?** If nothing breaks, it's unnecessary.
- **Solving the actual problem or a symptom?** Trace the causal chain.
- **Who benefits from this complexity?** If "nobody", simplify.

### Step 4: Build Up from Truths

1. Start with the minimum viable mechanism satisfying all truths
2. Add complexity only when a specific truth demands it
3. Each addition must answer: "Which truth requires this?"

### Step 5: Validate

- Does the solution solve the original problem?
- What assumptions need verification?
- What's the simplest experiment to test this?

## Requirement Convergence Gate

Before final review, verify all of the following:

- the user outcome and product value are explicit
- in-scope and out-of-scope behavior are explicit
- acceptance criteria describe observable outcomes
- user-owned product, scope, UX, compatibility, and risk decisions are resolved
- blocking open questions are empty
- technical unknowns are researched or explicitly deferred without changing MVP behavior

Light tasks skip `design.md`, `waves.md`, the first-principles analysis and the contract convergence pass; they may not skip evidence inspection, testable and mapped acceptance criteria, the final planning summary, or a fresh contract approval.

The final planning summary must show Goal, In Scope, Out of Scope, Acceptance Criteria with their checks, Key Decisions, relevant Risks or Deferred Items, and artifact status.

## Artifact Rules

`contract.md` records what done looks like and how it is checked (the driver parses these headings):

- `## Goal` — one paragraph: the user outcome and its value
- `## Scope` — in / out
- `## Acceptance criteria` — `AC-n: Given <precondition> When <action> Then <observable result>`
- `## Verification map` — one row per criterion: `id | kind | check | file`; `auto` rows carry a command that fails before the change and passes after
- `## Interface pins` — the signatures, paths and CLI / HTTP shapes the tests will call ("existing interfaces" is fine for light)
- `## Test paths` — optional; the globs the `test` role owns
- `## Partitions` / `## Waves` — optional; full tasks that split the work

Open questions do not belong in the contract; ask them and fold the answers in.

`design.md` records technical design for standard and full tasks:

- architecture and boundaries
- data flow and contracts
- compatibility and migration notes
- important trade-offs
- operational or rollback considerations

`waves.md` records, for full tasks, the chosen architect design's partitions and wave order with the reasoning (the contract's `## Partitions` / `## Waves` are the machine-readable part).

Light tasks have only `contract.md`. Standard tasks add `design.md`; full tasks add `waves.md`. `task.py start` checks this.

The roles receive only what the driver injects: the manifest entries (`implement.jsonl` feeds `architect`, `test` and `implement`; `check.jsonl` feeds `review`, `verify`, `fix`, and `simplify`), the contract, the design and the diff, so `implement.jsonl` and `check.jsonl` must each contain at least one real spec/research entry before `task.py start`; an empty manifest, or one holding only a legacy `_example` placeholder row, does not count. Fill them with `task.py seed-context <task> [--package <pkg> ...]` (spec layer index files, the guides index, and the task's research files; idempotent), then add or drop entries per side.

## Contract Convergence Pass (standard / full)

Before declaring planning ready or running `task.py start`, rewrite `contract.md` once against the final structure described in the artifact rules above. This is not optional cleanup; it is the final planning gate.

The pass must be lossless:

- Collapse repeated facts into one authoritative section.
- Fold temporary brainstorm notes such as `What I already know`, `Assumptions`, and resolved questions into Goal, Scope, Acceptance criteria or Interface pins; technical detail goes to `design.md`.
- Remove resolved open questions instead of leaving empty or already-answered sections.
- Merge parallel bug and requirement lists when they describe the same work; keep each defect's severity, evidence, and file:line anchors on the owning requirement.
- Preserve every file:line anchor, decision, constraint, AC id, and Verification map row.
- Do not proceed to final review while any blocking open question remains.

After the pass, read `contract.md` top to bottom and verify that no fact is repeated across sections unless the repetition adds new information.

## Quality Bar

Before declaring planning ready:

- `contract.md` has testable acceptance criteria, each with a Verification map row, and non-empty Interface pins.
- Standard / full: `contract.md` has passed the contract convergence pass and a review `Mode: plan`: no temporary brainstorm notes, no duplicate facts across sections, and no lost anchors, decisions, or map rows.
- Repository-answerable questions have already been answered through inspection.
- Blocking open questions are empty.
- Standard tasks have `design.md`; full tasks have `design.md` and `waves.md`.
- Both `implement.jsonl` and `check.jsonl` have real curated entries; manifests holding only a legacy `_example` row are not ready.
- The latest final planning summary has been presented to the user.
- In a subsequent message, the user explicitly approved that contract.

Do not run `task.py start` merely because the user originally asked for implementation.

Independent explore and architect questions can run concurrently in CONTRACT. The main agent chooses angles, uses dispatch-prefixed research files, collects all relevant results and consolidates the plan. Architecture perspectives are not limited to a fixed set or count.
