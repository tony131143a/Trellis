# 后续问题（不在本任务范围，评审中确认存在）

## F-1 中断后被中止轮次的迟到终止事件被记到中断轮次上（来源：r1-c1-correct-1）

- 现象：turn N 进行中 → `trellis channel interrupt` → `supervisor/inbox.ts` 先 `abortCurrent()`（为 N 发 `turn_finished{outcome:"aborted"}`），再 `begin()` 中断轮次 N+1。随后 provider 为被中止的 N 发出 `result{is_error:true}`（`adapters/claude.ts:163-175` → `error`），`supervisor/stdout.ts` 把它当作当前轮的终止：置终止标志并 `turnTracker.finish()`（LIFO）弹出的是 N+1，发出一条 N+1 的 `turn_finished`（outcome 取自 N）。之后 N+1 若崩溃，标志已置位、tracker 已空，不再合成任何终止事件，`wait` 只能等到超时。
- 性质：轮次归属问题，早于 C-1 存在；C-1 未使其变差（修复前第 1 轮之后本就不合成）。
- 方向：终止事件与轮次的对应需要 provider 侧的轮次标识，或在 interrupt 后丢弃一次被中止轮次的迟到终止事件。

## F-2（已纳入范围，由子任务 `10-23-channel-turn-attribution` / C-3 修复）worker 自发轮次的 `done` 被记到在途的用户轮次上，`turn_finished` 提前发出（2026-10-23 实测）

- 现象：star / Claude Code worker 用后台命令（`run_in_background`）跑测试时，后台任务结束会触发一个**无用户输入的自发轮次**，并产生一条 `result` → channel `done`。若此时一条用户消息正在途，supervisor（`supervisor/stdout.ts` 终止事件 → `turnTracker.finish()`）把自发轮次的 `done` 当成该用户轮次的终止，提前写出 `turn_finished{inputSeq}`；真正的结果到来时 tracker 已空，不再有 `turn_finished`。
- 实例：tw-orch 的 eng-core——seq 1139 派发 E1，11:11:03 自发轮次（37s）的 `done` 产生 `turn_finished{inputSeq:1139}`；E1 实际完成在 11:39:53（1729s），无对应 `turn_finished`。
- 影响：等待 `turn_finished.inputSeq == seq` 的编排器（本任务的引擎 `channel.py:368-375`、spark v2 同样）会在 worker 仍在改代码时进入验证/评审。
- 方向：provider 侧轮次关联——Claude stream-json 有 `--replay-user-messages`（把 stdin 用户消息回显到 stdout），supervisor 可据此把 `result` 绑定到最近一次回显的用户消息，未绑定的 `result` 视为自发轮次、不结束用户轮次；需实验确认回显时机。临时缓解：brief 要求 worker 在结束本轮前等待所有后台命令完成。

## F-3 `lint:py` 有 4 个早已存在的 basedpyright 错误（2026-10-23 最终验证）

- 位置：`packages/cli/src/templates/trellis/scripts/common/spec_lint.py:308`、`:313` 等（`reportOptionalSubscript`，对可能为 `None` 的值取下标）。该文件与 main 一致，本任务未改动。
- 影响：AC11 中 `lint:py` 不全绿；本任务新增的引擎文件 basedpyright 干净。
- 用户决定（2026-10-23）：不在本任务修，单独处理。
