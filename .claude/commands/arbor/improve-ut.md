# Improve Unit Tests (UT)

Use this command to improve test coverage after code changes.

## Usage

```text
/arbor:improve-ut
```

## Source of Truth

The packages are listed in the `packages:` section of `.arbor/config.yaml`; their unit-test specs live in `.arbor/spec/<package>/unit-test/` (for `cli`: `.arbor/spec/cli/unit-test/index.md`).

Read each unit-test `index.md` and follow its **"Pre-Development Checklist"** section. Read all guideline files listed in the index.

> If this command conflicts with the unit-test specs, the specs win.

---

## Execution Flow

1. Inspect changes:
   - `git diff --name-only`
2. Decide test scope using unit-test specs:
   - What must be unit vs integration vs regression
   - What must be mocked vs real filesystem flow
3. Add/update tests accordingly (mirror existing test structure)
4. Run validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

5. Report coverage decisions and remaining gaps.

---

## Output Format

```markdown
## UT Coverage Plan
- Changed areas: ...
- Test scope (unit/integration/regression): ...

## Test Updates
- Added: ...
- Updated: ...

## Validation
- pnpm lint: pass/fail
- pnpm typecheck: pass/fail
- pnpm test: pass/fail

## Gaps / Follow-ups
- <none or explicit rationale>
```
