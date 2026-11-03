# Arbor v5 方案：去 TDD 强制、单轮 REVIEW、单执行器、收尾一次

## Context

v4（0.7.0，分支 `arbor-v4`）的主线是 CONTRACT → BUILD(test 红 → implement 绿) → GATE → REVIEW → POLISH → FINISH。评估结论（本会话已与用户确认）：

- **TDD 强制是多余的**：所有 tier 都先派 `test` 角色写测试、驱动器跑红检、再派 `implement` 且禁改 test paths。用户判断模型会按规范自驱写测试，不需要流程硬卡。
- **审查阶梯对同一 diff 重复读**：standard 任务 REVIEW 2 人 + POLISH candidates 2 人 + verify，full 再 sweep；REVIEW self-check 与 POLISH candidates 角度集合几乎相同。
- **双执行器并存**：`codeg-cli` 命令执行器与 `codeg` MCP 执行器各走一套，外加 `canary`。
- **收尾命令堆叠**：`arbor.py finish` 跑两次、`task.py finish`、`task.py archive`、`add_session.py`、`/arbor:finish-work` 互相重复。
- **文档重复注入**：同一流程说明在 CLAUDE.md 管理块、workflow.md Driver 节、needs 表、2.1、面包屑、SessionStart 上下文出现五六次；polyrepo 章节占 workflow.md 十分之一但本仓库未启用。

用户已定的四个方向：去掉 TDD 强制与 test 角色；合并 REVIEW/POLISH 为单轮 REVIEW；只保留 MCP 执行器；polyrepo 代码保留、文档外移。

## v5 目标状态

### 状态机

| State | 进入 | 做什么 | 离开 |
|---|---|---|---|
| CONTRACT | task 创建 | explore / architect 并行研究 → 问题清单 → contract.md (+ design.md / waves.md) → seed-context → 结构校验 → full: review `Mode: plan` → 用户批准 | `task.py start` → BUILD |
| BUILD | 有 wave 待做 | `implement` 一次交付代码 + 测试，自己把 Verification map 的 auto 检查跑绿后提交；多 partition 时每个 partition 一个 implement 并行 | GATE |
| GATE | 任务分支有新提交 | `gate.commands` + 全部 auto 行。红 → `decide impl`（派 fix）或 `decide contract`（改合同、重批准） | 绿 → 下一 wave 或 REVIEW；连续 4 红 → STOP |
| REVIEW | GATE 绿、wave 全完 | standard/full：`simplify` → GATE → N 个 review `Mode: candidates`（standard 2、full 3，并行）→ 机械预筛 → `verify`（每批 ≤ 8，并行）→ CONFIRMED 派 `fix`，PLAUSIBLE 按 mandate → GATE → 只复审 `last_reviewed..HEAD`；full 在最后一轮干净后加一次 `sweep`。light：1 个 review `Mode: self-check` → fix → 复审 delta，无 simplify / verify | PASS → FINISH；fix 轮 > 2 或无进展 → STOP |
| FINISH | REVIEW 通过 | `arbor.py finish` 一次：scorecard + spec 提醒 + 开 PR 或打印 `--no-ff` 合并命令（auto 合并 / 子任务并入集成分支的情况直接接清理）；用户合并后 `/arbor:finish-work` 调 `arbor.py finish` 做清理（worktree、archive、journal） | DONE |
| STOP | BUDGET / NO_PROGRESS / abandon | 总是问用户：resume / override / abandon | — |

删除的状态与步骤：`BUILD/test`、`GATE/test`、红检、lanes（`tests` / `impl` 双 lane）、整个 POLISH 状态（其 simplify / candidates / verify / sweep / fix 步骤迁入 REVIEW）。

### Tier

| | light | standard | full |
|---|---|---|---|
| 合同产物 | contract.md | + design.md | + waves.md + review `Mode: plan` |
| BUILD | 一个 implement | partitions 按合同 | partitions + waves |
| REVIEW | 1 reviewer self-check → fix | simplify → 2 candidates → verify → fix | simplify → 3 candidates → verify → fix → sweep |
| 人类门 | tier、merge | + contract | + contract、plausible |

standard 不再强制 plan review（结构校验 + 用户审批即可）。

### 合同

- `## Interface pins` 变可选（供 design / 多 partition 对齐用），删掉 `existing interfaces` 特例。
- 删掉 `## Test paths` 节与 `test_paths:` 配置；写边界只剩 `.arbor/` 外任意文件。
- Verification map 的 auto 行只要求命令非空；文件不存在改为警告（新测试文件由 implement 创建）。
- `decide` 红门选项：`impl | contract`。

### Mandate

只剩 `contract / plausible / merge` 三个门；`stop` 删除，STOP 总是问（自动 resume 等价于上限 +1，改为直接把 review 轮上限统一为 2）。

### 执行器

只保留 `type: codeg-mcp`。删 `codeg-cli`、`--executor`、`canary`、同步 `dispatch_once`、无任务 stdin explore。`bind` / `collect` 保留为 hook 专用子命令，从文档主路径移出。

## 改动清单

