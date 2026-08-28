---
title: "0156 — 每一个内置插件都按第三方插件对待"
description: "52 个一方插件全部只依赖 @cognia/plugin-sdk 编译；SDK 里早已写好却接不上的能力注册表以子路径发布；一份只允许缩短的基线保证这条边界不再被重新打开。"
---

# ADR 0156 — 每一个内置插件都按第三方插件对待

**Status:** Accepted
**Date:** 2026-08-28
**Related:** [ADR-0026](./0026-plugin-marketplace-integrations), [ADR-0030](./0030-character-packs), [ADR-0145](./0145-python-plugin-runtime-alignment), [ADR-0155](./0155-plugins-reach-the-host-through-one-door)

## 背景

[ADR-0155](./0155-plugins-reach-the-host-through-one-door) 关掉了宿主专门为
Deep Research 开的那扇私门。同样的毛病遍布其余插件：52 个内置插件里有 46 个直接
import 宿主私有模块——`@/lib/**`、`@/stores/**`、`@/types/**`、`@/components/**`
——合计约 530 处。

`pnpm plugin:author-imports` 早就存在，但只管三个模板加一个参考插件。其余全在门禁
之外，于是「一方插件」实际上等于「放在 `plugins/` 里、享有宿主权限的代码」，插件
API 的真实形状变成了「宿主碰巧暴露了什么」。

有两个发现决定了修法。

**SDK 里大部分答案早就写好了，只是没接上。** `packages/plugin-sdk/src/api/` 下有
63 个精心整理过的能力模块——角色包注册表、子智能体注册表、外部智能体协议适配器、
OCR provider 注册表——其中只有 5 个可达。其余是「建好但从未接线」：一个插件想在
激活时注册角色包，没有任何已发布路径可用，只能去 import
`@/lib/plugin/registries/character-pack-registry`。

**SDK 真正缺的地方，缺的都是承重件。** 不是可有可无的空缺：
`defineMessageRenderer` 能注册一个渲染器，却没有任何办法把带该 part 的消息送进
会话；`ctx.sessions.getCurrentSessionId()` 在生产里对每个插件都返回 `null`，因为
它读的那个 store 只在一个从未被调用的 `load()` 里才会被填充；驱动 computer-use 的
插件读不到用户的 computer-use 策略；sandbox 消费者无法在执行前询问会话是否被限制。

## 决策

**1. 根出口只放类型与纯函数，注册表一律走子路径。**
`packages/plugin-sdk/src/index.test.ts` 早已钉死「注册表函数不得出现在包根」，这个
判断是对的：import 一个注册表应当是作者写下来的决定，而不是随
`import { definePlugin }` 一起到货的东西。于是 63 个 api 模块以
`@cognia/plugin-sdk/api/<capability>` 显式清单（不用通配）发布，根出口只增加类型和
纯函数。

**2. `unregisterXxxByPlugin(pluginId)` 才是拆卸方式——停用时如此，测试里也如此。**
插件测试此前调用宿主的 `__resetXxxForTesting`：那不在作者面上，而且会连带清掉本插件
从未注册过的贡献。每个注册表本来就有按插件作用域的那一半。

**3. 插件确实缺东西时，长出契约的是 SDK，而不是插件里的绕行。** 新增 14 个面，每一个
都由某个「否则写不出来」的具体插件驱动：`host-environment`（我在哪个壳里、用户在哪个
目录工作）、`sandbox`、`skill-recorder`、`browser`、`i18n`、`security-findings`、
`eval`、`resources`、`agent-turn`（无头角色回合与带种子的新会话）、`workflow-editor`、
`workflow-run`、`slash-command`、`tool-renderer`，以及仅测试用的 `testing`。

其中三处替换掉的是**重复实现**而非空缺：「用户在哪个目录工作」被实现了两遍——一次内联
在 CLI 工具执行器里，一次原样抄进 `workspace-tools`；「谁在驱动这一轮」——它决定谁有
资格点下审批按钮——被推导在 `workflow-ai` 内部；无头角色回合则由五个宿主模块拼装，其中
一个会把整份 settings 行交给插件。

**4. 门禁改为按「只允许缩短的基线」治理全部插件。** 回退的插件会失败；已经清干净却
仍留在名单上的插件**也**失败，这样这份记录不可能夸大剩余工作量。基线现已为空。门禁把
`jest.mock()` 等同视为模块引用——一个从 SDK import、却去 mock `@/lib/...` 的测试仍然
钉在宿主路径上；同时忽略注释与随包分发的作者类型产物，这两类此前都是误报。

**5. 放在插件目录里的宿主测试，本质仍是宿主测试。** `sre-agent` 带着一份会启动真实
`PluginManager`、驱动签名校验器与权限守卫的用例。第三方插件根本写不出这种测试——这恰恰
就是它让宿主私有 import 一直活着的原因。该文件已移入 `lib/plugin/core/`。

## 影响

- 52 个内置插件全部只依赖 `@cognia/plugin-sdk` 与 `@cognia/plugin-ui` 编译。每一个
  都成了第三方真能照抄的范例——这也是让已发布面保持诚实的唯一办法。
- 迁移途中顺带修好四个潜伏缺陷，因为迁移逼着人去问「受支持的调用到底是哪个」：生产环境
  下 `ctx.sessions` 恒返回 `null`；`defineMessageRenderer` 无法产出自己的 part；
  `web-tools` 还在 mock 一个它早已不读的 settings store；某个插件测试的
  `@/lib/platform/detect` mock 越过插件影响到宿主 keyring。
- 对第三方开放的面明显变大。这是有意为之——它现在被写下来、被测试、被版本化，而此前同样
  的触达只对一方代码开放、对其他人完全不开放——但每一个子路径从此都是兼容性承诺。
- `ctx.chat.appendMessagePart` 沿用该 chat API 现有惯例：在文档里写明需要
  `session:write`，而不在运行时强制；该 API 上另外三个写方法同样如此。给 chat API 加
  守卫是另一件事。
