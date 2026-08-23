---
title: "0142 — Agent SDK 是两个产品，不是一个"
description: "@cognia/agent 拆成两层：v0.1 运行时客户端必须先把回放、背压、重连和附件这几件事做对；v0.2 编排层的 Agent 定义不可变、由 Host 持久化，并在建会话时冻结进 session。客户端按 Apache-2.0 发布，Host 保持 AGPL。"
---

# ADR 0142 — Agent SDK 是两个产品，不是一个

**状态：** 已接受
**日期：** 2026-08-23
**取代：** `docs/plans/2026-08-11-rpc-first-agent-sdk-productization.md`
**相关：** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)、[ADR-0117](./0117-composed-agent-modes-and-creator)、[ADR-0125](./0125-durable-work-submission)

## 背景

`packages/agent` 是一个带类型的 JSON-RPC 客户端。它对话的 Host 是 `cli/` —— 即
`cognia-agent rpc`，服务实现在 `cli/src/agent/rpc/runtime-service.ts`，分帧实现在
`cli/src/agent/rpc/server.ts`。三个 `packages/agent-host-*` 按平台携带构建好的 Host
二进制，客户端把它们当作 optional dependency 解析。

这条边界是对的，本 ADR 不重新讨论它。2026-08-11 那份计划错在把"边界已经存在"当成
"产品离发布只差一步"。把已落地的代码对着那份计划读一遍，会发现两个被当成同一件事
在解决、实际上互相独立的问题。

**运行时客户端还不正确。** 不是"不完整"，是"不正确"——而且是第三方接入第一天就会
撞上的那种：

- `SessionEventChannel` 每个 session 只有**一个**队列，而每个 `events()` 迭代器都
  从这同一个队列 `shift()`。两个订阅者不是各自看到完整事件流，而是把它瓜分掉。计划
  自己写的验收标准（"两个订阅者获得相同序列"）在当前实现上就是不通过的。
- `events({ afterEventId })` 发起 `entries()` 却不 await，直接把回放页推进那个正在
  接收实时 `agent/event` 通知的同一个通道。历史与实时事件按到达顺序交错，而不是按
  事件顺序。
- 那个队列没有上限。一个停止消费的订阅者会让客户端堆内存一直涨到进程死掉，而且没有
  任何游标可供恢复。
- `traces.subscribe()` 只返回一个 `AsyncIterable`。协议里根本没有 `trace/unsubscribe`，
  所以 Host 的 `traceSubscriptions` 只有在 emit 抛错时才会缩小。
- Host 把每一次客户端 hook 调用都归属给
  `[...sessions.values()].find(candidate => candidate.busy)` —— **第一个** busy 的
  session。两个 session 并发时，hook payload 上的 `sessionId`、`runId`、`attemptId`
  全是错的。
- `session/tree(sessionId)` 忽略入参，直接返回 `store.tree()`，也就是整片森林。
- `AgentInput` 接受带 `path` 和 `data` 的 `attachments`。Host 侧没有任何代码读它们。
  收下了，然后丢掉。
- `initialize` 发送写死的 `version: "0.1.0"`，而响应里协商出来的 `limits` 只是挂在
  `runtime.info` 上，客户端从不执行。
- 没有重连。Host 崩溃就等于客户端结束。
- README 的第一个示例在调用 `session.run()` 之前就把 `session.events()` 迭代到底。
  它不可能终止。

**编排能力根本不存在。** `sessions.create({ model, cwd })` 就是全部配置面。没有办法
给一个 agent 命名、给它版本、或者让 session 钉住它启动时所依据的定义。每个接入方都
会在一个 session 工厂之上自己造一套，而且各造各的。

这是两个风险不同的产品。把它们合成一个 "1.0"，意味着正确性工作要等持久化设计，而
持久化设计又要在一个事件投递本身就是错的客户端上做验证。

## 决策

### 1. 两层，分开发布

**v0.1 是运行时客户端。** 它的全部职责是：一个第三方 Node 进程能安装这个包、拉起
Host、跑完 turn、消费事件、在 Host 崩溃后活下来、然后干净关闭 —— 在 macOS arm64、
Linux x64、Windows x64 三个平台上都如此。不引入任何新的编排概念。上面「背景」里列出
的每一条都是 v0.1 的阻塞项。

**v0.2 是编排 SDK。** 它加上由 Host 持久化的、不可变的、带版本的 Agent 定义，带类型
的客户端工具，以及结构化输出。它是纯增量的：v0.2 的 Host 原样服务 v0.1 的客户端，
`sessions.create({ model, cwd })` 通过映射到一个隐式标准定义继续工作。

Phase 4 的能力 —— asset references、真实 tracing、evals、workspace checkpoint ——
是增量的，不阻塞任何一次发布。

### 2. 运行是非阻塞的；交互是事件，不是状态

`session.run()` 保留为阻塞式便捷接口。在它旁边：

```ts
const run = await session.start(input, options)
for await (const event of run.events()) { /* … */ }
const outcome = await run.result
```

`AgentRunHandle` 暴露 `events()`、`result`、`abort(reason?)`，以及当前的
`commandId` / `sessionId` / 最后确认的 event 游标。

`AgentTurnOutcome` 只承载**终态**。现有的 `requires_action` 变体被移除：一个正在等待
permission 或 elicitation 的 turn 并没有结束，把它建模成一个 outcome 等于逼每个调用方
去重进一个本该由 SDK 自己拥有的循环。等待通过 run 事件流上的类型化事件表达。

