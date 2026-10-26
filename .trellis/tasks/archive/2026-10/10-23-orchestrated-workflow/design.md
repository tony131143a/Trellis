# 设计：沉淀 Conductor/Worker 编排流程（orchestrated 工作流）

需求与决策见 `prd.md`（D1–D4）。来源资产：spark-harness `.trellis/orchestrator/`（v2，契约 design.md §15，436 单测）、`.trellis/agents/{check,check-verify,simplify,implement}.md`、`.trellis/workflow.md` 的 orchestrating 块。调研：`research/install-mechanism.md`、`research/tests-specs-channel.md`。

## 1. 任务结构

父任务（本任务）+ 子任务；阶段 1 先实现，阶段 2 在阶段 1 合入后实现。

| 子任务 | 阶段 | 内容 | 依赖 |
|---|---|---|---|
| `channel-terminal-per-turn` | 1 | 修 C-1：终止事件标志按 turn 复位，后续轮次崩溃也合成 `error` | — |
| `channel-idle-ttl-per-worker` | 1 | 修 C-2：空闲清理按每个 worker 自己的 TTL | — |
| `channel-orchestrator-spec` | 1 | 在 `commands-channel.md` 新增"长生命周期编排器集成"一节（事件 / wait / resume / 预算 / 空闲 / project key / trusted dirs / stdout 末行 JSON），并更新 ShutdownController、OOM guard 两节为修复后行为 | C-1、C-2（spec 描述修复后的行为） |
| `orch-engine-port` | 2 | 引擎移植进 `templates/trellis/orchestrator/` 并通用化（§3、§4）+ Python 测试接入 | 阶段 1 |
| `orch-workflow-assets` | 2 | `orchestrated` 工作流正文、`conductor.md`、新 agent 卡、brief 协议（§5） | — |
| `orch-install` | 2 | TS：bundled 工作流 + 配套资产安装/移除/更新 + Claude hook opt-in + 预算调高 + 保留步骤（§6） | `orch-engine-port`、`orch-workflow-assets` |
| `orch-spec-docs` | 2 | spec：编排模式契约 + workflow-state writer 表 + 命令 spec；同步 bundled 技能参考文档 | `orch-install` |

## 2. 阶段 1：channel 运行时修复

- **C-1**（`supervisor/stdout.ts:201-203`、`supervisor/shutdown.ts:95/191/222`；turn 开始于 `supervisor/inbox.ts:123-132`）：合成判定改为"退出时是否有在途 turn 尚未发终止事件"——在 turn `begin()` 时复位标志（或以 `turnTracker.current()` 判定）。约束：空闲状态（上一 turn 已 done）下的正常退出不得再补事件；显式 shutdown 仍只发 `killed`。顺带恢复 `warning.ts:69-75` 的超时前 `supervisor_warning` 在后续轮次的触发。测试：补齐 `commands-channel.md:1109` 要求但缺失的 "Cold-exit fallback synthesis"、"markTerminalEmitted race"；新增"第 1 轮 done、第 2 轮进程崩溃 → 合成 `by=<worker>` 的 `error`，`wait --kind done/turn_finished` 返回"与"done 后空闲时正常退出 → 无额外事件"。
- **C-2**（`spawn.ts:180-197` → `guard.ts:597-601` → `cleanupExpiredIdleWorkers` 518/480-493）：每个 worker 的 TTL 已落盘在 `<channelDir>/<worker>.config` 的 `idleTimeoutMs`（`spawn.ts:259-283`、`supervisor.ts:603-614`）。`scanLiveWorkers`（`guard.ts:294-381`）读取它并按候选自身 TTL 判定；`.config` 缺失/不可读 → 回退调用方 TTL（向后兼容）。测试（`channel-guard.test.ts`）：A `.config` 3h、空闲 10 分钟，5m 策略的 spawn 不清理 A；B `.config` 5m（或缺失）空闲 10 分钟仍被清理。

修复后引擎侧可删去对应绕路（pid 轮询兜底保留为防御，但不再是唯一检测手段）。

## 3. 引擎通用化（`orch-engine-port`）

位置：`packages/cli/src/templates/trellis/orchestrator/` → 安装到 `.trellis/orchestrator/`（保持 spark 路径，hook 命令与提示词不变）。只移植运行时文件与 `briefs/`（`scripts/copy-templates.js` 自动打进 npm 包；不在 `templates/trellis/scripts/` 下，不受逐字节 dogfood 副本约束）。

测试（调研 1）：仓库无 pytest 体系，Python 一律经 vitest 测。引擎 unittest 放 `packages/cli/test/python/orchestrator/test_*.py`（不进模板 / npm 包），新增 vitest 包装 `test/scripts/orchestrator-unittest.test.ts` 跑 `python3 -m unittest discover`，缺 Python 时 `skipIf`，超时放宽。CI 约束：Python 3.9 `py_compile` 覆盖全部 `.py`（含测试）；basedpyright（standard，3.9）覆盖 `templates/**/*.py` → 引擎须 3.9 运行时兼容且 basedpyright 干净（11 个文件均已 `from __future__ import annotations`，3.9 语法解析通过；运行时与类型检查待验证）。测试夹具中 spark 专属内容（Go 命令、中文 commit、本机路径）随默认值一并改写。

