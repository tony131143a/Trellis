# 调研：工作流选择 / 模板安装 / update 的扩展点

路径相对 `packages/cli/`。结论先行：**(1) 目前不持久化"选中的工作流 id"**——update 只能从 workflow.md 是否有 hash 推断；**(2) 没有"按条件安装模板文件"的先例**（最接近的是 statusLine opt-in 与 registry 配置的保留步骤）。

## 1. 工作流解析与写入

- Resolver `src/utils/workflow-resolver.ts`：`NATIVE_WORKFLOW_ID="native"`（:40）是虚拟条目，返回内置 `workflowMdTemplate`（:90-107, :207-209）；其他 id 走 marketplace `index.json`（type:"workflow"）下载（:203-258）。列表中只有 native 是 bundled（:164）。
- init `src/commands/init.ts`：:1887-1903 解析 id；非 native → `workflowMdOverride`，由 `createWorkflowStructure` 写入（`src/configurators/workflow.ts`:133, :144-147）；`initializeHashes`（:1973）后对非 native 删除 workflow.md 的 hash（:1994-1996）。re-init 分支（:1197-1210）在 :1887 之前 return → re-init 时 `--workflow` 被忽略（由控制流推断）。
- `trellis workflow --template`（`src/commands/workflow.ts`）：:287 解析 → `writeWorkflow`（:160-228）按 missing / identical / pristine / modified 分类（:80-102）；`applyHashContract`（:144-158）native 刷新 hash、其他 `removeHash`；:303/:306 `warnAboutMissingAgents`。
- 持久化：无（`src` 中无 workflow_id 之类字段）。
- update：`collectTemplateFiles` 对 workflow.md 恒用 native 模板（`src/commands/update.ts`:903）；native 且 hash 匹配 → 自动更新（:1018-1032）；marketplace 变体无 hash → 冲突（`--skip-all` 跳过，`--force` 用 native 覆盖 :1182-1184；测试 `workflow.integration.test.ts`:284 只覆盖 skipAll）。

## 2. 内置模板注册与 update 判定

- `src/templates/trellis/index.ts`：`readTemplate`（:29）；`getAllAgents()` 固定三张（:146-152）；`getAllScripts()` 固定脚本集（:95-136）。
- `createWorkflowStructure` 无条件写 scripts / workflow.md / config.yaml / 全部 agents（`src/configurators/workflow.ts`:139-174；:165-170 注释明确 agents 与工作流无关地安装）。
- hash：init 记录写入（`init.ts`:1914）；`initializeHashes` 遍历 `.trellis/` 减去 `EXCLUDE_FROM_HASH`（`src/utils/template-hash.ts`:263-274, :387-396）；manifest prune 始终保留 `.trellis/*`（`src/utils/manifest-prune.ts` ~:136）。
- update 判定 `analyzeChanges`（`update.ts`:987-1041）：文件缺失且无 hash → 新增；缺失但有 hash → 视为用户删除、不动；与模板相同 → 无变化；hash 匹配 → 自动更新；否则冲突。写入 :2620-2688，hash 刷新 :2713-2733。
- 条件性先例（均非工作流）：只收集已配置平台（:870, :909）；registry spec 文件仅在 config.yaml 配置 registry 时纳入（:763-854, :935）；statusLine opt-in 在模板映射之后应用（`src/configurators/claude.ts`:146-153）；config.yaml 段落按 sentinel 追加（`update.ts`:605-651；`src/types/migration.ts`:39-81）；`ensureGitattributes` 只追加（`workflow.ts`:95-110）。

## 3. Claude statusLine opt-in

- 存储：只体现在磁盘上 settings.json 的 `statusLine` 键与 `.claude/hooks/statusline.py`，无配置开关；`--with-statusline` 经 `PlatformConfigureOptions.withStatusline` 传入（`src/configurators/shared.ts`:15-22, `init.ts`:1943-1945, :890-892）。
- 渲染：`collectClaudeTemplates()` 不含 statusline（`claude.ts`:109-128）；`configureClaude` 用 `injectStatusLine` 输出替换 settings.json（parse → 末尾加键 → `stringify(null,2)+"\n"`，:52-59）并写 hook 文件。
- update 字节一致：`preserveExistingClaudeStatusLine`（`update.ts`:706-742，:933 调用）用同样序列化把已有 `statusLine` 拷进新模板；update 不安装 statusline.py（其 hash 因不在平台模板集而被 prune，推断自 `manifest-prune.ts`:59-78）。
- 复用于 hook：添加可沿用同一方式；**移除是新代码**（preserve 只做加法）。`scrubHooksJson`（`src/utils/uninstall-scrubbers.ts`:99+）已能剥离指向已删除路径的 hook 条目，可复用。
- 测试：`test/configurators/platforms.test.ts`（:386, :1453, :1463, :1502；`CONFIGURE_ONLY_PATHS` :103）、`test/commands/update.integration.test.ts`（#22/#22a/#22b :1270-1352）、`test/commands/init.integration.test.ts`（#24-#28 :1538-1596）、`test/regression.test.ts`（:2126, :2136）、`test/utils/uninstall-scrubbers.test.ts`（:81-114）、`test/templates/shared-hooks.test.ts`（:51）。

## 4. 原地编辑 config.yaml 的 helper

- `writeMonorepoConfig`（`init.ts`:1057-1096）追加 `packages:`；`writeSpecRegistryConfig`（`src/utils/registry-config.ts`:83+）逐行重写 `registry.spec` 块；`applyConfigSectionsAdded`（`update.ts`:605-651）按 sentinel 追加整段；`preserveExistingRegistryConfig`（`update.ts`:744-761）把 registry 配置带进 update 模板。
- 只读：`parseWorkerGuardSection`（`src/commands/channel/guard.ts`:172-230）；`DEFAULT_MAX_LIVE_WORKERS=6`（:42）。
- 风险（由流程推断）：init 在 hash 之前改 config.yaml（:1928, :1969 → :1973），下次 update 时 hash 匹配会把 `max_live_workers` 自动更新回模板值 6（模板 :105），除非有类似 `preserveExistingRegistryConfig` 的保留步骤。

## 5. 相关测试

- `test/commands/workflow.integration.test.ts`：native vs tdd 的 hash 保留/删除（:102, :115）、切回 native（:175）、未加 `--force` 拒绝覆盖本地修改（:209, :238）、`--create-new`（:264）、update 不还原 native（:284）。
- `test/utils/workflow-resolver.test.ts`：native 离线、marketplace 拉取、错误、路径逃逸、列表顺序。
- `test/commands/update.integration.test.ts`：workflow.md 整文件更新（:1538）、config 追加段（~:860-900）、`update.skip`（#16/#17）、hash 回执修复与 `MIXED_OWNERSHIP`（:1585+）。
- `test/commands/update-internals.test.ts`（`loadUpdateSkipPaths` :141-179）、`test/utils/template-hash.test.ts`、`test/utils/manifest-prune.test.ts`（保留 `.trellis/*` :31，prune 无主条目 :45）。
- `test/templates/claude.test.ts`（settings.json 形状、SessionStart matcher）、`test/templates/trellis.test.ts`（workflow 模板内容）、`test/commands/init.integration.test.ts`（monorepo config #14 #18）。
