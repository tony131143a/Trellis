# Arbor 0.9.1 驱动器问题记录（polyrepo 产品任务实测）

- **来源任务**：ta 元仓库 `11-05-ap-sandbox-start-stale-attach`（standard，产品仓库 agent-platform，两个分区 backend / agent），2026-11-05
- **环境**：Arbor 0.9.1（ta 安装）· executor `codeg`（子 agent 为 codex）· `execution_mode: package` · macOS 15.7.3 · Python 3.14.4 · Node 25.9.0
- **源码行号**：均指本仓库 `packages/cli/src/templates/arbor/`

按影响从大到小排列。

## 处理结果（2026-11-05，arbor 0.9.1 分支）

| # | 状态 | 处理 |
| --- | --- | --- |
| 1 | 已修复 | implement 报 Blocked 或没有新提交时，status 记为 `judgment`，进入 `report_pending`，由主 agent `decide accept\|retry`，分区和 default 路径都适用。这类 implement 的 retry 计一轮 `no_progress`，两次后 STOP(NO_PROGRESS)；报告无法解读的 retry 不计。Partial 且有提交时保持原设计（light 升级，进 GATE）。 |
| 2 | 已修复 | 缩进的子弹是上一条的续行；标签接受全角 `：`；`task.py start` 遇到无法解析的合同会拒绝；已 start 的任务合同无法解析时，`next` 直接报错，不再退化成 default。start 只要求能解析，结构校验仍在合同阶段完成。 |
| 3 | 已修复 | 产品模式下，`next` 的 items 只给出一个可派发项，summary 注明串行，不再提示并发。reader 仍然串行。 |
| 4 | 已修复 | 空 text 时，报错给出 `get_session_info(<child_conversation_id>)` 和 `collect --text <reply file>` 的用法；`collect --text` 用手工取回的回复代替缺失的 text，request 记录 `text_recovered`；workflow.md 写明缓存会过期。 |
| 5 | 已修复（告警） | GATE 告警两种情况：map `file` 在 `base..HEAD` 中没有改动；检查命令、文件路径、文件内容都没有出现 AC id（如 `ac8`）。告警写进 gate 报告，不判红。 |
| 6 | 已修复 | delta 周期中，review 和 verify 的 prompt 注入 `Task base:`；verify.md 和 review.md 改为只把任务基线之前就存在的问题视为 pre-existing。 |
| 7 | 已修复 | 已 start 的任务改了合同后，`arbor resume` 校验后原地重新批准（记录 hash，写一条 `kind: contract` decision），状态不变。没有新增 `approve` 命令。 |

---

## 1. 分区 implement 报 Blocked 且零提交，驱动器仍把分区记为 done

**现象**：backend 分区的 d-004 报 `## Implementation Blocked`（原因是合同接口有歧义），没有任何提交。`collect` 记为 `status: ok`、`verdict: Blocked`，分区 `step` 变为 `done`。observations 里有 `implement produced no new commit`，但不影响状态。另一个分区完成后，`run` 照常合并了这个空分区，随后 GATE 因 backend 测试全部缺失而变红。

**根因**：
- `scripts/arbor.py:975-980` 的状态只由 `result.ok`、`check.ok` 和 `confidence` 决定，`Blocked` / `Partial` 这个 verdict 和"没有新提交"的 violation 都不参与判断。
- `scripts/arbor.py:1146-1147`：只要 `status == ok` 且有分区名，就调用 `on_partition_implemented`。
- `scripts/common/driver/state.py:819-822` 无条件把分区设为 `PARTITION_DONE`。
- `agents/implement.md` 写的是"A dispatch that ends without a new commit counts as failed"，与上述实现不一致。

**绕行方式**（代价是一轮 GATE 外加两次 override）：
1. GATE 变红后 `decide impl`，但驱动器给出的是 `fix` 角色。fix 要求 brief 里带 findings JSON，而且不允许超出 diff 修改，不适合补一整块实现。
2. 改用 `override --role implement` 在任务分支上补派，完成后再 `override --to GATE/gate`。

**建议**：implement 的 verdict 为 `Blocked` / `Partial`，或者没有新提交时：
- 分区保持在 `implement` 步骤（`needs=brief`），并计入 `no_progress`；
- 或者返回 `needs=decide`，由主 agent 选择重派还是回到合同。

非分区（default）路径也要核对是否有同样的问题。

---

## 2. 合同解析的格式要求过严，而且 start 前不校验，分区会被静默忽略

**现象**：
- AC 写成 `- AC-1（P 延长）：Given …`（全角冒号）时，`run` 报 `Acceptance criteria: expected '- <name>: …'`。
- 改成半角冒号后，AC 内缩进的 `  - 子项` 又被当作新条目，再次报错。
- 更关键的是：`task.py validate` 和 `task.py start` 都通过了，start 之后的 `next` 静默返回 `partition: default`，`## Partitions` 没有生效，直到 `run` 解析合同时才报错。修好格式后，同一个 wave 突然变成两个分区，此前写的单实现者 brief 只能重写。

