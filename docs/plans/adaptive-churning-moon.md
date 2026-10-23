# Claude 统筹 + StarFactory 派工：改造方案

## Context

用户的目标运行模式：

- **Claude Code 是主会话**：和用户讨论需求、brainstorm、写 `prd.md` / `design.md` / `implement.md`、更新 spec、提交。
- **StarFactory（`star` CLI，Claude Code 兼容 fork，本机 1.0.49）当子 agent 干活**：实现（implement）和审查（check）都由 star worker 执行。
- 用户希望能**按角色配置**：哪个角色由哪个 provider、用什么模型。

调研结论：这套模式在仓库里**已经有 90% 的基础设施**，缺的只是一块拼图。

| 需求 | 现状 |
|---|---|
| 主会话派工给另一个 CLI 进程 | `arbor channel` 运行时已存在（`packages/cli/src/commands/channel/`），provider 适配器插件化 |
| 主会话默认用 channel 派工而不是原生 Task 子 agent | 已有可切换的工作流模板 `channel-driven-subagent-dispatch`（marketplace 子模块），`arbor workflow --template channel-driven-subagent-dispatch` 一键切换 |
| 按角色配置 provider / 模型 | 已有 agent 卡片 `.arbor/agents/<name>.md`，frontmatter 支持 `provider:` + `model:`，`spawn --agent <name>` 读取 |
| **star 作为 worker provider** | **缺失**：provider 注册表（`adapters/index.ts` REGISTRY）只有 `claude` / `codex`，`agent-loader.ts` 也硬编码这两个 |

其他已核实的事实：

- Star 作为**主会话平台**的接入（`.starFactory/`、`configurators/star.ts`、`templates/star/`）已在 HEAD 提交（`b4f9c240`、`6cef32e2`），与本方案无重叠，不要重做。
- `cli_adapter.py` 里的 `build_run_command`（含 star 分支）**没有任何调用方**（旧 multi_agent 脚本在 v0.5.0-beta.0 删除），不是派工路径，本方案不依赖它。
- **大 prompt 问题不存在**：`star --help` 不显示 `--append-system-prompt-file`，但二进制里该选项以 `.hideHelp()` 注册（`new Option("--append-system-prompt-file <file>", "Read system prompt from a file and append…").hideHelp()`），处理代码也在。因此 star 适配器可以**完全复用 Claude 适配器的参数构造**，包括 > 8K 字符时走文件的路径。早先讨论的"超限报错"和"上下文经 stdin 首条消息注入"两个方案都不再需要，后者只作为冒烟失败时的备选。
- channel worker 由 supervisor 以 `ARBOR_HOOKS=0` 启动，star worker **不需要**项目里有 `.starFactory/`。
- 工作区里 `.arbor/tasks/10-21-spec-freshness/`、`spec_meta.py` / `spec_trace.py` 属于另一项进行中的工作，不要碰。

用户已决定：复用 channel 工作流模板，只新增 star provider；本次只改主仓库（marketplace 子模块不动）；不建 Arbor task，按本 plan 直接执行。

## 目标架构

```
用户 ⇄ Claude Code 主会话（Phase 1 规划 / Phase 3 收尾；原生 arbor-research 子 agent 仍可用）
            │  arbor channel create / spawn --agent implement|check / send / wait
            ▼
     channel supervisor ──spawn──▶ star -p --input-format stream-json --output-format stream-json
                                        --append-system-prompt(-file) ... [--model <id>]
                                   └─ 角色、provider、模型来自 .arbor/agents/implement.md / check.md
```

## 改动清单

### 0. 冒烟确认隐藏 flag（实现第一步）

```bash
star -p --output-format text --append-system-prompt-file /nonexistent/x "hi"
```

预期：报"文件不存在"类错误而不是 `unknown option`。若意外报 unknown option，则退回备选方案（supervisor 把 `# CONTEXT FILES` 块拼到转发给 worker 的第一条 inbox 消息前，需新增 `WorkerAdapter.contextTransport` 能力位并改 `spawn.ts` / `supervisor.ts` / `supervisor/inbox.ts`），本 plan 其余步骤不变。

### A. channel 新增 `star` provider（核心）

