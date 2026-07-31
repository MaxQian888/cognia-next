---
title: 光学压缩
description: 把对话历史压缩成图像而非摘要 —— 必须全部通过的四道保守门禁、证明画面可读的视觉回读，以及「回退到文本」这一保证：上下文绝不会丢进一张读不出来的图里。
---

# 光学压缩

<Status variant="experimental">Experimental · ADR-0063 · opticalArchives（Dexie v101）</Status>

<TLDR>
  「Snapcompact」把对话的中段渲染成 PNG，交给模型的是图像而不是文本摘要 ——
  赌的是「在同等 token 成本下，一张清晰的渲染比一段转述保留了更多原文」。
  它被刻意设计得**很难触发**：`compact.mjs` 跑一条**四门漏斗** ——
  覆盖度、预算 / 溢出、是否值得、以及一次往返可读性校验 ——
  **任何**一门不过就返回 `null`，此时调用方会把**同一段** `middle` 按文本摘要处理。
  上下文绝不会被丢进一张读不出来的图里。
</TLDR>

<StatGrid>
  <Stat label="门禁" value="4" hint="覆盖度 → 预算/溢出 → 是否值得 → 可读性" />
  <Stat label="Sidecar 模块" value="11" hint="sidecar/dispatch/optical —— 非测试 .mjs" />
  <Stat label="Dexie 表" value="1" hint="opticalArchives —— schema v101" />
  <Stat label="注入式 I/O" value="1" hint="transcribe —— 一次性视觉回读" />
</StatGrid>

设计动机见 [ADR-0063](../adr/0063-optical-context-compaction)。

## 可读性门禁才是整个设计的核心

把上下文渲染成图像，其失效模式是**静默的不可读**：
模型收到一张它读不出来的图，而对话丢失了它以为自己还持有的历史。
最后一道门用「往返」堵死了这条路 —— 渲染出的画面经一次性视觉回读
（`transcribe`，本模块**唯一**的 I/O，且是注入式的，因此其余部分可离线测试）
被转录回文本，再与原文比对。回读不达标，画面即被丢弃，转而执行文本摘要。

前三道门是更廉价的过滤器：中段是否被足够覆盖、渲染是否在预算内且不溢出、
以及这次替换究竟值不值得。

## 代码位置

```
sidecar/dispatch/optical/
  compact.mjs      # 编排 + 四门漏斗
  normalize.mjs    # 对话中段 → 归一化文本
  layout.mjs       # planOpticalFrames —— 文本如何分页成画面
  render.mjs       # renderSnapcompactPng
  raster.mjs  png.mjs  resample.mjs   # 渲染原语
  fonts.mjs  fonts-data.mjs           # 内嵌字体，不依赖系统
  readability.mjs  # checkReadability —— 往返门禁
  constants.mjs

sidecar/dispatch/compaction.mjs · compaction-strategies.mjs   # 调用方
lib/claude/optical-archive-persist.ts     # compact_boundary 事件 → Dexie
lib/db/optical-archives.ts                # opticalArchives 表
components/chat/message-parts/optical-archive-dialog.tsx   # 查看某一画面
```

字体是内嵌的（`fonts-data.mjs`）而非从系统解析，
因此无论宿主机装了什么，画面渲染结果都一致 ——
一个随机器而变的渲染会让可读性门禁失去可复现性。

## 持久化是刻意为之的副作用

`lib/claude/optical-archive-persist.ts` 把 sidecar 的 `compact_boundary` 事件桥接到 Dexie，
并且**刻意**放在纯粹的 `adapter.ts` reducer **之外** ——
它是一个尽力而为、仅限浏览器的副作用，与 `pre_messages` 路由到内存撤销注册表的做法一致。
Dexie 模块是动态导入的，因此 `adapter.ts` 不携带任何数据库依赖，
在 SSR 与测试环境下都能安全导入。

表本身很小：`opticalArchives: "&id, sessionId, createdAt, [sessionId+createdAt]"` ——
足以按顺序列出某会话的归档，并从聊天记录中打开任意一帧。

## 相关文档

<Cards>
  <Card title="ADR-0063" href="../adr/0063-optical-context-compaction" description="光学压缩的决策记录" />
  <Card title="Sidecar 与 Claude SDK" href="../core/sidecar-and-claude-sdk" description="本流程所处的 dispatch 管线" />
  <Card title="存储" href="../data/storage" description="opticalArchives 所在的 Dexie schema" />
</Cards>
