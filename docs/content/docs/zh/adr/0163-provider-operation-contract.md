---
title: "0163：一份 provider 操作契约，网关只做推理"
description: "每一项 provider 能力都是同一份 JSON 契约里五十个具名操作之一，由一个先按 provider、再按协议、最后兜底的注册表来服务。网关监听器只接收无状态的推理 JSON 族。管理面走 CLI bridge、headless RPC 与进程内执行器三条腿，共用一个分发器，管理凭据永远不会进入 agent 子进程。"
---

# ADR 0163：一份 provider 操作契约

**Status:** Accepted  
**日期：** 2026-09-02  
**基于：** [ADR-0025](./0025-unified-subscription-module)、[ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)、[ADR-0145](./0145-python-plugin-runtime-alignment)

## 背景

在此之前，provider 面是五样互不知情的东西。聊天路径经 `lib/ai/provider-consumption.ts` 解析 provider 后直接调 AI SDK。订阅子系统（ADR-0025）自己维护余额适配器与额度源。设置界面靠一张手写能力表决定显示哪些按钮。CLI 只有 `/limits`。网关监听器给 Claude Code 与 Codex 提供聊天，又因为它是外部 agent 唯一认识的端口，不断有人提议把「列模型」「读余额」「铸 ticket」也放上去。

三个缺陷让漂移暴露出来。路由 ticket 可以指定一个网关随后绑不上的模型，于是 `cognia-agent x claude` 面对的是一个只会回 404 的监听器。Claude Code 每一轮都会调的 token 计数端点根本不存在，agent 的上下文仪表因此一片空白。而对大多数 provider 的大多数操作，答案都是 `unknown`，用户无从得知这是不支持、未配置，还是只是没试过。

## 决定

### 1. 一份契约，五十个操作，具名 schema

`protocol/provider-operations.json` 就是契约。每个操作一条描述符（id、分组、类型、风险、幂等性、计费门、作用域、执行面、远端暴露、PII 门、流式、有状态句柄规则），并具名指向其输入输出的 zod schema。schema 位于 `packages/provider-types/src/provider-operation-schemas.ts`，从 `@cognia/provider-types` 导出。它们就是线上的形状：handler 的输入输出类型是具名 schema 的 `z.infer`，测试用同一个 schema 解析每一个输出。没有 handler 的描述符过不了 `pnpm provider-ops:check`，契约里没有的 id 也一样过不了。

### 2. 先 provider、再协议、最后兜底的注册表

`lib/ai/operations/registry.ts` 把一个操作 id 绑定到一个 provider 匹配。解析时先扫 provider 钉死的注册，再扫协议范围的，最后是 `any`。分发器里没有任何 `switch (providerId)`，厂商中立门禁（`check:provider-name-branches`）会扫描该目录里的厂商名。厂商行为是按 provider id 键入的注册，协议行为是按线协议键入的注册。

执行器（`lib/ai/operations/executor.ts`）掌管任何 handler 都不得重新决定的事：作用域检查、执行面检查（描述符不含 `sidecar` 的操作拒绝在那里跑）、`outbound-text` 操作的 PII 门，以及失败分类。handler 拿到解析后的 provider、设置快照与校验过的请求，返回输出。

### 3. 支持度只能是 `native`、`translated`、`derived`、`plugin`，或带理由的 `unsupported`

对内置 provider 来说，`unknown` 不是诚实的终态。`@cognia/provider-core` 里的纯能力矩阵（`capability-matrix.ts`）根据厂商事实回答每个内置 provider 的每个操作。厂商的任务 API 与宿主所说的线协议形状不同时，`HOST_GAPS` 记下 `unsupported` 及其理由。`unknown` 只留给尚未探测过的自定义部署，并且必须携带探测失败与重试条件。门禁断言内置 provider 没有任何 `unknown` 格子，每个 `unsupported` 格子都有理由。

### 4. 网关监听器只做推理

网关监听器（`crates/cognia-gateway`）只接收无状态的 JSON 推理族：chat、count-tokens、models、embeddings、responses。它不列余额、不铸 ticket、不读能力、不传文件，也不提供任何携带账户状态的操作。

理由是结构性的，不是口味问题。监听器的端口会作为 base URL 交给 Claude Code 与 Codex，而 agent 子进程会执行任意工具调用。那个端口上能到达的东西，agent 就能到达，任何能读它环境变量的东西也能到达。把管理操作放在那个端口上，等于从「可以调模型」提权到「可以读账户」。因此路由 ticket 只限定推理族，推理族之外的操作在监听器上无论持何凭据一律 403。

