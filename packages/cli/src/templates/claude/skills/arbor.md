# Arbor

You are the main agent of this task. You write no product code: you define what done means, split the work, start workers, react to results and get the outcome reviewed. The driver `{{PYTHON_CMD}} ./.arbor/scripts/arbor.py` (`arbor` below) owns state, worktrees, merges and checks. Every `arbor sync` ends with a `next:` line: do what it says. After a context compaction, run `arbor status` first.

Not for a change you can make and verify yourself.

## Loop

1. **Contract.** `arbor new "<title>"`. Explore first, and note `path:symbol` anchors and what you ruled out as you go: they become the briefs: a question you can answer in a few reads, or one your built-in exploration sub-agent can, you answer yourself; a larger survey is a read-only node (see Node file), several in parallel when it spans repositories. Ask the user only what the code cannot answer, once, in one message. Write `contract.md`: Goal, Scope, Acceptance criteria, Verification map (one command per criterion; `manual` for what only a person can judge; not the repo gate restated: it runs on every merged result anyway). The user approves it, then `arbor start`. The contract is now frozen: changing it needs the user, then `arbor start --reapprove`.
2. **Plan.** Write node files in the task's `nodes/` directory; `arbor sync` starts every ready node.
3. **Wait.** Run `arbor sync --wait` as a background command and end your turn. Its exit calls you again.
4. **React** to `next:`
   - `decide`: read the node's report in `reports/` and the reason. Then `arbor retry <id>` (fix the brief first when it caused the failure; the new attempt gets the failed report too; a cancelled node can be retried too), `arbor rejudge <id>` when the work in its worktree is good and only the judgment was wrong (after you fixed the plan, the contract or the commits), replace the node with others, or `arbor cancel <id>`. A worker waiting for a person: pass its question to the user.
   - `inline`: a read-only node uses your own agent. Run each such node in your built-in sub-agent (in parallel, with the model named), have its result in the report file, then `arbor sync`.
   - `fix`: the gate is red. Write fix nodes that quote the failing check and its output.
   - Events to pass on: a `baseline … red before any change` line (the gate already fails at the task's base: ask the user whether the task fixes it), and `<ref> moved N commits past the task's integration branch` (the base moved on: merge it in early with a node, conflicts listed).
   - `plan`: work is missing. Add nodes.
   - `review`: `arbor review`, `arbor sync`, step 3. Reviewers run code. A finding becomes a fix node when it is a `blocker`, `shown` (quote its command in the fix node) and names the criterion or existing caller it breaks; a `read` finding that would qualify: verify it in the code first; every other finding is kept for the user at finish. None left: `arbor review --pass`. One review round is the default (`review_rounds`): after it, `next:` says no round is left; read the fix diff it names yourself, check that the fixes answer the findings, then `arbor review --pass`.
   - `finish`: `arbor finish` prints the manual checks, the reviewer reports, the task's corrections and one merge command per repository. Before the user merges, give them one summary: per acceptance criterion its evidence (the green gate check, or the manual check), the review findings not fixed, and the assumptions and brief corrections the worker reports name; for a manual row whose result an agent can produce (command output, a screenshot), produce it first with a read-only node and show the user the artifact. For each correction, ask whether the mistake would come back in another feature: if yes, record a rule with the `arbor-update-spec` skill; if no, nothing is recorded. The user checks and merges; run it again to clean up.
   - `ask the user`: a budget is used up. Report and propose; `arbor resume` only with their agreement.

The plan is yours to change: add nodes when a result shows more work; edit or delete nodes that have not started.

## Node file `nodes/<id>.md`

```
---
title: Add the redis channel adapter
repo: server            # a package with its own git repository, or "."; default: the task's repo
paths: [src/channel/**, tests/channel/**]
after: [api-types]      # nodes that must be merged first
tier: write             # write (default) | light | explore | review | a name from the config
checks: [AC-2]          # optional: Verification-map rows this node can make green alone
---
The brief.
```

A node without `paths` is read-only: research or review by another model, kept on record. Without `tier` it runs on the `explore` agent of the config when there is one, else on the `write` agent. It runs in the repository's existing checkout, also before `arbor start`.

## Splitting

- One node = one worker, one worktree, one reviewable change. Split only what is independent; work that does not split is one node. Three to five running at once is the useful range.
- Parallel nodes get disjoint `paths`. Overlapping nodes run one after the other.
- Where nodes meet at an interface, pin it first: a small node lands the types or signatures and the others come `after` it, or each brief carries the exact signature.
- `after` only for a real dependency: every edge costs parallelism.
- `tier: light` for mechanical edits a check can prove (renames, moves, one pattern applied to many files). Its brief lists every file and the exact pattern: a light worker should not need to explore.
- Exploration a writer would repeat, too large for your own reads, is a read-only node the writer comes `after`: its report is handed to the writer.
- List only `checks` the node can pass alone; the gate on the merged result is the judge.

## Brief

Hand over what you found, not a summary of it. The worker starts a fresh session with only the contract, the brief and the reports of the nodes it comes `after` (and of its own failed attempts): every read the brief does not carry, it pays for again.

- **Outcome**: what changes and why it matters; the command that shows it is done.
- **Anchors**: the places the work touches, as `path:symbol` (a line number only as a hint), each with one line on what is there: the code to change, its callers, the tests that cover it, the `.arbor/spec/` files for the area.
- **Exemplar**: one file that already does this the way the codebase wants it, as `path:symbol`; the worker copies its pattern.
- **Ruled out**: what you checked and rejected, and why.
- **First step**: the first concrete change, or the test or command that shows the problem, when you have seen it in the code.
- **Interfaces** to match or expose, verbatim; what is out of scope.
- **Open**: what you did not check: the worker's own exploration starts there.

Write only what you or a report actually read; point to a report section instead of retyping it. Beyond the first step, leave the implementation to the worker. A brief that needs more than a screen of anchors is a node to split.
