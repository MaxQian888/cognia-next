# 统一 Work Submission：可持久、可恢复、可审计的工作提交

| 字段          | 值                                                                     |
| ------------- | ---------------------------------------------------------------------- |
| 状态          | P0 已实现（flag 关闭）；P1/P2 待排期                                   |
| 作者 · 日期   | Claude · 2026-08-15                                                    |
| 范围          | P0 Direct Chat 垂直链路已落地；P1/P2 仅排序纲要                        |
| 来源          | 用户提交的《Cognia 统一 Work Submission 完整实施计划》                 |
| 关联          | ADR-0125（本次新增）；依赖 ADR-0090、ADR-0116、ADR-0079、ADR-0086/0111 |
| 分支 / 里程碑 | 当前 `dev` 分支 · `durableWorkSubmission` 默认关闭                     |
| 评审方        | Agent Runtime · 数据与同步 · Chat/HostState · 安全与隐私 · 前端与 i18n |
| 取证状态      | 全部现状结论在 2026-08-15 的工作区上逐条核对，带 `file:line`           |

> **摘要**
>
> - **变更：** 用户消息、冻结输入、`ExecutionRun` 与派发 outbox 在同一个 Dexie 事务（v169）里提交，然后才派发。
> - **原因：** 此前 `send()` 分三次独立提交，任一间隙崩溃都会留下「用户看得见但永远无人应答」的消息；重试则按重试时刻的会话重新推导 prompt。
> - **影响：** 运行时派发路径不变（仍走 `sendPrompt`）；HostState 线协议不变；`durableWorkSubmission` 关闭时聊天路径逐字节等同于今天。
> - **决策：** 复用 `ExecutionRun` 作为生命周期权威、复用既有零重放恢复机、复用账户级加密与中央保留清扫器。

## 1. 已交付（P0）

| 模块               | 文件                                                 | 覆盖率 stmt/branch/func |
| ------------------ | ---------------------------------------------------- | ----------------------- |
| 共享契约           | `packages/agent-config-types/src/work-submission.ts` | 100 / 100 / 100         |
| 跨边界 guard       | `packages/agent-config-types/src/ref-safety.ts`      | 100 / 100 / 100         |
| Dexie v169 存储    | `lib/db/work-submissions.ts`                         | 100 / 100 / 100         |
| 加密               | `lib/work-submission/crypto.ts`                      | 100 / 100 / 100         |
| 接受 / 绑定 / 终态 | `lib/work-submission/service.ts`                     | 100 / 94 / 100          |
| 恢复决策           | `lib/work-submission/recovery.ts`                    | 100 / 100 / 100         |
| 派发 outbox        | `lib/work-submission/outbox-runner.ts`               | 100 / 94.9 / 100        |
| Chat 适配器        | `lib/work-submission/chat-adapter.ts`                | 100 / 96 / 100          |
| 双宿主接线         | `lib/work-submission/bootstrap.ts`                   | 100 / 100 / 100         |

接线点：渲染端 `components/providers/initializers/deferred-boot-initializers-impl.tsx`；
Headless `lib/headless/runtimes/initializers.ts`（`work-submission-outbox`）。

## 2. 关键设计结论（与原计划的偏差）

1. **`run.started` 从「接受时」移到「派发时」。** 它经 `lib/execution/run-reducer.ts`
   把运行投影成 `running`，对「已接受、仍在排队」的工作是假的。接受时开 `queued`，
   `markWorkSubmissionStarted` 在派发时发 `run.started`。
2. **两阶段冻结是必需的，不是可选的。** `effectiveContent` 在
   `use-claude-chat-controller.ts:823` 定稿且此后只读；`sendOptions` 在
   `:972 / :1044 / :1046 / :1372 / :1383` 还会被改 5 次。
3. **加密改用 `@cognia/rag` 的 `encryptContentEnvelope`**（AAD 绑定、base64、已有
   Dexie 落盘先例 `retrievalEncryptedContent`），密钥仍走
   `loadOrCreateAccountArtifactKey` 新增的 `work-submission` domain。AAD 绑定
   `account : submission : half`。
