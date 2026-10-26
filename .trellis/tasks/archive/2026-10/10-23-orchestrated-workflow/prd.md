# 沉淀 Conductor/Worker 编排流程到 Trellis

## 目标

把 spark-harness 落地验证过的"Conductor 指挥 / Worker 施工"编排模式沉淀进 Trellis，让任何 Trellis 项目都能通过选择工作流启用；同时把落地中发现的 Trellis channel 运行时缺陷在源头修掉，并把相关契约写进 spec。

用户价值：主会话只做规划、拆分、派遣、裁决、合并决策，`trellis channel` worker 并发完成扫描、实现、评审、精简、修复；流程由引擎强制（`orch.py` 状态机 + `NEXT:` 唯一合法下一步），hook 硬拦截绕路。

## 背景

- 来源：spark-harness `.trellis/orchestrator/`（v2，2026-10-23 上线；契约 design.md §15；~6.6k 行 Python stdlib + ~6.5k 行测试 / 436 个），`conductor.md`（英文、host 中立），9 个 brief，agent 卡 `check.md`（finder）/ `check-verify.md` / `simplify.md`，`workflow.md` 的 `[workflow-state:orchestrating]` 块，Claude Code 的 guard（PreToolUse）/ inject（SessionStart、UserPromptSubmit）。
- 这些资产只存在于 spark-harness 的 git-excluded `.trellis/` 里，且有 spark 绑定：默认门禁为 Go/make 命令、`DEFAULT_TRELLIS_BIN` 写死本机路径（`ledger.py:33-34`、`guard.py:41`）、中文提交模板、依赖"`.trellis` 不入库 + worktree 软链"（Trellis 项目默认把 `.trellis/tasks/` 入库，`packages/cli/src/templates/trellis/gitignore.txt`）、改写了 bundled `check.md` / `implement.md`。
- Trellis 现状（详见 `research/install-mechanism.md`）：bundled 工作流只有 `native`；marketplace 工作流是单个 `workflow.md`，选中后为用户自管内容（hash 被丢弃，`commands/workflow.ts:153`）；不持久化选中的工作流 id，update 对 workflow.md 恒用 native 模板（`update.ts:903`）；无按条件安装模板的先例；channel 默认 `idle_timeout: 5m`、`max_live_workers: 6`（`templates/trellis/config.yaml:102-104`）。
- 仓库 origin 为用户 fork `tony131143a/Trellis`；`docs-site` 是未初始化的独立子模块。

## 决策

- **D1 范围**：阶段 1（channel 缺陷修复 + spec）+ 阶段 2（内置可选 `orchestrated` 工作流，约束层仅 Claude Code）。本任务为父任务，阶段 1 子任务先实现。
- **D2 标准**：按可提 upstream 的标准——严格 opt-in、默认英文提交模板、TS 测试与 spec 齐全。
- **D3 启用方式**：选工作流即启用。新增 CLI 内置工作流 `orchestrated`；选中时同时安装 workflow.md、引擎、配套卡、Claude Code hook，`trellis update` 在选中期间跟随版本更新，切回其他工作流时移除。
- **D4 并发预算**：选中时若 `channel.worker_guard.max_live_workers` 仍为未改过的默认 6，改为 16 并提示；用户改过的值不动。依据：引擎按峰值预留准入（每子任务 1 implement + 3 finder = 4，编排另留 1 个集成槽位），默认 6 时同一时间只能推进 1 个子任务。

## 需求

### 阶段 1

- **R1（C-1）后续轮次崩溃要有终止事件**：现状 `supervisor/stdout.ts:202` 置位的 `terminalEmitted` 从不复位，`supervisor/shutdown.ts:191` 在第 2 轮之后崩溃时跳过合成 `error`。修复后任何在途 turn 因进程退出结束都要发终止事件；空闲时正常退出不补事件；显式 shutdown 仍只发 `killed`。
- **R2（C-2）空闲清理按 worker 自己的 TTL**：现状 `spawn.ts:194-200` → `guard.ts:508` 用本次 spawn 的 TTL 判定全项目空闲 worker。修复后按每个 worker 记录的 `idleTimeoutMs`（`<worker>.config`）判定，无记录时回退调用方 TTL。
- **R2b（C-3，2026-10-23 由 F-2 纳入）自发轮次不结束用户轮次**：Claude 系 worker 后台任务结束触发的自发 provider 轮次（`system/task_notification` → `init` → `result`）不得为在途用户消息写出 `turn_finished`；自发轮次的终止事件保留在事件流并可区分，不唤醒 `wait` / `run`。临时缓解：编排 brief 要求 worker 结束本轮前等待所有后台命令完成。
- **R3 channel spec**：`commands-channel.md` 描述修复后行为，并新增"长生命周期编排器集成"一节。

### 阶段 2

