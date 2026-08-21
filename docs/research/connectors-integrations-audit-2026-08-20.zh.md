# 连接器 / 集成 / 文档提供方 / 外部桥 全量审计

**日期**：2026-08-20
**范围**：`lib/connectors` · `lib/integrations` · `lib/docs-providers` · `lib/external-bridge` · `lib/wiki` · `components/{inbox,connectors,integrations,settings/connections,settings/external-bridge}` · `hooks/connectors` · `crates/{cognia-connectors,cognia-mcp-server}`（仅接线面）
**基准**：工作树（非 HEAD）。范围内唯一的在途改动是 `lib/integrations/ingress-client.ts(+test)`，属于其他会话，**不计入本报告任何结论**。
**性质**：只读审计。未修改任何生产代码，未提交。

---

## 0. 摘要

审计对象 467 个生产源文件 / 约 21.7 万行（含 Rust）。机械扫描覆盖：全仓导入图可达性（21823 个文件、7441 个可达节点）、1187 个导出符号的生产/测试/文档三路引用计数、Rust `#[tauri::command]` 注册面、能力入口矩阵。

**判定口径**

| 级别   | 含义                                               |
| ------ | -------------------------------------------------- |
| **P0** | 造成用户可见的错误行为，或绕过安全/审计控制        |
| **P1** | 能力失效、不可达，或违反项目硬规则且有实际后果     |
| **P2** | 整洁度与可维护性；无当前用户可见影响，但有漂移风险 |

**结论一览**

| #   | 级别   | 结论                                                                                                                                                            |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **P0** | **Slack OAuth 端到端不可能成功**，两处独立缺陷叠加；`buildSlackOAuthState` 这段死代码正是缺失的那次调用；配套测试把错误行为钉死了                               |
| 2   | **P1** | 外部桥客户端凭据**只能签发和轮换，无法吊销** —— Rust RPC、TS 封装、`revokedAt` 字段俱全，唯独没有 UI 入口                                                       |
| 3   | **P1** | Google 文档"断开连接"**不向 Google 吊销授权**；`GOOGLE_REVOKE_URL` 定义了却从未 fetch                                                                           |
| 4   | **P1** | 瘦客户端（配对手机 / 驱动远端主机的桌面）的收件箱里，**8 张表不在同步协议内**，活动流、恢复面板、标签、指派历史、常用语、健康、话题状态、发送者身份全部静默为空 |
| 5   | **P1** | `lib/connectors/bus.runtime.test.ts` 32 例中 **12 例红**，孤立可复现；已定位到 `DexieError TransactionInactiveError`                                            |
| 6   | **P1** | `components/settings/connections/tabs/inbox-tab.tsx` 零生产引用，`pnpm audit:unreachable-components` 因此在 dev 上红                                            |
| 7   | **P2** | 29 个生产死符号 + 4 个零测试用户的死测试钩子 + 2 个被取代的 Rust API 对                                                                                         |
| 8   | **P2** | 5 处重复实现：MCP 资源双实现、GitHub App JWT 双实现、LabelChip 双组件、标签体系双表、wiki 模块文章 agent 被绕过                                                 |
| 9   | **P2** | 连接器深链路由里 5 条硬编码英文 toast，且 i18n 门禁**结构上看不见它们**                                                                                         |

**范围内表现良好的部分**（不是缺陷，值得记录）：硬规则 3（同址测试）在本范围内**零缺口**；`ConnectorMeta.status === "planned"` 的休眠标注三轴齐全，是全仓最标准的一例；A2UI mapper 工具箱被 15 个适配器真实复用；46 个 Rust 连接器/MCP 命令**全部**已注册；集成子系统（ADR-0026）的作业管线在 app 与 headless 两条启动路径上都已接线。

---

## 1. 死代码

判定线：**零生产调用者**。逐条给"删除 vs 接线"的判断。同址测试与文档引用不算调用者。

### 1.1 完全不可达的模块（导入图口径）

从 204 个生产入口（`app/**`、`sidecar/**`、`cli` 入口、插件入口、`services/**`、构建脚本入口 `lib/external-bridge/mcp-server/standalone-entry.ts`）做传递闭包，范围内 467 个文件中有 **5 个不可达**：

| 文件                                                                                                             | 行数            | 唯一引用者 | 判断                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | --------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| [lib/external-bridge/handlers/resources.ts](lib/external-bridge/handlers/resources.ts)                           | 174 (+198 测试) | 仅自身测试 | **删除**（理由见下）                                                                                     |
| [lib/wiki/exporter.ts](lib/wiki/exporter.ts)                                                                     | 182 (+264 测试) | 仅自身测试 | **接线或删除，不要放着**                                                                                 |
| [components/settings/connections/tabs/inbox-tab.tsx](components/settings/connections/tabs/inbox-tab.tsx)         | —               | 仅自身测试 | **门禁已红，见 §2.6**                                                                                    |
| [components/settings/connections/forms/adapter-form.tsx](components/settings/connections/forms/adapter-form.tsx) | —               | 仅自身测试 | 已在 `unreachable-component-baseline.json` 中，历史债                                                    |
| `lib/connectors/__smoke__/_helpers.ts`                                                                           | —               | 仅自身测试 | **不是缺陷** —— 测试夹具（门禁的 `IS_TEST_HELPER` 正则未覆盖 `__smoke__/` 目录，但它只管 `components/`） |

**`handlers/resources.ts` 判定为删除，而非接回去。** 这一点值得展开，因为直觉上"补接线"更好：

`lib/external-bridge/handlers/` 下 12 个 handler，11 个被 [server.ts](lib/external-bridge/mcp-server/server.ts) 导入，唯独 `resources.ts` 没有。`server.ts` 在 [1575–1866 行](lib/external-bridge/mcp-server/server.ts:1575) 用 `ResourceTemplate` 自己重新实现了同样的 wiki / skill / character 三族资源。两份实现不等价，而且**活着的那份严格更强**：

- `server.ts` 每次 list/read 都走 [`recordCall`](lib/external-bridge/mcp-server/server.ts:1610) 写审计；孤儿版本没有任何审计。
- `server.ts` 对 wiki 正文调用 [`wrapUntrusted`](lib/external-bridge/mcp-server/server.ts:1671)，落实 ADR-0008 R7（把生成的 wiki 散文围栏为不可信，防止编码 agent 把它当指令）；孤儿版本**没有** `wrapUntrusted`。
- `server.ts` 用 `scopedSettings(settingsGetter, extra)` 按请求解析作用域；孤儿版本要求调用方把 `enabledScopes` 传进来。

也就是说，"把 `handlers/resources.ts` 接回去"会**回退两项安全控制**。正确动作是删除 `resources.ts` + `resources.test.ts`（372 行），并在 `server.ts` 的 Resources 段落上补一行注释说明资源实现就在这里，避免下一个人再造一次 handler 层。

`scopeForResourceUri` 与 `readResource` 是该文件内的导出，随文件一并删除。`parseResourceUri` 由 [mcp-server/resource-uri.ts](lib/external-bridge/mcp-server/resource-uri.ts) 提供，`server.ts` 直接引用，不受影响。

**`lib/wiki/exporter.ts` 是"造完但从未挂上入口"的完整特性。** 182 行 + 264 行测试，fs 抽象（注入 `WriteFs`，同一份代码驱动 Tauri fs 与内存 map），输出 Fumadocs 友好的 MDX。文件头注释自陈"`docs/` 子应用会在用户选择发布时收录它们"—— 而"选择发布"的按钮不存在。外部桥设置页已经有 `wiki` 面板（[nav-config.ts:37](components/settings/external-bridge/nav-config.ts:37) 的 `BridgePanelId`）。三个选项里最差的是保持现状：446 行零用户的维护成本。建议在 wiki 面板加一个"导出为 Markdown"动作（小改），否则连测试一起删。

### 1.2 生产零引用的导出符号

在可达模块内部，另有 **29 个符号**零生产引用（排除仅注释内提及、排除同文件内部使用）：

