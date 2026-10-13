---
title: "0226 — 库插件通过 IPC 声明契约"
description: "可独立安装的库插件提供经过 schema 校验的 RPC 和消费者独立的 JavaScript 模块，不转移权限。"
---

# ADR 0226 — 库插件通过 IPC 声明契约

**状态：** 已接受  
**日期：** 2026-10-13

## 背景

GitHub Comment Bot 需要共享实现代码。ADR-0156 允许将
`packages/github-bot-kit` 作为构建期包打入消费者。这解决了源码复用，却不能让
提供者独立安装、版本化、启用或撤销。现有 IPC 已经负责 `expose`、`call`、发现、
超时、熔断和空闲唤醒；manifest 的必需依赖已经决定启用顺序和移除保护。

用户审阅 `docs/plans/2026-10-13-runtime-library-plugins.md` 的完整方案后，
确认同时支持运行时 RPC 和直接 JavaScript 导入，并要求双方分别持有权限。
新建传输协议或另一套依赖图会重复已有职责。

## 决策

### 库是一项 contribution，不是新的运行时

插件声明 `library` capability，并提供非空的 `library.rpc` 和／或
`library.modules` 映射。它仍可独立安装，也可保留普通 contribution。
提供者必须声明 `engines.cognia: ">=0.2.0"`；使用新 API 的消费者也必须以此
作为最低宿主版本。契约目录 1.3.0 包含 capability、API、方法级运行时限制以及
模块入口路径。SDK 声明和 Python 镜像从目录生成。

每个插件 ID 只安装一个版本。RPC 和模块契约随提供者的 `version` 发布，破坏性
变更升级 major。消费者在直接、必需的 `dependencies` 中声明 semver 范围；
可选依赖和传递依赖不授权调用。缺失、不兼容或循环的必需依赖阻止启用；已经安装
的依赖先启用。宿主不自动下载依赖。

### RPC 继续使用现有分发器

每个公开 RPC 名称声明描述、draft-07 输入／输出 JSON schema、
`risk`（`read`、`write` 或 `destructive`）以及 `requiredPermissions`。
输入 schema 校验完整的位置参数数组；无返回值的操作返回 `null`。
JavaScript 通过 `ctx.events.ipc.expose` 提供实现；Python 声明公开的模块级
`handler`，由 manager 适配到 IPC。启用完成前必须具备所有已声明的实现。

对于已声明的方法，宿主从必需依赖推导调用者。作者传入的 `allowedCallers`
不能扩大或替代该关系。消费者需要 `ipc:call`，提供者需要 `ipc:expose`，双方还
必须分别持有每项方法权限。现有 silent/confirm/forbid 策略决定审批；risk 用于
发现与审计，不增加另一层确认。异步审批后以及接收结果前，重新检查授权、账户
可用性、启用生命周期和依赖资格。宿主没有交互审批响应器时明确拒绝 confirm 级操作。

输入和输出作为有大小上限的 JSON 复制，不强制转换、不填充默认值。非 JSON 数据、
无效 schema、不支持的关键字／方言以及无法解析的引用均拒绝。解释执行的校验器
不改变应用 CSP。无效请求在进入熔断器前失败；执行和输出错误使用现有熔断器。
取消只停止等待，不能撤销已经分发的副作用。未声明的旧 IPC 方法保留既有行为。

### 直接模块属于消费者本次启用

`await ctx.libraries.importModule(providerId, moduleName)` 加载独立打包的
`.cjs` 入口，不能与提供者 main 相同。默认导出的 factory 接收消费者受控的
context，返回 `{ exports, dispose? }`。导出包含真实 JavaScript 值，包括函数、
类和回调；调用它们不经过 RPC 或 JSON schema。

每次消费者启用都独立求值 bundle。同一个模块的并发导入共享初始化；不同消费者
不共享 bundle 内状态。模块权限对双方分别检查。宿主调用只使用消费者的权限和
context。子级 disposable scope 管理初始化和清理；迟到结果会被清理，旧 context
即使在消费者重新启用后也不能访问宿主。

这沿用可信 JavaScript 执行模型，隔离 bundle 内状态，不隔离全局对象或共享宿主
模块，也不是新的安全沙箱。普通已保留 JavaScript 值无法撤销；宿主能力受生命周期
约束。静态跨插件 import 不在本契约范围内。

### 生命周期继续由依赖关系管理

必需消费者的启用意图或正在进行的工作会阻止提供者停用、替换和热重载。任何仍然
安装的必需消费者都会阻止卸载。用户先停止依赖者，再替换提供者并显式重新启用，
不迁移状态、不自动重启。消费者结束时清理其模块实例；账户／运行时结束时作废
scope 和注册。RPC 保留通过授权后的空闲唤醒；直接模块导入要求提供者已经活跃。
空闲挂起不能使仍启用的消费者失去提供者。

普通 frontend/hybrid JavaScript 支持两种路径，包括其 CLI 和 headless 宿主。
Python 在具备 Python 能力的宿主上支持双向 RPC，但不能导入 JS 模块。
独立 Node 沙箱插件和 WASM 拒绝该功能。Python 的方法级目录限制同样作用于原始
反向 RPC 请求，不能通过 `ctx.call` 绕过只供 JS 使用的回调 API 限制。

### 打包和诊断沿用现有组件

标准 `library.modules.*.entry` 路径元数据驱动前端打包器、浏览器完整性清单、
原生路径约束检查和 CLI 打包器。库入口沿用其他入口经过校验的提供者根目录读取。
Plugin messaging 诊断卡显示 RPC 版本、风险和权限。IPC 保留有界的调用元数据
历史，不记录参数或结果。

## 影响

- 作者可发布可复用的提供者，不必将发布和启用绑定到每个消费者。不兼容的版本要求
  产生明确冲突。
- 依赖绝不转授权限。高权限库不能暗中让消费者获得自己的权限。
- RPC 可跨支持的 JS 和 Python 运行时；直接模块保留 JS 使用体验，但需要消费者
  独立初始化和清理。
- 旧宿主需要明确的最低版本边界。仍报告 0.1.0 的开发 checkout 不满足发布后的
  0.2.0 库契约。
- `github-bot-kit` 及其消费者仍是构建期共享。Cogpack 和 cogset 继续负责原有
  安装／版本及启用状态；本功能不会将任意包自动转换为库。

## 实现与验证边界

主要实现位于 `lib/plugin/library/`（访问、schema、模块）、
`lib/plugin/messaging/ipc.ts`、现有 manager／loader／依赖解析器以及 SDK
标准目录。共置测试覆盖 schema 接纳、JSON 复制、依赖范围、撤权、Python 路由、
生命周期清理以及实际 manager／loader 集成。打包测试覆盖映射入口遍历和 CJS
输出。原生、浏览器和 Python 进程的验收结果必须与单元测试分开报告。

相关：[ADR-0145](./0145-python-plugin-runtime-alignment)、
[ADR-0155](./0155-plugins-reach-the-host-through-one-door)、
[ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin)、
[ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs)、
[ADR-0210](./0210-a-plugin-can-carry-a-pi-package)。
