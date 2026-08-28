---
title: "0155 — 插件只从同一扇门进入宿主"
description: "以「作者可调用的宿主工具」、按会话解析的运行时、以及结构化命令结果，取代那套让唯一一个内置插件才能搜索、阅读与推理的私有依赖注入。"
---

# ADR 0155 — 插件只从同一扇门进入宿主

**Status:** Accepted
**Date:** 2026-08-28
**Related:** [ADR-0026](./0026-plugin-marketplace-integrations), [ADR-0060](./0060-web-reader), [ADR-0090](./0090-unified-agent-execution), [ADR-0100](./0100-unified-template-platform), [ADR-0145](./0145-python-plugin-runtime-alignment)

## 背景

Deep Research 名义上是插件，实际上是宿主在替它兜底：

- `lib/claude/plugin-tool-ipc.ts` 用 `request.name === "deep_research"` 分支，
  把解析好的 web 绑定和一个模型桥塞进 `PluginToolContext.hostContext`。
- CLI 专门有一个 `deep-research-ai-bridge.ts`，唯一职责就是替这一个插件从 CLI
  配置里构造模型客户端——为此它还得反过来 import 插件内部的 `AiBridge` 类型。
- 插件本身直接 import `@/lib/search/configured-search`、`@/lib/web/web-tools-core`、
  `@/lib/claude/web-builtin-tools`、`@/stores/settings` 与 `@/types/plugin`，
  并且要靠 `as unknown as` 才能拿到 `ctx.ai`——因为公共 context 类型根本不承认它存在。

这些都是同一个缺陷的不同外衣：一个研究型插件真正需要的能力——用户配置的搜索
提供方、带 SSRF 防护的页面阅读器、一个模型——没有公共入口，于是宿主替自带的
那个插件私开了一道门。第三方插件写不出这样的代码，也就意味着当时那套东西
算不上「插件 API」。

代价并不假设性。CLI 之所以需要自己的桥，正是因为公共 API 把一切都解析到渲染端
Zustand store，而 CLI 进程永远不会 hydrate 它；又因为多个 CLI 会话共享同一个进程、
各自持有不同的 provider 与 key，那里的「环境查找」不只是取不到值，而是可能记错账。

## 决策

**1. 一部分宿主工具按名字对作者开放，名单固定。**

`ctx.agent.invokeTool` 会把 `web_search` 与 `web_fetch`——且仅此两个——解析到宿主
自己的 promoted web 内置工具，且优先于调用方插件自己的同名工具。插件因此直接
获得用户配置的搜索提供方、共享结果缓存、来源可信度校验、PII 脱敏、SSRF 防护与
出站限流，因为它跑的就是主 agent 跑的那份代码。

这是白名单，不是过滤器。`dispatch_agent`、`ask_user`、会话控制与 working-set 类
工具仍然是宿主私有；不在名单上的名字会以 `not-author-callable` 被拒绝，而不是
落到内部分发器上。跨插件调用同样无法从 `invokeTool` 抵达：想调用别的插件的工具，
必须声明依赖并使用 `invokeDependencyTool`。

**2. 宿主按调用解析运行时；会话制宿主必须 fail closed。**

`PluginHostRuntime` 回答三个问题——用哪套 web 策略、用哪个模型、默认值是什么——
由 `resolvePluginHostRuntime({pluginId, sessionId})` 选出答案。渲染端、Tauri 与
移动端共用同一个由 settings store 支撑的 ambient 运行时；CLI 则按会话注册，并关闭
ambient 解析，因此一个没带 sessionId、或带了未绑定 sessionId 的调用会直接抛错，
而不是去读一个空 store，或借用另一个会话的凭据。

这正是 `AIChatOptions`、`AIEmbedOptions` 与 `PluginInvocationOptions` 都带
`sessionId` 的原因：在多会话宿主上它不是元数据，它是地址。

**3. PII 闸门在运行时接缝之上，而不是之内。**

`ctx.ai.chat` / `ctx.ai.embed` 先执行 `assertNoLeakingPii`，再解析运行时。任何
运行时——现在的还是将来的、渲染端还是 CLI——都不可能成为「忘了脱敏」的那一个。

**4. 命令可以用自己的内容作答。**

`onCommand` 可返回 `{handled, message?, payload?}`。宿主把 `message` 原样写入发起
命令的会话，把 `payload` 交给程序化调用方。返回 `true` 仍表示「已处理，用你的
通用文案」，返回 `false` / `{handled:false}` 仍表示放弃，让下一个 handler 继续。
调用方的 `{sessionId, characterId}` 会交给插件——一个要调模型的命令必须记在用户
真正所处的那个会话上。

在此之前，所有插件命令都只会答「Command handled by plugin」，于是一个「输出即答案」
的命令只能把多页带引用的报告塞进 toast 里偷渡出来。

**5. 错误是分类的，不是字符串。**

宿主工具以 `{ok: false, code, error}` 返回，`code` 取自固定的
`PluginHostToolErrorCode` 词表——`web-disabled`、`no-search-provider`、
`rate-limited`、`blocked`、`not-author-callable`、`invalid-arguments`、
`execution-failed`。SSRF 拒绝按错误**类型**（`FetchTargetBlockedError`）分类，
而不是匹配文案，因此改写措辞不会让分类失效。

## 影响

Deep Research 现在只 import `@cognia/plugin-sdk` 与相对路径，并与作者模板一起被
`pnpm plugin:author-imports` 门禁看住。`pnpm sdk:ts:pack:test` 还会在一个没有
`@/*` 别名的目录里，用**打包后**的 SDK 对它的源码做类型检查——import 门禁只能看见
文件写了什么，而这一步证明发布出去的类型确实带得动一个插件真正需要的东西。

宿主这边删掉了 `PluginToolContext.hostContext`、`deep_research` 注入分支、
`resolveDeepResearchAiBridge`，以及 CLI 的 `deep-research-ai-bridge` 模块。仍然
提到该插件名字的只剩 `build-options.ts` 里一处能力过滤：用户关闭联网工具时隐藏
依赖联网的工具。它不注入任何东西，是策略判断而非依赖。

Deep Research 也不再自带 Exa/Tavily provider 与密钥。已持久化的旧值保留不删，
以便回滚；只是永远不再读取。

契约版本升到 1.1.0，TypeScript SDK 升到 0.2.0。wire protocol 保持 2.0.0——跨进程
形状没有任何变化——`minimumSdkVersion` 保持 0.1.0，因为按旧 boolean `onCommand`
和无参 `ai.embed` 写的插件仍然能编译，且行为与从前完全一致。

### 本次不做什么

不开放宿主内部工具面，不新增 `ctx.web` 命名空间，不改动研究引擎的算法与报告
格式，不引入迁移，也不涉及插件市场的签名、发布与安装。它只证明一件事：一个
真实、非平凡的插件，可以仅凭公共 SDK 编译并运行。