| 文件:行                                                                                                | 符号                                                                                                                                                                                                                                     | 测试引用 | 判断                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [lib/connectors/adapters/slack/oauth-handler.ts:27](lib/connectors/adapters/slack/oauth-handler.ts:27) | `buildSlackOAuthState`                                                                                                                                                                                                                   | 5        | **接线** —— 见 §2.1，这是 P0 的修复点                                                                                                                                                                                                                                                                         |
| [lib/docs-providers/oauth-deep-link.ts:41](lib/docs-providers/oauth-deep-link.ts:41)                   | `getDocsOAuthCompletion`                                                                                                                                                                                                                 | 2        | 删除（`completeDocsOAuthDeepLink` 内部直接读 map）                                                                                                                                                                                                                                                            |
| [lib/docs-providers/oauth-deep-link.ts:51](lib/docs-providers/oauth-deep-link.ts:51)                   | `isDocsOAuthDeepLink`                                                                                                                                                                                                                    | 4        | 删除（路由用自己的 `DOCS_OAUTH_RE`，见 §3.5）                                                                                                                                                                                                                                                                 |
| [lib/docs-providers/providers/google/auth.ts:52](lib/docs-providers/providers/google/auth.ts:52)       | `GOOGLE_REVOKE_URL`                                                                                                                                                                                                                      | 0        | **接线** —— 见 §2.3                                                                                                                                                                                                                                                                                           |
| [lib/docs-providers/registry.ts:40](lib/docs-providers/registry.ts:40)                                 | `getDocsProvider`                                                                                                                                                                                                                        | 9        | 删除                                                                                                                                                                                                                                                                                                          |
| [lib/docs-providers/registry.ts:54](lib/docs-providers/registry.ts:54)                                 | `listAvailableDocsProviders`                                                                                                                                                                                                             | 3        | 删除 + 改注释，见 §5.3                                                                                                                                                                                                                                                                                        |
| [lib/external-bridge/tauri-control.ts:148](lib/external-bridge/tauri-control.ts:148)                   | `revokeExternalBridgeClient`                                                                                                                                                                                                             | 0        | **接线** —— 见 §2.2                                                                                                                                                                                                                                                                                           |
| [lib/external-bridge/token.ts:68](lib/external-bridge/token.ts:68)                                     | `parseBearerHeader`                                                                                                                                                                                                                      | 11       | 删除 —— Bearer 解析在 Rust（`crates/cognia-mcp-server/src/http_server.rs`）；TS 侧只用 `generateToken`（[server-panel.tsx:141](components/settings/external-bridge/panels/server-panel.tsx:141)）。`verifyToken` / `constantTimeEquals` / `hasToken` 同样零生产调用，是同一层被 Rust 取代后的残留，可一并清理 |
| [lib/external-bridge/orchestration-ipc.ts](lib/external-bridge/orchestration-ipc.ts)                   | `sendOrchestrationResponse`、`subscribeOrchestrationExec`                                                                                                                                                                                | 各 3     | 待判 —— 模块本身被 [orchestration-dispatch-provider.tsx](components/providers/orchestration-dispatch-provider.tsx) 与 [desktop-message-source.ts](lib/headless/runtimes/desktop-message-source.ts) 引用（用的是别的导出），这两个是同一模块内的未用配对 API                                                   |
| [lib/wiki/agents/module-article-agent.ts:33](lib/wiki/agents/module-article-agent.ts:33)               | `runModuleArticleAgent`                                                                                                                                                                                                                  | 3        | **接线** —— 见 §3.4                                                                                                                                                                                                                                                                                           |
| [lib/wiki/merkle.ts:75](lib/wiki/merkle.ts:75)                                                         | `refreshSubset`                                                                                                                                                                                                                          | 5        | 删除 + 改注释，见 §5.4                                                                                                                                                                                                                                                                                        |
| [lib/wiki/merkle.ts:89](lib/wiki/merkle.ts:89)                                                         | `dropPaths`                                                                                                                                                                                                                              | 6        | 删除 + 改注释                                                                                                                                                                                                                                                                                                 |
| [lib/connectors/callback-binding-cleanup.ts:174](lib/connectors/callback-binding-cleanup.ts:174)       | `startCallbackBindingCleanupSchedule`                                                                                                                                                                                                    | 8        | 删除 —— 被 [housekeeping-scheduler.ts:57](lib/connectors/housekeeping-scheduler.ts:57) 取代的旧定时器路径                                                                                                                                                                                                     |
| [lib/connectors/known-kinds.ts:46](lib/connectors/known-kinds.ts:46)                                   | `listKnownConnectorKinds`                                                                                                                                                                                                                | 4        | 删除 —— 注释说"排序以便稳定展示"，但没有任何界面展示它；`isKnownConnectorKind` 才是在用的那个                                                                                                                                                                                                                 |
| [lib/connectors/adapters/lark/auth.ts:420](lib/connectors/adapters/lark/auth.ts:420)                   | `clearUserTokenCache`                                                                                                                                                                                                                    | 2        | **接线** —— 见 §2.4                                                                                                                                                                                                                                                                                           |
| [lib/connectors/inbox-relay/host-events.ts:102](lib/connectors/inbox-relay/host-events.ts:102)         | `configureHostEvents`                                                                                                                                                                                                                    | 5        | 删除 + 改注释，见 §5.5                                                                                                                                                                                                                                                                                        |
| [lib/connectors/hitl/approval-registry.ts:162](lib/connectors/hitl/approval-registry.ts:162)           | `pendingApprovalCount`                                                                                                                                                                                                                   | 12       | 删除 —— 只有按会话的 `pendingApprovalCountForSession` 在用                                                                                                                                                                                                                                                    |
| [lib/connectors/adapter-metadata.ts:119](lib/connectors/adapter-metadata.ts:119)                       | `findMetadataGaps`                                                                                                                                                                                                                       | 2        | **保留** —— 注释明确自陈是测试自检助手，诚实标注                                                                                                                                                                                                                                                              |
| [hooks/connectors/use-conversation-labels.ts:35](hooks/connectors/use-conversation-labels.ts:35)       | `useConversationLabelMap`                                                                                                                                                                                                                | 3        | 删除 —— `LabelPicker` 用 `catalog.filter(...)` 自己做了等价的事                                                                                                                                                                                                                                               |
| [lib/connectors/adapters/lark/chat-seed.ts](lib/connectors/adapters/lark/chat-seed.ts)                 | `CHAT_LIST_SCOPE`                                                                                                                                                                                                                        | 0        | 删除（零引用，连测试都没有）                                                                                                                                                                                                                                                                                  |
| 其余 9 个                                                                                              | `serializePostMessageAsync`、`aes128DecryptBlock`、`buildSendMediaBody`、`adapterIdOfConversationKey`、`identityScopeOf`、`removePlatformSurface`、`collectA2UIRemoteImageUrls`、`replaceA2UIImageUrls`、`isSenderInCommandAllowlist` 等 | 2–5      | 逐个判 —— 多为"同文件内部使用但被 export"的过度导出，降级为模块私有即可，不必删                                                                                                                                                                                                                               |

> **过度导出（另一类，共约 40 项）**：`FNV1A_PRIME`、`MAX_INLINE_BYTES`、`BUTTON_TEXT_MAX`、`DEFAULT_QQ_INTENTS`、`STALE_RECOVERY_INTERVAL_MS`、`GOOGLE_PROVIDER_ID`、`LARK_PROVIDER_ID` 等常量在自身文件内使用、被 `export` 却无外部消费者。单个无害，整体让"这个符号是公共 API"这件事失去信号。建议随各自模块的下次改动顺手降级，不单独开批次。

### 1.3 零测试用户的死测试钩子

`__reset*ForTesting` 系列共 29 个，其中 25 个被测试真实使用（正常）。以下 **4 个连测试都没有用**，是纯粹的脚手架残留：

- [lib/connectors/bootstrap/install-connector-runtime.ts](lib/connectors/bootstrap/install-connector-runtime.ts) `__resetConnectorRuntimeOwnershipForTests`
- [lib/connectors/credentials-events.ts](lib/connectors/credentials-events.ts) `__resetCredentialsEventsForTesting`
- [lib/connectors/delivery-gateway.ts](lib/connectors/delivery-gateway.ts) `__resetConnectorDeliveryGatewayForTesting`
- [lib/connectors/run-presentation/runner.ts](lib/connectors/run-presentation/runner.ts) `__resetExecutionRunPresentationRunnerForTesting`

这四个模块都持有模块级可变状态却没有任何测试重置它 —— 值得顺带确认它们的测试是否因此存在跨用例污染。

### 1.4 Rust 侧被取代的 API

`crates/{cognia-connectors,cognia-mcp-server}` 共 150 个 `pub fn`，其中 4 个无跨文件引用：