| spark 绑定 | 改为 |
|---|---|
| `DEFAULT_SETTINGS.quick_gate / full_gate / integration_setup` 为 Go/make 命令（`ledger.py`） | 默认空列表；由 plan.json `settings` 提供（config.yaml 不作为门禁来源，2026-10-23 复审后裁定）；`plan` 在为空时提示（不报错） |
| `DEFAULT_TRELLIS_BIN` 本机路径，经 `node <trellis.js>` 调用（`ledger.py:33`、`guard.py:41`、`channel.py:171`） | 解析顺序：环境变量 `TRELLIS_CLI`（值以 `.js` 结尾时经 `node` 运行，兼容 spark 的 `TRELLIS_BIN`）→ `shutil.which("trellis")` → `shutil.which("tl")`；找不到时报清晰错误。现有脚本只有 `session_context.py:331-347` 裸调 `trellis`（调研 4） |
| `commit_messages` 中文模板 | 英文 conventional 默认：`refactor: simplify $title`、`fix: repair post-merge build`、`fix: repair integration gate`、`merge: merge $integration_branch into $branch (resolve conflicts)`、`merge: merge $base_branch into $integration_branch (sync base)`；可在 settings 覆盖 |
| `hot_files` 含 go.mod 等 | 保留常见锁文件/清单的通用默认（`**/go.mod`、`**/go.sum`、`**/package.json`、`**/package-lock.json`、`**/pnpm-lock.yaml`、`**/Cargo.lock` …），可覆盖 |
| `max_live_workers: 28` | 引擎预算 = min(settings 值, channel `worker_guard.max_live_workers`)；`plan` 输出当前预算下可并行子任务数及调高建议 |
| `session.py` 平台识别（star / claude） | 保留；未知平台 → 无身份 → guard 放行（文档说明约束层仅 Claude Code 生效） |
| 代码注释中文 | 统一英文（upstream 约定） |
| 写 `task.json.status = orchestrating`（`orch.py:624/634`） | 保留为新 writer，登记到 workflow-state 契约 writer 表（见 §7） |

## 4. `.trellis` 入库 / 不入库两种模式

spark 方案（worktree 内软链 `.trellis` → 主检出）只在 `.trellis/` 不入库时成立。引擎在 `start` 时探测模式：`git ls-files --error-unmatch .trellis/workflow.md` 成功 = 入库。

| | 不入库（spark） | 入库（Trellis 默认） |
|---|---|---|
| worktree 内 `.trellis` | 软链到主检出（现状） | 分支自带的已跟踪副本，不软链 |
| agent 卡来源 | 软链 → 主检出 | worktree 自带（`agent-loader.ts:41-75` 只按名字在 `<cwd>/.trellis/agents/` 查找）→ **`start` 前置检查：编排所需卡已提交到基线分支**，否则报错并给出提交提示 |
| 任务产物（prd、brief、reviews 输出） | 经软链在 cwd 内 | brief 一律给主检出绝对路径（现有 brief 已如此）；Claude worker 为 `bypassPermissions`（`adapters/claude.ts:278-280`）可读写 |
| 引擎提交 | 两种模式都不提交 `.trellis/**`（沿用 `gitops.py` 的 stray `.trellis` reset 与 `clean -e .trellis`）；scope 检查忽略 `.trellis/**` |
| 子任务目录 | 主检出里由 `task.py create --parent` 创建，随父任务在 Phase 3 正常提交/归档 |

已知限制：codex 等沙箱 provider 写主检出绝对路径可能被拒；首版文档注明推荐 claude / star 类 provider。

## 5. 工作流资产（`orch-workflow-assets`）

