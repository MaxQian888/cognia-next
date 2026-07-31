---
title: 长期记忆
description: 持久化的个人记忆 —— 一条事实如何从对话中被抽取、被证据与来源治理、在回合中被检索回注，并暴露给插件、MCP 与 Companion API，同时确保第三方内容永远无法改写 Agent 的行为。
---

# 长期记忆

<Status variant="beta">Beta · memories schema v65 → 治理 v118 → v122</Status>

<TLDR>
  **学习到的记忆（learned memory）**是从对话中推断、或由用户主动保存的持久事实。写入只有一个漏斗 ——
  `storeMemoryCore()`（`lib/memory/api/store-memory.ts:78`）；读取只有另一个 ——
  `retrieveMemories()`（`packages/memory/src/retrieve/retriever.ts:266`），再由
  `applyMemoryContext()`（`packages/memory/src/runtime/apply-memory-context.ts:102`）折进当前回合。
  真正保证安全的是**来源（provenance）**：只有 `user` / `explicit` 来源的记忆才可能是 `procedural`，
  因此一条从连接器进来的消息无法悄悄改写 Agent 的长期行为。所有持久化数据落在四张 Dexie 表 ——
  `memories` 加上不可变的 `memoryEvidence`、持久任务队列 `memoryJobs`、以及不含内容的
  `memoryAuditEvents` —— 它们在 **schema v118** 一同引入。
</TLDR>

<StatGrid>
  <Stat label="核心模块" value="28" hint="lib/memory —— 非测试 .ts" />
  <Stat label="抽取出的内核" value="20" hint="packages/memory/src —— 零 app 导入" />
  <Stat label="UI 组件" value="9" hint="components/memory" />
  <Stat label="Dexie 表" value="4" hint="memories · memoryEvidence · memoryJobs · memoryAuditEvents" />
  <Stat label="记忆类型" value="3" hint="semantic · episodic · procedural" />
  <Stat label="作用域" value="4" hint="global · workspace · character · agent" />
</StatGrid>

设计动机见 [ADR-0069](../adr/0069-long-term-memory-external-api-surfaces)。本页描述**当前实现**。
领域词汇 —— 以及产品刻意保持区分的那些概念 —— 维护在 `lib/memory/CONTEXT.md`。

## 什么算记忆，什么不算

这个子系统在这件事上非常严格，因为把这些概念混为一谈，正是一个「回忆系统」退化成「无法追责的策略引擎」的路径：

| 概念 | 归属 | 会成为学习记忆吗？ |
| --- | --- | --- |
| **学习记忆** | 本子系统 | 它本身就是 —— 属于回忆上下文，而非强制策略 |
| **人类指令** | 用户 / 团队 / 管理员，有明确作者与优先级 | 否 |
| **任务检查点** | 某个任务或会话的生命周期 | 仅在显式提升（promotion）后 |
| **流程（Procedure）** | 某个 Skill 或 Workflow | 否 —— 流程按需加载 |
| **团队黑板** | 同一次运行中协作的多个 Agent | 否 —— 属于短时运行态 |
| **外部上下文** | 工具、MCP、网页搜索、连接器、屏幕捕获 | 否 —— 它是**证据**，有独立的信任级别 |

答案依赖了外部上下文的回合称为**被污染回合（contaminated turn）**。它可以**使用**学习记忆，但不会自动
**产生**学习记忆 —— 经审阅的证据仍需被显式提升。

## 代码位置

```
lib/memory/
  api/            store-memory · search-memory · mutate-memory · wire   # 写入漏斗
  retrieve/       retriever                                             # 作用域并集读取
  extract/        extractor · salience                                  # 对话 → 候选事实
  write/          run-memory-extraction · run-episodic-distill          # 后台写入任务
  consolidate/    consolidator                                          # 合并近重复项
  forget/         decay                                                 # 重要度衰减 + 淘汰
  lifecycle/      job-worker · maintenance · enqueue-reconcile          # memoryJobs 队列
  control-plane/  policy · manage · contamination                       # 治理决策
  runtime/        apply-memory-context · build-deps                     # 注入回合
  external/       providers（claude-code · codex）· discover · edit     # 外部记忆文件
  CONTEXT.md                                                            # 领域词汇表

packages/memory/src/            # 抽取出的内核 —— 零 `@/` 导入
lib/db/memories.ts              # Dexie CRUD：create/get/update/invalidate/touch/pin/list
lib/plugin/api/memory-api.ts    # 面向插件的 ctx.memory
lib/external-bridge/handlers/memory.ts   # MCP 工具
components/memory/              # 控制台 · 详情面板 · 冲突解决 · 批量工具条
app/memory/                     # 管理页路由
```

