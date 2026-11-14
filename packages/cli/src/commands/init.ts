import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import figlet from "figlet";
import inquirer from "inquirer";
import { createWorkflowStructure } from "../configurators/workflow.js";
import {
  getInitToolChoices,
  resolveCliFlag,
  configurePlatform,
  getConfiguredPlatforms,
  getPlatformsWithPythonHooks,
} from "../configurators/index.js";
import {
  getPythonCommandForPlatform,
  replacePythonCommandLiterals,
  setResolvedPythonCommand,
} from "../configurators/shared.js";
import { AI_TOOLS, type CliFlag } from "../types/ai-tools.js";
import { DIR_NAMES, FILE_NAMES, PATHS } from "../constants/paths.js";
import { VERSION } from "../constants/version.js";
import {
  agentsMdContent,
  claudeMdContent,
} from "../templates/markdown/index.js";
import {
  setWriteMode,
  startRecordingWrites,
  stopRecordingWrites,
  writeFile,
  writeManagedBlockFile,
  type WriteMode,
} from "../utils/file-writer.js";
import {
  ARBOR_BLOCK_END,
  ARBOR_BLOCK_START,
  mergeManagedBlockContent,
} from "../utils/managed-paths.js";
import {
  detectProjectType,
  detectMonorepo,
  sanitizePkgName,
  type ProjectType,
  type DetectedPackage,
} from "../utils/project-detector.js";
import { initializeHashes } from "../utils/template-hash.js";
import {
  isCwdHomedir,
  homedirGuardMessage,
  homedirBypassEnabled,
} from "../utils/cwd-guard.js";

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 9;
const PYTHON_VERSION_RE = /Python (\d+)\.(\d+)/;

export function isSupportedPythonVersion(versionOutput: string): boolean {
  const match = versionOutput.match(PYTHON_VERSION_RE);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MIN_PYTHON_MAJOR ||
    (major === MIN_PYTHON_MAJOR && minor >= MIN_PYTHON_MINOR)
  );
}

// Sentinel returned when child_process spawn is blocked by a sandbox / kernel
// policy (e.g. seccomp inside Codex's Linux sandbox). EPERM/EACCES here mean
// "the kernel refused the spawn" — NOT "python3 isn't installed". The host
// usually has python3 on PATH; we just can't probe it from this Node process.
type PythonProbe = string | null | "sandbox-restricted";

function detectPythonVersion(command: string): PythonProbe {
  try {
    return execSync(`${command} --version`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM" || code === "EACCES") {
      return "sandbox-restricted";
    }
    return null;
  }
}

export function requireSupportedPython(command: string): string {
  // Final escape hatch — set when the user knows python3 is on PATH but
  // the probe keeps failing for environment-specific reasons.
  if (process.env.ARBOR_SKIP_PYTHON_CHECK === "1") {
    return `version check skipped (ARBOR_SKIP_PYTHON_CHECK=1)`;
  }

  const versionOutput = detectPythonVersion(command);

  if (versionOutput === "sandbox-restricted") {
    console.warn(
      chalk.yellow(
        `⚠ Python version check skipped — sandboxed environment blocked ` +
          `child_process spawn (EPERM/EACCES). Assuming "${command}" is on ` +
          `PATH. If init fails later, re-run on the host or set ` +
          `ARBOR_SKIP_PYTHON_CHECK=1.`,
      ),
    );
    return `version unknown (sandbox-restricted)`;
  }

  if (!versionOutput) {
    throw new Error(
      `Python command "${command}" not found. Arbor init requires Python ≥ 3.9.`,
    );
  }

  if (!isSupportedPythonVersion(versionOutput)) {
    throw new Error(
      `${versionOutput} detected via "${command}", but Arbor init requires Python ≥ 3.9.`,
    );
  }

  return versionOutput;
}

/**
 * Candidate Python command list per platform.
 *
 * Windows: `python` is the usual python.org installer choice, but Microsoft
 * Store ships `python3`, and the `py` launcher is `py -3`. We try all three
 * before giving up — fixes #236 where users with only `python3` (not
 * `python`) had `arbor init` fail outright.
 *
 * Non-Windows: `python3` is canonical; `python` is a fallback for systems
 * where Python 3 is the only Python and is named `python` (some Arch
 * configs, conda envs).
 */
