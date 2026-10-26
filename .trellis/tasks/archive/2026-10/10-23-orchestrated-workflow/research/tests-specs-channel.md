# 调研：Python 测试接入、channel 缺陷修复点、相关 spec、CLI 定位

路径相对仓库根。

## 1. Python 测试与 CI

- 仓库没有 pytest/unittest 体系：Python 全部经 **vitest** 测试——把模板拷进临时 `.trellis/`，`spawnSync("python3", …)` 运行（`packages/cli/test/scripts/task-meta.integration.test.ts:17-54`；`test/regression.test.ts:1770-1813` 内联 `python -c`）。缺 Python 时 `hasPython()` + `describe.skipIf` 跳过（`test/scripts/symlinked-workflow-dir.integration.test.ts:35,80`）；`test/setup.ts:4-22` 清理宿主环境变量；`vitest.config.ts:5-6` 只收 `test/**/*.test.ts`，单测默认 10s 超时。
- CI `.github/workflows/ci.yml`：Python 3.9（41-44）；对所有已跟踪 `.py` 跑 `py_compile`（46-49，测试文件也须 3.9 可解析）；`basedpyright`（62-63），`pyrightconfig.json` 覆盖 `.trellis/scripts`、`.claude/hooks`、`packages/cli/src/templates/**/*.py`（pythonVersion 3.9，standard）；构建后 `pnpm test`（70-74）。
- husky pre-commit 只跑 TS 的 lint-staged（`.husky/pre-commit:1`），spec 明确不要往里加测试（`.trellis/spec/cli/unit-test/index.md:56-58`）。
- 约束：`packages/cli/src/templates/trellis/scripts/` 下的 `.py` 必须与 `.trellis/scripts/` 副本逐字节一致（`regression.test.ts:11785-11830`；`script-conventions.md:55-108`）——引擎放 `templates/trellis/orchestrator/` 不受此约束；`scripts/copy-templates.js:28-29` 只排除 `__pycache__`/`.pyc`/`.ts`，引擎会自动进 npm 包；脚本只有列入 `getAllScripts()` 才会装到用户项目（`templates/trellis/index.ts:95-134`）。
- 建议：引擎测试放 `packages/cli/test/python/orchestrator/test_*.py`（不进模板、不进 npm 包），加一个 vitest 包装（如 `test/scripts/orchestrator-unittest.test.ts`）跑 `python3 -m unittest discover`，缺 Python 跳过、超时调大；如需类型检查把该目录加入 `pyrightconfig.json`。
- spark 引擎现状：11 个文件均 `from __future__ import annotations`，`ast.parse(feature_version=(3,9))` 全部通过；运行时 3.9 兼容与 basedpyright 结果未验证。

## 2. channel 缺陷

**C-1（确认）**：`terminalEmitted` 在 `supervisor/shutdown.ts:95` 初始化为 false，只会被置 true（192, 222），接口无复位（36-66）；`supervisor/stdout.ts:201-203` 每次 adapter done/error 置位，`turnTracker.finish()`（210）不碰它；turn 开始于 `supervisor/inbox.ts:123-132`，无复位；TurnTracker 只驱动空闲计时（`supervisor.ts:272-275`）。→ 第 1 轮之后 `shutdown.ts:191` 跳过合成，第 2 轮起崩溃无终止事件。副作用：`warning.ts:69-75` 的一次性超时前 `supervisor_warning` 在第 1 轮后永不触发。`idle.ts:70-73` 有意忽略该标志（测试 `channel-supervisor-idle.test.ts:134`）。
修复要点：空闲状态下 done 之后正常退出不能再补一个事件——按"是否有在途 turn"（`turnTracker.current()`）判定合成，或在 turn `begin()` 时复位。
现有测试只用 stub：`test/commands/channel.test.ts:362`（turn_finished，stub 367）、:641-790（`finalizeSupervisorExit`，stub `finalizeOnExit` 674/772）；`channel-supervisor-idle.test.ts:10-19,134`；`channel-wait-warning.test.ts:235-460`（367 `hasTerminalEvent` true）；core reducer `packages/core/test/channel/worker-state.test.ts:101,303`。spec 要求的 "Cold-exit fallback synthesis"、"markTerminalEmitted race" 测试（`commands-channel.md:1109` Tests Required）**不存在**。

**C-2（确认）**：`guard.ts:597-601` 把 `input.policy.idleTimeoutMs`（新 spawn 的值，来自 `spawn.ts:180-197`）传给 `cleanupExpiredIdleWorkers`，对每个 worker 判定（518, 480-493）。**每个 worker 自己的 TTL 已落盘**：`<channelDir>/<worker>.config`（JSON，含 `idleTimeoutMs`），由 `spawn.ts:259-283`（字段 271）经 `writeSupervisorConfig`（`supervisor.ts:603-614`）写入，路径 `workerFile`（`store/paths.ts:117-125`）；supervisor 读取（`supervisor.ts:183,598-600`）驱动自身空闲计时（463-468）；退出时删除（`supervisor.ts:561`、`kill.ts:163`）；写入早于预留（`spawn.ts:292`）；不在 `spawned` 事件（`supervisor.ts:437-451`）与 core WorkerState 中。→ `scanLiveWorkers`（`guard.ts:294-381`）可读每个 worker 的 `.config`，缺失时回退调用方策略。
guard 测试：`packages/cli/test/commands/channel-guard.test.ts`——103（优先级）、168（解析）、228-273（eligibility）、279-568（scan/enforce），无 per-worker TTL 覆盖。

## 3. spec

`.trellis/spec/cli/backend/`：`commands-channel.md` 是 channel 运行时主 spec——ShutdownController（336-343）、事件载荷（353+）、Worker OOM guard（563-695）、存储布局（876）、supervisor 错误矩阵（961-973）、Tests Required（1109）、Pattern 1（1153）；`trellis-core-sdk.md`（core/CLI 边界含 channel API）；`filesystem-safety.md:79-91`（`assertSafeName`/`channelDir`）；`index.md:37,64` 指向 `commands-channel.md`。无独立 guard/supervisor spec。

workflow-state writer 表（`workflow-state-contract.md:257-275`，列 `# | Writer | File:Line | Value | Trigger`，7 行）。新增 `orchestrating` writer 需要：加行（375, 388, 406 要求）、删除 "No other writer exists" 断言（273）、workflow.md 提供 `[workflow-state:orchestrating]` 块（否则走通用 breadcrumb，324-334）、更新可达性矩阵（298-309）、核对全部消费方（391-393）。**没有"只有 task.py 能写 status"的规则**，已有 TS writer，规则是每个 writer 必须登记。

## 4. Python 定位 trellis CLI

唯一调用：`common/session_context.py:331-347` `subprocess.run(["trellis","--version"], timeout=1.0)`（裸 PATH，失败返回 None；测试 stub 在 `regression.test.ts:2388`）。`cli_adapter.py` 不调 trellis。`src` 中无 CLI 路径环境变量/持久化；bundled 技能文档用裸 `trellis channel …`。TS supervisor 用 `process.execPath` + `dist/cli/index.js`（`spawn.ts:285,301-310,378-384`），Python 无法复用。
建议引擎默认：环境变量覆盖（如 `TRELLIS_CLI`）→ `shutil.which("trellis")`（Windows 下能找到 `.cmd`）→ 回退 `tl`（两者都在 `packages/cli/package.json` 的 `bin`）。
