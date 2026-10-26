# 执行计划

父任务只负责拆分、跨子任务验收和最终集成评审；实现都在子任务里。子任务在 `task.py start` 之后用 `task.py create "<title>" --slug <slug> --parent .trellis/tasks/10-23-orchestrated-workflow` 创建，各自写精简 `prd.md`（目标 / 范围 / 验收 / 验证命令），依赖写在子任务 prd 里。

## 验证命令（全部子任务通用）

```bash
pnpm --filter @mindfoldhq/trellis typecheck
pnpm --filter @mindfoldhq/trellis lint
pnpm --filter @mindfoldhq/trellis lint:py          # basedpyright（Python 3.9 / standard）
pnpm --filter @mindfoldhq/trellis test             # vitest；单文件：pnpm --filter @mindfoldhq/trellis exec vitest run <path>
python3 -m py_compile <新增或改动的 .py>          # CI 用 3.9 跑，注意 3.9 运行时兼容
```

注意：本机 git-ai 包装会拖慢含 git 的测试，出现超时先用原生 git 重跑再判断是否代码问题。

## 阶段 1（三个子任务；前两个可并行）

### 1. `channel-terminal-per-turn`（C-1）
- [ ] `supervisor/shutdown.ts`：合成判定改为"在途 turn 未发终止事件"；turn `begin()` 复位（入口 `supervisor/inbox.ts:123-132`），`stdout.ts:201-203` 置位逻辑不变
- [ ] 确认 `warning.ts:69-75` 在后续轮次恢复触发；`idle.ts:70-73` 行为不变
- [ ] 测试：第 2 轮崩溃合成 `error`；done 后空闲正常退出无额外事件；显式 shutdown 只发 `killed`；补 `commands-channel.md:1109` 要求的 cold-exit fallback / markTerminalEmitted race
- 回滚点：单 commit，可独立 revert

### 2. `channel-idle-ttl-per-worker`（C-2）
- [ ] `guard.ts` `scanLiveWorkers` 读 `<worker>.config` 的 `idleTimeoutMs`；`cleanupExpiredIdleWorkers` 按候选自身 TTL 判定，缺失回退调用方 TTL
- [ ] 测试（`channel-guard.test.ts`）：长 TTL worker 不被短 TTL spawn 清理；短 TTL / 无 `.config` worker 照常清理；`idle_timeout: 0` 语义不变
- 回滚点：单 commit

### 2b. `channel-turn-attribution`（C-3，F-2 纳入范围）
- [ ] 实验记录 stream-json 轮次边界（`research/stream-turns.md` 在子任务目录）
- [ ] `adapters/claude.ts` 加 `--replay-user-messages`，按回显的 `systemUserKind` 判定轮次来源；自发轮次终止事件带 `selfInitiated: true`
- [ ] `supervisor/stdout.ts` 自发终止不写 `turn_finished`、不置终止标志；core `worker-state` / `filter` 忽略自发终止；`wait` / `run` 不被唤醒
- [ ] 9 个编排 brief 加"结束本轮前等待后台命令"规则
- 回滚点：单 commit

### 3. `channel-orchestrator-spec`（依赖 1、2）
- [ ] `commands-channel.md`：更新 ShutdownController（336-343）、OOM guard（563-695）为修复后行为；新增"长生命周期编排器集成"一节（`send` 返回 seq → 等 `turn_finished.inputSeq`、`spawn --resume`、per-worker idle TTL、项目级 `max_live_workers`、`trusted_context_dirs`、stdout 末行 JSON、project key 固定）

## 阶段 2（阶段 1 合入后开始）

### 4. `orch-engine-port`
- [ ] 拷入 `packages/cli/src/templates/trellis/orchestrator/`（11 个 .py + `briefs/` + `conductor.md` 占位，正文由 5 提供）
- [ ] 通用化：默认门禁空、trellis CLI 解析、英文 commit 模板、通用 hot_files、预算取 min(settings, channel)、注释英文、入库/不入库两种 `.trellis` 模式 + 卡已提交前置检查 + scope 忽略 `.trellis/**`、派发新卡名（design §3、§4）
- [ ] 测试移到 `packages/cli/test/python/orchestrator/` + vitest 包装；夹具去 spark 化；`pyrightconfig.json` 视情况加入测试目录
- [ ] 先跑一次 basedpyright 摸底；告警量过大则在本子任务内再拆
- 验收：unittest 全绿（数量 ≥ 移植前，扣除删除的 spark 专属用例需说明）、basedpyright 干净、3.9 `py_compile` 通过

### 5. `orch-workflow-assets`（可与 4 并行）
- [ ] `templates/trellis/workflow-orchestrated.md`：以 bundled native 为底，保留全部 `[workflow-state:*]` 块与步骤编号；Phase 2 改编排模式；新增 `[workflow-state:orchestrating]`
- [ ] `conductor.md` 通用化（去 spark 示例）
- [ ] 新卡 `review-finder.md` / `review-verify.md` / `simplify.md`（`provider: claude` + star 覆盖提示）；implement "Orchestration Mode" 协议并入 `briefs/implement.md` / `fix.md` / `resolve.md`
- [ ] 模板测试（`test/templates/trellis.test.ts` 类）：orchestrated workflow.md 含全部必需块；卡 frontmatter 合法

### 6. `orch-install`（依赖 4、5）
- [ ] resolver：bundled `orchestrated` 虚拟条目；`applyHashContract` 对 bundled 两者保留 hash
- [ ] 选中：写 workflow.md、装引擎与三张卡并记 hash；Claude 已配置 → settings.json 注入 hook；预算 6 → 16 并提示；未配置 Claude → 提示约束层仅 Claude Code
- [ ] 切走：存在活跃编排时拒绝（`--force` 越过）；删除未改动的引擎与卡及其 hash；剥离 settings.json 中指向 `.trellis/orchestrator/` 的 hook
- [ ] update：选中信号 = `.trellis/orchestrator/orch.py` 有 hash；workflow.md 用 orchestrated 模板；纳入引擎与卡；settings 模板注入 hook 保持字节一致；新增 `preserveExistingWorkerGuardConfig`
- [ ] 测试：init `--workflow orchestrated`、workflow 切换往返、切走拒绝/`--force`、update 选中与未选中两种、settings 字节一致、预算调高与保留、未选中项目零变化（`workflow.integration.test.ts`、`update.integration.test.ts`、`init.integration.test.ts`、`platforms.test.ts` 参照 statusLine 用例）
- [ ] 冒烟：`.trellis` 入库的玩具仓库，`trellis init --workflow orchestrated` → 提交 → 用真实 worker 跑一个 2 子任务编排到 finish

### 7. `orch-spec-docs`（依赖 6）
- [ ] 新 spec：编排模式契约（来源 spark design.md §15，按通用化后行为改写）
- [ ] `workflow-state-contract.md`：writer 表、可达性矩阵、删除 "No other writer exists"
- [ ] `commands-workflow.md`：bundled 第二工作流与配套资产
- [ ] 同步 bundled 技能参考（trellis-channel `references/workflows.md`、trellis-meta 架构文档）

## 父任务最终检查（全部子任务合入后）

- [ ] 全量 `typecheck` / `lint` / `lint:py` / `test` 通过
- [ ] 未选中 orchestrated 的新项目 init 结果与改动前一致（模板集合、settings.json、config.yaml）
- [ ] 入库模式冒烟记录存入父任务 `research/`

## start 前检查

- [ ] `implement.jsonl` / `check.jsonl` 已填入真实 spec 与调研条目
- [ ] 用户批准最终规划摘要