**根因**：
- `scripts/common/contract.py:102` 的 `_BULLET_RE = ^\s*[-*]\s+` 会匹配任意缩进的子弹，所以嵌套列表会拆成多条；`_bullets`（:149）只把缩进的**非**子弹行当作续行。
- `_split_labelled`（:161-165）只按半角 `:` 分割。

**建议**：
- `task.py start`（以及 structural validation）先调用 `parse_contract`，失败就拒绝 start。
- 缩进的子弹应视为上一条 AC 的续行，只有顶格 `- ` 才开始一条新 AC。
- 标签分隔接受全角 `：`，或者报错时明确提示"请使用半角冒号"。
- 合同解析失败时，`next` 不应退化成 `default` 分区，而应直接报错。

---

## 3. `next` 提示 reader "may run concurrently"，但产品任务实际串行

**现象**：REVIEW 阶段 `next --json` 给出 `batch: [d-007, d-008]`，提示 "readers d-007, d-008 may run concurrently: write each brief, then `arbor run --dispatch <id>` for each"。第二个 `run` 报 `product task dispatches are serialized; collect/finish the running dispatch first`。多分区 wave 也一样：`next` 同时列出两个分区的 items，第二个 `run --partition` 被拒。

**根因**：
- `scripts/arbor.py:1074-1077`：有 `execution_binding` 时，只要存在 `mcp_pending` 或正在运行的分区就拒绝派发。
- `scripts/common/driver/state.py:413` 生成并发提示时没有考虑 execution_binding。
- workflow.md（"Product execution dispatches are serialized, including within a multi-partition wave"）已写明串行，但 `next` 的输出与之矛盾。

**建议**：在 product execution 模式下：
- `next` 的 `items` / `batch` 只给出当前可以派发的一个，并在 summary 中注明"串行"；
- 或者允许只读 reader（review candidates / verify）并发，因为它们不写产品仓库。

---

## 4. codeg 结果缓存过期后无法 collect，需要手工拼 result

**现象**：子任务完成一段时间后，`get_delegation_status` 返回 `status: completed`、`message: "Result no longer cached; open child session 1309 for the full output."`，没有 `text`。hook 和 `collect` 报 `completed MCP report has no result text; retrieve the complete child report`。

**根因**：`scripts/common/driver/mcp.py:143-144` 要求 `completed` 报告必须带 text，而 codeg 只在缓存期内返回 text。这次的触发条件是：一次 `wait_ms` 轮询被 harness 移到后台，之后再轮询时已经过期。

**绕行方式**：用 codeg `get_session_info(child_conversation_id)` 取子会话最后一条 assistant 消息，写进 result JSON 的 `text`，再执行 `arbor.py collect --result <file>`。

**建议**：
- 遇到 "no longer cached" 时，hook 或 collect 给出明确的恢复指令，带上 `child_conversation_id` 和 `get_session_info` 的用法；
- 或者 `sync-delegation` hook 在第一次看到 `completed` 时就把 text 持久化到 result_path。
- 文档中写明结果缓存会过期，完成后要尽快轮询。

---

## 5. GATE 的 `-k` 选择器会空转通过

**现象**：backend 还没有实现时，AC-8（`-k "startup_event or milestone"`）和 AC-10（`-k "slow or node_name or completed"`）就已经显示 pass，因为选择器命中了已有测试。

**建议**：GATE 增加以下任一项弱校验：
- Verification map 中 `file` 列指向的文件必须在任务 range 内被新增或修改；
- 或者至少选中一个测试名包含该 AC id 的测试（implement.md 已经建议把 AC id 写进测试名，例如 `pytest --collect-only -k "ac8"`）。

否则改为告警。

---

## 6. delta 审查周期里，verify 会把本任务早先引入的问题判为 pre-existing

**现象**：第二轮 candidate 审查的 range 只有 fix 的改动（`def094753..2125d3b94`）。verify 以"在 range 基线之前就存在"为由把一条候选判为 REFUTED，但这个基线 `def094753` 是本任务自己 d-006 的提交，不是产品基线。主 agent 只能在 fix brief 里手工把它提升回来。

**根因**：`agents/verify.md:43` 规定 "Also REFUTED: problems that existed before the diff"。在 delta 周期中，"the diff" 被理解为当前周期的 range。

**建议**：delta 周期的 verify prompt 同时注入任务基线（`task.json.base`），并把规则改为：只有任务基线之前就存在的问题才判为 pre-existing；`base..cycle_from` 之间由本任务引入的问题仍然算在范围内。

---

## 7.（次要）启动后修改合同，之后每条命令都会打印 "differs from the recorded approval"

**现象**：start 之后改了两次合同，一次修 AC 格式，一次澄清接口。之后每次 `run`、`collect`、`next` 都会输出 `Note: contract.md differs from the recorded approval`，violations 里也会带上这一条。没有轻量的方式重新记录批准。

**建议**：提供 `arbor.py approve --reason "…"`（或者 `resume` 在非 CONTRACT 状态下也能重新记录 hash），并写入 scorecard；或者只在第一次检测到差异时提示一次。
