---
sources:
  - packages/cli/src/migrations/index.ts
  - packages/cli/src/migrations/manifests/*.json
  - packages/cli/src/types/migration.ts
  - packages/cli/src/commands/update.ts
  - packages/cli/src/utils/template-hash.ts
  - packages/cli/src/utils/manifest-prune.ts
  - packages/cli/src/utils/retired-platforms.ts
  - packages/cli/src/utils/file-writer.ts
  - packages/cli/src/utils/cwd-guard.ts
last_verified: 2026-11-13
---
# Migration System

智能迁移系统，用于处理模板文件重命名和删除。

## 目录结构

```
src/migrations/
├── index.ts              # 迁移逻辑 (动态加载 JSON)
└── manifests/
    └── {version}.json    # 各版本迁移清单
```

## 添加新版本迁移

创建 `src/migrations/manifests/{version}.json`：

```json
{
  "version": "0.2.0",
  "description": "变更说明",
  "breaking": false,
  "recommendMigrate": false,
  "changelog": "一行变更摘要",
  "migrations": [
    {
      "type": "rename",
      "from": ".claude/commands/old.md",
      "to": ".claude/commands/new.md",
      "description": "重命名原因"
    },
    {
      "type": "delete",
      "from": ".arbor/scripts/deprecated.py",
      "description": "删除原因"
    }
  ]
}
```

**无需修改任何代码** - 构建时自动复制到 dist。

### Breaking 版本必须提供 `migrationGuide`

任何 `breaking: true` + `recommendMigrate: true` 的 manifest 必须额外附带 `migrationGuide`（`aiInstructions` 可选）：

```json
{
  "version": "1.0.0",
  "breaking": true,
  "recommendMigrate": true,
  "migrationGuide": "1. Before updating, finish or abandon every started task...\n2. Run `arbor update --migrate`...",
  "migrations": [ /* ... */ ]
}
```

**强制原因**：`update.ts` 在升级结束、summary 之后，把 `getMigrationMetadata(fromVersion, toVersion)` 收集到的**所有** `migrationGuide` 逐个打印（只在区间是 `breaking` 时）。这是用户在本次升级里能看到的唯一一份按版本的操作说明。如果当前 breaking release 漏写 `migrationGuide`：

- 场景 A：用户跨多个版本升级 → 只打印更早版本的 guide，**一字不提本次 breaking**
- 场景 B：区间内所有 manifest 都没 `migrationGuide` → 什么都不打印

没有任何检查强制这一点，靠人工 review：`breaking && recommendMigrate` 的 manifest 必须带 `migrationGuide`。

**字段语义**：
- `migrationGuide` —— 面向最终用户的 narrative，`arbor update` 结束时以 `📋 v<version> migration guide:` 打印
- `aiInstructions` —— 面向 AI 的指令；`getMigrationMetadata` 会把它和 guide 一起收集，但目前没有任何代码显示它

**何时 _不_ 需要**：
- 非 breaking 版本（`breaking: false`）：不需要 `migrationGuide`
- breaking 但 `recommendMigrate: false`：没校验强制（0.11.0 就是这种组合，仍带了 `migrationGuide`）。

## 迁移类型

| Type | 必填字段 | 说明 |
|------|----------|------|
| `rename` | `from`, `to` | 重命名文件 |
| `rename-dir` | `from`, `to` | 重命名目录（包含所有子文件） |
| `delete` | `from` | 删除文件 |
| `safe-file-delete` | `from`, `allowed_hashes` | Hash 校验后自动删除废弃文件（无需 `--migrate`） |

### rename-dir 示例

```json
{
  "type": "rename-dir",
  "from": ".arbor/structure",
  "to": ".arbor/spec",
  "description": "重命名 structure 为 spec"
}
```

**特点**：
- 整个目录移动（包括用户添加的文件）
- 自动批量更新 hash 追踪
- 移动后自动清理空的源目录
- 嵌套目录按深度优先处理（避免父目录先移动导致子目录找不到）
- 目标目录不存在时，是否自动执行取决于归属：只有当 manifest 记录了 `from` 目录下的文件（即这个目录是 arbor 自己建的）才会 `auto`；否则视为可能是用户自建的同名目录（例如用户自己的编辑器配置目录，恰好与某个已退役的 Arbor 平台目录同路径），路由到 `skip`（即使 `--force` 也不执行）。详见下方分类逻辑与 [Filesystem Safety](./filesystem-safety.md)。

### safe-file-delete 示例

```json
{
  "type": "safe-file-delete",
  "from": ".arbor/scripts/common/driver/mcp.py",
  "description": "codeg MCP handoff, replaced by driver/orca.py in 0.10.0",
  "allowed_hashes": ["16b08a07c955fc71d13a33d4cf59de6969e7234c1352a215223963deb6569519", "..."]
}
```

（取自 `manifests/0.10.0.json`。）

**工作机制**：
- **无需 `--migrate`** — 在每次 `arbor update` 时自动执行
- **Hash 校验** — 只有当文件内容的 SHA256 匹配 `allowed_hashes` 中的某个值时才删除
- **版本无关** — 从所有 manifest 收集 safe-file-delete 条目，不受版本范围限制（`.arbor/.version` 缺失时也执行）
- **当前模板优先** — 路径属于当前模板集时忽略该条目（后来的版本有意恢复了这个路径）
- 删除后自动清理 hash 记录和空目录

**分类逻辑**：

| 分类 | 条件 | 行为 |
|------|------|------|
| `delete` | 文件存在，hash 匹配，非 protected，非 update.skip | 删除文件 |
| `skip-missing` | 文件不存在 | 跳过 |
| `skip-modified` | 文件存在但 hash 不匹配（用户已修改） | 保留 |
| `skip-protected` | 路径在 PROTECTED_PATHS 中 | 保留 |
| `skip-update-skip` | 路径在 config.yaml `update.skip` 中（breaking + `--migrate` 时绕过） | 保留 |

`allowed_hashes` 为空或缺失的条目一律归为 `skip-modified`。

## 分类逻辑

| 分类 | 条件 | 行为 |
|------|------|------|
| `auto` | 文件未被用户修改 / rename-dir 目标不存在且源目录有 manifest 记录（arbor 建的）/ rename-dir 目标存在且只含未修改模板文件 | 自动迁移 |
| `confirm` | 文件已被用户修改 | 默认询问，`-f` 强制，`-s` 跳过 |
| `conflict` | 新旧路径都存在且新路径含用户修改内容 | 跳过并提示手动解决 |
| `skip` | 旧路径不存在 / 路径受保护 / rename-dir 目标不存在且源目录无 manifest 记录（疑似用户自建同名目录，即使 `--force` 也不执行） | 无需操作 |

## `configSectionsAdded`（追加式 config.yaml 节）

可选 manifest 字段，声明本版本在 `.arbor/config.yaml` 引入的新顶层 section。`arbor update` 走完文件写入循环后会再扫一遍 `getConfigSectionsAddedBetween(fromVersion, toVersion)`，每条 entry 命中"目标文件存在 + sentinel 不在文件里"才会从打包模板里抽对应 section 追加到末尾。仅追加，幂等（重跑时 sentinel 已在）。

```jsonc
{
  "version": "0.1.0",
  "configSectionsAdded": [
    {
      "file": ".arbor/config.yaml",
      "sentinel": "executors:",     // 用户文件里出现这个 substring（注释或活配）就视为已存在
      "sectionHeading": "Executors" // 模板里 #--- 分隔块内 `# <heading>` 行匹配此值
    }
  ]
}
```

**字段语义**：

- `file` —— 目标文件相对仓库根的路径（当前只用过 `.arbor/config.yaml`，机制本身不限定）
- `sentinel` —— 幂等 gate：用户文件包含此 substring（live 或注释）就跳过。挑稳定的 token，比如新引入的顶层 YAML key
- `sectionHeading` —— 模板里 `#---` 分隔块内 `# <heading>` 那一行的内容，extractor 从此分隔块开始抽到下一个 `#---` 分隔块（或 EOF）。模板里找不到这个 heading 时该条目静默跳过

