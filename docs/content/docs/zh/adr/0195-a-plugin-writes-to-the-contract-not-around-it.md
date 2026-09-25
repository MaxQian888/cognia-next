---
title: "0195 — 插件照着契约写，而不是绕开契约"
description: "逐个审查 66 个树内插件后发现，同样的变通写法在一个又一个插件里重复：分叉的 SDK 注册表、手写的翻译 hook、为绕过未映射的上下文方法而做的类型断言、移动端静默无效的操作。每一处都是宿主 API 的缺口。本 ADR 在契约层补齐它们：所有 SDK 子路径都是共享模块，契约目录双向校验，缺失的接缝（导航、插件翻译、实时查询、测试上下文、宿主网页克隆工具、本地化的清单名称、插槽上下文）成为公开 API。"
---

# ADR 0195 — 插件照着契约写，而不是绕开契约

**状态：** 已接受 — 已实现
**日期：** 2026-09-25
**相关：** [ADR-0155](./0155-plugins-reach-the-host-through-one-door) 与 [ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin)（本 ADR 补全的作者边界）、[ADR-0145](./0145-python-plugin-runtime-alignment)（契约目录）、[ADR-0189](./0189-a-plugin-says-which-of-four-things-it-is-doing)（拦截器）、[ADR-0026](./0026-plugin-extension-point-expansion)（扩展插槽）

## 背景

ADR-0156 让每个树内插件只导入公开 SDK，这一点守住了：作者导入检查是绿的。但在桌面端和 375 px 移动端宽度下逐个审查全部 66 个插件后，能看到公开 API 不够用时作者是怎么做的——他们绕开它，而且同一种绕法会在好几个插件里重复出现：

- **分叉的注册表。** 只有少数 SDK 子路径是共享模块。插件导入其他子路径时会打包自己的一份副本，于是 `registerX()` 写进了宿主从不读取的注册表。
- **未映射的上下文方法。** 受治理的上下文对 `catalog.json` 中没有的方法一律抛出 `unmapped`。`PluginContext` 暴露的 37 个方法（产物版本、`chat.appendMessagePart`、`i18n.getLocale`、`integrations.*` 系列等）不在目录中。插件用 `as never`、`ctx.x?.` 绕过类型，结果在运行时失败。
- **私有的翻译 hook。** 好几个插件各自带了一份基于 `ctx.i18n.t` 的 `use-plugin-t.ts`，手动拼 `plugin.<id>.` 前缀，切换语言也不重新渲染。清单里的插件名称则根本没有本地化的途径。
- **框架导入。** 插件用 `next/navigation` 做路由、用 `dexie-react-hooks` 做实时读取。Python、WASM 或已安装的包都拿不到这两个模块，而且它们会把插件绑死在某一个宿主上。
- **移动端静默无效。** `ctx.files.save` 在 Capacitor WebView 里什么也没写，却依然报告成功。
- **过时或越界的语义。** `ctx.config` 是激活时的快照。所有插件的上下文提供方会在每个插件的智能体里运行。`deactivate()` 拿不到上下文，无法干净地注销。`onConnectorInbound` / `onConnectorOutbound` 钩子不需要任何连接器权限就能运行。

逐个在插件里修补，下一位作者仍会碰到同样缺失的接缝。

## 决定

### 1. 每个已发布的 SDK 子路径都是共享模块

`lib/plugin/core/sdk-subpath-loaders.ts` 把 `@cognia/plugin-sdk` 的 `exports` 中每一项（`./testing` 除外）映射到一个惰性的宿主加载器。`primeSharedModulesFor(code)` 只预热某个包实际导入的子路径。浏览器内置插件构建器和 CLI 前端构建器都把 `@cognia/plugin-sdk/*` 设为外部依赖，因此已安装的插件与宿主解析到同一个模块实例。

### 2. 契约目录双向校验

`catalog.json` 补上缺失的 37 行和 `ui.navigate`（共 836 个方法契约）。`lib/plugin/core/context.test.ts` 中新增的反向一致性测试遍历完整挂载的上下文，只要有目录未列出的可调用方法就失败。方法不会再出现"类型上可达、运行时 `unmapped`"的情况。

### 3. 缺失的接缝成为公开 API