| 位置                                                                                         | 符号                           | 判断                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| [crates/cognia-mcp-server/src/lib.rs:188](crates/cognia-mcp-server/src/lib.rs:188)           | `start_with_verifiers`         | 删除 —— 被 `start_with_clients`（带身份+作用域元数据）取代                                                                              |
| [crates/cognia-mcp-server/src/lib.rs:350](crates/cognia-mcp-server/src/lib.rs:350)           | `replace_client_verifiers`     | 删除 —— 被 `replace_bridge_clients` 取代（后者还会 `sessions.close_all()`，这正是吊销需要的）                                           |
| [crates/cognia-mcp-server/src/commands.rs:119](crates/cognia-mcp-server/src/commands.rs:119) | `mcp_server_restart_for_state` | 删除或复用 —— `mcp_server_restart`（[commands.rs:93](crates/cognia-mcp-server/src/commands.rs:93)）把同样的 stop+start 逻辑内联抄了一遍 |
| [crates/cognia-mcp-server/src/commands.rs:184](crates/cognia-mcp-server/src/commands.rs:184) | `first_existing_sidecar`       | 降级为私有（同文件用了 6 次）                                                                                                           |

**Rust 接线面结论：无未注册命令。** 46 个连接器/MCP `#[tauri::command]` 与 `src-tauri/src/lib.rs` 的 `generate_handler!`（950 项）逐一对齐，缺口为 0。`src-tauri/capabilities/*.json` 不含连接器条目 —— 这是正确的，应用自定义命令不需要 ACL 行，与仓库其余部分一致。

---

## 2. 接线缺陷

### 2.1 【P0】Slack OAuth 端到端不可能成功

两个独立缺陷叠加，任一单独存在都足以让流程失败。

**缺陷 A —— state 存储键不匹配。**

```
components/settings/connections/forms/slack-config.tsx:204
    sessionStorage.setItem("slack_oauth_state", state)

lib/connectors/oauth-state.ts:2
    export const CONNECTOR_OAUTH_STATE_KEY = "connector-oauth-state"

components/connectors/connector-deep-link-router.tsx:55
    stored = sessionStorage.getItem(CONNECTOR_OAUTH_STATE_KEY) ?? ""

components/connectors/connector-deep-link-router.tsx:110-113
    if (!state || state !== storedState) {
      toast.error("OAuth state mismatch")
      return
    }
```

Slack 写 `"slack_oauth_state"`，路由读 `"connector-oauth-state"`。两个键永不相交，`storedState` 恒为空串，`state !== ""` 恒成立 → 每一次 Slack 授权回跳都在第一步以 **"OAuth state mismatch"** 结束。

**缺陷 B —— state 值的形状不对。** 即使修好键，还有第二层：

```
components/settings/connections/forms/slack-config.tsx:201-202
    const state = typeof crypto !== "undefined"
      ? crypto.randomUUID() : Math.random().toString(36).slice(2)

lib/connectors/adapters/slack/oauth-handler.ts:69-72
    const parsed = parseSlackOAuthState(deps.state)
    if (!parsed) throw new Error(
      "Slack OAuth state malformed — expected `slack:<adapterId>:<nonce>`")
```

发出去的是裸 UUID，处理器要的是 `slack:<adapterId>:<nonce>`。`parseSlackOAuthState` 返回 `null` → 抛错。而**产生正确形状的那个函数就在同一个文件里，且是死代码**：

```
lib/connectors/adapters/slack/oauth-handler.ts:27
    export function buildSlackOAuthState(adapterId: string, nonce: string): string {
      return `slack:${adapterId}:${nonce}`
    }
```

**对照组：Lark 是对的。** [lark-config.tsx:266–271](components/settings/connections/forms/lark-config.tsx:266) 写的是 `CONNECTOR_OAUTH_STATE_KEY`（还额外镜像到 `localStorage` 以扛冷启动），而 state 由 [oauth-begin.ts:89](lib/connectors/adapters/lark/oauth-begin.ts:89) 的 `buildLarkOAuthState(adapterId, nonce)` 生成，并通过 `setPending` 落一份持久记录。Slack 三样都没有 —— 键错、形状错、无持久 pending 记录（所以就算前两条修好，授权途中重启应用仍会失败）。

**测试把错误行为钉死了。** [slack-config.test.tsx:361](components/settings/connections/forms/slack-config.test.tsx:361) 断言 `sessionStorage.getItem("slack_oauth_state")` 为真值 —— 它锁定的正是缺陷 A。修复时这条断言必须一起改。

**用户可见后果**：Slack 连接器无法通过 OAuth 完成绑定。`CONNECTOR_METADATA` 把 slack 标为 `status: "stable"`（[adapter-metadata.ts:58](lib/connectors/adapter-metadata.ts:58)），[oauth-registry.ts:32](lib/connectors/oauth-registry.ts:32) 的注释写着 "Slack — fully wired"。两处都不成立。

**修复形状**（三行量级）：在 `slack-config.tsx` 里把 state 换成 `buildSlackOAuthState(adapterId, nonce)`、把存储键换成 `CONNECTOR_OAUTH_STATE_KEY`、同步改测试；是否补 `setPending` 持久记录以对齐 Lark 是第二个决策点。

### 2.2 【P1】外部桥客户端凭据无法吊销

链路上除了 UI 入口，每一环都在：

| 层              | 位置                                                                                                                           | 状态                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Rust 实现       | [companion_api/rpc/native_tools.rs:349](src-tauri/src/companion_api/rpc/native_tools.rs:349) `"external_bridge_client_revoke"` | ✅                              |
| Rust ACL 名单   | `rpc.rs:395`、`rpc.rs:1237`、`rpc.rs:1489`、`native_tools.rs:26` 四处                                                          | ✅                              |
| Rust 运行时生效 | `replace_bridge_clients` → `sessions.close_all()`                                                                              | ✅                              |
| TS 封装         | [lib/external-bridge/tauri-control.ts:148](lib/external-bridge/tauri-control.ts:148) `revokeExternalBridgeClient`              | ✅ 但**零调用者**               |
| 数据模型        | `ExternalBridgeClient.revokedAt`                                                                                               | ✅                              |
| UI              | [server-panel.tsx](components/settings/external-bridge/panels/server-panel.tsx)                                                | ❌ **只有 rotate，没有 revoke** |
| i18n            | `i18n/messages/en/**`                                                                                                          | ❌ 无任何 bridge revoke 文案    |

面板已经在读 `revokedAt`（[server-panel.tsx:173](components/settings/external-bridge/panels/server-panel.tsx:173)、[:223](components/settings/external-bridge/panels/server-panel.tsx:223) 都用 `!candidate.revokedAt` 过滤），也就是说 UI 已经预设了"凭据可以被吊销"这个状态，却没有产生这个状态的路径。

**后果**：外部 agent 凭据泄露时没有关闭开关。轮换（rotate）签发新凭据，但**旧凭据的 verifier 是否随之失效**取决于 `replace_bridge_clients` 的语义 —— 即便如此，"吊销某一个客户端而不影响其他客户端"这件事在 UI 上做不到。

### 2.3 【P1】Google 文档"断开连接"不向 Google 吊销授权

```
lib/docs-providers/providers/google/auth.ts:52
    export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"   // 从未被 fetch

lib/docs-providers/providers/google/config.ts:115-121
    export async function clearGoogleConnection(): Promise<void> {
      await docsProviderSecrets().delete(GOOGLE_TOKENS_KEY)      // 只清本地 keyring
      await updateGoogleDocsSettings(...)                        // 只清本地标志位
    }
```

[docs-providers-card.tsx:189](components/settings/connections/docs-providers/docs-providers-card.tsx:189) 的 "Disconnect" 按钮调的就是 `clearGoogleConnection`。本地 token 被删了，但**Google 侧的 refresh token 授权仍然有效**，用户需要自行去 Google 账号页面撤销。常量的存在证明这不是设计意图，是漏接。

修复：`clearGoogleConnection` 在删本地凭据**之前** `POST GOOGLE_REVOKE_URL` with `token=<refreshToken>`；吊销失败不阻断本地清理（Google 的 revoke 端点对已失效 token 返回 400，属正常）。

### 2.4 【P1】Lark 用户 token 内存缓存在断开时不清

```
lib/connectors/adapters/lark/auth.ts:419-422
    /** Clear the in-memory user-token cache for an adapter (tests / disconnect). */
    export function clearUserTokenCache(adapterId: string): void {
      userTokenCache.delete(adapterId)
    }
```

注释自陈用于"tests / disconnect"，实际零调用者 —— 连测试都只调了 2 次（在自身测试里）。断开 / 换绑 Lark 账号后，进程内缓存仍会命中旧 token 直到 TTL 过期。相邻的 [adapter-registry.ts:30](lib/connectors/adapter-registry.ts:30) 里 QQ 的 `clearQQTokenCache` 是被 import 的，说明这个模式在别处已被正确接线，Lark 是漏的那个。

### 2.5 【P1】瘦客户端收件箱的 8 张表不在同步协议内

ADR-0131 的跨壳写入面做得很完整：[inbox-writes/route.ts](lib/connectors/inbox-writes/route.ts) 用一张路由矩阵决定 `local` / `remote` / `unavailable`，组件不再各自 `isTauri()`。**读侧没有对应的接缝。**

