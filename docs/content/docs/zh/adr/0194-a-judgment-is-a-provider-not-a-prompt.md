---
title: "0194 — 判断是一个提供方，而不是一段提示词"
description: "System-1 决策（一次推理给出带校准概率的是非、单选、打分类型化问题答案）成为宿主能力 `ctx.decisions`，由提供方注册表支撑。laya 插件是本地提供方，TypeSafe 兼容接口是远程提供方。无论提供方声称在哪运行，每次请求都先脱敏并过 PII 门；提供方以类型化信封返回结果而不是抛异常。"
---

# ADR 0194 — 判断是一个提供方，而不是一段提示词

**状态：** 已接受 — 已实现
**日期：** 2026-09-25
**相关：** [ADR-0145](./0145-python-plugin-runtime-alignment)（Python 支撑的贡献、契约目录）、[ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin)（树内插件只用 SDK）、[ADR-0026](./0026-plugin-extension-points-v2)（惰性工厂模块桥）

## 背景

两件事同时到来。

`jev-chat/jev-chat-jarvis`（MIT）是一个安卓聊天副驾。它的核心循环从不问语言模型"你怎么看"，而是向 **System-1 决策模型**提出七个类型化问题——最新一条是否字面意思、对方真正想要什么、离吵架还有多远（0–9）、对方需要什么、下一条是否该给实质内容、什么动作合适、紧张是否已化解——大约一秒拿回校准过的概率。随后由 LLM 起草三条回复，再由同一个决策模型排序。协议很小：`POST {model, state, questions}` → `{answers}`，问题类型为 `noul`（是非）、`choice`（单选）、`score`（有序等级）。

`plugins/cognia-laya-guard` 已经在运行 **laya**——一个说同样问题格式的本地编码器——用于入站 IM 审核。它的 `laya_decide` 工具只是一个宿主里没人能调用的透传，插件也无法把引擎提供给别的功能。

如果把副驾当作"一个功能调用一个后端"来移植，就会重复插件已经暴露的模式：能力被锁在最先需要它的代码里。

## 决定

### 1. `ctx.decisions` 是带提供方注册表的宿主能力

`lib/decisions/` 负责整个子系统：

- `types/decisions`：线上的问题 / 答案类型、`DecisionProvider`、`DecisionResult`（成功带类型化答案，或类型化错误种类）、设置。
- `registry.ts` + `host-registry.ts`：内置远程接口与插件贡献共用一个注册表，提供 `subscribe()` 和稳定的 `list()` 快照供 `useSyncExternalStore` 使用。
- `run-decision.ts`：**唯一入口。**校验、提供方解析（显式 id，否则 `settings.decisions.providerId`）、递归保护、脱敏、PII 门、截止时间与归一化都在这里。回复副驾、设置页探测和插件 API 都调用它。

插件通过 `ctx.decisions.decide()`（`decisions:run`）使用，通过 `manifest.decisionProviders[]` 或 `ctx.decisions.registerProvider()`（`decisions:provide`）贡献。Python 插件用 `@cognia.contribution("<id>")` 支撑提供方：宿主调用一次 `describe()` 读取纯数据描述，并代理 `decide` / `status`。

### 2. 无论提供方是谁，每次请求都脱敏并过门

`runDecision` 对 state 与问题文本中的每个字符串**值**运行 `redactText`（键不动，因此单选的选项键得以保留），若 `hasNoLeakingPiiDeep` 仍发现个人信息则以 `pii` 拒绝。本地提供方同样适用：`locality: "local"` 是插件对自身的声明，宿主无法验证，因此只用于展示。

### 3. 提供方返回信封，而不是抛异常

`decide()` 返回 `{ok: true, answers, latencyMs, routing?, truncation?, stateTrimmed?}` 或 `{ok: false, error: {kind, message}}`。Python 支撑的提供方要跨 RPC，异常到达时只剩字符串，所以类型化的错误种类必须作为数据传递。未知种类归为 `provider_error`；laya 的 `not_ready` / `invalid_question` / `predict_failed` 分别映射为宿主的 `provider_unavailable` / `invalid_request` / `provider_error`。只有请求会跨 RPC——宿主的 `AbortSignal` 无法序列化，因此由 `runDecision` 让调用与信号和截止时间赛跑。

### 4. 交付两个后端：本地 laya，远程 TypeSafe 兼容接口

- **本地**：laya 插件贡献 `laya-local`。`describe()` 公布所路由检查点的 token 预算（`limits`），调用方据此选择精简版问题措辞。`decide` 支持 `stateTrim`——一个列表路径，其中*最旧*的条目可以被丢弃以适配预算——因为否则 laya 会从尾部截断序列化后的 state，对聊天而言就是丢掉最新消息。截断会被报告，而不是隐藏。
- **远程**：`builtin:decisions-http` 通过 `createPlatformFetch`（网络出口门认可的托管传输）请求 OpenRouter `api/alpha/decisions` 或 `/v1/systemone` 网关（博查、TypeSafe、Vercel、OpenCode Zen、自定义）。除回环地址外拒绝明文 http。密钥按预设存于钥匙串，绝不写入设置。

`AppSettings.decisions` 属于 `device-local`：所选提供方常常是只存在于某台机器的插件，密钥也在那台机器的钥匙串里。

### 5. 没有提供方是一个标注出来的状态，而不是被隐藏

没有提供方时，调用方得到 `no_provider`。需要判断的功能把它呈现为明确的未启用状态（回复副驾仍起草回复，只是不排序），而不是悄悄跳过判断。

## 被否决的方案

- **用对话 LLM 模拟判断。**成本低，但得到的是模型自报的置信度而非校准概率，且在界面上与真正的判断器看起来一样。改为明确的"无提供方"状态。
- **让副驾直接调用 laya 的工具。**把宿主功能耦合到某个插件的工具名与参数形状，其他调用方也无从接入。
- **相信 `locality` 从而对本地提供方跳过脱敏。**插件可以声明任何东西；门必须在不相信它的前提下依然成立。

## 影响

- 契约目录中新增一个能力族（`decision-provider`、`decisionProviders[]`、`ctx.decisions`、两个权限）及其镜像。
- laya 插件从单一用途的审核钩子变成通用的本地 System-1 后端。
- 脱敏意味着判断器看到的是 `<PHONE_001>` 而不是号码。对意图与语气这类类型化判断，这是正确的取舍；将来若有问题确实需要原始值，应由别的机制回答，而不是削弱这道门。
