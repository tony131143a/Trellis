---
sources: []
last_verified: 2026-11-13
---
# Cross-Platform Thinking Guide

> **Purpose**: Catch platform-specific assumptions before they become bugs.

Most cross-platform bugs come from implicit assumptions: that the shebang works, that `/` is the separator, that line endings are `\n`, that `grep` exists, that UTF-8 is the default. If it is not explicit, it is an assumption.

## 1. Script Execution

Shebangs and `./script.py` do not work on Windows, and `python3` may not exist there (`python` usually does).

- User-facing docs, help text and error messages either state the rule (`python` on Windows, `python3` elsewhere) or render the command through the same `{{PYTHON_CMD}}` placeholder the code uses.
- Config generated at init time uses the placeholder, resolved by platform detection; JavaScript that calls Python at runtime chooses the command by platform.
- When Python must be verified as installed, render and execute exactly the command the probe accepted: `resolveSupportedPython()` (`commands/init.ts`) caches it with `setResolvedPythonCommand` (`configurators/shared.ts`) so every later template uses it. Do not probe one alias and render another.
- The Python an AI CLI host spawns may not be your shell's `python3`: a minimal PATH can resolve to macOS system 3.9. Distributed templates target the lowest plausible version; see `cli/backend/script-conventions.md` for the PEP 604 rule.
- Python calling Python uses `sys.executable`, not a hardcoded command.

## 2. Path Handling

- Python uses `pathlib.Path` for every path operation, never string concatenation.

### Logical key vs filesystem path

A path string passed straight to `fs.*` stays OS-native. A path string that crosses OSes or is persisted (a Map key consumed elsewhere, a JSON field, a hash dictionary key) is POSIX.

- Normalize with `toPosix` (`packages/cli/src/utils/posix.ts`) once at the boundary (collector exit or write time), not with `replaceAll` at every `path.join`.
- This holds for writes too: `writeTemplateMap` (`configurators/shared.ts`) splits the map key on `/`, so a backslashed key writes one oddly named file instead of nested directories.
- `path.relative()` yields `\` on Windows; `toPosix` it before using it as a lookup key.

## 3. Line Endings

- `.gitattributes` enforces LF.
- Content hashed or compared across OSes normalizes `\r\n` to `\n` first: `.gitattributes` governs only checkout, and files written by users, scripts or `core.autocrlf=true` can still be CRLF. Exemplar: `computeHash` in `packages/cli/src/utils/template-hash.ts`.

## 4. Environment Variables

- `HOME` is not set on Windows, the `PATH` separator differs, and names are case-insensitive there. Use `Path.home()` instead of reading `HOME`.

## 5. Command Availability

- `grep`, `cat` and `tail -f` do not exist on Windows and `find` differs. Use the Python standard library instead of shell commands where possible.

## 6. File Encoding

- Windows terminals and file I/O default to the system locale (CP1252, GBK). File I/O and subprocess calls pass `encoding="utf-8"` and `errors="replace"`.
- Git commands force UTF-8 output with `-c i18n.logOutputEncoding=UTF-8` (`common/git.py`).
- Scripts that print non-ASCII configure stdout encoding; see `cli/backend/script-conventions.md` → "Cross-platform".

## 7. External Data and Tool Contracts

- Formats of external tools (Claude Code, Codex, Orca) are verified from their documentation, not guessed.
- TypeScript types are compile-time only. JSON files, API responses and user input are checked for required fields before use (filter or return early).

## Cross-Platform Persisted JSON

When a JSON file is read and written across OSes and an older format with cross-platform pollution (backslashed keys, CRLF-derived hashes) may already be on disk, give it a `__version` sentinel and have the loader discard legacy or unknown versions so the writer regenerates clean data. Discarding is safer than migrating in place because the corrections are correlated. Apply it only to recomputable data (hash dictionaries, caches); data the user would miss (task state, drafts, typed settings) gets a real migration. Exemplar: `HASHES_SCHEMA_VERSION` in `packages/cli/src/utils/template-hash.ts`.

## Change Propagation Checklist

- [ ] A new skill reaches every platform in `PLATFORM_IDS` (`configurators/index.ts`), not a remembered set
- [ ] Docstrings, `--help` / argparse text, README usage, error messages that suggest commands, and Markdown docs are updated
- [ ] `src/templates/`, the dogfooded `.arbor/scripts/` and the rebuilt `dist/` all carry the change
- [ ] Searched for every affected location:

```bash
grep -r "{{PYTHON_CMD}}\\|python3\\|python " --include="*.py" --include="*.md"
```

## Pre-Commit Checklist

- [ ] User-facing Python invocations are platform-aware or use `{{PYTHON_CMD}}`
- [ ] Python subprocesses from Python use `sys.executable`
- [ ] Paths use `pathlib.Path`; no hardcoded separators
- [ ] Logical/persisted path keys go through `toPosix()`; `fs.*` calls keep OS-native paths
- [ ] Cross-OS content hashes normalize line endings first
- [ ] Cross-OS JSON with possible legacy pollution carries a `__version` sentinel
- [ ] No platform-specific commands without a fallback
- [ ] File I/O and subprocess calls specify `encoding="utf-8"` and `errors="replace"`
- [ ] Git commands use `-c i18n.logOutputEncoding=UTF-8`
- [ ] External tool formats verified from documentation
- [ ] Documentation matches code behavior

When you find a platform bug: fix it, grep for the same pattern elsewhere, and add the question here if it can recur.

## Release Checklist

Versioned files:

- [ ] `src/migrations/manifests/<version>.json` exists with the correct version, description and changelog
- [ ] `pnpm build` copies the manifests to `dist/`
- [ ] The upgrade path is tested from older versions, not only the adjacent one; a missing manifest breaks upgrades from older versions

Bundled assets (docs and changelog can move independently of the branch that owns the templates):

- [ ] The source file exists in the branch being tagged
- [ ] `pnpm build` copies it into `dist/templates/**`, and `npm pack --dry-run --json` lists it
- [ ] The built binary installs it in a fresh temp repository, `.arbor/.template-hashes.json` tracks it, and `arbor update --dry-run` there reports `Already up to date!`