### 3. 回放以游标为界，且排在实时之前

接入事件流时先拿到 Host 的 `headEventId`，分页回放历史直到恰好这个游标，期间缓冲实时
通知，按 event ID 去重，然后才切到实时投递。不交错，不留缺口。

### 4. 每个订阅者拥有自己的有界队列

每次 `events()` 调用拿到自己的队列，默认容量 1024。溢出只关闭**该订阅者**，抛出带最后
游标的 `BackpressureError`，调用方可以据此主动恢复。一个慢消费者永远不会卡住 session，
也不会让堆无界增长。

### 5. 未知结果只上报，绝不重试

结果未送达的命令以 `IndeterminateCommandError` 上报，并带上它的 `commandId`。SDK 绝不
自动重发。调用方可以用同一个 command ID 查询或重试，此时 Host 已有的 receipt 表让这次
重试是幂等的。自动重放一个可能已经执行过的副作用，不会是这个 SDK 的行为。

重连本身对 `bundled` 和 `path` 类型的 Host 支持（最多 5 次指数退避），对 `stream` 类型
只在调用方提供了能重建传输的 `factory` 时才支持。重连后客户端重新协商、重新注册
tools 与 hooks、重新打开 session handle 与 trace 订阅，并从游标回放事件。

### 6. Capability 细粒度、带版本、由 backend 实际支持情况推导

现在的 `SERVICE_CAPABILITIES` 是一串无条件声明的、十六个裸字符串组成的平坦集合。客户端
无法判断 `sandbox-policy-snapshots` 指的是真正的文件系统 checkpoint 还是一条策略记录。
Capability 改为带版本的标识符，且只在 backend 真的支持时才声明。

### 7. 附件是被拒绝，不是被丢弃

在 asset references 落地（Phase 4）之前，携带旧式 `data`、base64 或 `path` 附件的 turn
以 `invalid_params` 失败。静默丢弃用户输入比拒绝它更糟。

### 8. Agent 定义不可变、由 Host 持久化、并冻结进 session

```ts
interface AgentDefinitionV1 {
  schemaVersion: 1
  agentId: string
  version: number
  name: string
  description?: string
  composition: AgentCompositionSelectionV1
  instructions?: { append: string }
  runtimeBindingRef?: string
  toolRefs: AgentToolReference[]
  output?: JsonSchemaContract
  metadata?: Record<string, string | number | boolean>
  definitionDigest: string
}
```

约束本身就是决策：

- `instructions` 只**追加**到解析后的 preset。它不能替换系统策略，因为 Host 的治理正是
  骑在那条策略上的。
- 定义引用 Host 的凭据与运行时绑定。它从不保存 provider key 或任何 secret。
- 版本不可变。更新是针对 `expectedVersion` 的 compare-and-swap，写出 `N+1`。
- 归档是逻辑归档。任何被 session 引用过的版本永远可读。
- `session/create({ agent: { agentId, version? } })` 只在创建时解析一次 `latest`，随后把
  精确版本、definition digest、composition digest 和 execution fingerprint 冻结进 session
  manifest。已存在的 session 永不跟随后来的定义更新。

Resolver 把定义 lower 到既有的 composition resolver 和统一 execution spec 上。不引入任何
平行的 authority、model 或 tool 配置体系。

### 9. 工具：契约在 Host，handler 在客户端

`defineTool()` 从 Valibot schema 推导 input/output 类型并转换成 JSON Schema。保留 raw
JSON Schema 逃生口，其类型为 `unknown`。

定义只保存工具契约和 schema digest —— 从不保存 handler 代码。客户端在每次连接与重连时
注册 handler。Host 在调用模型之前检查 handler 存在且 digest 一致。input 与 output 在
双侧校验；handler 缺失、digest 不匹配、输出非法，都是类型化错误，而不是静默降级。

### 10. 许可证在进程边界上分开

`@cognia/agent` 按 **Apache-2.0** 发布。Host、CLI 和 runtime packages 保持
**AGPL-3.0-only**。客户端 tarball 不得包含 AGPL runtime 源码，也不得静态链接它 —— 二者
只通过 RPC 传输通信，这恰恰就是当初把边界画在那里的原因。

## 后果

客户端的事件层是重写而不是打补丁：每订阅者队列、回放游标、重连状态机是同一个设计，不是
三个独立修复。

Host 获得了它此前没有的边界 —— callback receipt、trace 订阅、open session、active turn、
replay 页数上的 TTL 与上限 —— 并且这些上限会变成可观测的拒绝，而不是无界增长的 Map。

移除 `requires_action` 是对 `AgentTurnOutcome` 的破坏性变更。它被放在 0.1.0 发布之前做，
正是为了不必在发布之后再做。

许可证变更要求客户端持续"配得上"它的 transport-only 身份。任何未来把 runtime 源码拉进
`packages/agent` 的便利做法都会悄悄改变它的许可证，所以 Apache 边界是对客户端**允许包含
什么**的约束，而不只是 `package.json` 里的一个字段。

## 非目标

Pi 兼容的 API 或 wire protocol。浏览器或 Edge 内嵌 runtime。新的 DAG / workflow engine。
客户端持有 provider 凭据。对结果未知的副作用命令自动重试。上传任意可执行 extension。
Realtime voice 或托管服务。在 TypeScript 契约稳定之前做其他语言的 SDK。用 sandbox policy
snapshot 冒充文件系统 checkpoint。