- **workflow.md（orchestrated 变体）**：以 bundled native 为底，保留全部 `[workflow-state:*]` 块与 Phase/步骤编号契约；Phase 2 改为编排模式；新增 `[workflow-state:orchestrating]` 块（Conductor 循环 + `--parent`）。spark 版本是在 channel-driven 变体上改写的，不能直接拿来。
- **conductor.md**：spark v2 版本（英文、host 中立），去掉 spark 示例（`go test`、中文 commit 约定），改为通用示例。
- **agent 卡**：不改写 bundled `check.md` / `implement.md`（其他工作流在用）。新增三张卡：`review-finder.md`（只报不改、JSON 输出、每条带 failure_scenario）、`review-verify.md`（对抗式证伪）、`simplify.md`；默认 `provider: claude` + star 覆盖提示（与 research 卡一致）。spark `implement.md` 追加的 "Orchestration Mode" 段落移入 `briefs/implement.md` / `fix.md` / `resolve.md`，bundled implement 卡零改动。引擎派发时按新卡名。
- **briefs/**：9 个模板原样（已为英文），去掉 spark 字样。

## 6. 安装机制（`orch-install`）

调研结论：现在**不持久化选中的工作流 id**，update 对 workflow.md 恒用 native 模板（`update.ts:903`）；**无按条件安装模板的先例**。

- **选中信号**：不新增状态。"已选中 orchestrated" ⇔ `.trellis/.template-hashes.json` 里存在 `.trellis/orchestrator/orch.py` 的 hash（即由 Trellis 安装）。spark-harness 这类自建引擎没有 hash → 不被视为选中、不被触碰。
- **bundled 第二工作流**：resolver 新增虚拟条目 `orchestrated`（同 native，离线、`source: "bundled"`），列表中排在 native 之后；`applyHashContract` 对 bundled 两者都保留 hash。
- **选中（init `--workflow orchestrated` / `trellis workflow --template orchestrated`）**：写 orchestrated workflow.md；安装 `.trellis/orchestrator/**` 与三张新卡并记 hash；若 Claude Code 已配置 → 向 `.claude/settings.json` 注入 hook 条目（PreToolUse guard、SessionStart startup/clear/compact inject、UserPromptSubmit inject），序列化方式同 `injectStatusLine`；预算调高（D4，§8）；未配置 Claude Code 时打印"约束层仅 Claude Code 生效"。
- **切走（选 native 或 marketplace 变体）**：若存在活跃编排（任一父任务 `orchestration.json` 的 stage ∈ LIVE_STAGES）→ 拒绝并提示先 finish/abort（`--force` 可越过）；否则删除 `.trellis/orchestrator/**` 与三张卡（仅当文件与记录 hash 一致；用户改过的保留并提示）、移除对应 hash、从 settings.json 剥离指向 `.trellis/orchestrator/` 的 hook 条目（复用 `scrubHooksJson` 思路，`uninstall-scrubbers.ts:99+`）。预算不回调（只是上限，不影响其他工作流）。
- **update**：`collectTemplateFiles` 在选中时：workflow.md 用 orchestrated 模板对比；纳入引擎文件与三张卡；Claude settings 模板注入 hook 条目（保持字节一致，否则每次 update 都报 settings.json 变更）。未选中时一律不纳入。
- **re-init 忽略 `--workflow`** 是现有行为（`init.ts:1197-1210`），本任务不改，文档注明用 `trellis workflow --template`。

## 7. workflow-state 契约

`orch.py start` 把父任务 `task.json.status` 写为 `orchestrating`，`finish` / `abort` 写回 `in_progress`（以 spark 实现为准，`orch.py:624/634`）。仓库没有"只有 task.py 能写 status"的规则，要求是每个 writer 登记（调研 3）。`workflow-state-contract.md` 需要：writer 表（257-275）加行、删除 "No other writer exists" 断言（273）、可达性矩阵（298-309）加 `orchestrating`、核对消费方（391-393）；orchestrated workflow.md 提供 `[workflow-state:orchestrating]` 块（native 不含此块，未选中时状态不可达）。

## 8. 并发预算（D4）

- 选中时读 `config.yaml` 的 `channel.worker_guard.max_live_workers`：缺失或等于内置默认 6 → 写为 16 并打印说明（"约并行 3 个子任务；可按机器内存调整"）；其他值不动。
- **update 保留步骤**：新增 `preserveExistingWorkerGuardConfig`（与 `preserveExistingRegistryConfig` 对称，`update.ts:744-761`），把已有 `worker_guard` 值带进模板后再比较，避免 hash 匹配时被自动更新回 6（调研 4 的风险）。此步骤对所有项目生效（未修改的项目值即模板默认，行为不变）。

## 9. 兼容与回滚

- 未选中 orchestrated 的项目：模板集合、settings.json、config.yaml 行为不变（测试断言）。
- 阶段 1 修复向后兼容：旧 worker 无 per-worker TTL 记录 → 回退调用方 TTL。
- 回滚：选回 native 即移除全部配套资产；代码层面各子任务独立 commit，可单独 revert。
- spark-harness 继续使用本地 v2 副本；迁移到 bundled 版本不在本任务。

## 10. 风险

- 引擎体量大（~6.6k 行 Python + ~6.5k 行测试）进入 upstream 的评审成本；通过子任务拆分与契约 spec 降低。
- 入库模式未经真实冒烟（spark 是不入库模式）→ `orch-install` 验收含一次入库模式的玩具仓库冒烟。
- Claude settings.json 注入/剥离与 update 字节一致性是回归高发点（statusLine 有前例与测试可参照）。
- 引擎进入 basedpyright（standard，3.9）覆盖范围后可能出现大量类型告警，修复工作量未知；`orch-engine-port` 先跑一次摸底再定是否拆分。