每当某个新操作放在那里看起来很方便时，这条线就会被重新提起。答案每次都一样：监听器是 agent 的端口，管理面不属于 agent 的端口。

### 5. 管理面走已经在鉴权的平面，共用一个分发器

管理操作有三条腿、一个分发器：

- **桌面 bridge**（`src-tauri/src/cli_bridge`）：`X-Cognia-Dev-Token`，仅回环，允许清单（`provider_admin.rs`）里的每一项都必须证明自己是无需审批的低风险读操作。bridge 在 `/api/dev/provider-operations/manifest` 提供契约，CLI 据此对旧桌面按动词降级而不是整体报错。
- **headless**（`cognia-server`）：`POST /internal/_rpc/{name}`，携带服务令牌。
- **进程内**：执行器本身，CLI 用自己的配置跑它。

三条腿都经 `remote_execution::execute` 分发。没有第二个分发器，也没有第二份允许清单。两个网关平面都不得为宿主没有真正执行的操作伪造同步结果。

### 6. 管理凭据永远不进 agent 子进程

dev token 与服务令牌只发给签发它们的那个平面。`cognia-agent x` 只把一张路由 ticket（仅推理族、会话范围）写进 agent 的环境，别的什么都不写。没有任何动词会把管理凭据转交给 Claude 或 Codex，CLI 的传输层也没有可以这么做的路径。

### 7. 有状态资源钉在 provider 上，没有故障转移

文件、向量库、批处理、微调任务、视频与实时会话都活在同一个 provider、同一个部署、同一个账户、同一个凭据之内。`ProviderResourceHandle` 记下这四者加上凭据指纹。后续对句柄的操作钉住这四者，所有者不匹配的句柄一律拒绝。带有状态句柄的操作全部关闭 provider 故障转移与 key-pool 故障转移，因为资源在另一边并不存在。

### 8. CLI 与 TUI 是同一组模块

`cognia-agent provider <capabilities|models|balance|limits|usage|probe>` 与 TUI 的 `/provider …`、`/models`、`/balance` 都委托给 `cli/src/provider/*`。答案来自第一个在线的平面（bridge、然后 headless、然后本地），每个动词都有本地路径，CLI 从不需要桌面才能作答。会计费的读取必须显式 `--live`，探测另加 `--yes`，实时探测永不进 CI。

### 9. 插件通过一个新贡献点与三个投影点参与

`provider-operation-adapter` 是契约原生的贡献点。插件为某个 provider、某个协议或所有 provider 服务一个操作。注册表以 `support: "plugin"` 与 `via: "<pluginId>:<adapterId>"` 绑定 handler，并随插件一起卸下。契约之前就有的三个点（`balance-adapter`、`limits-source`、`protocol-adapter`）执行方式完全不变，只是被投影进矩阵成为插件格子。于是一个获得了插件余额适配器的 provider，其 `balance.read` 会显示为 `plugin`，厂商事实无需任何改动。

### 10. 快照按部署与账户分别缓存

操作画像与模型清单缓存在 Dexie（`providerOperationSnapshots`，schema v217），按部署与账户键入，因为换 key 或切组织都会改变 provider 列出的内容。模型清单只在账户引用相同且 TTL 未过时复用。

## 后果

- 新增一个操作意味着一条描述符、一对具名 schema、一次 handler 注册，以及每个内置 provider 的一个矩阵答案。门禁不接受更少。
- 新增一个 provider 意味着厂商事实，以及任务 API 与线协议不同时的一条带理由的 `HOST_GAPS`。它永远不意味着分发器里多一个分支。
- 监听器的操作集合是封闭的。扩大它需要新的 ADR，而不是新的路由。
- CLI 可以离线回答能力问题，并且答案不可能与面板不同，因为它们共用模块。
- 插件看到的就是宿主看到的那五十个 id。插件不能发明契约里没有的操作。

## 门禁

`pnpm provider-ops:check`（描述符与 handler 双向绑定、内置 provider 无 `unknown`、每个 `unsupported` 都有理由）、`pnpm check:provider-name-branches`、`cargo test -p cognia-gateway`、`lib/ai/operations/contract-parity.test.ts`，以及 `cli/src/provider` 与 `cli/src/tui/runtime/provider-controller.test.ts` 下的 CLI 测试。
