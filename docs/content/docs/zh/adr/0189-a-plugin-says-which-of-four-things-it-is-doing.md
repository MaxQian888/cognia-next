---
title: "0189 — 插件必须说明自己在做四件事中的哪一件"
description: "插件接入面此前对所有参与请求只有一种形状——hook 包上的一个函数——宿主因此分不清一个处理器是在观察、改写请求、否决它，还是包裹整次执行。四种语义（observe / transform / guard / around）统一到一个注册表、一套排序规则、一条存活规则和一个调度器，next 至多进入一次，失败策略按扩展点声明。修复了一个用户一次发送产生两次模型请求的 chat middleware 路径、一个忽略目标会话的插件写入，以及一个靠方法名猜测重试安全性的 transport。"
---

# ADR 0189 — 插件必须说明自己在做四件事中的哪一件

**Status:** Accepted — 已实现
**Date:** 2026-09-16
**Related:** [ADR-0026](./0026-plugin-extension-points-v2)（扩展点 v2、`ctx.chat.use`、`onBuildOptions`）、[ADR-0155](./0155-plugin-author-boundary)（SDK 作者边界）、[ADR-0145](./0145-python-plugin-runtime)（契约目录与其镜像）、[ADR-0020](./0020-computer-use)（三档权限模型）

## 背景

插件此前可以从三扇互不相干的门接入宿主管线：

- `activate()` 返回的 `PluginHooks` 包；
- `ctx.chat.use(...)`，around 风格的 chat middleware；
- 跨进程运行时用的 `before`/`after` 桥接对。

每扇门都有自己的存储、自己的排序规则，以及各自对「这个插件已被禁用」的理解。它们向宿主呈现的形状完全相同——一个函数——所以运行时无从知道某个处理器是在观察、改写、否决还是包裹。而这个区分恰恰决定了三件宿主必须做对的事：失败能否被吞掉、处理器能否并发、返回值能否顶替真实结果。

由此产生了三个确认缺陷。

**chat middleware 链可能把一次轮次发送两遍。** `runChatMiddlewareChain` 自己组装链路，在 middleware 超时或抛错时再次调用 `next(req)`：

```ts
const result = await raceWithTimeout(callMiddleware(), entry.timeoutMs)
if (result.kind === "timeout") { …; return next(req) }   // ← 第二次调用
if (result.kind === "error")   { …; return next(req) }   // ← 第二次调用
```

只有在 middleware 从未委派时这才正确。而常见写法恰恰是 `await next()` 之后做后处理——此时下游 terminal 为委派执行一次，再为「恢复」执行一次。middleware 自己调用两次 `next()` 会走同一条路径；**同步**抛错则完全逃出 `Promise.race`，因为 race 能捕获 rejection，捕获不了 promise 尚未产生时就抛出的异常。

**`ctx.chat.appendMessagePart` 忽略了显式目标会话。** 它读取 `options.sessionId`，却调用 `store.appendMessage(msg)`，而后者只写入当前有焦点的会话——插件向后台会话追加的消息，落在了用户正在阅读的那个会话里。

**transport 靠方法名猜测重试安全性。** `isIdempotentPluginApi` 用 `/:(get|list|read|stat|…|watch|…)/` 匹配，命中即视为可安全重试。两个方向都错：`managedIdeState:watch` 会**创建**订阅，超时后重试会留下两个；而契约里声明为非幂等的 `fs:stat`，仅因名字以读动词开头就白得一次重试。

还有一个更安静的问题。`PluginEventHooks.dispatchChatRequest` 让每个插件面对**同一个** `messages` 数组，再倒序扫描取最后一个成功结果——装了两个插件时，实际只有一个生效，而是哪一个取决于注册顺序。

## 决定

插件参与是五种机制，不是一种。其中四种是 *interceptor*；第五种（`contribution`）是既有的声明式注册路径，保持不变。

| 机制 | 回答的问题 | 执行语义 |
| --- | --- | --- |
| `observe` | 发生了什么？ | 不改变结果；异步、有界、可丢弃 |
| `transform` | 输入或投影应如何改变？ | 独立快照、返回新值、可重复、不得改变身份与授权 |
| `guard` | 是否允许继续？ | pass / deny / requireApproval；不能把上层的 deny 翻成 allow |
| `around` | 如何包裹一次执行？ | 有类型的输入输出、`next` 至多一次、显式错误与取消语义 |

