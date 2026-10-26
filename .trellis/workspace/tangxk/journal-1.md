# Journal - tangxk (Part 1)

> AI development session journal
> Started: 2026-10-21

---



## Session 1: Spec freshness lint and change traceability
<!-- trellis-session: v=2 fp=b499688902d6d0fc -->

**Date**: 2026-10-21
**Task**: Spec freshness lint and change traceability
**Package**: cli
**Branch**: `feat/spec-freshness`

### Summary

Added spec.py (lint / verify / init-meta) with seven advisory freshness rules, archive-time spec_changes tracing, shipped template seeds and index checklist sections, and frontmatter on this repo's own spec docs. Merged into main and archived from the follow-up session.

### Main Changes

- spec.py lint rules L1-L7 (missing metadata, dead source, broken link, stale, placeholder, missing index section, unlisted doc); --strict / --json / --provenance
- task.py archive writes spec_changes + spec_changes_source; task.py add-spec-change for manual entries
- Shipped spec templates gain sources frontmatter and Pre-Development Checklist / Quality Check index sections; finish-work, workflow 3.3 and update-spec skill mention spec verify/lint

### Git Commits

| Hash | Message |
|------|---------|
| `3762e02b` | feat(scripts): add spec.py freshness lint and archive-time spec change tracing |
| `406a8a70` | feat(templates): ship spec frontmatter seeds, index checklist sections, and lint guidance |
| `47b9d48a` | docs(spec): add frontmatter to project spec docs and document spec.py |

### Testing

- [OK] spec-lint and task-archive-spec-changes integration suites; spec.py lint --strict exits 0 on this repo (0 errors, 31 warnings)

### Status

[OK] **Completed**

### Next Steps

- Re-check stale docs (commands-channel, commands-ablate, commands-platforms, commands-update, script-conventions, workflow-state-contract) and stamp them with spec.py verify
- Sync marketplace/workflows/native/workflow.md with the bundled workflow (StarFactory markers + step 3.3 line) so the mirror test and pre-commit hook go green


## Session 2: StarFactory channel worker provider and cross-session wrap-up
<!-- trellis-session: v=2 fp=138ffb4a3a6becd0 -->

**Date**: 2026-10-21
**Task**: StarFactory channel worker provider and cross-session wrap-up
**Package**: cli
**Branch**: `main`

### Summary

Made StarFactory a trellis channel worker provider so Claude Code can plan while star runs implement/check workers; merged feat/spec-freshness and the star branch into main; finished the other session's task and fixed two gaps found while wrapping up.

### Main Changes

- channel: star adapter in the provider REGISTRY reusing the Claude stream-json adapter; provider validation via isProvider(); --provider help derived from listProviders(); provider/model hints on bundled implement/check cards
- task_store: .starFactory added to _SUBAGENT_CONFIG_DIRS so star-only projects seed implement.jsonl / check.jsonl
- spec_trace: post-merge fork-point derivation so archive after merge records the branch's spec changes; archived 10-21-spec-freshness record re-derived (34 docs)

### Git Commits

| Hash | Message |
|------|---------|
| `4fb879ab` | feat(channel): add StarFactory (star) as a channel worker provider |
| `7dd36a4b` | fix(scripts): seed jsonl manifests in StarFactory-only projects |
| `55247497` | fix(scripts): derive branch spec changes after the branch is merged |

### Testing

- [OK] Live star smoke runs: one-shot worker, 9.3 KB context via hidden --append-system-prompt-file, check card worker with done event
- [OK] Targeted vitest suites, typecheck, eslint, basedpyright; full suite red only on the known marketplace mirror test and git-ai-wrapper timeouts

### Status

[OK] **Completed**

### Next Steps

- Decide how to publish the marketplace mirror fix (no push access to mindfold-ai/marketplace)


## Session 3: spark-harness 编排引擎 v2：多编排并发与会话归属，替换上线
<!-- trellis-session: v=2 fp=eb68be96ad6d7d97 -->

**Date**: 2026-10-23
**Task**: spark-harness 编排引擎 v2：多编排并发与会话归属，替换上线
**Package**: cli
**Branch**: `main`

### Summary

在 /private/tmp/orch-v2 构建并验证 orch 引擎 v2（无全局单例、Conductor = 会话的 Trellis current task、项目级按预留计的 worker 预算、跨编排 owns 重叠检查、finish 前基线同步），移植线上热修后原子替换进 spark-harness，线上编排 10-21-harness-audit-leftovers 已在新引擎上 resume。工作在 spark-harness 的 git-excluded .trellis/ 与 /tmp 中，本仓库无代码提交。

### Main Changes