**为什么不直接覆盖 config.yaml**：`.arbor/config.yaml` 存的是项目自己的设置（`packages`、`executors` 等），`collectTemplateFiles` 根本不把它放进模板集，所以 `arbor update` 永远不会重写它，`--force` 也不会（`test/migrations/migration-1.0.0.test.ts > never rewrites .arbor/config.yaml, not even with --migrate --force`）。`configSectionsAdded` 的 sentinel-gated 追加是 update 写这个文件的唯一路径，而且只在真正升级时（`cliVsProject > 0`、版本已知）运行。

**未来加新 section**：在对应版本 manifest 加一条 entry 即可，`update.ts` 不需要改。`packages/cli/src/templates/arbor/config.yaml` 模板里加对应 `#---` 分隔块和 section 内容，`arbor init` 走默认写入路径自然会拿到新 section。

## 受保护路径

以下路径不会被任何迁移操作修改或删除（用户数据）：

- `.arbor/workspace` — 开发者工作记录
- `.arbor/tasks` — 任务追踪
- `.arbor/spec` — 开发指南（用户自定义）
- `.arbor/.developer` — 开发者身份
- `.arbor/.current-task`

> 注意：`rename`/`rename-dir` 类型允许将文件迁移 **到** 受保护路径，但不允许从受保护路径迁移；`delete` 等其他类型两个方向都不允许。