const PYTHON_CANDIDATES: Record<"win32" | "other", readonly string[]> = {
  win32: ["python", "python3", "py -3"],
  other: ["python3", "python"],
};

/**
 * Detect a working Python ≥ 3.9 command on the host platform.
 *
 * Honors `ARBOR_PYTHON_CMD` (explicit override, no probe) and
 * `ARBOR_SKIP_PYTHON_CHECK=1` (skip probe, trust platform default).
 *
 * Otherwise tries each candidate in `PYTHON_CANDIDATES` in order and returns
 * the first whose `--version` matches `Python ≥ 3.9`. Caches the result via
 * `setResolvedPythonCommand` so all downstream template / configurator
 * writes pick up the resolved value.
 *
 * Throws a helpful, Windows-aware error if no candidate works.
 */
export function resolveSupportedPython(): {
  command: string;
  version: string;
} {
  // Explicit override — user knows their environment.
  const override = process.env.ARBOR_PYTHON_CMD?.trim();
  if (override) {
    setResolvedPythonCommand(override);
    return { command: override, version: "set via ARBOR_PYTHON_CMD" };
  }

  // Skip probe entirely.
  if (process.env.ARBOR_SKIP_PYTHON_CHECK === "1") {
    const fallback = getPythonCommandForPlatform();
    setResolvedPythonCommand(fallback);
    return {
      command: fallback,
      version: "version check skipped (ARBOR_SKIP_PYTHON_CHECK=1)",
    };
  }

  const candidates =
    process.platform === "win32"
      ? PYTHON_CANDIDATES.win32
      : PYTHON_CANDIDATES.other;

  const probeFailures: string[] = [];
  for (const candidate of candidates) {
    const probe = detectPythonVersion(candidate);
    if (probe === "sandbox-restricted") {
      console.warn(
        chalk.yellow(
          `⚠ Python version check skipped — sandboxed environment blocked ` +
            `child_process spawn (EPERM/EACCES). Assuming "${candidate}" is ` +
            `on PATH. If init fails later, re-run on the host or set ` +
            `ARBOR_SKIP_PYTHON_CHECK=1.`,
        ),
      );
      setResolvedPythonCommand(candidate);
      return {
        command: candidate,
        version: "version unknown (sandbox-restricted)",
      };
    }
    if (!probe) {
      probeFailures.push(`${candidate}: not found`);
      continue;
    }
    if (!isSupportedPythonVersion(probe)) {
      probeFailures.push(`${candidate}: ${probe} (< 3.9)`);
      continue;
    }
    setResolvedPythonCommand(candidate);
    return { command: candidate, version: probe };
  }

  const isWindows = process.platform === "win32";
  const installHint = isWindows
    ? `Install Python ≥ 3.9 from https://www.python.org/downloads/windows/ — make sure ` +
      `"Add Python to PATH" is checked in the installer. Or, if Python is ` +
      `installed under a different name, set ARBOR_PYTHON_CMD=<your-cmd> ` +
      `before re-running init (e.g. \`set ARBOR_PYTHON_CMD=py -3\`).`
    : `Install Python ≥ 3.9 from https://www.python.org/downloads/ or via your ` +
      `package manager. Or set ARBOR_PYTHON_CMD=<your-cmd> before re-running.`;

  throw new Error(
    `No supported Python command found. Tried: ${candidates.join(", ")}.\n` +
      `Probe results:\n  ${probeFailures.join("\n  ")}\n\n` +
      `Arbor init requires Python ≥ 3.9. ${installHint}\n` +
      `Last-resort escape hatch: set ARBOR_SKIP_PYTHON_CHECK=1 to skip the probe entirely.`,
  );
}

