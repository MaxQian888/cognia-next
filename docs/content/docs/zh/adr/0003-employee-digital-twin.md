---
title: ADR-0003 — 员工数字分身
description: 把文档、聊天与代码蒸馏成一个可对话的分身，提供风格忠实、检索增强的回复。
---

# 员工数字分身

| 状态     | 已接受                                                              |
| -------- | ------------------------------------------------------------------- |
| 日期     | 2026-05-01                                                          |
| 替换     | 初始提交中空的 `lib/document/knowledge-rag.ts` 桩。                 |

## 背景

cognia-next 最初以 Character + Skill + Custom Mode 作为交付单元，但
**没有任何方式吸收用户自己的数据**。每个 character 都是手工编写的。
团队想要一个忠实的员工「数字分身」，它能够：

- 从用户的文档、聊天导出和代码中检索答案。
- 在生成的邮件、PR 和回复中匹配用户的行文语气。
- 为重复的工作模式浮现操作手册（「Alice 是怎么处理 P1 的？」），
  供入职的同事使用。

两个场景驱动了设计：

- **A —— 自我增强。** 用户把自己蒸馏成一个本地分身，让一个 Claude
  会话延续他们的风格 + 自动用上他们的 Skills。
- **D —— 新人入职。** 一位前任的导出变成一个分身，新人可以向它发问。

## 决策

### 1. 以画像为先的蒸馏

我们不把用户数据当作一个大的 embedding 池，而是先蒸馏成一份**结构化
画像**（风格样本、操作手册、实体词典、决策日志），并据此合成
Character + Skill 草稿。运行时以画像为依据；原始 chunk 池是它的检索
伴随物，而非真相来源。

### 2. RAG 在渲染器上运行，向量库在远端

cognia-next 是 Tauri 渲染器 + sidecar。把向量索引放进 sidecar 会强制
每次读取都走 IPC，并破坏「在浏览器里也能用」这条路径。我们把向量库
当作远程依赖（Qdrant / Pinecone / Milvus / Weaviate / Chroma server 都
通过移植的 `lib/vector/*` 客户端支持），让渲染器直接做 RAG。

### 3. 任何云端调用之前先做 PII 脱敏

每个 chunk 在我们 embed 它或喂给蒸馏 LLM 之前，都先经过
`lib/twin/ingest/redact.ts`。脱敏是对称的：我们在 `twinChunks.content`
中保留原文（用于 workbench 显示），在 `twinChunks.contentRedacted`
中保留占位版本（用于网络传输）。映射表在磁盘上加密。

### 4. 一个编排器下的五个子 agent

`lib/twin/distill/orchestrator.ts` 串联五个专家：

1. **KnowledgeAgent** —— 实体抽取，每次批量 100 个 chunk。
2. **StyleAgent** —— 有代表性的写作样本。
3. **PlaybookAgent** —— 带置信度评分的重复工作模式。
4. **Synthesizer** —— 组装 Character + Skill 草稿。
5. **Evaluator** —— 从新人的视角为每份草稿评分。

编排器从不与具体 provider 对话；它走 `lib/twin/distill/llm.ts` 里的
`LlmClient` 接口。测试注入一个确定性的 mock；生产接 `createAnthropicLlmClient`。

### 5. 草稿停在自己的表里，直到有人接受

`twinDrafts` 是审核队列。接受时会写入一行真实的 `characters` 或
`skills`，并在草稿上盖上 `acceptedAsId` 以供审计。这让正在生效的选择器
保持干净，并给用户一个机会在分身影响任何对话之前进行编辑。

### 6. 软绑定，没有单独的分身实体

一个「分身」只是一个字符串 id。Character 通过 `Character.twinId` 选择
加入。多个 character 可以共享同一个分身（自我蒸馏、自我总结、自我教练），
而且 Dexie 索引了 `[twinId+kind]` / `[twinId+status]`，因此同一个数据库
可以承载多个互不相关的分身，无需 UI 上的折腾。

### 7. 运行时注入位于 `applyTwinContext`

`lib/twin/runtime/apply-twin-context.ts` 是聊天发送管线与分身子系统之间
唯一的接缝。它总是返回（从不抛出），因此向量库故障时会优雅降级为
无上下文发送，而不是弄坏聊天。Phase 8 将通过
`lib/claude/build-options.ts:resolveSendOptions` 暴露它，让任何带
`twinId` 的 character 自动用上 RAG + few-shot。

## 数据模型

五个新的 Dexie 表位于 v14：

```
twinSources     — registered raw artefacts (file, chat export, code repo)
twinChunks      — sliced text + remote vector pointer + provenance
twinProfile     — distilled structured profile (1:1 with twinId)
twinDrafts      — synth output queued for human review
twinJobs        — ingest / distill workflow tracking
```

`Character` 新增可选的 `twinId` + `twinSettings`，以选择加入运行时注入。

## 管线

```
Ingest:   sources → parse → redact → chunk → embed → persist (Dexie + vector store)
Distill:  chunks  → knowledge → style → playbook → synth → evaluate → drafts
Runtime:  user msg → embed (1×) → RAG topK + style topK → 4-segment system prompt
```

## 本次不包含的内容

- 非文档来源的导入器（Slack / Lark / DingTalk / WeChat / .mbox /
  .eml / git-repo）。管线在 Phase 7 接受粘贴的文本；这些导入器稍后以
  `lib/twin/importers/*` 落地。