- **R4 内置 `orchestrated` 工作流**：bundled、离线可用，出现在 `trellis workflow` 列表与 `trellis init --workflow` 中。
- **R5 引擎通用化**：无 spark 默认值（门禁默认空、英文提交模板、通用 hot_files）；trellis CLI 按 `TRELLIS_CLI` → PATH `trellis` → `tl` 解析；预算取 min(引擎设置, channel 预算) 且 `plan` 输出可并行数与调高建议；`.trellis` 入库与不入库两种模式都可用（入库模式要求编排卡已提交到基线，否则 `start` 报错给出提示）；引擎从不提交 `.trellis/**`；Python 3.9 运行时兼容、basedpyright 干净。
- **R6 不改写 bundled 卡**：新增 `review-finder` / `review-verify` / `simplify` 三张卡；implement 的编排协议放进 brief；bundled `check.md` / `implement.md` 不变。
- **R7 opt-in 安装与移除**：选中时安装引擎、三张卡、（Claude Code 已配置时）hook，并按 D4 调预算；未配置 Claude Code 时提示约束层仅 Claude Code 生效；切走时若有活跃编排则拒绝（`--force` 越过），否则移除未被用户改动的配套文件与 hook。
- **R8 update 一致性**：选中期间 update 用 orchestrated 模板对比 workflow.md、更新引擎与卡、保持 settings.json 字节一致；新增 worker_guard 保留步骤，防止调高的预算被还原。
- **R9 workflow-state 契约**：`orchestrating` 状态的 writer（`orch.py` start/finish/abort）登记到 `workflow-state-contract.md`；orchestrated workflow.md 提供 `[workflow-state:orchestrating]` 块。
- **R10 spec 与随包文档**：编排模式契约 spec；`commands-workflow.md` 更新；bundled trellis-channel / trellis-meta 参考文档同步。

## 验收标准

- [ ] AC1（R1）：两轮会话第 1 轮 done、第 2 轮 worker 进程崩溃 → 事件流出现 `by=<worker>` 的合成 `error`，`trellis channel wait --kind done` 返回；done 后空闲正常退出 → 无额外事件；`commands-channel.md:1109` 要求的 cold-exit fallback / markTerminalEmitted race 测试存在且通过。
- [ ] AC2（R2）：`--idle-timeout 3h` 的 worker 空闲 10 分钟，另一次 5m 策略的 spawn 不清理它；5m 或无 `.config` 的 worker 空闲 10 分钟仍被清理。
- [ ] AC2b（R2b）：fixture 流经真实 adapter + supervisor：消息 M 在途时自发轮次的 `result` 不产生 `turn_finished{inputSeq:M}`，M 自己的 `result` 恰好产生一条；用户轮次中途到达的 notification 不拆分、不结束该轮；9 个 brief 含后台命令规则。
- [ ] AC3（R3）：`commands-channel.md` 的 ShutdownController、OOM guard 节与新"编排器集成"节反映修复后行为。
- [ ] AC4（R4、R7）：`trellis init --workflow orchestrated`（Claude Code 平台）后，`.trellis/orchestrator/`、三张新卡、settings.json 中的 guard/inject hook 都存在，`max_live_workers` 为 16；`trellis workflow --template native` 后它们被移除、hook 被剥离；存在活跃编排时切走被拒绝，`--force` 可越过。
- [ ] AC5（R7、D2）：未选中 orchestrated 的新项目 init 结果（模板文件集合、settings.json、config.yaml）与改动前逐字节一致。
- [ ] AC6（R8）：选中状态下 `trellis update` 无伪变更（settings.json、workflow.md、config.yaml 不被报告修改，预算保持 16）；引擎文件随新版本自动更新。
- [ ] AC7（R5）：引擎 unittest 经 vitest 包装在 `pnpm test` 中全绿；basedpyright 与 Python 3.9 `py_compile` 通过；源码中无 spark 专属内容（Go/make 默认命令、本机路径、中文提交模板）。
- [ ] AC8（R5）：`.trellis` 入库的玩具仓库里，`init --workflow orchestrated` 并提交后，用真实 worker 跑通一个 2 子任务编排到 finish；冒烟记录存入父任务 `research/`。
- [ ] AC9（R6）：bundled `check.md` / `implement.md` 与改动前一致。
- [ ] AC10（R9、R10）：`workflow-state-contract.md` 登记 `orchestrating` writer 与可达性；编排模式契约 spec 存在；`commands-workflow.md` 与 bundled 技能参考文档描述 orchestrated。
- [ ] AC11：全量 `typecheck` / `lint` / `lint:py` / `test` 通过。

## 不在范围

- 阶段 3：Claude Code 以外平台的约束层（guard / inject）。其他平台可选 orchestrated，但只有提示词与 `NEXT:` 引导。
- spark-harness 迁移到 bundled 引擎（继续用本地 v2 副本）。
- docs-site（独立子模块仓库）页面。
- re-init 时忽略 `--workflow` 的现有行为（`init.ts:1197-1210`）。
- 沙箱型 provider（如 codex）写主检出绝对路径的兼容；首版文档注明推荐 claude / star 类 provider。
- 提交 upstream PR 本身（本任务只保证达到可提标准）。
