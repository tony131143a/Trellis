# Spec Writing

Arbor specs are the rules of this repository for future agents: which parts exist, what each owns, how they interact, and how code is written among them. They explain how to work here, not how a generic project might be organized, and not what the code does line by line.

## What Belongs

Agents read the spec for an area before every task there. Each line costs context each time, and a line that describes one feature goes stale when that feature changes. Keep what stays true across features:

- The framework: the systems or modules, what each owns, how they interact (who may call whom, through which public surface, who owns a shared contract).
- Engineering rules: layering, ownership, transactions, error delivery, naming, how tests are organised.
- Checks and commands that are specific and reliable.

Leave out:

- How a single feature works: flows, state transitions, request and response fields, error codes, config keys. The code and its tests are the source.
- Target designs, decision records, migration status, history.
- What a guard already checks, beyond one line that states the rule and names the guard.

Test each candidate with two questions: would it still apply to a different feature in the same area, and will it still be true after the next few features land? A good spec doc changes rarely.

## Write From Evidence

Each important rule should be backed by one of these:

- A source file that demonstrates the preferred pattern.
- A test file that shows expected behavior.
- A project document that defines the convention.
- A repeated pattern across multiple files.

Name the file path and the symbol or behavior. Quote code only when a few lines make the rule clearer.

## File Structure

Keep the spec tree aligned with the project:

- Keep `index.md` as the navigation file for the spec directory.
- Split topics when developers would look for them independently.
- Merge topics when separate files would repeat the same rule.
- Delete template files that do not apply.
- Add new files for important local patterns the template missed.

## Content Standards

Good spec sections include:

- When the rule applies.
- The rule, as a sentence that says what must or must not happen, with the reason when it is not obvious.
- The source, test or guard that shows or enforces it.
- Common mistakes or anti-patterns.
- Verification commands or checks when they are specific and reliable.

Avoid:

- Placeholder prose.
- Generic framework advice.
- Tool instructions that only work in one agent host.
- Long copied code blocks.
- Signature, field or error-code tables copied from the code.
- Walkthroughs of how one feature works.
- Rules based on a single accidental implementation detail.

## Example Shape

```markdown
## Command Handlers

Command handlers should keep argument parsing, validation, and side effects separate. The local pattern is:

- Parse CLI flags at the command boundary.
- Convert raw inputs into typed task options before invoking core logic.
- Keep filesystem writes in the command or service layer, not in template helpers.

Reference files:
- `packages/cli/src/commands/example.ts`
- `packages/cli/test/commands/example.test.ts`

Avoid passing raw `process.argv` or unvalidated config objects into shared helpers.
```

## Final Pass

Before finishing:

```bash
grep -R "To be filled\\|TODO: fill\\|placeholder" .arbor/spec
```

Also check links, index files, and whether any spec still describes a template rather than this repository. Then read each doc once more and ask which lines would have to change if a single feature changed; those lines are feature detail and come out.