### 一个注册表、一套排序、一条存活规则

所有接入面都归一化为 `InterceptorRegistration`（`lib/plugin/interceptors/normalize.ts`），落进同一个注册表（`lib/plugin/interceptors/registry.ts`）。旧的门继续开着——它们是作者侧的写法，不是第二套运行时。

排序分四级：**信任层级** → **before/after DAG** → **priority** → 稳定的 **registrationId**。信任层级来自安装来源（`Plugin.source`），绝不来自 manifest——能自报层级的插件只会报最高的那一档，而层级决定谁先看到并改写载荷。DAG 用 Kahn 算法，就绪队列按层级/优先级排序，因此在图未作约束的地方这个意图得以保留。悬空的 `after: ["not-installed"]` 或成环时，丢弃的是引发问题的**边**、保留全部注册，并给出诊断：一个作者的笔误不该让整个扩展点对其他插件停摆。

存活判定统一为 `isPluginHooksEnabled`，抽到两个注册表都能引用的叶子模块。缓存只覆盖纯排序；启用状态每次调度都重新读取——它在插件 store 里翻转，不会触碰这个注册表。

### 十条调度规则

`lib/plugin/interceptors/dispatch.ts` 强制执行：

1. 单次 invocation 中 `next` 至多进入一次；第二次调用直接 reject，下游操作**不**重跑。
2. 同步抛错与异步 rejection 走同一条捕获路径。
3. 只有在尚未委派且未提交任何副作用时，处理器才可被跳过。
4. 一旦开始委派，失败意味着等待**同一个**操作（或暴露它的错误），绝不另起一个。
5. 后处理失败绝不重新发起模型或工具调用。
6. 下游耗时与下游错误归属下游。把一次缓慢的模型调用记在每一层包裹者头上，正是三个健康插件同时熔断的成因。
7. 超时不等于取消成功：撤销该次能力，拒绝迟到的提交，同时不假装回滚了已在别处提交的工作。
8. transform 默认串行，除非扩展点声明其取值互不相交。
9. 重入按 operation 维度在调用图上检测。
10. 由扩展点的失败策略裁决；注册方只能**收窄**（`fail-open` → `fail-closed`），不能放宽。

失败记账是注入的而非自有的，所以 chat middleware 保留设置面板已订阅的三振熔断器，而不是多出一个与之打架的。

### 扩展点

声明在 `lib/plugin/contracts/plugin-points.ts` 的新 `kind: "interceptor"` 下，与其他扩展点契约并排——这样 `audit:slots`、生成的 `plugin-points.json` 镜像与文档看到的仍是同一份目录。

| 扩展点 | 语义 | 触发位置 |
| --- | --- | --- |
| `agent.context.prepare` | transform | `hooks-system.ts:dispatchBuildOptions` |
| `model.request.prepare` | transform | `chat-middleware/runner.ts` |
| `model.request.invoke` | around | `chat-middleware/runner.ts` |
| `tool.call.prepare` | transform | `invoke-plugin-tool.ts` |
| `tool.execute` | around | `invoke-plugin-tool.ts` |
| `tool.result.project` | transform | `hooks-system.ts:dispatchPostToolUse` |
| `ui.action.invoke` | guard | `commands/registry.ts:executeCommand` |
| `operation.completed` | observe | `interceptors/dispatch.ts` |
| `model.stream.transform` | transform | **virtual** |
| `agent.turn.decide` | guard | **virtual** |
| `ui.surface.project` | transform | **virtual** |

三个 virtual 扩展点被如实标注，而不是作为「调了也没反应」的 API 发布：

- `model.stream.transform` —— `dispatchStreamChunk` 是同步的且调用方丢弃返回值，改写后的分块无处可去。把它变成 transform 是改流式契约，不是改这份目录。
- `agent.turn.decide` —— 轮次循环在 sidecar 内部，宿主侧没有可拦截的继续/停止决策。
- `ui.surface.project` —— surface 投影在同步渲染内运行，无法承载其他扩展点都依赖的截止时间与撤销语义。以更弱的契约发布它，会让「失败策略说了算」这句话恰恰在插件离用户最近的地方失效。

