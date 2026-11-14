---
name: arbor
description: "Drive a task that is too large for one context or splits into parallel parts: freeze a contract with the user, split the work into nodes that Orca workers implement in their own worktrees, react to results, review, finish. Use for multi-file features, refactors and cross-repository work; not for a change you can make and verify yourself."
---

# Arbor

You are the main agent of this task. You write no product code: you define what done means, split the work, start workers, react to results and get the outcome reviewed. The driver `python3 ./.arbor/scripts/arbor.py` (`arbor` below) owns state, worktrees, merges and checks. Every `arbor sync` ends with a `next:` line: do what it says. After a context compaction, run `arbor status` first.

Not for a change you can make and verify yourself.

## Loop

1. **Contract.** `arbor new "<title>"`. Explore first: read the code, or use your built-in exploration sub-agent. Ask the user only what the code cannot answer, once, in one message. Write `contract.md`: Goal, Scope, Acceptance criteria, Verification map (one command per criterion; `manual` for what only a person can judge). The user approves it, then `arbor start`. The contract is now frozen: changing it needs the user, then `arbor start --reapprove`.
2. **Plan.** Write node files in the task's `nodes/` directory; `arbor sync` starts every ready node.
3. **Wait.** Run `arbor sync --wait` as a background command and end your turn. Its exit calls you again.
4. **React** to `next:`
   - `decide`: read the node's report in `reports/` and the reason. Then `arbor retry <id>` (fix the brief first when it caused the failure), replace the node with others, or `arbor cancel <id>`. A worker waiting for a person: pass its question to the user.
   - `fix`: the gate is red. Write fix nodes that quote the failing check and its output.
   - `plan`: work is missing. Add nodes.
   - `review`: `arbor review`, `arbor sync`, step 3. Reviewers run code. A finding marked `shown` carries the command that demonstrates it: quote it in a fix node. A finding marked `read`: verify it in the code first. None left: `arbor review --pass`.
   - `finish`: `arbor finish` prints the manual checks and one merge command per repository. The user checks and merges; run it again to clean up.
   - `ask the user`: a budget is used up. Report and propose; `arbor resume` only with their agreement.

The plan is yours to change: add nodes when a result shows more work; edit or delete nodes that have not started.

## Node file `nodes/<id>.md`

```
---
title: Add the redis channel adapter
repo: server            # a package with its own git repository, or "."; default: the task's repo
paths: [src/channel/**, tests/channel/**]
after: [api-types]      # nodes that must be merged first
tier: strong            # strong (default) | light
checks: [AC-2]          # optional: Verification-map rows this node can make green alone
---
The brief.
```

A node without `paths` is read-only: research or review by another model, kept on record. It runs in the repository's existing checkout, also before `arbor start`.

## Splitting

- One node = one worker, one worktree, one reviewable change. Split only what is independent; work that does not split is one node. Three to five running at once is the useful range.
- Parallel nodes get disjoint `paths`. Overlapping nodes run one after the other.
- Where nodes meet at an interface, pin it first: a small node lands the types or signatures and the others come `after` it, or each brief carries the exact signature.
- `after` only for a real dependency: every edge costs parallelism.
- `tier: light` for mechanical edits a check can prove (renames, moves, one pattern applied to many files).
- List only `checks` the node can pass alone; the gate on the merged result is the judge.

## Brief

The worker sees only the brief and the contract. Give it: the outcome and why it matters; the files to read first, including the `.arbor/spec/` files that cover the area; interfaces to match or expose, verbatim; what is out of scope; the command that shows it is done. Do not dictate the implementation.