`components/inbox` 与 `hooks/connectors` 下的读取全部是 `useLiveQuery` 直连本地 Dexie，零主机感知：

```
hooks/connectors/use-inbound-recovery-jobs.ts:23
    return getDb().connectorInboundJobs.where("conversationKey")...

hooks/connectors/use-conversation-labels.ts:24
    return getDb().conversationLabels.toArray()...
```

Companion 同步协议只覆盖 25 张表（[table-catalog.ts:413](lib/data-governance/table-catalog.ts:413)），连接器相关的只有 `adapterInstances`、`conversationOverrides`、`connectorDrafts`、`outboundQueue`、`messages`、`sessions`。

**不在协议内、但收件箱 UI 会读的连接器表**：

| 表                             | 驱动的界面                         |
| ------------------------------ | ---------------------------------- |
| `connectorAudit`               | 会话活动时间线、外发饱和度 chip    |
| `connectorInboundJobs`         | 入站恢复面板（继续 / 重试 / 忽略） |
| `conversationLabels`           | 标签选择器、标签设置页             |
| `conversationAssignmentEvents` | 指派历史                           |
| `cannedResponses`              | 常用语选择器                       |
| `connectorHeartbeats`          | 适配器健康徽章                     |
| `connectorConversationStates`  | 话题运行时 chip                    |
| `platformIdentities`           | 发送者身份解析                     |

**为什么这不会被"要求主机"卡住**：[inbox-shell.tsx:197](components/inbox/inbox-shell.tsx:197) 只在 `writeRoute === "unavailable" && !isTauri()` 时渲染 `StateCard.RequiresHost`。配对了主机时路由是 `"remote"`，整个收件箱正常渲染 —— 然后上面这些面板静默为空。

标签这条特别有迷惑性：`useConversationLabels` 在挂载时会 `seedBuiltinLabels()`，所以瘦客户端**看得到内置标签**，只是看不到主机上用户自建的标签、也看不到主机侧的标签指派。界面看起来是有数据的，用户没有任何信号意识到它不同步。

这同时是硬规则 7 的 UI 轴缺口：这些面板在非主机壳上是惰性的，但没有任何一处标注了这一点。

### 2.6 【P1】`inbox-tab.tsx` 零生产引用，门禁在 dev 上红

```
$ pnpm audit:unreachable-components
[unreachable-components] 7 component(s) have no production importer:
  components/agent/mode/mode-selector.tsx
  components/chat/search/chat-history-search-results.tsx
  components/settings/connections/tabs/inbox-tab.tsx     ← 本范围内
  components/shell/member-list.tsx
  components/terminal/ai-shell/index.ts
  components/terminal/terminal-tab-appearance-picker.tsx
  components/terminal/terminal-template-prompt.tsx
```

其中 6 个在本范围外（属于终端 / agent / 搜索，是他人在途或既有工作，**记为既有问题**）。`inbox-tab.tsx` 是本范围的：它有同址测试，测试是它唯一的引用者。

顺带：门禁还报告"6 个基线条目现已挂载或消失"和"1 个基线行指向不存在的文件" —— 基线该重生成了。

### 2.7 【P2】插件贡献的连接器无法走 OAuth 深链

[platform-kind.ts:34](types/connectors/platform-kind.ts:34) 的 `PlatformKind = BuiltInPlatformKind | (string & {})` 明确写着"TypeScript 连接器插件可以在不修改宿主业务模型的前提下实现新 IM 平台"。但深链路由在查表前先做了内置校验：

```
components/connectors/connector-deep-link-router.tsx:117-119
    if (!isPlatformKind(adapterType)) {
      toast.error(`No OAuth handler for unknown platform: ${adapterType}`)
```

而 [`isPlatformKind`](types/connectors/platform-kind.ts:36) 只认 `ALL_PLATFORM_KINDS` 里的 15 个内置 id。插件即便向 `oauthRegistry` 注册了 handler 也永远走不到。

（对照：适配器工厂那条路是**对的** —— [`buildAdapterFromRow`](lib/connectors/adapter-registry.ts:43) 的 `default: return null` 只服务 DB 行，插件适配器走 [`connectors-bridge.ts`](lib/plugin/bridge/connectors-bridge.ts) 的独立注册路径，不是缺陷。）

---

## 3. 重复实现与抽象泄漏

### 3.1 MCP 资源：两份实现，孤儿那份更弱

见 §1.1。`handlers/resources.ts`（174 行）与 `server.ts:1575–1866`（约 290 行）实现同样的三族资源；活着的那份多了审计与 prompt-injection 围栏。

### 3.2 GitHub App JWT：两套独立签名实现

| 实现 | 位置                                                                                            | 方式                                                                 | 服务对象                                      |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| A    | [lib/integrations/github-auth.ts:158](lib/integrations/github-auth.ts:158) `createGithubAppJwt` | 手写 RS256：`base64Url` + WebCrypto                                  | 集成市场 / `github-delivery` 插件（ADR-0026） |
| B    | [lib/github/auth-app.ts](lib/github/auth-app.ts)                                                | `@octokit/auth-app` 的 `createAppAuth`，附带 installation token 缓存 | Agent Team PR 反馈（ADR-0022）                |

同一把私钥、同一个 GitHub App、两条铸造 JWT 的路径、两套独立的 `iat`/`exp` 时钟偏移处理和缓存策略。这是安全相邻的重复：任何一处的偏移量算错，症状是间歇性 401，而且只在一半的功能上出现。

### 3.3 标签体系：两张表、两个 LabelChip 组件

|          | 收件箱会话标签                                                     | Issue 标签                                                           |
| -------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 表       | `conversationLabels`（Dexie v83）                                  | `labels`（Dexie v170，[lib/db/labels.ts](lib/db/labels.ts)）         |
| 组件     | [components/inbox/label-chip.tsx](components/inbox/label-chip.tsx) | [components/labels/label-chip.tsx](components/labels/label-chip.tsx) |
| 组件差异 | `{label, onRemove, className}`                                     | `{label, onRemove, removeLabel, className}`                          |
| 使用者   | 仅 `label-picker.tsx`                                              | issue-card / issue-list / issue-detail-panel / issues-mobile-body    |

两个同名 `LabelChip`，`components/labels/` 那个明显是后来泛化的版本（多一个 `removeLabel` 无障碍文案 prop）。收件箱那个应该删掉，改用泛化版。两张表是否要合并是更大的产品决策，不在本次改造范围内，但值得记录：用户会看到两套互不相通的标签。

### 3.4 wiki 模块文章 agent 被编排器绕过

[module-article-agent.ts:33](lib/wiki/agents/module-article-agent.ts:33) 的 `runModuleArticleAgent` 把"构造 prompt → 调 LLM → 组装草稿"封成一步。编排器不用它，把同一段逻辑内联抄了一遍：

```
lib/wiki/orchestrator.ts:226-234
    const llmResponse = await deps.llm.complete(
      moduleArticlePrompt({ module: modulePath, stat, chunks: inBudget }),
      { system: WIKI_SYSTEM_VOICE, temperature: 0, maxTokens: 2048 }
    )
    ...
    const draft = assembleArticle(stat, inBudget, fileHashes, llmResponse)
```

对照 `runModuleArticleAgent` 的实现，两者逐字等价，只是编排器写死 `2048` 而 agent 用常量 `MAX_OUTPUT_TOKENS`（当前也是 2048）。**目前无实际漂移**，但 prompt / temperature / token 预算改一处不会传导到另一处。修复很小：编排器改调 `runModuleArticleAgent`。

### 3.5 三套 OAuth 状态机制

| 子系统          | state 生成                                                     | state 存储                                                              | 校验点                                         |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| 连接器（Lark）  | `buildLarkOAuthState(adapterId, nonce)` + `setPending`（持久） | `sessionStorage` + `localStorage` 镜像，键 `CONNECTOR_OAUTH_STATE_KEY`  | 路由预检 + handler 内对 pending 记录做权威校验 |
| 连接器（Slack） | 裸 `crypto.randomUUID()`                                       | `sessionStorage["slack_oauth_state"]`                                   | **实际无校验**（见 §2.1）                      |
| 文档提供方      | provider 自己铸造                                              | provider 自己的持久 pending 记录（`providers/google/oauth-pending.ts`） | provider 内部                                  |

[oauth-deep-link.ts:9-13](lib/docs-providers/oauth-deep-link.ts:9) 明确写了为什么文档提供方**不该**共用连接器的 `sessionStorage` state store，这个论证是站得住的。所以这里的问题不是"应该合并成一套"，而是**连接器内部 Slack 和 Lark 两条路径就不一致**，且不一致的那条是坏的。

