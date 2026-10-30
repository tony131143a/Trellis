import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { init } from "../commands/init.js";
import { update } from "../commands/update.js";
import { uninstall } from "../commands/uninstall.js";
import { DIR_NAMES } from "../constants/paths.js";
import { PACKAGE_NAME, VERSION } from "../constants/version.js";
import { compareVersions } from "../utils/compare-versions.js";
import { getConfiguredPlatforms } from "../configurators/index.js";
import { AI_TOOLS } from "../types/ai-tools.js";

// Re-export for backwards compatibility (consumers should prefer constants/version.js)
export { VERSION, PACKAGE_NAME };

/**
 * Check if a Arbor update is available (compare project version with CLI version)
 */
function checkForUpdates(cwd: string): void {
  const versionFile = path.join(cwd, DIR_NAMES.WORKFLOW, ".version");

  if (!fs.existsSync(versionFile)) return;

  const projectVersion = fs.readFileSync(versionFile, "utf-8").trim();
  const cliVersion = VERSION;
  const comparison = compareVersions(cliVersion, projectVersion);

  if (comparison > 0) {
    // CLI is newer than project - update available
    console.log(
      chalk.yellow(
        `\n⚠️  Arbor update available: ${projectVersion} → ${cliVersion}`,
      ),
    );
    console.log(chalk.gray(`   Run: arbor update\n`));
  } else if (comparison < 0) {
    // CLI is older than project - CLI needs updating
    console.log(
      chalk.yellow(
        `\n⚠️  Your CLI (${cliVersion}) is older than project (${projectVersion})`,
      ),
    );
    console.log(chalk.gray(`   Rebuild the CLI and run \`npm link\`\n`));
  }
}

const cwd = process.cwd();

// Check for updates at CLI startup (only if .arbor exists)
if (fs.existsSync(path.join(cwd, DIR_NAMES.WORKFLOW))) {
  checkForUpdates(cwd);
}

const program = new Command();

program
  .name("arbor")
  .description(
    "AI-assisted development workflow framework for Claude Code and Codex",
  )
  .version(VERSION, "-v, --version", "output the version number");

program
  .command("init")
  .description("Initialize arbor in the current project")
  .option("--claude", "Include Claude Code commands")
  .option("--codex", "Include Codex skills and hooks")
  .option(
    "--with-statusline",
    "Install the Arbor statusLine for Claude Code (off by default)",
  )
  .option("-y, --yes", "Skip prompts and use defaults")
  .option(
    "-u, --user <name>",
    "Initialize developer identity with specified name",
  )
  .option("-f, --force", "Overwrite existing files without asking")
  .option("-s, --skip-existing", "Skip existing files without asking")
  .option("--monorepo", "Force monorepo mode")
  .option("--no-monorepo", "Skip monorepo detection")
  .action(async (options: Record<string, unknown>) => {
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
  });

program
  .command("update")
  .description("Update arbor configuration and commands to latest version")
  .option("--dry-run", "Preview changes without applying them")
  .option("-f, --force", "Overwrite all changed files without asking")
  .option("-s, --skip-all", "Skip all changed files without asking")
  .option("-n, --create-new", "Create .new copies for all changed files")
  .option("--allow-downgrade", "Allow downgrading to an older version")
  .option("--migrate", "Apply pending file migrations (renames/deletions)")
  .action(async (options: Record<string, unknown>) => {
    try {
      await update({
        dryRun: options.dryRun as boolean,
        force: options.force as boolean,
        skipAll: options.skipAll as boolean,
        createNew: options.createNew as boolean,
        allowDowngrade: options.allowDowngrade as boolean,
        migrate: options.migrate as boolean,
      });
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
  });

program
  .command("uninstall")
  .description(
    "Remove all arbor files (managed platform files + .arbor/) from this project",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--dry-run", "List what would be removed without changing anything")
  .action(async (options: Record<string, unknown>) => {
    try {
      await uninstall({
        yes: options.yes as boolean,
        dryRun: options.dryRun as boolean,
      });
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
  });

program
  .command("platforms")
  .description(
    "Show which AI platforms are configured (active) in the current project",
  )
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    try {
      const configured = getConfiguredPlatforms(cwd);
      const platforms = [...configured].map((id) => ({
        id,
        displayName: AI_TOOLS[id].name,
        configDir: AI_TOOLS[id].configDir,
      }));

      if (options.json) {
        console.log(JSON.stringify({ platforms }, null, 2));
        return;
      }

      if (platforms.length === 0) {
        console.log(chalk.gray("No platforms configured in this project."));
        return;
      }

      console.log(chalk.bold("Configured platforms:"));
      for (const p of platforms) {
        console.log(`  ${p.displayName} (${p.id}) — ${p.configDir}`);
      }
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
  });

program.parse();