function getOsDisplayName(
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function logPythonAdaptationNotice(command: string): void {
  const osName = getOsDisplayName();
  console.log(
    chalk.blue(
      `📌 ${osName} detected: Arbor rendered Python commands as "${command}" in generated skills and help text`,
    ),
  );
}

/**
 * Handle re-init when .arbor/ already exists.
 * Returns true if handled (caller should return), false if user chose full re-init.
 */
async function handleReinit(
  cwd: string,
  options: InitOptions,
  developerName: string | undefined,
  pythonCmd: string,
): Promise<boolean> {
  const TOOLS = getInitToolChoices();
  const configuredPlatforms = getConfiguredPlatforms(cwd);
  const configuredNames = [...configuredPlatforms]
    .map((id) => AI_TOOLS[id].name)
    .join(", ");

  // Determine explicit platform flags
  const explicitTools = TOOLS.filter(
    (t) => options[t.key as keyof InitOptions],
  ).map((t) => t.key);

  let doAddPlatforms = explicitTools.length > 0;
  let doAddDeveloper = !!options.user;
  let platformsToAdd: string[] = explicitTools;

  // No explicit flags → show menu
  if (!doAddPlatforms && !doAddDeveloper) {
    if (options.yes) {
      console.log(chalk.gray(`Already initialized with: ${configuredNames}`));
      console.log(
        chalk.gray(
          "Use platform flags (e.g., --codex) or -u <name> to add platforms/developer.",
        ),
      );
      return true;
    }

    console.log(
      chalk.gray(`\n   Already initialized with: ${configuredNames}\n`),
    );

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "Arbor is already initialized. What would you like to do?",
        choices: [
          { name: "Add AI platform(s)", value: "add-platform" },
          {
            name: "Set up developer identity on this device",
            value: "add-developer",
          },
          { name: "Full re-initialize", value: "full" },
        ],
      },
    ]);

    if (action === "full") {
      return false; // Fall through to full init
    }
    if (action === "add-platform") doAddPlatforms = true;
    if (action === "add-developer") doAddDeveloper = true;
  }

  // --- Add platforms ---
  if (doAddPlatforms) {
    if (platformsToAdd.length === 0) {
      // Interactive: show only unconfigured platforms
      const unconfigured = TOOLS.filter((t) => {
        const pid = resolveCliFlag(t.key);
        return pid && !configuredPlatforms.has(pid);
      });

      if (unconfigured.length === 0) {
        console.log(
          chalk.green("✓ All available platforms are already configured."),
        );
      } else {
        const answers = await inquirer.prompt<{ tools: string[] }>([
          {
            type: "checkbox",
            name: "tools",
            message: "Select platforms to add:",
            choices: unconfigured.map((t) => ({
              name: t.name,
              value: t.key,
            })),
          },
        ]);
        platformsToAdd = answers.tools;
      }
    }

    // Opt-in Claude Code statusLine: only for platforms actually being added
    // (already-configured ones are skipped in the loop below)
    await maybePromptStatuslineOptIn(
      options,
      platformsToAdd.filter((tool) => {
        const pid = resolveCliFlag(tool as CliFlag);
        return !!pid && !configuredPlatforms.has(pid);
      }),
    );

    const reinitWritten = startRecordingWrites(cwd);
    try {
      for (const tool of platformsToAdd) {
        const platformId = resolveCliFlag(tool as CliFlag);
        if (platformId) {
          if (configuredPlatforms.has(platformId)) {
            console.log(
              chalk.gray(
                `  ○ ${AI_TOOLS[platformId].name} already configured, skipping`,
              ),
            );
          } else {
            console.log(
              chalk.blue(`📝 Configuring ${AI_TOOLS[platformId].name}...`),
            );
            await configurePlatform(platformId, cwd, {
              withStatusline: options.withStatusline,
            });
            if (platformId === "claude-code" && options.withStatusline) {
              console.log(
                chalk.gray(
                  "   ↳ Arbor statusLine installed (--with-statusline)",
                ),
              );
            }
            if (platformId === "claude-code") {
              writeClaudeMd(cwd);
            }
          }
        }
      }
    } finally {
      stopRecordingWrites();
    }

    // Update template hashes. Merge mode: preserve previously-tracked
    // platforms' hashes, layer in the newly-added platform's writes.
    const hashedCount = initializeHashes(cwd, {
      trackedPaths: reinitWritten,
      merge: true,
    });
    if (hashedCount > 0) {
      console.log(
        chalk.gray(`📋 Tracking ${hashedCount} template files for updates`),
      );
    }
  }

  // --- Add developer ---
  if (doAddDeveloper) {
    let devName = developerName;
    if (!devName) {
      devName = await askInput("Your name: ");
      while (!devName) {
        console.log(chalk.yellow("Name is required"));
        devName = await askInput("Your name: ");
      }
    }

    try {
      const scriptPath = path.join(cwd, PATHS.SCRIPTS, "init_developer.py");
      execSync(`${pythonCmd} "${scriptPath}" "${devName}"`, {
        cwd,
        stdio: "pipe",
      });
      console.log(chalk.green(`✓ Developer "${devName}" initialized`));
    } catch {
      console.log(
        chalk.yellow("⚠ Could not initialize developer. Run manually:"),
      );
      console.log(
        chalk.gray(
          `  ${pythonCmd} .arbor/scripts/init_developer.py ${devName}`,
        ),
      );
    }
  }

  return true;
}