同一文件里还有一处小抽象泄漏：`isDocsOAuthDeepLink` / `DOCS_OAUTH_PATH_RE` 是给路由准备的判别函数，路由却在 [connector-deep-link-router.tsx:43](components/connectors/connector-deep-link-router.tsx:43) 复制了一份正则 `DOCS_OAUTH_RE`。两份正则必须同步，谁也没引用谁。

### 3.6 A2UI 映射：**不是**重复（记录一个正面结论）

`lib/connectors/adapters/_shared/a2ui-mapper.ts` 被 15 个适配器模块真实 import（`walkA2UISurface` / `buildActionId` / `bindingHintFields` / `generatePlainTextMirror`）。10 个 `inbound-to-a2ui.ts` 是按平台线上形状必需的分化，不是复制。这一层的抽象是健康的。

---

## 4. 能力可达性矩阵

**本节不计为缺陷**，是范围的地形图。

### 4.1 外发能力 × 入口

`ConnectorBus` 暴露 14 个外发方法。统计每个方法在生产代码里的非 bus 调用者：

| 能力                            | 插件 API | 工作流节点 |          内部特性          | 收件箱 UI | MCP 工具 | IM 命令 |
| ------------------------------- | :------: | :--------: | :------------------------: | :-------: | :------: | :-----: |
| `sendOutbound`                  |    ✅    |     —      |             —              |    — ¹    |   — ¹    |    —    |
| `editOutbound`                  |    ✅    |     —      |             —              |     —     |    —     |    —    |
| `deleteOutbound`                |    ✅    |     ✅     |             —              |     —     |    —     |    —    |
| `addReactionOutbound`           |    ✅    |     ✅     |             —              |     —     |    —     |    —    |
| `removeReactionOutbound`        |    ✅    |     ✅     |             —              |     —     |    —     |    —    |
| `forwardOutbound`               |    ✅    |     ✅     |             —              |     —     |    —     |    —    |
| `pinOutbound` / `unpinOutbound` |    ✅    |     —      |             —              |     —     |    —     |    —    |
| `sendUrgentOutbound`            |    ✅    |     —      | ✅ `escalation/actions.ts` |     —     |    —     |    —    |
| `getReadReceiptOutbound`        |    ✅    |     —      |             —              |     —     |    —     |    —    |
| `setTypingOutbound`             |    ✅    |     —      |             —              |     —     |    —     |    —    |
| `uploadFileOutbound`            |    ✅    |     —      |             —              |     —     |    —     |    —    |
| `streamReplyOutbound`           |    ✅    |     —      |             —              |     —     |    —     |    —    |
| `fetchHistoryAll`               |    ✅    |     —      |             —              |     —     |    —     |    —    |

¹ 收件箱回复和 MCP `connectors_send_message` **不**走 `bus.sendOutbound`：前者经 `inbox-writes` → 持久 `outboundQueue` → `outbound-runner` → `adapter.send`；后者（[handlers/connectors.ts:264](lib/external-bridge/handlers/connectors.ts:264)）走 `runConnectorDigestTurn`（一次模型轮次）。这是刻意的耐久化设计，不是漏接。

**读法**：14 项能力中 **8 项只有插件 API 一个入口** —— 置顶、取消置顶、已读回执、正在输入、文件上传、流式回复、编辑、拉历史，用户在应用里做不到，只有插件能做。这可能完全符合产品意图（插件面就是为了这个），但值得确认没有哪一项是"UI 本来该有却忘了接"。

### 4.2 平台 × 能力

| 平台                             | 适配器工厂  | OAuth handler  | `oauth` 元数据 | `richMessages` | 出站 A2UI mapper |
| -------------------------------- | :---------: | :------------: | :------------: | :------------: | :--------------: |
| telegram                         |     ✅      |       —        |     false      |      true      |        ✅        |
| discord                          |     ✅      |       —        |    **true**    |      true      |        ✅        |
| slack                            |     ✅      | ✅（坏，§2.1） |      true      |      true      |   ✅ block-kit   |
| lark                             |     ✅      |       ✅       |      true      |      true      |    ✅ card.ts    |
| onebot                           |     ✅      |       —        |     false      |     false      |        ✅        |
| dingtalk                         |     ✅      |       —        |     false      |      true      |   ✅ serialize   |
| wecom                            |     ✅      |       —        |    **true**    |      true      |        ✅        |
| wechat-oa                        |     ✅      |       —        |    **true**    |     false      |        —         |
| wechat-personal                  |     ✅      |       —        |     false      |     false      |        ✅        |
| qq-official                      |     ✅      |       —        |    **true**    |     false      |        —         |
| matrix                           |     ✅      |       —        |     false      |      true      |   ✅ serialize   |
| email / kook / line / mattermost | — `planned` |       —        |      混合      |      混合      |        —         |

**加粗的四个**（discord / wecom / wechat-oa / qq-official）：元数据声明 `oauth: true`，但既没有 `oauthRegistry` 条目，也没有任何配置表单会打开授权 URL（全仓只有 lark-config 和 slack-config 会）。`ConnectorMeta.oauth` 的字段注释是"该平台的接入是否需要一次 OAuth 往返"，而这个标志唯一的消费者是 [discover-inspector.tsx:545](components/discover/discover-inspector.tsx:545) 上的一个 `OAuth` 徽章。要么这四个平台的语义是"你要去平台自己的控制台做 OAuth"（那字段注释该改），要么元数据就是错的。**P2，需要产品确认口径**。

### 4.3 IM 控制命令的原生暴露

[commands/registry.ts:48–66](lib/connectors/commands/registry.ts:48) 的 18 条命令里，`nativeExposed: false` 的有 12 条：`/commands`、`/dir`、`/resume`、`/mode`、`/model`、`/reasoning`、`/character`、`/team`、`/workflow`、`/agent`、`/goal`、`/tasks`。这些命令**只有用户手打才能用**，不会出现在平台的命令菜单里。列在这里供确认是否符合预期。

---

## 5. 休眠三轴合规（硬规则 7）

规则：**类型有文档 + UI 标不可用 + 测试钉住**，三缺一即为潜伏缺陷。

### 5.1 ✅ `ConnectorStatus === "planned"` —— 全仓最标准的一例

- **类型轴**：[adapter-metadata.ts:21–32](lib/connectors/adapter-metadata.ts:21) 明确写了"这是 CLAUDE.md 规则 7 的刻意休眠标记"，并逐条列出读取它的 UI 面。
- **UI 轴**：[add-connector-grid.tsx](components/settings/connections/adapters/add-connector-grid.tsx) 把 planned 渲染成虚线边框、`disabled`、无 `onPick`、带 `plannedHint` title 的卡片；[platform-badge.tsx:67](components/inbox/platform-badge.tsx:67) 渲染通用两字母回退 + "Planned platform" title。
- **测试轴**：`platform-badge.test.tsx` + `add-connector-grid.test.tsx` 双向钉住。
- **接线核实**：[adapters-tab.tsx:65](components/settings/connections/tabs/adapters-tab.tsx:65) 确实用 `listConnectorMetadata().filter(status === "planned")` 计算 `PLANNED_KINDS` 传给 grid，注释所述属实。

### 5.2 ✅ `defaultDegradeChain` —— 合规（上一轮遗留项，此处结案）

[types/connectors/capability.ts:188–198](types/connectors/capability.ts:188) 的注释自陈"**现实核对**：今天没有中央 walker 消费它。降级发生在各适配器序列化器内部；bus 不走这条链。保留它作为文档化的默认顺序"。

- 类型轴：✅ 文档诚实到点名了自己的休眠状态。
- 测试轴：✅ `capability.test.ts` 钉住 4 条降级序列。
- UI 轴：**不适用** —— 它不是 UI 面，没有可标注"不可用"的对象。

**判定：合规，保留。** 而且它的价值是实在的：[a2ui-to-segments.ts:68](lib/connectors/a2ui-bridge/a2ui-to-segments.ts:68) 和 [runtime.test.ts:485](lib/connectors/runtime.test.ts:485) 都在注释里引用它来解释自己的临时降级 —— 它是那个顺序的可执行规范。删掉会让降级顺序失去单一事实源。上一轮标记的"待判"到此可以关闭。

### 5.3 ❌ `listAvailableDocsProviders` —— 注释描述了不存在的接线

```
lib/docs-providers/registry.ts:49-53
    /**
     * Providers that can actually run on this host. The picker and the settings
     * cards both key off this — everything else stays visible but inert, so a
     * mobile user sees WHY the feature is missing instead of an empty list.
     */
```