## update.skip 配置

在 `config.yaml` 中配置跳过路径，防止 safe-file-delete 删除指定文件：

```yaml
update:
  skip:
    - .claude/skills/arbor/SKILL.md
    - .agents/skills/
```

- 支持文件路径和目录路径（目录路径以 `/` 结尾，匹配所有子文件）
- 同时影响模板更新和 safe-file-delete
- 跨 `breaking` + `recommendMigrate` 的升级加 `--migrate` 时整体绕过（`breakingBypass`，见 `commands-update.md`）

## 模板哈希追踪

- 存储位置：`.arbor/.template-hashes.json`
- 用途：检测用户是否修改过模板文件
- 原理：比较当前文件 SHA256 与存储的哈希值
- 初始化：`arbor init` 时自动创建
- 更新：`arbor update` 后自动更新被覆盖文件的哈希

### Manifest ownership contract (CRITICAL — data loss prevention)

`.template-hashes.json` is the **single source of truth** for `arbor uninstall`. Every key listed there gets `fs.unlinkSync`'d at uninstall time. Therefore the manifest must contain **only files arbor actually wrote during init / update — never files that merely happen to exist under a managed directory**.

#### Why this matters

`.claude/` and `.codex/` contain platform-specific user data:
- `.claude/projects/<sanitized-cwd>/*.jsonl` — Claude Code conversation history
- `.codex/sessions/*` — Codex session data
- User-added `.claude/agents/<name>/`, `.agents/skills/<name>/`

If `initializeHashes` walks these dirs and hashes everything, uninstall faithfully deletes user data. Real incidents reported upstream: a platform's session-history directory wiped (Issue #221), and a pre-existing `AGENTS.md` wiped (PR #271).

#### Required contract

**`initializeHashes(cwd, opts)`** must derive the manifest set from `opts.trackedPaths` (a `Set<string>` of paths arbor **actually wrote this run**), NOT from `fs.readdirSync` walks of platform dirs.

The set is produced by `startRecordingWrites()` / `stopRecordingWrites()` instrumentation inside `utils/file-writer.ts`. `writeFile()` records `recordWrite(absPath)` ONLY when:

- The file did not exist → wrote (recorded)
- The file existed and content differed → overwrote (recorded)

And **does NOT record** when:

- The file existed and content was byte-identical (no disk write)
- `writeMode` was `skip-existing` and the file existed (skipped)
- The call was append-mode (`appendFile`)

Every configurator that wants its writes tracked must funnel through `writeFile()` — direct `fs.writeFileSync` bypasses the recorder. The one exception to "record only real writes" is `writeManagedBlockFile()` (used for `CLAUDE.md`): it records the path even when the content is unchanged, because a file carrying the managed block is Arbor-managed either way and uninstall only strips the block.

#### `.arbor/` walk exemption

`.arbor/` files are still hashed via recursive walk (existing `collectFiles` behavior + `EXCLUDE_FROM_HASH` filters). Rationale: `arbor uninstall` step 3 does `fs.rmSync('.arbor/', { recursive: true, force: true })` regardless of manifest content, so the walk's blast radius is contained. Over-hashing inside `.arbor/` only affects `arbor update` 3-way-merge accuracy, not uninstall safety.

#### Self-heal contract: `pruneOrphanManifestKeys`

Existing users may have poisoned manifests from older arbor versions. `pruneOrphanManifestKeys(cwd, configuredPlatforms, hashes, opts)` runs at the top of both `arbor update` AND `arbor uninstall` (before plan classification) and prunes orphan keys.

**Preserve set** (a key is kept iff one of):

1. Starts with `.arbor/` (walk-managed)
2. Path appears in `collectPlatformTemplates(id)` output for ANY configured platform
3. Path appears in `from` or `to` of ANY migration manifest entry (across all `migrations/manifests/*.json`, not just pending) — must preserve so rename/delete migration logic still has a hash to compare against
4. Path is `AGENTS.md` or `CLAUDE.md` AND the file on disk contains `ARBOR_BLOCK_START` + `ARBOR_BLOCK_END` markers, OR the file is missing. Files lacking markers are treated as user-owned and pruned.
5. Path is in `utils/retired-platforms.ts:RETIRED_PLATFORM_PATHS` (see "Retired platforms" below)

`options.persist: false` skips the manifest write; `uninstall --dry-run` passes it, `arbor update` does not (it persists the prune on every run, `--dry-run` included).

#### Wrong vs Correct