4. **恢复决策发生在认领之前**，所以绝不可重放的工作连 `attemptCount` 都不会 +1。
5. **未接 `AgentExecutionService`**：Chat 至今绕过它，且 `agentExecutionResolverV2`
   默认关闭。冻结的 spec 标 `specAuthority: "shadow"`。

## 3. 顺带修复的既有缺陷

- `packages/agent-config-types/src/ref-safety.ts` 的 `SECRET_SHAPE` 用未加边界的
  `sk-`，把 `task-1` / `risk-report` / `disk-cache` 误判为 OpenAI 密钥。影响该包全部
  跨边界契约。已按同文件 `token[=:]` 既有写法加 `(^|[^a-z])` 边界。
- `lib/ai/eval/artifact-crypto.ts` 的平台判定漏 `isHeadlessHost()`，headless 上落到
  Browser Vault 分支报错。**两处**都有（`loadOrCreateAccountArtifactKey` 与
  `loadOrCreateEvalArtifactKey`），已统一到 `resolveArtifactPlatform()`。
- Headless 此前完全没有陈旧运行对账（`recoverStaleDirectChatExecutionRuns` 只挂在渲染
  端两个 initializer）。已通过 headless roster 补上。

## 4. 动手前必须知道的既有红线（非本次引入）

| 门禁 / 测试                                      | 现状                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `docs/data-governance.generated.json`            | 原停在 v159 / 251 表，本次重生成为 v169 / 271 表，**吸收了约 10 个版本、20 张表的无关漂移** |
| `lib/data-governance/table-catalog.test.ts`      | 原断言 265，而 `dev` 已是 268 —— 本来就红。现为 271                                         |
| `hooks/chat/chat-main-flow.integration.test.tsx` | 在 pristine `dev` 上同样 3 失败 / 7 通过，已逐字核对                                        |
| `pnpm audit:adr-catalog`                         | 8 条 findings 全在 ADR-0116/0117/0118（他人在途）                                           |
| `pnpm lint:i18n`                                 | findings 在 `components/shell/workspace-manage-dialog.tsx`（他人在途）                      |
| `pnpm audit:colocated-tests`                     | findings 在 `lib/tray-panel/types.ts` 等（他人在途）                                        |

## 5. 并发教训

计划阶段记下的「Dexie 版本号会被并发抢走」在本次同样发生在 **ADR 编号**上：动手时
0123/0124 已被另一会话占用，最终使用 **0125**。任何全局单调序号（Dexie 版本、ADR 号）
都必须在写入当刻重新确认，而不是在计划阶段确认。

## 6. 剩余工作

- **P0.5** Host 侧包住 `message.enqueue`（协议不变）。
- **P0.6b** Chat 时间线的 queued / blocked / recovery_required / cancelled /
  no_response 状态与 i18n。i18n 新 key 必须写进**拆分源**
  `i18n/messages/{en,zh-CN}/<namespace>.json` 再跑 `pnpm i18n:build`；
  `en.json` / `zh-CN.json` 是生成产物（`scripts/i18n/build-messages.mjs`），
  手改会让 `i18n:build:check` 变红。CLAUDE.md 规则 4 在这一点上已过时。
- **P1** Automation → Workflow → Goal → Team → Connector。Automation 通过既有
  `registerTaskExecutor` 注册，不新增 Scheduler；`CogniaSchedulerDB` 是独立库，
  只能靠幂等键对账。
- **P2** Task-scoped Actor Grant、Runtime Catalog、Plugin SDK。

## 7. 灰度与回滚

`durableWorkSubmission`（`lib/ai/agent/execution/feature-flags.ts`，默认 false，
env `NEXT_PUBLIC_DURABLE_WORK_SUBMISSION`）。关闭时 `acceptChatTurn` /
`bindChatTurnContext` / `settleChatTurnForSession` 全部返回 null/false，聊天路径与今
天完全一致。Dexie 迁移纯 additive，回滚不删表。