- 引擎 v2：per-parent 状态、session.py 会话解析、guard 只约束本编排的 Conductor 且不写状态、预留预算 + 门禁槽位池化、base_conflict / syncing_base、spawn_failed 决策（契约 design.md §15）
- 4 轮 star 评审（39 条）全部修复；替换前移植线上 3 处热修中的 2 处（retry 定位卡住的 inflight、异常结束保留 inflight，含集成侧）+ commit 模板回退默认中文
- 替换：pause → rsync 暂存 + 两次 rename → active.json 迁移为 orchestration.paused → resume；旧引擎备份 ~/.cache/orch-v2-wip/spark-backup-20261023-000752/

### Git Commits

(No commits - planning session)

### Testing

- [OK] 工作副本与 spark-harness 内各跑全量单测：436 通过
- [OK] 真实 star worker 冒烟 3 轮：并行编排、跨编排重叠、预留节流、基线冲突 resolve、finish 拒绝后重同步、集成门禁修复与用完即 kill
- [OK] 用 v2 对线上账本副本跑 tick（假 channel/git）兼容通过；真实会话 guard 模拟：397c3541 仅受本编排约束，24f87799 / 新会话不受限

### Status

[OK] **Completed**

### Next Steps

- 让 Conductor 会话 397c3541 后台重跑 advance（可先 /compact 重新注入新版 conductor.md）
- 可选：清理玩具 channel 目录（orch-v2、orch-v2-review）
- 可选：按分析把编排流程沉淀进 Trellis（阶段 1：spec + channel 运行时问题复核修复）


## Session 4: 沉淀 Conductor/Worker 编排流程到 Trellis（channel 修复 + orchestrated 工作流）
<!-- trellis-session: v=2 fp=5be7e4596caffc42 -->

**Date**: 2026-10-25
**Task**: 沉淀 Conductor/Worker 编排流程到 Trellis（channel 修复 + orchestrated 工作流）
**Package**: cli
**Branch**: `feat/orchestrated-workflow`

### Summary

把 spark-harness 的 orch v2 编排沉淀进 Trellis：阶段 1 修复 channel 运行时三处缺陷（后续轮次崩溃无终止事件、空闲清理用调用方 TTL、Claude 系自发轮次提前结束用户轮次），阶段 2 新增可选 bundled 工作流 orchestrated（通用化引擎、三张评审/精简卡、Claude Code guard/inject hook、install/remove/update 接线、契约 spec）。全部实现与评审由 star channel worker 完成，Claude 只做规划、裁决与验证。4 个 commit 在 feat/orchestrated-workflow，未合入 main、未 push。

### Main Changes

- C-1 per-turn terminalEmitted + 冷退出合成 error/turn_finished；C-2 空闲清理按 worker 自身 .config 的 idleTimeoutMs；C-3 --replay-user-messages 区分轮次来源，自发轮次终止带 selfInitiated 且不写 turn_finished、不唤醒 wait/run
- 引擎通用化：门禁只来自 plan.json、英文提交模板、CLI 按 TRELLIS_CLI/TRELLIS_BIN/trellis/tl 解析、预算 = min(设置, channel 预算)、.trellis 入库/不入库两种模式、运行时状态在 .trellis/.runtime/orchestrator/、Python 3.9 兼容
- orchestrated 工作流：选中信号为 orch.py 的模板 hash；用户改过的文件保留并列出；活跃编排时拒绝切走（--force 越过）；update 保持 settings.json 字节一致；默认预算 6 → 16
- spec：orchestration-contract.md（新）、workflow-state-contract.md 登记 orchestrating writer、commands-workflow/update、bundled trellis-channel/trellis-meta 参考

### Git Commits

| Hash | Message |
|------|---------|
| `d23e35da` | fix(channel): attribute terminals to the turn that produced them |
| `47d02022` | feat(orchestrator): ship a generic Conductor/Worker orchestration engine |
| `ebdaa365` | feat(workflow): add the opt-in `orchestrated` bundled workflow |
| `28abf08e` | docs(spec): document the orchestration contract and the orchestrated workflow |

### Testing

- [OK] [OK] typecheck / lint 干净；core 405 通过；cli 2064/2067（session_auto_commit 在 main 同样超时；issue-399.1 单跑通过）；引擎 unittest 481 通过
- [OK] [OK] AC8 冒烟：.trellis 入库玩具仓库 + 真实 star worker，2 子任务全流水线到 finish，记录在 research/smoke-tracked-mode.md
- [OK] [WARN] lint:py 有 4 个早已存在的 spec_lint.py 错误（F-3，用户决定不在本任务修）

### Status

[OK] **Completed**

### Next Steps

- 决定 feat/orchestrated-workflow 是否合入 main / push
- 跟进 F-1（interrupt 后迟到终止事件的归属）与 F-3（spec_lint.py basedpyright 错误）
- 可选：删除 /tmp/orch-smoke 玩具仓库