源头是模板 `packages/cli/src/templates/arbor/`，`.arbor/` 必须逐字镜像（`packages/cli/test/regression.test.ts` 的 byte-identical 用例强制 scripts 一致；agents / hooks / workflow.md 手动镜像）。下面路径写模板路径，镜像同步到 `.arbor/`、`.claude/hooks/`、`.claude/commands/arbor/`。

### Wave 1：驱动器状态机（scripts/common/driver、arbor.py）

- `common/driver/state.py`
  - `STATES` 去 POLISH；`DEFAULT_STEP["BUILD"]="implement"`；`DISPATCH_STEPS` 删 `(BUILD,test)`、`(GATE,test)`，把 `(POLISH,*)` 改成 `(REVIEW,simplify|candidates|verify|fix|sweep)`，REVIEW 的 light 路径保留 `(REVIEW,review)` self-check。
  - 删 `on_red_check`、`on_partition_red_check`、`LANES`、`LANE_FIRST_STEP`、`is_lane`、`PARTITION_BRIEF_STEPS` 中的 test；`DECIDE_CHOICES = ("impl","contract")`。
  - `on_writer_done`：BUILD implement → GATE → `after_gate = REVIEW/entry`；REVIEW entry 按 tier：light → `review`，否则 → `simplify`。原 `_start_polish_round` / `on_candidates_filtered` / `on_verify` / `on_sweep_filtered` / `_polish_done` 改名为 REVIEW 内函数，计数器 `counters.polish` 并入 `counters.review`，`POLISH_ROUND_CAP` → `REVIEW_ROUND_CAP = 2`（三 tier 统一）。
  - `on_review`（self-check，light）：PASS → FINISH；FAIL → fix。
  - `resume()` 默认落点 `BUILD/implement`。
  - `ensure_fields`：遇到 v4 的 `state=POLISH` 或 `step=test` 直接 `StateError("v4 task in flight; finish it on arbor-v4 or abandon")`，不做自动迁移（当前无活跃任务）。
- `common/driver/gate.py`：删 `RedResult`、`run_red_check`；保留 `auto_checks` 与 gate 运行。
- `common/driver/partitions.py`：`first_step` 恒为 `implement`。
- `common/driver/mandate.py`：`GATES` 去 `stop`；`apply()` 删自动 resume 分支；`DEFAULTS` 按上表。
- `arbor.py`
  - 删 `uses_lanes`、`waves_of` 的 lanes 分支、`LANE_SCOPE`、`_red_paths`、`_red_notes`、`_advance` 的 BUILD/test 分支、`_advance_partition` 的 test 分支、`cmd_run` / `cmd_collect` / `decide_report` 的红检、`start_wave` 的 lanes 设置、`_scope_escape` 的 lane 豁免。
  - `_advance` 的 candidates / sweep / verify 分支改读 REVIEW 状态；`_prefilter_report` 路径不变。
  - `validate_dispatch` / `dispatch_once` / `finish_contract` / `_resume` / `cmd_finish` 不再传 `test_paths`。
- `common/invariants.py`：`WRITER_ROLES` 去 `test`；`check_after_dispatch` 删 330-336 的 test paths 两条规则。
- `common/driver/validate.py`：删 `_STATUS_LINE_RE["test"]`、`listed_regression_tests` / `adjust_violations` 中的 fix 测试豁免（fix 可改测试，由 review Acceptance 角度把关"不得削弱断言"）。
- `common/contract.py`：`test_paths`、`EXISTING_INTERFACES_PIN`、`effective_test_paths` 删除；`validate_contract` 去 pins 非空规则与 auto 行文件必须在 test paths 内的规则，文件不存在降为 warning。
- `common/arbor_config.py`：删 `DEFAULT_TEST_PATHS`、`get_test_paths`；`DEFAULT_EXECUTORS_CONFIG` 只剩 codeg-mcp。
- `common/driver/integration.py` `scope_globs`：去 test_paths。
- `common/dispatch_context.py`：角色表去 `test`；`REVIEW_MODES` 保留 self-check / candidates / sweep / plan。

### Wave 2：执行器与收尾

- `common/driver/executor.py`：删 `build_command`、`run_executor`、command 分支；`resolve_executor` 只接受 `codeg-mcp`。
- `arbor.py`：删 `cmd_canary`、`finish_canary`、`CANARY_*`、`dispatch_once`、`--executor`、`cmd_run_contract` 的 command 分支与无任务 stdin 路径；`prepare_mcp` / `cmd_collect` 去 canary kind。
- `common/driver/finish.py`：`finish_before_merge` 一次运行同时写 scorecard 并执行合并判定（auto / integration 合并直接进 `start_cleanup`，否则打印 PR / 合并命令）；`cleanup` 的 `pointer` 步骤改为直接清 session 指针（不再调 `task.py finish`）。
- `task.py`：删 `cmd_finish` 与 parser（`after_finish` hook 并入 archive 前触发）；`task_store.cmd_archive` 已有 `_clear_worktree_pointers`，确认它覆盖 session 指针。
- `.claude/hooks/sync-delegation.py`：`TOOL_RE` 不变；去 canary 注释，`COLLECT_TIMEOUT_S` 按不再跑红检下调。
- `templates/common/commands/finish-work.md`：Step 3/4 的 `task.py archive` + `add_session.py` 改为"有任务：`arbor.py finish`（它做 archive + journal）；无任务：仅 `add_session.py`"。