/**
 * Interactive opt-in for the Claude Code statusLine when `--with-statusline`
 * was not passed. Fires only when Claude Code is among the platforms about to
 * be configured and never in -y mode. Mutates `options.withStatusline` so the
 * configurePlatform call sites and the install hint read the same answer; the
 * `!== undefined` gate doubles as the asked-once-per-run guard.
 */
async function maybePromptStatuslineOptIn(
  options: InitOptions,
  toolKeys: string[],
): Promise<void> {
  if (options.yes || options.withStatusline !== undefined) return;
  if (!toolKeys.includes(AI_TOOLS["claude-code"].cliFlag)) return;

  const answer = await inquirer.prompt<{ withStatusline: boolean }>([
    {
      type: "confirm",
      name: "withStatusline",
      message:
        "Install Arbor statusLine for Claude Code? (status bar: model, context, branch, rate limits)",
      default: false,
    },
  ]);
  options.withStatusline = answer.withStatusline;
}

interface InitOptions {
  claude?: boolean;
  codex?: boolean;
  yes?: boolean;
  user?: string;
  force?: boolean;
  skipExisting?: boolean;
  monorepo?: boolean;
  /** Claude Code only: install the opt-in Arbor statusLine (--with-statusline) */
  withStatusline?: boolean;
}

// Compile-time check: every CliFlag must be a key of InitOptions.
// If a new platform is added to CliFlag but not to InitOptions, this line errors.
// Uses [X] extends [Y] to prevent distributive conditional behavior.
type _AssertCliFlagsInOptions = [CliFlag] extends [keyof InitOptions]
  ? true
  : "ERROR: CliFlag has values not present in InitOptions";
const _cliFlagCheck: _AssertCliFlagsInOptions = true;

/**
 * Write monorepo package configuration to config.yaml (non-destructive patch).
 * Appends packages: and default_package: without disturbing existing config.
 */
function writeMonorepoConfig(cwd: string, packages: DetectedPackage[]): void {
  const configPath = path.join(cwd, DIR_NAMES.WORKFLOW, "config.yaml");
  let content = "";

  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    // Config not created yet; will be created by createWorkflowStructure
    return;
  }

  // Don't overwrite if packages: already exists (re-init case)
  if (/^packages\s*:/m.test(content)) {
    return;
  }

  const lines = ["\n# Auto-detected monorepo packages", "packages:"];
  for (const pkg of packages) {
    lines.push(`  ${sanitizePkgName(pkg.name)}:`);
    lines.push(`    path: ${pkg.path}`);
    if (pkg.isSubmodule) {
      lines.push("    type: submodule");
    } else if (pkg.isGitRepo) {
      lines.push("    git: true");
    }
  }

  // Use first non-submodule package as default, fallback to first package
  const defaultPkg =
    packages.find((p) => !p.isSubmodule)?.name ?? packages[0]?.name;
  if (defaultPkg) {
    lines.push(`default_package: ${defaultPkg}`);
  }

  fs.writeFileSync(
    configPath,
    content.trimEnd() + "\n" + lines.join("\n") + "\n",
    "utf-8",
  );
}