1. **`packages/cli/src/commands/channel/adapters/index.ts`**
   - 新增 `starAdapter: WorkerAdapter<undefined>`：`provider: "star"`，`buildArgs` 直接调用 `buildClaudeArgs({ resumeSessionId: view.resume, model: view.model, systemPrompt: view.systemPrompt, systemPromptFile: view.systemPromptFile })`；`createCtx` / `isReady` / `parseLine` / `encodeUserMessage` / `encodeInterruptMessage` 与 `claudeAdapter` 完全相同（复用 `adapters/claude.ts` 的 `parseClaudeLine`、`encodeClaudeUserMessage`、`encodeClaudeInterruptMessage`）。
   - `REGISTRY` 加 `star: starAdapter`，`Provider` 类型自动扩展；文件头注释 "(claude, codex, future: …)" 顺带补 star。
   - 不新建 `adapters/star.ts`，不做 `createClaudeCompatibleAdapter` 工厂：两个 20 行的字面量比工厂更直白，第三个 stream-json fork 出现时再抽。注释里写明 star 是 Claude Code fork、wire 协议同构、`--append-system-prompt-file` 为隐藏选项。
2. **`agent-loader.ts`**：`AgentDefinition.provider` 改为 `Provider`；`normalizeProvider` 改为 `isProvider(t) ? t : undefined`，去掉硬编码联合；文件头注释第 10 行加 `star`。（`adapters/index.ts` 不反向 import loader，无循环。）
3. **`dev-parse-trace.ts`**：`parseTrace(adapter: Provider, …)`，分支 `adapter === "claude" || adapter === "star"` 走 `parseClaudeLine`。不改会让 `Provider` 变宽后 typecheck 失败（`index.ts:947` 调用处）。
4. **`index.ts`（channel 子命令注册）**：第 278 行 spawn 描述 "(claude/codex)"、第 287 / 403 行 `--provider` 帮助文案，改为由 `listProviders()` 拼接。校验逻辑已经用 `isProvider` / `listProviders`，不用动。
5. 注释清理：`supervisor.ts:2` "(claude or codex)"、`supervisor.ts:128` 的 `resolveProviderPath` 文档。`run.ts` / `messages.ts` / `list.ts` 无硬编码，不动。

### B. 角色 / 模型配置面

- 用户在项目里编辑 `.arbor/agents/implement.md` 与 `check.md`：

  ```yaml
  ---
  name: implement
  provider: star
  model: <star --model 接受的 id>
  ---
  ```

- 内置卡片模板 `packages/cli/src/templates/arbor/agents/{implement,check}.md` 在 `provider: claude` 后加两行注释提示（参照 `.codex/agents/*.toml` 的做法；`parseFrontmatter` 会跳过 `#` 行，`test/templates/arbor.test.ts` 的 frontmatter 断言不受影响）：

  ```yaml
  # provider: star          # StarFactory worker (Claude Code-compatible fork; `star` must be on PATH)
  # model: <provider model id>  # optional; passed as --model
  ```

- `arbor update` 行为：卡片是普通 hash 跟踪文件，用户改过后会进入 `changedFiles` 走交互确认，不会被静默覆盖，但每次 update 都会提示。可选后续（本次不做）：仿 `configurators/codex.ts:128-143` 的 `preserveCodexAgentModelKeys` 写一个 `preserveAgentCardKeys`，把用户的 `provider:` / `model:` 嫁接到新模板上。
- research 角色仍由 Claude 主会话原生 `arbor-research` 子 agent 承担（属于规划阶段），不新增 research 卡片模板。

### C. 文档 / spec

- `.arbor/spec/cli/backend/commands-channel.md`：第 16 行 "(claude / codex)"、第 70 行 `claude | codex`、第 321 行 `"claude" | "codex"`、第 364 行 `provider: "claude"|"codex"`、第 941 行错误文案、第 1128 行 "Happy turn (claude / codex)" 全部加 star；文件树处加一行说明 star 复用 Claude 适配器。
- `.arbor/spec/cli/backend/index.md:37`：`provider adapters (claude / codex)` 加 star。
- `packages/cli/src/templates/common/bundled-skills/arbor-channel/references/workers.md`：第 4-5 行 "(claude or codex)"、第 28 行 `--provider <claude|codex>`、第 32 行 resume 说明加 star；agent 卡片示例（56-60 行）加 `model:` 与注释提示；117-123 行并行 reviewer 示例加 `--provider star --as check-star`。
- 同目录 `workflows.md`：Pattern C 加 `check-star` 的 spawn/send 与 `--from check,check-cx,check-star`；Pattern D 加一条 `arbor channel run --provider star --message "say hi in 3 words" --timeout 1m`。
- 同目录 `command-reference.md`：第 217、254 行 `[--provider claude|codex]`、第 239-240 行 provider 列表加 star。
- `packages/cli/src/templates/common/bundled-skills/arbor-meta/references/local-architecture/multi-agent-channel.md:64`：`(Claude stream-json, Codex app-server)` 改为 Claude 与 StarFactory 共用 stream-json。

### D. 测试