### 哪些旧 hook 被归一化

`onChatRequest`、`onBuildOptions`、`onPostToolUse` 本身就是 interceptor 形状，成为 transform 注册。`onPreToolUse` **不**归一化：它的形状是 allow/deny/modify——guard 与 transform 的融合体——塞进 transform 链会让后面的插件把前面插件的 `deny` 翻回 `allow`。它保留「首个非 allow 胜出」的调度器；`tool.execute` 是它有类型的继任者。

### 契约驱动的重试

`isIdempotentPluginApi` 按 transport 实际看到的顺序查声明：先查 `packages/plugin-sdk/contract/catalog.json` 中新增的 `wireOps` 数组（网关逐字收到的宿主代理操作，如 `window:getSize`、`db:commit`），再查与作者侧方法一一对应的 ctx 方法目录。**未声明**的操作不重试；调用方的 `idempotent` 提示只能收窄——安全分类属于方法的所有者，不属于恰好在调用它的人。

### 作者写法

```ts
import { defineInterceptors } from "@cognia/plugin-sdk"

export function activate(ctx: PluginContext) {
  return defineInterceptors([
    {
      point: "tool.result.project",
      after: ["@cognia/redact"],
      failurePolicy: "fail-closed",
      handler: (value) => ({ ...value, projection: redact(value.projection) }),
    },
  ])
}
```

这个 helper 是纯的——它构造描述并返回。注册发生在宿主读取 `activate()` 返回值时，因此绑定到激活租约（plugin id、generation、realm、信任层级），而不是绑定到某个模块恰好被 import 的时刻。调用即注册的 helper 会让插件在热重载后处于半活状态，上一代际的闭包仍留在链上。

`activate()` 可以返回历史的 hook 包、`defineInterceptors` 的结果，或同时携带两者的一个对象。

## 影响

**行为变化。**

- 委派之后失败的 chat middleware 不再造成第二次模型请求。也不再造成第二次**任何**事情——下游操作是被等待，而不是被重跑。
- `next()` 现在转发 middleware 手上的那个请求，所以请求改写真正生效。旧 runner 始终转发原始请求。
- `onChatRequest` 与 `onPostToolUse` 成为管线：每个插件看到前一个的输出。前面插件做的脱敏对后面的插件可见，后者也无法靠返回收到的原值把它撤销。
- `appendMessagePart` 写入目标会话；目标不存在时返回 `null`，而不是凭空播种一个幽灵会话。
- 未声明的 wire op 不再重试。在用的 25 个宿主代理操作已在 `wireOps` 中声明；新增的必须声明才能拿回重试，transport 会对每个缺口告警一次。

**失败策略按扩展点声明，旧 hook 支撑的扩展点保持原有行为。** `agent.context.prepare`、`model.request.prepare`、`model.request.invoke` 与 `tool.result.project` 为 `fail-open`，与今天的 `onBuildOptions` / `onChatRequest` / `onPostToolUse` 一致——归一化旧 hook 包不该让按旧行为编写的插件突然开始阻断输出。脱敏类 interceptor（崩溃绝不能读作「没什么要脱敏的」的那种场景）把自己的注册收窄为 `fail-closed`，宿主予以尊重，插件永远无法再放宽回去。`tool.execute` 与 `ui.action.invoke` 是全新的，从一开始就是 `fail-closed`。

**明确不在范围内。** 不做 `CompositionPlan`、不扩大 service realm override、不做 MCP Apps 适配层、不做统一长任务句柄。

vNext 设计中另外三个拟议契约字段同样缺席，且是有意为之而非遗漏：`inputSchema` / `outputSchema` / `schemaRevision`（运行时 wire 校验）、`requiredResourceGrant`、`streaming`。每一个背后都需要一套机制——780 余个方法的 JSON Schema、资源授予账本、分块协议——只声明字段而不落地机制，产出的是无人读取的元数据，正是这个扩展点目录本身要防止的「建好即休眠」模式。它们应与实现它们的工作一起交付。

**代价。** hook 与其处理器之间多了一层模块，以及两个纯粹为打断循环依赖而抽出的叶子模块（`plugin-liveness.ts`、`hook-telemetry.ts`）。