- 驱动 cron 触发蒸馏重试的调度器执行器。Phase 4-5 发布一个手动 job
  worker（`lib/twin/job-worker.ts`）；调度器集成随后跟进。
- `lib/claude/build-options.ts` 尚未调用 `applyTwinContext`。在那段
  接线落地之前，运行时是可选的；在此之前，workbench 孤立地展示 prompt
  组装。

## 后果

- 我们为每个 chunk 付出两次写入：Dexie（全文 + 出处）和远程向量库
  （向量 + 200 字符预览）。存储成本很小，而冗余让我们在任一侧漂移时
  得以恢复。
- 蒸馏是突发性的：每次运行约 5 次 LLM 调用（每个 agent 一次）加上
  ⌈N/100⌉ 次 knowledge 调用。一次 1k-chunk 的运行针对 Claude
  Sonnet 4.6 约耗时 2 分钟，成本大约 $0.30。
- 运行时给一次聊天发送增加约 150ms（一次 embed + 一次向量搜索 + 一次
  Dexie 批量查找）。4 段式 prompt 经过结构化设计，让 Anthropic 的
  prompt cache 能命中身份块。

## 另见

- `lib/twin/ingest/job-runner.ts` —— 七阶段摄取管线
- `lib/twin/distill/orchestrator.ts` —— 五 agent 蒸馏管线
- `lib/twin/runtime/apply-twin-context.ts` —— 运行时入口
- `components/twin/twin-panel.tsx` —— 审核 workbench
- `~/.claude/plans/superpowers-deep-penguin.md` —— 原始执行计划

## Phase 8 后续（2026-05）

2026-05 的后续清扫补齐了原 ADR 标记为「后续工作」的缺口。所有列出的
项目都在 Phase 1-9 计划（`~/.claude/plans/harmonic-popping-lovelace.md`）
中带测试地交付。

- **管线严谨性**
  - `lib/twin/ingest/job-runner.ts:finalizeIngestRun` —— finalise 阶段
    现在按来源聚合成功/失败、刷新画像时间戳，并浮现一个 `allFailed`
    标志，执行器用它把静默批次升级为 job 级失败。
  - `lib/twin/job-retry.ts` + `lib/twin/job-worker.ts` —— worker 现在以
    指数退避（1 → 60 s，封顶、加抖动）重新入队瞬时失败，在
    MAX_RETRIES = 3 时进死信，强制按 kind 的并发上限，并在句柄上暴露
    pause / resume。
  - `lib/twin/distill/with-timeout.ts` + `orchestrator.ts` —— 每个子
    agent 在 90 s 预算下运行，带隔离的 try/catch；只有 Synthesizer 失败
    才会中止运行，其余记入 `partialFailures` 并贡献空默认值。
  - `lib/twin/distill/llm.ts` —— `LlmClient.getUsageSnapshot` 让累计的
    输入 + 输出 token 总数对编排器可见；`runDistillJob` 把它写入
    `twinJobs.llmTokensUsed`。
- **数据完整性**
  - `lib/data/build-package.ts` + `apply-package.ts` —— v3 备份现在能
    往返全部五个 twin 表。Profile 是按 id 覆盖（twinId 是其自然键），
    因此重复策略导入不会留下孤儿。
- **UI 表面**
  - `components/settings/character/twin-binding-section.tsx` —— character
    编辑器现在绑定 / 解绑一个分身，并调节四个运行时开关（RAG 启用、
    top-K、风格 few-shot 启用、samples-K），带实时画像统计。
  - `components/twin/twin-overview-card.tsx` —— Settings tab 新增一个
    7 天 chunk 增长面积图、一个来源类型饼图，以及一个分块策略条形图，
    都通过既有的 shadcn 图表原语实现。
  - `components/twin/twin-panel.tsx` —— tab 状态现在镜像到 `?tab=…`，
    因此刷新或分享深链会落到同一视图；`?twinId=…` 让 character 可以
    深链直达其分身的 workbench。
  - `components/chat/twin-header-badge.tsx` —— 聊天头部为绑定分身的
    character 浮现一个紧凑徽章，悬停显示 chunk 数 + RAG / few-shot 开关
    状态，点击打开 workbench。
  - 所有分身 UI 字符串现在都流经 next-intl 命名空间
    （`twin.*`、`chat.twinBadge`、`settings.characters.editor.twinBinding`），
    并在 en 和 zh-CN 中都发布。
- **外部 bridge / MCP**
  - `lib/external-bridge/handlers/rag.ts` 新增一个 `scope: "twin"` 分支，
    对 Dexie chunk 做 BM25。`lib/external-bridge/permission-gate.ts:checkRagCall`
    根据请求把 gate 路由到 `rag:cognia` 还是新的 `rag:twin` scope。
    `rag:twin` **不**在 `DEFAULT_ENABLED_SCOPES` 中——用户必须显式选择
    加入。
- **隐私**
  - `lib/twin/ingest/redact.ts` —— PII 覆盖扩展到 IPv4（仅公网段）、
    未压缩 IPv6、命名 API key 前缀（sk-、ghp\_、AIza… 等）、提示驱动的
    secret、CN 护照前缀（E/G/EH/EJ），以及 CN 驾照卡号（需要提示，
    以免 12 位哈希误报）。
  - `lib/twin/distill/job-runner.ts:sanitizeDraftPayload` —— 每份
    synthesizer 草稿都通过最终的 `hasNoLeakingPii` gate；失败则就地
    重新脱敏，并向 scheduler logger 写入一条警告，让审计轨迹记录下原因。