```typescript
// Wrong — walk-based hashing pollutes manifest with user data
for (const dir of ALL_MANAGED_DIRS) {
  for (const f of collectFiles(cwd, dir)) {
    hashes[f] = sha256(read(f));   // includes .claude/projects/x/foo.jsonl
  }
}

// Correct — manifest reflects exactly what arbor wrote this run
startRecordingWrites();
await runConfigurators(cwd);       // each writeFile() calls recordWrite()
const written = stopRecordingWrites();
initializeHashes(cwd, { trackedPaths: written });
```

#### Homedir guard (R2 — defense in depth)

Even with the manifest contract above, `arbor init` and `arbor uninstall` refuse to run when `process.cwd()` is exactly the user's home directory. Use `isCwdHomedir()` from `utils/cwd-guard.ts` — it compares via `fs.realpathSync.native()` on both sides, Windows-lowercases for case-insensitivity, and returns `false` (guard does not trip) when the lookup throws. Override via `ARBOR_ALLOW_HOMEDIR=1` only; `--force` does NOT bypass.

#### Tests required for any change in this area

- Integration: pre-populate user files under `.claude/` and `.codex/`, run init+uninstall, assert user data preserved.
- Integration: pre-existing `AGENTS.md` (skip-existing path), uninstall preserves it.
- Integration: poisoned manifest (manually injected key) → update OR uninstall prunes it, user file survives.
- Unit: `recordWrite` instrumentation — new/overwrite recorded, identical/skip/append NOT recorded.
- Unit: `pruneOrphanManifestKeys` — preserves all five classes above; rewrites manifest only when pruned.length > 0.
- Unit: `isCwdHomedir` — symlinked home matches; subdirectory does NOT match; Windows case-insensitive.

## 1.0.0 manifest

`manifests/1.0.0.json` 是 `breaking: true` + `recommendMigrate: true` + `migrationGuide`，`configSectionsAdded` 为空，`migrations` 全部是普通 `delete`（99 条，没有 `allowed_hashes`）。因此：

- 从 0.x 升级而不带 `--migrate`（也不是 `--dry-run`）时 breaking gate 让 `arbor update` 以 exit 1 结束。
- 带 `--migrate` 时：未修改的文件直接删除（`auto`），用户改过的走 `confirm`（`-f` 删除、`-s` 保留、交互默认 `backup-rename`）；空目录随后被清理。
- 条目覆盖 0.11 装过而 1.0 不再安装的路径：`.arbor/agents/*.md`、`.arbor/workflow.md`、被删的 `.arbor/scripts/**`、`.claude/hooks/*`（不含 `statusline.py`）、`.claude/commands/**`、`.claude/skills/**` 与 `.agents/skills/**` 下被删的 skill、`.codex/hooks/*` 和 `.codex/hooks.json`。
- `.claude/settings.json` 不在删除列表里：未修改时由 1.0 模板（无 `hooks`）覆盖；用户改过的 `.claude/settings.json` / `.codex/hooks.json` 被 `update.ts:planHookScrubs` 从模板覆盖和删除列表里拿出来，只去掉指向被删脚本的 hook 条目（见 `commands-update.md` § `--migrate`）。

没有生成脚本。删除列表由 `test/migrations/migration-1.0.0.test.ts` 钉住：非脚本部分必须恰好等于 `test/fixtures/install-0.11.0.json`（一次 0.11 claude + codex 安装的 manifest 路径）减去一次 1.0 安装的路径；脚本部分不得含 1.0 仍安装的脚本，也不得漏掉 0.11 有而 1.0 没有的脚本。增删模板后这个测试失败，就改 manifest，不改测试。

## Retired platforms

`utils/retired-platforms.ts:RETIRED_PLATFORM_PATHS` 列出已退役平台（StarFactory，`.starFactory/`）曾写过的文件，只用于清理归属，不能再安装：

- `pruneOrphanManifestKeys` 保留这些 manifest 条目（preserve set 第 5 类），所以它们的 hash 在 update 后仍在，`arbor uninstall` 能认领并清理（`.starFactory/settings.json` 走 `scrubHooksJson`，见 `commands-uninstall.md`）。
- 未修改的文件由 `manifests/0.2.0.json` 里对应的 `safe-file-delete` 条目（hash 校验）删除；改过的保留。
- `update.ts` 的 `BACKUP_DIRS` 包含这些路径的顶层目录，删除前已进快照。

测试：`test/commands/retired-platform.integration.test.ts`。

## CLI 使用

```bash
arbor update              # 显示迁移提示
arbor update --migrate    # 执行迁移（修改过的文件会提示确认）
arbor update --migrate -f # 强制迁移（备份后执行）
arbor update --migrate -s # 跳过修改过的文件
```

## 相关文件

- `src/types/migration.ts` - 类型定义
- `src/migrations/index.ts` - 迁移逻辑
- `src/utils/template-hash.ts` - 哈希工具
- `src/commands/update.ts` - 更新命令集成