- 新建 `packages/cli/test/commands/channel-star-adapter.test.ts`：
  - `getAdapter("star").provider === "star"`；`isProvider("star")`；`listProviders()` 含 star；`getAdapter("claude")` / `getAdapter("codex")` 不变。
  - `getAdapter("star").buildArgs({ systemPrompt: "agent body", cwd: "/" })` 含 `-p`、`--input-format stream-json`、`--output-format stream-json`、`--permission-mode bypassPermissions`、`--dangerously-skip-permissions`、`--append-system-prompt agent body`。
  - 传 `systemPromptFile` 时含 `--append-system-prompt-file <path>` 且不含 `--append-system-prompt`（与 `channel-claude-adapter.test.ts` 的断言对称）。
  - `model` / `resume` 透传为 `--model` / `--resume`。
- 扩展 `packages/cli/test/commands/channel-context-trust.test.ts`（已有 `loadAgent` 用例，355-395 行）或新建 `channel-agent-loader.test.ts`：`provider: star` → `"star"`；`provider: STAR` → `"star"`；`provider: gemini` → `undefined`；`# provider: star` 注释行被忽略。
- `packages/cli/test/templates/arbor.test.ts`：现有 `getAllAgents` 断言须继续通过；加一条两模板都含 `# provider: star` 提示的断言。

### E. 用户侧启用步骤（文档，不是代码）

1. 目标项目执行 `arbor workflow --list` 看模板，再 `arbor workflow --template channel-driven-subagent-dispatch` 切换 `.arbor/workflow.md`。
2. 编辑 `.arbor/agents/implement.md`、`check.md`：`provider: star`，按需加 `model:`。`architect` / `plan` 卡片保持 codex（或按需改）。
3. 确保启动 Claude Code 的 shell 里 `star` 在 PATH（supervisor 继承环境）。
4. 跨 provider 双审：同一频道 `spawn --agent check --provider claude --as check-cc` 与 `--provider star --as check-star`，`wait --from check-cc,check-star --all`。
5. 只有想把 Star 也当交互式主会话用时才需要 `arbor init --star`；纯 worker 不需要。

## 验证

```bash
# 仓库根目录
pnpm --filter @tony131143a/arbor-core build
pnpm --filter @tony131143a/arbor typecheck
pnpm --filter @tony131143a/arbor lint
pnpm --filter @tony131143a/arbor exec vitest run \
  test/commands/channel-star-adapter.test.ts test/commands/channel-claude-adapter.test.ts \
  test/commands/channel-context-trust.test.ts test/commands/channel.test.ts test/templates/arbor.test.ts
pnpm --filter @tony131143a/arbor test

pnpm build
node packages/cli/bin/arbor.js channel spawn --help | grep -- --provider     # 应显示 claude | codex | star
node packages/cli/bin/arbor.js channel run --provider star --message "say hi in 3 words" --timeout 2m
node packages/cli/bin/arbor.js channel run --provider star --file README.md \
  --message "Quote the first heading of the context file you were given." --timeout 2m   # 触发 > 8K 的文件路径
node packages/cli/bin/arbor.js channel run --agent check --provider star --as check-star \
  --file .arbor/tasks/<task>/prd.md --message "Active task: .arbor/tasks/<task>" --timeout 10m
```

冒烟要确认：star 的 stream-json `system.init` 能持久化 session_id、`assistant` 文本变成 `message` 事件、`result` 变成 `done`；`--verbose` 不报未知 flag。失败时临时频道会保留，看 `~/.arbor/channels/<bucket>/run-*/<worker>.log` 里的 `[supervisor] starting star (resolved: …) <args>` 和 `events.jsonl`。

## 风险 / 待确认

- 隐藏 flag 的运行时行为只在冒烟后才算确认（见步骤 0），备选方案已写明。
- star 的 stream-json 事件同构性来自二进制字串（`total_cost_usd`、`num_turns`、`control_request`、`hook_started`）推断，冒烟时验证。
- star 接受的 `--model` id 未知，由用户按 star 文档填写；错误 id 会以 `result.is_error` → channel `error` 事件暴露。
- 后续可选：marketplace 子模块 `channel-driven-subagent-dispatch/workflow.md` 的 stable handles 列表与跨 provider 示例加 `check-star`（两仓库改动，单独 PR）。
- 顺带发现（不在本方案范围，建议单独补）：已提交的 star 平台接入里 `task_store.py` 的 `_SUBAGENT_CONFIG_DIRS` 仍缺 `.starFactory`（`.arbor/scripts/common/` 与 `packages/cli/src/templates/arbor/scripts/common/` 两份），Star 单独 init 的项目 `task.py create` 不会播种 `implement.jsonl` / `check.jsonl`。Claude + Star 共存的项目因有 `.claude/` 不受影响。
