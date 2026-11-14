---
sources:
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/update.ts
  - packages/cli/src/commands/uninstall.ts
  - packages/cli/src/cli/index.ts
last_verified: 2026-11-13
---
# Logging Guidelines

> How console output and logging is done in this CLI project.

---

## Overview

This CLI project uses **chalk** for colored console output. Since this is a user-facing CLI tool, we use `console.log()` and `console.error()` directly rather than a structured logging library. Output follows consistent color conventions to help users quickly understand the nature of each message.

---

## Color Conventions

| Color | Chalk Method | Usage | Example |
|-------|--------------|-------|---------|
| **Cyan** | `chalk.cyan()` | Headers, banners, section titles | `"\nArbor Update"`, `"\n--- Summary ---\n"` |
| **Blue** | `chalk.blue()` | Action in progress, step indicators | `"📁 Creating workflow structure..."` |
| **Green** | `chalk.green()` | Success messages | `"✓ Already up to date!"` |
| **Yellow** | `chalk.yellow()` | Warnings, skipped items, retry hints | `"No tools selected. At least one tool is required."` |
| **Red** | `chalk.red()` | Errors, conflicts, destructive actions | `"Error:"` prefix |
| **Gray** | `chalk.gray()` | Secondary info, hints, paths | `"Mode: Force overwrite existing files\n"` |
| **White** | `chalk.white()` | Highlighted inline values | `chalk.white(projectVersion)` |

---

## Message Patterns

### Section Headers (Cyan)

```typescript
// commands/update.ts
console.log(chalk.cyan("\nArbor Update"));
console.log(chalk.cyan("Analyzing migrations...\n"));
console.log(chalk.cyan("\n--- Summary ---\n"));
```

### Progress Steps (Blue with Emoji)

```typescript
// commands/init.ts
console.log(chalk.blue("📁 Creating workflow structure..."));
console.log(chalk.blue(`📝 Configuring ${AI_TOOLS[platformId].name}...`));
console.log(chalk.blue("📦 Monorepo packages written to config.yaml"));
console.log(chalk.blue("📄 Created AGENTS.md"));
```

### Sub-steps (Gray with Indentation)

```typescript
console.log(chalk.gray("   ↳ Arbor statusLine installed (--with-statusline)"));
console.log(chalk.gray(`   - ${pkg.name}`) + chalk.gray(` (${pkg.path})`));
```

### Success (Green)

```typescript
console.log(chalk.green(`✓ Developer "${devName}" initialized`));
console.log(chalk.green("✓ Already up to date!"));
console.log(chalk.green(`\n✅ ${actionWord} complete! (${projectVersion} → ${cliVersion})`));
```

### Warnings (Yellow)

```typescript
console.log(chalk.yellow("No tools selected. At least one tool is required."));
console.log(chalk.yellow("⚠ Could not initialize developer. Run manually:"));
console.log(chalk.yellow(`  Run: arbor update --migrate`));
```

### Errors (Red)

```typescript
console.error(
  chalk.red("Error:"),
  error instanceof Error ? error.message : error,
);
```

### Informational (Mixed Colors)

```typescript
// Key-value pairs
console.log(chalk.blue("👤 Developer:"), chalk.gray(developerName));
console.log(`Project version: ${chalk.white(projectVersion)}`);

// Manual follow-up command after a soft failure
console.log(chalk.gray(`  ${pythonCmd} .arbor/scripts/init_developer.py ${devName}`));
```

---

## Output Structure

### Banner and Introduction

```typescript
// ASCII art banner (cyan)
const banner = figlet.textSync("Arbor", { font: "Rebel" });
console.log(chalk.cyan(`\n${banner.trimEnd()}`));

// Tagline (gray)
console.log(chalk.gray("\n   AI engineering workflows for Claude Code & Codex\n"));
```

### Progress Output

```typescript
// Mode indicator
console.log(chalk.gray("Mode: Force overwrite existing files\n"));

// Detection results
console.log(chalk.blue("👤 Developer:"), chalk.gray(developerName));
console.log(chalk.blue("\n🔍 Detected monorepo packages:"));

// Step progress
console.log(chalk.blue("📁 Creating workflow structure..."));
console.log(chalk.blue(`📝 Configuring ${AI_TOOLS[platformId].name}...`));
```

### Completion Summary

```typescript
// init: hash tracking + first-init hint
console.log(chalk.gray(`📋 Tracking ${hashedCount} template files for updates`));
console.log(chalk.blue("💡 Next: have your agent fill .arbor/spec/ with this project's conventions using the arbor-spec-bootstrap skill"));

// update: summary block, then success line
console.log(chalk.cyan("\n--- Summary ---\n"));
console.log(`  Added: ${added} file(s)`);
console.log(chalk.green(`\n✅ ${actionWord} complete! (${projectVersion} → ${cliVersion})`));
```

---

## Emoji Usage

| Emoji | Usage |
|-------|-------|
| 📁 | Directory/folder operations |
| 📝 | Configuration/file writing |
| 📄 | Single file creation |
| 📦 | Package / monorepo config |
| 📋 | Tracking, migration guides |
| 👤 | User/developer related |
| 🔍 | Detection/analysis |
| 💡 | Next-step hint |
| ✅ | Success completion |
| ⚠️ | Warnings |

---

## Indentation

Use indentation to show hierarchy:

```typescript
// Top level (no indent)
console.log(chalk.blue(`📝 Configuring ${AI_TOOLS[platformId].name}...`));

// Sub-level (3 spaces)
console.log(chalk.gray("   ↳ Arbor statusLine installed (--with-statusline)"));

// File listings (4 spaces under a 2-space heading)
console.log(chalk.green("  New files (will add):"));
console.log(chalk.green(`    + ${file.relativePath}`));
```

---

## DO / DON'T

### DO

- Use `chalk` for all colored output
- Follow the color convention consistently
- Use emojis for visual scanning (sparingly)
- Use indentation to show hierarchy
- Add blank lines between sections for readability
- Use `console.error()` for errors

### DON'T

- Don't use raw ANSI escape codes
- Don't mix color meanings (e.g., red for non-error)
- Don't overuse emojis
- Don't log sensitive information (paths with usernames excepted for context)
- Don't use `console.log()` for errors (use `console.error()`)
- Don't output debug information unless `DEBUG` / `ARBOR_DEBUG` is set

---

## Examples

### Error Output

```typescript
try {
  await init(options);
} catch (error) {
  console.error(
    chalk.red("Error:"),
    error instanceof Error ? error.message : error,
  );
  if (process.env.DEBUG || process.env.ARBOR_DEBUG) {
    console.error(error instanceof Error ? error.stack : error);
  }
  process.exit(1);
}
```

### Warning Output

```typescript
// Non-critical failure with a manual fallback
console.log(chalk.yellow("⚠ Could not initialize developer. Run manually:"));
console.log(chalk.gray(`  ${pythonCmd} .arbor/scripts/init_developer.py ${devName}`));
```