| 需求               | 契约                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 跳转到应用页面     | `ctx.ui.navigate(href)`：只接受应用内链接（`isInAppHref`），由 `plugin-runtime-initializer` 交给宿主路由                               |
| 翻译插件文案       | `@cognia/plugin-sdk/api/i18n` 的 `usePluginTranslations(pluginId)`：自动加前缀，切换语言时重新渲染                                     |
| 本地化插件名称     | `manifest.nameKey` / `descriptionKey`（以及用于 `/` 选择器的 `commands[].descriptionKey`），由 `lib/plugin/i18n/manifest-text.ts` 从插件自己的 `i18n.locales` 解析，用于插件库、详情与权限提示 |
| 实时读取           | `@cognia/plugin-ui` 重新导出的 `useLiveQuery`                                                                                          |
| 测试插件           | `@cognia/plugin-sdk/testing` 的 `createTestPluginContext()`：完整挂载、记录调用的假上下文                                              |
| 检查兼容性         | `@cognia/plugin-sdk/manifest` 的 `evaluatePluginCompatibility`                                                                          |
| 克隆网页           | `web_clone` 与 `web_search` / `web_fetch` 并列为作者可调用的宿主工具，按工具在 `PLUGIN_HOST_TOOL_PERMISSIONS` 中声明权限，并走同一出站检查 |
| 保留多行命令参数   | `PluginCommandContext.rawArgs`，同样转发给 Python 命令                                                                                 |
| 知道插槽渲染在哪里 | `ExtensionProps.context`；`chat.input.effort` 插槽传入 `ChatInputEffortSlotContext {sessionId, disabled, compact}`                     |

作者导入检查新增一条规则：插件的运行时代码不得导入 `next`、`next-intl`、`dexie`、`dexie-react-hooks`、`@tauri-apps/*` 或 `@capacitor/*`。仅类型导入和测试文件除外。

### 4. 现有契约如实报告自己做了什么

- `ctx.files.save` 在 Capacitor 上走移动端导出路径，并返回 `{ saved, platform, location }`，插件可以告诉用户文件去了哪里。
- `ctx.config` 是读取插件存储的 getter：设置改动在下一次读取时即可见，无需重新激活。
- 上下文提供方按所属插件解析（`resolveContextContributions(input, pluginId)`）。
- `deactivate(context)` 会收到插件的上下文；没有上下文可给时，管理器跳过这次 deactivate。
- 声明 `onConnectorInbound` 需要 `connectors:read`，声明 `onConnectorOutbound` 需要 `connectors:send`，否则校验拒绝该钩子。
- Computer Use 保留调用来源的沙箱运行时（`sandboxRuntimeRef`），不再按会话重新解析。

### 5. 插件贡献的技能可以被选中

插件注册的技能出现在聊天技能选择器（"来自插件"分组）、`@` 提及和有效技能解析中，角色也可以固定它们（`pluginSkillIds`）。此前它们虽然已注册，却没有任何界面能选中。

### 6. 所有树内插件完成迁移

全部 66 个插件改用 `definePlugin` + `definePluginManifest` + `definePluginTool`，不再有 `as never` 断言。会写入或发送的工具带 `requiresApproval`，接收路径的工具声明 `access` + `pathParams`，耗时工具设置 `timeoutMs`。文案放在插件自己的语言包里，包括 `nameKey` / `descriptionKey`。`runtimeCompatibility` 如实声明。演示插件、主题包和 `cognia-laya-guard` 改为手动启用的内置插件，新安装时不会擅自启动。

## 被否决的方案

- **逐个在插件里修。** 每种变通写法都已经重复出现；一个个修，缺口仍留给下一位第三方作者。
- **允许插件直接导入 `next/navigation` 和 `dexie-react-hooks`。** 只对某一个宿主上的 React 包有效。`ui.navigate` 和重新导出的 `useLiveQuery` 对所有运行时走同一接缝。
- **把 SDK 打包进每个插件。** 这正是注册表分叉的原因，而不是解法。
- **让网页克隆插件自带快照器。** 需要插件本不该持有的 shell 与文件系统权限，还重复了原生实现。作为宿主工具，它继承出站检查和权限。
- **在宿主消息文件里翻译清单名称。** 宿主语言包无法预知已安装的插件，只有插件自己的语言包能做到。

## 影响

- 契约目录及其生成的五个镜像增长到 836 个方法。新增上下文方法而不加目录行会导致测试失败。
- `deactivate` 多了一个参数；忽略它的现有 JavaScript 插件不受影响。
- 声明了连接器钩子却没有连接器权限的插件，现在会校验失败，而不是无门控地运行。
- 主题包去掉了 `motionSpeed`，校验器拒绝非法取值。
- 不在本次范围内、留作后续：
  - 面向插件的宠物奖励事件类型
  - 从镜像手机端卸载插件
  - 向 webview 推送主题与动效 token
  - `ctx.eval` / `ctx.sandbox` 的中止信号
  - `workspace.stat`
  - 子智能体、模板和包的本地化名称
