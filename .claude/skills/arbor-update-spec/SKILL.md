---
name: arbor-update-spec
description: "Decides whether something learned belongs in .arbor/spec/ and, when it does, records it as a short rule that holds across features. Use after a task, bug fix or review surfaced a convention, a module boundary or a recurring mistake, when a spec doc disagrees with the code, or when asked to update, trim or re-verify spec docs. Not for documenting how a single feature works."
---

# Update Spec

`.arbor/spec/` holds the rules of this codebase: what stays true whichever feature is being built. Use this when a task, a fix, a review or a discussion surfaced something that may belong there, or when a spec doc no longer matches the code.

Most of what a task teaches does not belong in the spec. Decide that first; then write the part that does belong as a short rule.

## Why the spec stays small

Every agent reads the spec for an area before touching it, on every task. A line there costs context each time, and a line that describes how one feature behaves is out of date as soon as that feature changes. A stale line is worse than a missing one, because it is trusted. The code and its tests already say exactly how a feature behaves, and they cannot drift from themselves.

So the spec is the abstract layer: which parts exist, what each owns, how they interact, and the rules for writing code among them. A good spec doc changes rarely. A doc that has to change whenever a feature changes is holding the feature, not the rules.

## Does it belong

Two questions decide it:

- Would it still apply to a different feature in the same area?
- Will it still be true after the next few features land?

Both yes: it is a rule. Otherwise it goes elsewhere.

| What you have | Where it goes |
| --- | --- |
| An engineering rule that holds across features: layering, ownership, transactions, error delivery, naming, how tests are organised | The layer doc for that topic |
| Which systems or modules exist, what each owns, how they interact: who may call whom, through which public surface, who owns a shared contract | The system or architecture doc |
| A question worth asking before writing code | `guides/`, as a checklist item |
| How one feature works: its flow, timing, state transitions, request and response fields, error codes, config keys | Not the spec. The code and its tests are the source; if the behaviour needs protecting, write a test |
| A target design, a decision record, a migration plan, what is not done yet, how things used to be | Not the spec. Design docs, the task directory, git history |
| A rule a machine can check | A guard: a lint rule, an architecture test, a script. The spec keeps one line that states the rule and names the guard |
| A mistake made once, with no general rule behind it | Nowhere |

Module interaction belongs at the level of direction and ownership: "the edge layer translates protocols and owns no tables", "consumers import the event contract, never the producer". The sequence of calls that serves one request does not belong.

When nothing qualifies, change nothing and say so. That is a normal outcome, and the common one after a feature.

## Writing a rule

- One sentence that says what must or must not happen. Add the reason when it is not obvious: a rule with its reason gets applied correctly to cases nobody listed.
- Point at what enforces it or shows it: the guard, or one file that does it right. Name the path and the symbol; do not paste the code.
- No signatures, field tables or error matrices. They are the code, copied, and the copy is the part that goes stale.
- Before writing "all", "every", "never" or "does not exist", open each call site. If you checked only some, word the rule for those.
- Write what holds now. No status notes ("not migrated yet", "planned"), no decision numbers, no history.

## Examples

**A refund endpoint was added**, with its request fields and a conflict response when the order is already refunded.
Nothing to write. The schema and the route tests hold all of it, and no other feature would follow these lines.

**A handler kept a database transaction open across an HTTP call**, and the pool ran dry under load.
One rule in the layer's database or consistency doc: "No network, file or queue I/O inside a transaction: commit, do the I/O, then record the result in a second transaction." If the doc already says so, the code was the defect and the spec does not change.

**A new module went in** that two existing modules call through a port.
The architecture doc gets its row (the module, what it owns) and its place in the dependency direction. How its calls are sequenced stays in the code.

**The team decided to move event delivery to a message stream next quarter.**
Not the spec. It is a plan: it goes to the design docs. When the code lands, the architecture doc gets one line on what the stream may carry.

**The doc says every router wraps its handlers in the error translator; one router does not.**
Read that router. If it is exempt on purpose, reword the rule to name the exemption. If it is an oversight, the rule stands and the code is the defect to report.

## Making the edit

1. Read the target doc and its `index.md`. The rule may already be there, or there may be a sentence to tighten where you were about to add one.
2. Prefer changing or deleting over adding, and remove what the change made false.
3. Put a new rule where a reader looking for that topic would look. A new doc is for a new topic, and it gets a row in the layer's `index.md`.
4. Compare the doc before and after. Growth beyond the rule itself usually means feature detail came along with it: take that back out.
5. Check every path, symbol and command you wrote against the repository.

Keep to what this task surfaced. When you notice something else on the way (another doc that disagrees with the code, a doc that lint reports `stale`, feature detail sitting next to your change), report it and leave it. A correction made in passing was not checked with the care a task of its own would give it, and the spec is meant to move in small steps that someone can review.

## When the spec and the code disagree

The code is what runs, so work from the code. Then look at the sentence that was wrong. If it was a rule and the code breaks it, that is a defect in the code: report it and leave the rule. If it was describing behaviour, delete it; updating it only makes it wrong again later.

## Metadata

Layer docs (not `index.md`, not `guides/`) open with a frontmatter block:

```markdown
---
sources:
  - src/commands/example.ts
last_verified: 2026-10-21
---
```

- `sources`: repo-relative paths or globs of the code that embodies the doc's rules: the module, the guard, the config. Keep it narrow. The doc is reported `stale` when any source has a commit newer than `last_verified`, so a whole test directory or a design document keeps it stale for good and the signal is lost.
- `last_verified`: when the doc was last re-checked against its sources. Do not hand-edit it. After you update a doc, or re-check one you were asked to re-check, stamp it:

```bash
python3 ./.arbor/scripts/spec.py verify .arbor/spec/<layer>/<doc>.md
```

`python3 ./.arbor/scripts/spec.py lint` reports `missing-metadata`, `dead-source`, `broken-link`, `stale`, `placeholder`, `missing-section` and `unlisted-doc` findings. `spec.py init-meta <doc>` seeds the block on a doc that lacks one. All of it is advisory: fix what a finding names, it never blocks.

## Report

Say what changed in the spec, in one line per doc. For what you left out, say where it lives instead (the code, a test, a design doc), so the reader can see it was a decision and not an omission.