内核被抽取为 `@cognia/memory` 以便独立构建；`types/memory/memory.ts` 是一个边界 shim，
转导出 `@cognia/memory/types/memory`，从而让约 80 个既有导入方保持不变。

## 类型模型

```ts
type MemoryType   = "semantic" | "episodic" | "procedural"
type MemoryScope  = "global" | "workspace" | "character" | "agent"
type MemoryStatus = "active" | "invalidated"
```

`active` 行可被检索；`invalidated` 行是软删除 —— 保留用于历史与时序推理，但排除在检索之外。
作用域解析是一次并集读取：`character` 记忆是覆盖在 `global` 之上的一层，键 / 文本冲突时 character 胜出。
`agent` 是私有命名空间 —— 没有相同 agent id 就看不见这些行。

治理又加了四个维度，均在 v118 引入：

```ts
type MemoryEvidenceState      = "legacy" | "supported"
type MemoryReviewStatus       = "unreviewed" | "verified" | "conflict"
type MemoryContaminationState = "clean" | "external-context" | "unknown"
type MemorySensitivity        = "normal" | "sensitive"
```

在证据追踪能力之前创建的记忆被标记为 `legacy`，而不是用编造的来源去回填 ——
它们依然可用，但 UI 不得把它们的来源或置信度当作已知信息呈现。

## 来源即信任边界

`provenance` 记录一条记忆从哪来，并据此限制它**被允许成为什么**：

| 来源 | 出处 | 限制 |
| --- | --- | --- |
| `user` | 从本地、用户自己写的会话中自动抽取 | —— |
| `explicit` | 用户主动捕获（`/remember`、「记住 …」） | —— |
| `inbound` | 源自连接器入站的第三方内容 | 永不进入 `global` 作用域，永不为 `procedural` |
| `system` | 应用自身创建（迁移、种子数据） | —— |
| `external` | 经 API 面写入 —— 插件 `ctx.memory`、MCP 桥工具、Companion RPC | 写入时必过 PII 门禁，永不为 `procedural` |

只有 `user` 与 `explicit` 来源可以产出 `procedural` 记忆。正是这一条规则，
阻断了「一条从连接器进来的消息改写 Agent 长期行为」的路径。

## 存储

`memories` 在 **schema v65** 引入，其索引严格对应面板与检索器真实执行的读取 ——
`scope` / `type` / `characterId` 用于面板分组与作用域并集检索，`status` 因为检索只过滤 `active`，
`lastAccessedAt` 用于新近度因子与按访问时间过期，`vectorDocId` 用于向量清理时的反查，
`sourceSessionId` 用于「跳转到来源」，`pinned` 用于豁免淘汰，
再加上 `[scope+type]`、`[scope+status]`、`[type+status]` 三个复合索引。

**v118** 是治理迁移。它为 `memories` 增加 `projectId` / `agentId` / `reviewStatus` 索引，
并新增三张**刻意不放进记忆行内**的表：

- `memoryEvidence` —— 指向支撑该记忆之来源的不可变引用
- `memoryJobs` —— 持久化抽取队列（`dedupeKey`、`nextAttemptAt`、`[status+queuedAt]`）
- `memoryAuditEvents` —— 不含内容的审计轨迹

**v122** 增加 `sourceMessageId` 索引，让聊天界面能找到某条消息产生了哪些记忆。

## 外部接口面

有三个接口面可以从应用外部触达记忆，且它们全部经由同一条
`storeExternalMemory()` 路径写入（`lib/memory/api/store-memory.ts:314`）——
这正是「换一扇门就能绕过 PII 门禁与 `external` 来源限制」不成立的原因：

- **MCP 工具**（`lib/external-bridge/handlers/memory.ts`）—— `memory_search` / `memory_list` 归于
  `memory:read` 权限，`memory_store` / `memory_update` / `memory_forget` 归于 `memory:write`。
  两个权限默认均为 **OFF**：这是蒸馏后的个人内容，暴露必须是显式选择。
- **插件** —— `ctx.memory`，由 `createMemoryAPI(pluginId)` 按插件构建
  （`lib/plugin/api/memory-api.ts:112`）。
- **Companion RPC** —— 移动端 / 远程接口面，走 [Companion API](./companion-api) 所述传输层。

## 相关文档

<Cards>
  <Card title="ADR-0069" href="../adr/0069-long-term-memory-external-api-surfaces" description="该子系统背后的决策记录" />
  <Card title="External Bridge" href="./external-bridge" description="承载记忆工具的 MCP 服务器" />
  <Card title="插件系统" href="./plugin-system" description="ctx.memory 如何被授予与鉴权" />
  <Card title="存储" href="../data/storage" description="这些表所在的 Dexie schema" />
</Cards>