"选择器和设置卡都以它为准"—— **两者都没有调用它**。设置卡用的是硬编码单 provider 检查：

```
components/settings/connections/docs-providers/docs-providers-card.tsx:48
    const hostSupported = isDocsProviderHostSupported(googleDocsProvider)
```

卡片文件头有一段很好的论证，说明为什么这里刻意写成两个手工行而不是通用列表（Lark 什么都不需要、Google 需要用户自备凭据，两个截然不同的接入故事）。**这个决定是合理的**；问题在于 registry 的注释没有跟上，还在描述一个通用列表世界。

同时留下一个潜伏 bug：`hostSupported` 用 Google 一个 provider 的结果控制**整张卡**的显隐。当前两者 `hosts` 都是 `["tauri"]` 所以无害；一旦加入一个 hosts 更宽的 provider，Lark 行会在它本可以工作的壳上被一起藏掉。

**修复**：删除 `listAvailableDocsProviders`（零生产调用者），改写 registry 注释以反映"设置卡刻意手工枚举"，并把 `hostSupported` 改成按行判定。

### 5.4 ❌ `merkle.ts` 的注释描述了不存在的调用

```
lib/wiki/merkle.ts:85-88
    /**
     * Drop entries from a Merkle map. Used after the orchestrator processes the
     * `removed` list from `diffManifest`. ...
     */
```

编排器只 import 了 `buildMerkleMap` 和 `hashContent`（[orchestrator.ts:35](lib/wiki/orchestrator.ts:35)）。而且当前设计下这两个增量助手是**冗余的**：编排器每轮都读全部 included 文件、重建整张 Merkle map（[orchestrator.ts:145](lib/wiki/orchestrator.ts:145)），被删除的路径自然不在新 map 里。

**修复**：删除 `refreshSubset` + `dropPaths` 及其测试，或者（如果增量扫描是路线图上的）把注释改成 "reserved for the planned incremental walk; no caller today" 并补一条测试钉住休眠。**不要保持现状** —— 现在的注释会让下一个人以为增量路径已经在跑。

### 5.5 ❌ `configureHostEvents` 的注释描述了不存在的调用

```
lib/connectors/inbox-relay/host-events.ts:101-102
    /** Install the production seams (called by the connector runtime bootstrap). */
    export function configureHostEvents(next: Partial<HostEventsDeps>): () => void {
```

"由连接器运行时 bootstrap 调用"—— 零调用者。模块通过 `defaultDeps` 正常工作，行为无碍，但这是那个已知的注入依赖反模式的镜像：**默认对象就是唯一的生产路径，注入接缝只被测试用**。

**修复**：删除 `configureHostEvents`，或改注释为 "test seam only"。

---

## 6. 硬规则 3 / 4 缺口

### 6.1 硬规则 3（同址测试）—— 本范围零缺口 ✅

```
$ pnpm audit:colocated-tests
[colocated-tests] 16 source file(s) are missing a co-located test
```

16 个全部在本范围外（terminal / issues / onboarding / support / db types）。**记为既有问题，不属于本次审计范围。** 门禁另报告"44 个基线文件现已有测试"和"3 个基线行指向不存在的文件"，基线该重生成。

### 6.2 硬规则 4（i18n）—— 5 处硬编码 + 一个结构性门禁盲区

门禁本身是绿的：

```
$ pnpm lint:i18n
[lint:i18n] OK — key parity (tolerated drift: 0/0)
[lint:i18n] OK — JSX hardcoded strings: 107 (≤ baseline 370)
[lint:i18n] OK — referenced keys exist in both locales (22217 literal refs, ...)
```

但检测器只扫 **JSX 文本节点** 和 `placeholder` / `aria-label` / `title` / `alt` 四个属性（[lint-i18n.ts:58](scripts/gates/lint-i18n.ts:58)、[:101](scripts/gates/lint-i18n.ts:101)）。CLAUDE.md 规则 4 明确写着"toast 和错误消息也算用户可见"，而 `toast.*()` / `new Error()` 是 TS 表达式，不是 JSX —— **门禁结构上看不见它们**。

本范围内因此漏掉 5 处，全部集中在同一个文件：

```
components/connectors/connector-deep-link-router.tsx:111  toast.error("OAuth state mismatch")
components/connectors/connector-deep-link-router.tsx:121  toast.error(`No OAuth handler for unknown platform: ${adapterType}`)
components/connectors/connector-deep-link-router.tsx:127  toast.error(`No OAuth handler for ${adapterType}`)
components/connectors/connector-deep-link-router.tsx:140  toast.success(`${adapterType} connected successfully`)
components/connectors/connector-deep-link-router.tsx:142  toast.error(`OAuth exchange failed: ${err.message}`)
```

讽刺的是**同一个文件的文档提供方分支是对的**：[:159–166](components/connectors/connector-deep-link-router.tsx:159) 用的是 `tDocs("settings.connectSucceeded")` / `tDocs("errors.notConfigured")`。连接器那一半没跟上。

第 142 行还会把 handler 的原始英文错误直接抛给用户 —— 例如 `Slack OAuth state malformed — expected \`slack:<adapterId>:<nonce>\``。

**建议**：修这 5 处的同时，考虑把 i18n 检测器扩到 `toast.*` 的字符串字面量与模板字面量首段。这会让 baseline 数字跳一大截，所以是独立决策，不要和本次修复捆绑。

---

## 7. 上一轮遗留项结案

| 遗留项                                                | 结论                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 跨壳中继"切库 provider"是否已被现方案覆盖             | **写侧已覆盖**（`inbox-writes/route.ts` 的路由矩阵，ADR-0131），**读侧没有** —— 见 §2.5，8 张表不在同步协议内。原来的担忧是对的，只是落点在读侧。 |
| `bus.runtime.test.ts` 红测是自身缺陷还是 harness 问题 | **部分解答，见下。**                                                                                                                              |
| `defaultDegradeChain` 的休眠是否合规                  | **合规，结案** —— 见 §5.2。                                                                                                                       |

### 7.1 `bus.runtime.test.ts` 红测诊断

**事实**：32 例中 12 例失败，整套 103 秒。

```
Tests: 12 failed, 20 passed, 32 total
```

**已排除的解释**：

- **不是顺序依赖 / 共享状态**：单例孤立运行（`npx jest <file> --testNamePattern "..."`）同样失败，7.8 秒。
- **不是模块级 db 句柄陈旧**：全仓无 `const x = getDb()` 的模块级捕获。
- **不是近期改动引入**：`bus.ts` 自最后一次触碰该测试文件的提交（`188506a42`）以来只增加了 29 行，全部在 `runConnectorCallback` 的 `issue_action` 短路分支里（`6b3cf1adf` 合并带入），与入站管线无关。`policy-eval.ts`、`delivered-messages.ts`、测试文件本身自那以后都没变过。

**已定位的根因信号**：

```
console.error
  [connector-bus] route handler failed DexieError { name: 'TransactionInactiveError' }
  at ConnectorBus.handleRouteHandlerFailure (lib/connectors/bus.ts:1199)
```

轮次在 `startRouteHandlerTurn`（[bus.ts:1131](lib/connectors/bus.ts:1131)）的完成路径上抛 Dexie `TransactionInactiveError` → 被 `handleRouteHandlerFailure` 吞掉、审计成 `adapter.error`、作业标为 `recovery_required` → 测试看到 `routeHandler` 调用次数为 0。这解释了全部 12 例（它们共同的特征是断言持久化的入站作业状态，而通过的 20 例断言的是路由决策本身）。

**为什么还不能定论是产品缺陷还是 harness 缺陷**：`TransactionInactiveError` 是 Dexie 的经典陷阱 —— 事务体内 await 了一个非 Dexie 的 promise，事务已提交后再做 Dexie 操作。这个语义在真实浏览器里是一样的，所以**倾向于真实缺陷**。但 `fake-indexeddb` 的事务存活窗口比真实 IndexedDB 更严格，且该测试的 `beforeEach` 每例都 `await getDb().delete()` + `__resetDbForTesting()` + 冷开 100+ 版本的完整 schema（注释里自陈需要 30 秒 hook 预算），这个生命周期在生产中不存在。

**下一步（一步即可定论）**：在 [bus.ts:1199](lib/connectors/bus.ts:1199) 临时打印 `err.stack`（或设 `Dexie.debug = true`）跑一次，拿到抛错的确切 Dexie 调用点。若该调用点位于某个 `db.transaction()` 体内且其上游 await 过非 Dexie promise → 产品缺陷，且会在"删除全部数据 / 恢复备份"（ADR-0001）这种会话内重开库的真实场景里复现。若调用点在事务外 → harness 生命周期问题，修 `beforeEach`。