interface InitAnswers {
  tools: string[];
}

export async function init(options: InitOptions): Promise<void> {
  // Refuse to run in $HOME — running here would scoop platform runtime data
  // (Claude/Codex/OpenCode session histories etc.) into the arbor hash
  // manifest, and a subsequent `arbor uninstall` would wipe it.
  if (isCwdHomedir() && !homedirBypassEnabled()) {
    console.error(chalk.red(homedirGuardMessage("init")));
    process.exit(1);
  }

  const cwd = process.cwd();
  const isFirstInit = !fs.existsSync(path.join(cwd, DIR_NAMES.WORKFLOW));

  // Generate ASCII art banner dynamically using FIGlet "Rebel" font
  const banner = figlet.textSync("Arbor", { font: "Rebel" });
  console.log(chalk.cyan(`\n${banner.trimEnd()}`));
  console.log(
    chalk.gray("\n   AI engineering workflows for Claude Code & Codex\n"),
  );

  // Set write mode based on options
  let writeMode: WriteMode = "ask";
  if (options.force) {
    writeMode = "force";
    console.log(chalk.gray("Mode: Force overwrite existing files\n"));
  } else if (options.skipExisting) {
    writeMode = "skip";
    console.log(chalk.gray("Mode: Skip existing files\n"));
  } else if (options.yes) {
    // -y implies non-interactive: never prompt on conflicts. Default to skip
    // (preserve user files) — explicit --force is required to overwrite.
    writeMode = "skip";
    console.log(chalk.gray("Mode: Non-interactive (skip existing files)\n"));
  }
  setWriteMode(writeMode);

  // Detect developer name from git config or options
  let developerName = options.user;
  if (!developerName) {
    // Only detect from git if current directory is a git repo
    const isGitRepo = fs.existsSync(path.join(cwd, ".git"));
    if (isGitRepo) {
      try {
        developerName = execSync("git config user.name", {
          cwd,
          encoding: "utf-8",
        }).trim();
      } catch {
        // Git not available or no user.name configured
      }
    }
  }

  if (developerName) {
    console.log(chalk.blue("👤 Developer:"), chalk.gray(developerName));
  }

  const { command: pythonCmd } = resolveSupportedPython();

  // ==========================================================================
  // Re-init fast path: skip full flow when .arbor/ already exists
  // ==========================================================================

  if (!isFirstInit && !options.force && !options.skipExisting) {
    const reinitDone = await handleReinit(
      cwd,
      options,
      developerName,
      pythonCmd,
    );
    if (reinitDone) return;
    // reinitDone === false means user chose "full re-initialize" → fall through
  }

  if (!developerName && !options.yes) {
    // Ask for developer name if not detected and not in yes mode
    console.log(
      chalk.gray(
        "\nArbor supports team collaboration - each developer has their own\n" +
          `workspace directory (${PATHS.WORKSPACE}/{name}/) to track AI sessions.\n` +
          "Tip: Usually this is your git username (git config user.name).\n",
      ),
    );
    developerName = await askInput("Your name: ");
    while (!developerName) {
      console.log(chalk.yellow("Name is required"));
      developerName = await askInput("Your name: ");
    }
    console.log(chalk.blue("👤 Developer:"), chalk.gray(developerName));
  }

  // Detect project type (silent - no output)
  const detectedType = detectProjectType(cwd);

  // ==========================================================================
  // Monorepo Detection
  // ==========================================================================

  let monorepoPackages: DetectedPackage[] | undefined;

  if (options.monorepo !== false) {
    // options.monorepo: true = --monorepo, false = --no-monorepo, undefined = auto
    const detected = detectMonorepo(cwd);

    if (options.monorepo === true && !detected) {
      console.log(
        chalk.red(
          "Error: --monorepo specified but no multi-package layout detected.",
        ),
      );
      console.log("");
      console.log(chalk.gray("Checked:"));
      console.log(chalk.gray("  ✗ pnpm-workspace.yaml"));
      console.log(chalk.gray("  ✗ package.json workspaces"));
      console.log(chalk.gray("  ✗ Cargo.toml [workspace]"));
      console.log(chalk.gray("  ✗ go.work"));
      console.log(chalk.gray("  ✗ pyproject.toml [tool.uv.workspace]"));
      console.log(chalk.gray("  ✗ .gitmodules"));
      console.log(chalk.gray("  ✗ sibling .git directories (need ≥ 2)"));
      console.log("");
      console.log("To configure manually, add to .arbor/config.yaml:");
      console.log("");
      console.log(chalk.cyan("  packages:"));
      console.log(chalk.cyan("    frontend:"));
      console.log(chalk.cyan("      path: ./frontend"));
      console.log(chalk.cyan("      git: true       # if it has its own .git"));
      console.log(chalk.cyan("    backend:"));
      console.log(chalk.cyan("      path: ./backend"));
      console.log(chalk.cyan("      git: true"));
      return;
    }

    if (detected && detected.length > 0) {
      let enableMonorepo = false;

      if (options.monorepo === true || options.yes) {
        enableMonorepo = true;
      } else {
        // Show detected packages and ask
        console.log(chalk.blue("\n🔍 Detected monorepo packages:"));
        for (const pkg of detected) {
          const tag = pkg.isSubmodule
            ? chalk.gray(" (submodule)")
            : pkg.isGitRepo
              ? chalk.gray(" (git repo)")
              : "";
          console.log(
            chalk.gray(`   - ${pkg.name}`) +
              chalk.gray(` (${pkg.path})`) +
              chalk.gray(` [${pkg.type}]`) +
              tag,
          );
        }
        console.log("");

        const { useMonorepo } = await inquirer.prompt<{
          useMonorepo: boolean;
        }>([
          {
            type: "confirm",
            name: "useMonorepo",
            message: "Enable monorepo mode?",
            default: true,
          },
        ]);
        enableMonorepo = useMonorepo;
      }

      if (enableMonorepo) {
        monorepoPackages = detected;
      }
    }
  }

  // Tool definitions derived from platform registry
  const TOOLS = getInitToolChoices();

  // Build tools from explicit flags
  const explicitTools = TOOLS.filter(
    (t) => options[t.key as keyof InitOptions],
  ).map((t) => t.key);

  let tools: string[];

  if (explicitTools.length > 0) {
    // Explicit flags take precedence (works with or without -y)
    tools = explicitTools;
  } else if (options.yes) {
    // No explicit tools + -y: default to Cursor and Claude
    tools = TOOLS.filter((t) => t.defaultChecked).map((t) => t.key);
  } else {
    // Interactive mode
    const answers = await inquirer.prompt<InitAnswers>([
      {
        type: "checkbox",
        name: "tools",
        message: "Select AI tools to configure:",
        choices: TOOLS.map((t) => ({
          name: t.name,
          value: t.key,
          checked: t.defaultChecked,
        })),
      },
    ]);
    tools = answers.tools;
  }

  // Treat unknown project type as fullstack
  const projectType: ProjectType =
    detectedType === "unknown" ? "fullstack" : detectedType;

  if (tools.length === 0) {
    console.log(
      chalk.yellow("No tools selected. At least one tool is required."),
    );
    return;
  }

  // Opt-in Claude Code statusLine: confirm interactively when the flag wasn't passed
  await maybePromptStatuslineOptIn(options, tools);

  // ==========================================================================
  // Create Workflow Structure
  // ==========================================================================

  // Record every successful write from here through createRootFiles. The
  // captured set is the source of truth for `.template-hashes.json`'s
  // platform/root entries — replacing the previous "walk every managed dir"
  // approach that swept user-owned runtime files into the manifest
  // (.codex/sessions/, .claude/projects/, pre-existing AGENTS.md).
  const writtenPaths = startRecordingWrites(cwd);
  try {
    // Create workflow structure with project type
    console.log(chalk.blue("📁 Creating workflow structure..."));
    await createWorkflowStructure(cwd, {
      projectType,
      packages: monorepoPackages,
    });

    // Write monorepo packages to config.yaml (non-destructive patch)
    if (monorepoPackages) {
      writeMonorepoConfig(cwd, monorepoPackages);
      console.log(chalk.blue("📦 Monorepo packages written to config.yaml"));
    }

    // Write version file for update tracking
    const versionPath = path.join(cwd, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, VERSION);

    // Configure selected tools by copying entire directories (dogfooding)
    for (const tool of tools) {
      const platformId = resolveCliFlag(tool);
      if (platformId) {
        console.log(
          chalk.blue(`📝 Configuring ${AI_TOOLS[platformId].name}...`),
        );
        await configurePlatform(platformId, cwd, {
          withStatusline: options.withStatusline,
        });
        if (platformId === "claude-code" && options.withStatusline) {
          console.log(
            chalk.gray("   ↳ Arbor statusLine installed (--with-statusline)"),
          );
        }
      }
    }

    const pythonPlatforms = getPlatformsWithPythonHooks();
    const hasSelectedPythonPlatform = pythonPlatforms.some((id) =>
      tools.includes(AI_TOOLS[id].cliFlag),
    );
    if (hasSelectedPythonPlatform) {
      logPythonAdaptationNotice(pythonCmd);
    }

    // Create root files (AGENTS.md skips if exists; CLAUDE.md merges its block)
    await createRootFiles(cwd, tools);
  } finally {
    stopRecordingWrites();
  }

  // Initialize template hashes for modification tracking
  const hashedCount = initializeHashes(cwd, { trackedPaths: writtenPaths });
  if (hashedCount > 0) {
    console.log(
      chalk.gray(`📋 Tracking ${hashedCount} template files for updates`),
    );
  }

  // Initialize developer identity (silent - no output)
  if (developerName) {
    try {
      const scriptPath = path.join(cwd, PATHS.SCRIPTS, "init_developer.py");
      execSync(`${pythonCmd} "${scriptPath}" "${developerName}"`, {
        cwd,
        stdio: "pipe", // Silent
      });
    } catch {
      // Silent failure - user can run init_developer.py manually
    }
  }

  if (isFirstInit) {
    console.log(
      chalk.blue(
        "💡 Next: have your agent fill .arbor/spec/ with this project's conventions using the arbor-spec-bootstrap skill",
      ),
    );
  }
}