### Wave 3：角色卡、配置、文档、hooks

- `templates/arbor/agents/`：删 `test.md`；`implement.md` 改为"交付代码与测试，先写测试再实现是建议不是门禁，提交前 auto 检查必须全绿"，删 test paths 边界；`fix.md` / `simplify.md` 删 test paths 边界，fix 加"可改测试但不得为通过而削弱断言"；`review.md` 删 Cleanup-lite 以外的 v4 特有说明，modes 表注明 self-check 仅 light。
- `templates/arbor/config.yaml`：删 `test_paths`、`executors.codeg-cli`、`mandate.*.stop`；`executors` 只留 `codeg`。实例 `.arbor/config.yaml` 保留本地 `packages` 块，其余同步。
- `templates/arbor/workflow.md` 重写为单一来源（目标 ≤ 350 行）：Principles → System（紧凑）→ Driver（命令表、`next --json` 字段、needs 表、MCP 流程一段、brief、header、self-exemption）→ State Machine（唯一一张表）→ Tiers → Human Gates → Triage → Task Artifacts → Parent/Child → 面包屑块 → Phase 1/2/3 只保留步骤清单与必要细节，不再复述 Driver 节。
- polyrepo：`workflow.md:77-135` 与 164-173 移到 `templates/arbor/spec/guides/polyrepo.md`（guides index 加一行），workflow.md 留一句指引。
- `templates/markdown/claude.md` 与 `agents.md` 管理块压到 ≤ 12 行：tier 分类、`arbor.py next` 循环、角色只走 `arbor.py run` + MCP、人类门、指向 workflow.md。
- `shared-hooks/session-start.py`：`_build_workflow_overview` 抽取范围随新 workflow.md 调整（仍是 `## Phase Index` 到 `## Phase 1`）；`common/workflow_phase.py` 同步。
- `shared-hooks/inject-workflow-state.py`：面包屑 key 不变，块体随 workflow.md 更新。

### Wave 4：模板索引、测试、版本

- `templates/arbor/index.ts`：去掉 `test.md` 导出；若删模块则同步常量。
- vitest 更新（`packages/cli/test/`）：`v2-driver-build`、`v2-driver-modules`、`v2-driver-waves`、`v2-invariants`（红检 / lanes 用例删除或改为 implement 直达 GATE）；`v2-parallel`、`v4-ready-merge`（lanes）；`v2-driver-review`、`v2-mandate`（POLISH → REVIEW、stop 门删除）；`v2-driver-mcp`、`sync-delegation`（canary、command 执行器）；`v2-driver-finish`、`task-archive*`（finish 一次、`task.py finish` 删除）；`templates/*.test.ts`；`regression.test.ts` byte-identical 用例保持。
- 镜像：`.arbor/scripts`、`.arbor/agents`、`.arbor/workflow.md`、`.claude/hooks`、`.claude/commands/arbor/finish-work.md`、`CLAUDE.md` / `AGENTS.md` 管理块。
- `packages/cli/package.json` 版本 0.8.0，CHANGELOG 记 v5。

## 复用

- `state.py` 的 batch 机制（`batch_of` / `on_batch_*`）、`validate.py` 的 `prefilter` / `dedup`、`arbor.py` 的 `ready_set` / `next_payload` 原样复用，只改状态名。
- `finish.py` 的 `merge_checks` / `merge_no_ff` / `merge_into_integration` / `cleanup` 的 mark 机制复用。
- `task_store.cmd_archive` 的 `_clear_worktree_pointers` 承接 `task.py finish` 的职责。

## 验证

1. `pnpm -C packages/cli test`：全部 vitest 通过，含 regression byte-identical 用例。
2. `pnpm lint:py`（basedpyright）无新增错误。
3. `grep -rn "red_check\|LANES\|POLISH\|codeg-cli\|canary\|test_paths" packages/cli/src/templates/arbor .arbor .claude` 为空（polyrepo 文档除外）。
4. 端到端冒烟：在临时仓库 `arbor init` 后跑一个 light 任务：create → contract → start → `next` 直接给 `BUILD implement` → 模拟 collect → gate → REVIEW self-check → finish 一次打印合并命令 → 合并 → `/arbor:finish-work` 完成 archive + journal。再跑一个 standard 任务确认 simplify → 2 candidates → verify → fix → delta 复审链路。
5. `python3 .arbor/scripts/get_context.py --mode phase --step 2.3` 与 SessionStart 输出引用的是新 workflow.md。

## 执行方式建议

改动跨驱动器、hooks、模板、测试约 20 个文件，建议用 v4 自身跑一个 `full` 任务、按上面四个 wave 作为 contract 的 `## Waves`（partition 按目录切：driver / finish+executor / docs+agents / tests+templates 有重叠，故串行 wave 而非并行 partition），或直接在本会话按 wave 顺序实施并每个 wave 跑一次 vitest。