**本次审计未做这一步**，因为它需要改动生产文件，超出只读契约。

### 7.2 全仓测试健康度（顺带观测，非本范围结论）

一次误触发的全量运行给出：

```
Test Suites: 36 failed, 758 passed, 794 total
Tests:       51 failed, 8276 passed, 8327 total
```

多个失败是 `beforeEach` 里 `getDb().delete()` 超时（`lib/goal/seed-templates.test.ts`、`lib/sync/handlers/agent-tasks.test.ts` 等），与 §7.1 的 Dexie 生命周期信号同源。**这不是本范围的问题**，但如果 §7.1 定论为 harness 缺陷，很可能是同一个根因，修一处收益覆盖数十个套件。

---

## 8. 大文件拆分方案

四个目标文件的拆分难度差异极大，取决于内部耦合度 —— 下面每条都给了实测的耦合数据。

### 8.1 `lib/connectors/bus.ts`（2590 行）

单个 `ConnectorBus` 类占 2400 行。**关键测量**：两个 500 行级方法对实例状态的依赖极窄，所以拆分是机械的，不需要动类的公共形状。

```
runInboundPipeline (533 行) 触及的 this.<成员>：
   routeHandler ×3, policyState ×2, notifyInboundObservers, enqueueWorkflowFanOut,
   enqueueRouteHandlerTurn, applySystemEvent, applyMessageEdit, applyMessageDelete   → 8 个

runConnectorCallback (498 行) 触及的 this.<成员>：
   callbackHandler ×2, notifyCallbackObservers, dispatchInboundFull                  → 3 个

15 个外发方法 (382 行) 触及的 this.<成员>：
   adapters ×14                                                                      → 1 个
```

**拆分顺序**（每步独立可提交、可测）：

| 步  | 目标文件                   | 搬什么                                                                                                                                         | 约行数 | 做法                                                                                       |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| 1   | `bus/outbound-facade.ts`   | 15 个 `*Outbound` + `fetchHistoryAll`                                                                                                          | 382    | 改为自由函数 `sendOutbound(adapters, adapterId, req)`；类方法保留为一行转发，公共 API 不变 |
| 2   | `bus/callback-dispatch.ts` | `runConnectorCallback`                                                                                                                         | 498    | 传入 `{callbackHandler, notifyCallbackObservers, dispatchInboundFull}` 三元组              |
| 3   | `bus/inbound-pipeline.ts`  | `runInboundPipeline`                                                                                                                           | 533    | 传入 8 成员的 context 对象                                                                 |
| 4   | `bus/turn-queue.ts`        | `turnQueues` / `enqueueRouteHandlerTurn` / `startRouteHandlerTurn` / `runRouteHandlerTurn` / `handleRouteHandlerFailure` / `flushInboundTurns` | 250    | 提取为一个小类 `TurnQueue`，bus 持有一个实例                                               |
| 5   | `bus/message-mutations.ts` | `applyMessageEdit` / `applyMessageDelete` / `applySystemEvent` / `findStoredPlatformMessage`                                                   | 240    | 纯 Dexie 操作，几乎无 `this`                                                               |
| 6   | `bus/fan-out.ts`           | `enqueueWorkflowFanOut` / `fanOutSystemTriggers` / `fanOutWorkflowTriggers`                                                                    | 170    |                                                                                            |

拆完 `bus.ts` 剩约 **400 行**：类型定义、常量、字段、注册/观察者、外发转发壳、组合根。

**并发冲突风险：高**。`bus.ts` 是整个子系统最热的文件（近 6 个月里被 6 个不同特性提交触碰）。这 6 步必须**连续做完并尽快落地**，不要跨天悬着；每步一个 commit，`git commit --only lib/connectors/bus.ts lib/connectors/bus/<新文件>*`。

### 8.2 `lib/external-bridge/mcp-server/server.ts`（2090 行）

**最容易的一个** —— 文件已经用 banner 注释切成了独立的 `registerXTools(server, settingsGetter)` 段落，没有跨段共享可变状态。

| 目标文件                            | 源行范围                                                                                         | 约行数 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| `mcp-server/tool-kit.ts`            | 83–165 + 2015–2090（`scopedSettings` / `bridgeCaller` / `bridgeIdempotencyKey` / `runWithGate`） | 160    |
| `mcp-server/tools/workflow.ts`      | 166–499                                                                                          | 334    |
| `mcp-server/tools/wiki.ts`          | 504–562                                                                                          | 59     |
| `mcp-server/tools/rag.ts`           | 567–631                                                                                          | 65     |
| `mcp-server/tools/runtime.ts`       | 638–681                                                                                          | 44     |
| `mcp-server/tools/computer-use.ts`  | 686–730                                                                                          | 45     |
| `mcp-server/tools/orchestration.ts` | 738–1042                                                                                         | 305    |
| `mcp-server/tools/connectors.ts`    | 1047–1232                                                                                        | 186    |
| `mcp-server/tools/inbound.ts`       | 1237–1337                                                                                        | 101    |
| `mcp-server/tools/memory.ts`        | 1343–1573                                                                                        | 231    |
| `mcp-server/resources.ts`           | 1578–1866                                                                                        | 289    |
| `mcp-server/prompts.ts`             | 1871–2014                                                                                        | 144    |
| `server.ts`（保留）                 | `buildMcpServer` 组合根                                                                          | ~120   |

**唯一的注意点**：`startWorkflowToolRefresh` 是从 `server.ts` 导出的，被 [standalone-entry.ts:21](lib/external-bridge/mcp-server/standalone-entry.ts:21) import。搬到 `tools/workflow.ts` 后要么改 `standalone-entry.ts` 的 import，要么在 `server.ts` 里 re-export。**同时注意这是 esbuild 单独打包的 sidecar 入口**（`scripts/build/build-mcp-sidecar.mjs`），拆完必须跑一次 `node scripts/build/build-mcp-sidecar.mjs` 验证打包仍然成立。

**并发冲突风险：低**（近期只有 §7.1 提到的一次 issue 相关改动）。

### 8.3 `lib/connectors/runtime.ts`（1781 行）

`installRuntime`（830–1781，951 行）几乎全部是一个 `bus.routeHandler = async (...) => {...}` 闭包。

| 步  | 目标文件                     | 源行范围                                                                                                       | 约行数 |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `runtime/recovery-spec.ts`   | 131–247（`candidateDeploymentIds` + `resolveRecoveryExecutionSpec`）                                           | 117    |
| 2   | `runtime/respond-via.ts`     | 248–376（`notifyImFailure` + `RespondViaTarget` + `resolveRespondViaTarget`）                                  | 129    |
| 3   | `runtime/inbound-content.ts` | 377–390 + 472–543 + 681–693（`isInboundTextPiiSafe` / `inboundEventToSendContent` / `shouldEmbedInboundText`） | 100    |
| 4   | `runtime/inbound-persist.ts` | 544–680（`insertInboundMessage` + `suppressedReasonToAuditKind`）                                              | 137    |
| 5   | `runtime/send-options.ts`    | 694–829（`resolveInboundSendOptions`）                                                                         | 136    |
| 6   | `runtime/route-handler.ts`   | 831–1781 的闭包体 → `createRouteHandler(opts): RouteHandler`                                                   | 950    |

第 6 步之后 `runtime.ts` 剩约 200 行（类型 + `installRuntime` 的三行装配）。`route-handler.ts` 仍有 950 行，需要**第二轮**按处理阶段（前置守卫 / 执行分发 / 结果投影）再切，但那要先看清闭包捕获了哪些 `opts` 字段，建议放到第一轮落地之后再评估。

**并发冲突风险：中**。

### 8.4 `lib/connectors/outbound-runner.ts`（1484 行）

`startOutboundRunner`（450–1484）是一个闭包工厂，内部 `processJob`（约 565 行）和 `rerouteJob`（约 120 行）闭包捕获了 `adapterState` / `lanes` / `inFlight` / `sendSemaphore` / `idempotencyCache` 等共享可变状态。