/**
 * Simple readline-based input (no flickering like inquirer)
 */
function askInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function createRootFiles(cwd: string, tools: string[]): Promise<void> {
  const agentsPath = path.join(cwd, FILE_NAMES.AGENTS);

  // Write AGENTS.md from template
  const agentsWritten = await writeFile(agentsPath, agentsMdContent);
  if (agentsWritten) {
    console.log(chalk.blue("📄 Created AGENTS.md"));
  }

  if (tools.includes(AI_TOOLS["claude-code"].cliFlag)) {
    writeClaudeMd(cwd);
  }
}

/**
 * Write the Arbor main-agent block into CLAUDE.md. A missing file is created
 * from the template; an existing one keeps all of its own text and gets the
 * block replaced in place or appended below it.
 */
function writeClaudeMd(cwd: string): void {
  const claudePath = path.join(cwd, FILE_NAMES.CLAUDE);
  const template = replacePythonCommandLiterals(claudeMdContent);
  const existing = fs.existsSync(claudePath)
    ? fs.readFileSync(claudePath, "utf-8")
    : null;
  const content =
    existing === null
      ? template
      : mergeManagedBlockContent(
          existing,
          template,
          ARBOR_BLOCK_START,
          ARBOR_BLOCK_END,
        );
  if (writeManagedBlockFile(claudePath, content)) {
    console.log(
      chalk.blue(
        existing === null
          ? "📄 Created CLAUDE.md"
          : "📄 Updated the Arbor block in CLAUDE.md",
      ),
    );
  }
}