| 步  | 目标文件                        | 搬什么                                                                      | 约行数 | 备注                                                                                                                               |
| --- | ------------------------------- | --------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `lib/utils/lru-map.ts`          | `LruMap`（247–280）                                                         | 34     | **通用工具**，不该埋在连接器里                                                                                                     |
| 2   | `outbound/quiet-hours.ts`       | `isInQuietHours` / `msUntilQuietEnd`（85–173）                              | 89     | 已被 `sla.ts` / `derive-job-badge.ts` / `quiet-hours-chip.tsx` / `use-pet-proactive.ts` 跨子系统复用，从 runner 里独立出来名副其实 |
| 3   | `outbound/tuning.ts`            | 常量 + `DEFAULT_OUTBOUND_TUNING` + `sanitizeOutboundTuning`（174–246）      | 73     |                                                                                                                                    |
| 4   | `outbound/conversation-lane.ts` | `ConversationLane`（281–340）                                               | 60     |                                                                                                                                    |
| 5   | `outbound/runtime-state.ts`     | `AdapterRuntimeStateSnapshot` + `getAdapterRuntimeStateSnapshot`（386–443） | 58     |                                                                                                                                    |
| 6   | `outbound/process-job.ts`       | `processJob` + `rerouteJob`                                                 | 685    | 先在 runner 里提出一个 `RunnerContext` 对象承载共享状态，再把两个函数改成 `(ctx, job) => ...`                                      |

前 5 步是纯搬迁，零风险。第 6 步是唯一需要设计的一步。

**并发冲突风险：中低**。

---

## 9. 改造批次计划

每批一个 commit，按"独立可验证 + 冲突面最小"排序。**不建议一次做完** —— 批次 1–3 是低风险高收益，可以立刻做；批次 6–9 是重构，应在前面几批稳定后再启动。

| 批次   | 内容                                                                                                                                                                         | 涉及文件                                                                                                  | 测试要求                                                                            | changeset                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| **1**  | **修 Slack OAuth**（§2.1）：`slack-config.tsx` 改用 `buildSlackOAuthState` + `CONNECTOR_OAUTH_STATE_KEY`；改 `slack-config.test.tsx:361` 的断言；决定是否补 pending 持久记录 | `components/settings/connections/forms/slack-config.{tsx,test.tsx}`                                       | 现有 slack-config 套件 + 新增一条"state 形状可被 `parseSlackOAuthState` 解析"的断言 | ✅ patch                 |
| **2**  | **接上外部桥吊销**（§2.2）：`server-panel.tsx` 加 Revoke 按钮 + 确认对话框，调 `revokeExternalBridgeClient`；补 en/zh 文案                                                   | `components/settings/external-bridge/panels/server-panel.{tsx,test.tsx}`、`i18n/messages/{en,zh-CN}/**`   | 新增 revoke 交互测试；`pnpm lint:i18n`                                              | ✅ minor                 |
| **3**  | **Google 吊销 + Lark token 缓存清理**（§2.3、§2.4）：`clearGoogleConnection` 先 POST `GOOGLE_REVOKE_URL`；Lark 断开路径调 `clearUserTokenCache`                              | `lib/docs-providers/providers/google/config.ts`、`lib/connectors/adapters/lark/auth.ts` 的调用方          | 两个模块的同址测试各加一条                                                          | ✅ patch                 |
| **4**  | **i18n 补齐**（§6.2）：`connector-deep-link-router.tsx` 5 处 toast 走 `useTranslations`                                                                                      | `components/connectors/connector-deep-link-router.{tsx,test.tsx}`、`i18n/messages/{en,zh-CN}/**`          | `pnpm lint:i18n`                                                                    | ✅ patch                 |
| **5**  | **`inbox-tab.tsx` 处置**（§2.6）：挂载或删除（连同测试）；顺手 `pnpm audit:unreachable-components -- --write-baseline`                                                       | `components/settings/connections/tabs/inbox-tab.*`                                                        | `pnpm audit:unreachable-components` 转绿（本范围部分）                              | 挂载则 minor，删除则跳过 |
| **6**  | **死代码清理 A —— 整模块**（§1.1）：删 `handlers/resources.ts` + 测试；`lib/wiki/exporter.ts` 二选一                                                                         | `lib/external-bridge/handlers/resources.*`、`lib/wiki/exporter.*`                                         | 删除后跑 external-bridge + wiki 套件                                                | 跳过（内部）             |
| **7**  | **死代码清理 B —— 符号级**（§1.2、§1.3、§1.4）：29 个生产死符号中判定为"删"的部分 + 4 个死测试钩子 + 3 个 Rust 被取代 API；同批修 §5.3/§5.4/§5.5 三处说谎的注释              | 分散，建议按子系统再切三个 commit：connectors / docs-providers+external-bridge / wiki+rust                | 每个子系统的既有套件；Rust 侧 `cargo test -p cognia-mcp-server`                     | 跳过（内部）             |
| **8**  | **`bus.runtime.test.ts` 定论**（§7.1）：加一次性 `err.stack` 打印定位 Dexie 调用点，按结论修产品或修 harness                                                                 | 视结论而定                                                                                                | 该套件转绿                                                                          | 视结论                   |
| **9**  | **瘦客户端读侧接缝**（§2.5）：把 8 张表纳入 companion 同步协议，或给这些面板加主机门控 + 说明文案                                                                            | `lib/data-governance/table-catalog.ts`、`lib/sync/handlers/*`、`hooks/connectors/*`、`components/inbox/*` | 新增 sync handler 测试；三轴休眠标注                                                | ✅ minor（用户可见）     |
| **10** | **拆分 `server.ts`**（§8.2）：最容易的一个，先做以验证拆分流程                                                                                                               | `lib/external-bridge/mcp-server/**`                                                                       | 既有套件全绿 + `node scripts/build/build-mcp-sidecar.mjs` 成功                      | 跳过（内部）             |
| **11** | **拆分 `outbound-runner.ts`**（§8.4）第 1–5 步（纯搬迁）                                                                                                                     | `lib/connectors/outbound-runner.ts`、`lib/utils/lru-map.ts`、`lib/connectors/outbound/**`                 | 既有套件全绿                                                                        | 跳过                     |
| **12** | **拆分 `bus.ts`**（§8.1）6 步，6 个连续 commit                                                                                                                               | `lib/connectors/bus.ts`、`lib/connectors/bus/**`                                                          | 7 个 bus.* 套件全绿（含 §7.1 修好后的 runtime 套件）                                | 跳过                     |
| **13** | **拆分 `runtime.ts`**（§8.3）第 1–5 步                                                                                                                                       | `lib/connectors/runtime.ts`、`lib/connectors/runtime/**`                                                  | 既有套件全绿                                                                        | 跳过                     |
| **14** | **重复消解**（§3.2、§3.3、§3.4）：GitHub JWT 收敛到一份；删 `components/inbox/label-chip.tsx` 改用 `components/labels/`；wiki 编排器改调 `runModuleArticleAgent`             | 分散                                                                                                      | 各自套件                                                                            | 跳过                     |
| **15** | **元数据口径确认**（§4.2、§2.7）：`ConnectorMeta.oauth` 四个平台的语义定性；插件连接器 OAuth 深链是否放行                                                                    | 需要产品决策后再定                                                                                        | —                                                                                   | 视结论                   |

**并发注意**：批次 10–13 是大范围移动，与其他会话冲突概率最高。启动前先 `git status --porcelain -- <目标目录>` 确认无他人在途改动，提交时严格 `git commit --only <本次改动的路径>`。

---

## 附录：方法与可复现命令

**模块级可达性**（本报告 §1.1 的依据）：对 `app/**`、`sidecar/**`、`cli` 入口、插件入口、`services/**`、`scripts/**`、`lib/external-bridge/mcp-server/standalone-entry.ts` 共 308 个入口做导入图传递闭包（解析 `@/`、`@web/`、相对路径，含动态 `import()` 与 `require()`），排除 `node_modules` / `dist` / `build` / `.next` / `out` / `target`。测试与 story 不作为入口。

**符号级引用计数**（§1.2 的依据）：抽取范围内 1187 个值导出，用 `rg -ow -F -f names.txt` 分别在生产 / 测试 / 文档三个语料上计数。**注意 ripgrep 的 glob 顺序语义**：`-g '!**/*.test.ts'` 必须写在 `-g '*.ts'` **之后**，否则后者会把测试文件重新纳入（本次审计第一轮就踩了这个坑，导致 30 个死符号被漏报）。自引用计数额外剔除定义行与注释行，否则文件头注释里提到自己的函数会被误判为"内部有使用"。

**Rust 命令注册面**：从 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` 块解析 950 个已注册 ident，与两个 crate 的 46 个 `#[tauri::command]` 求差集。

**验证命令**（本次实跑）：

```bash
pnpm audit:unreachable-components
```

```bash
pnpm audit:colocated-tests
```

```bash
pnpm lint:i18n
```

```bash
npx jest lib/connectors/bus.runtime.test.ts
```

**未做的验证**：未跑范围内全部 jest 套件（契约约定不全量跑）；未跑 `cargo test`；未跑 tauri smoke；未跑 `pnpm build:packages`。§7.2 的全仓数字来自一次误触发的全量运行，仅作背景参考。
