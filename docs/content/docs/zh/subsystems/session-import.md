---
title: Agent 会话导入
description: 读取其他 Agent 的会话历史 —— Claude Code、Codex、OpenCode、Aider、Continue、Gemini CLI —— 采用两阶段扫描：先廉价摘要，只为你真正导入的会话付出完整解析的代价。
---

# Agent 会话导入

<Status variant="stable">Stable · ADR-0062 · 复用 sessions / messages</Status>

<TLDR>
  九个适配器读取其他 Agent CLI 留在磁盘上的会话历史，并把它们转成 Cognia 会话。
  设计要点是**两阶段扫描**：`scan.ts` 遍历数据源的根目录，每个匹配文件**只读一次**，
  通过适配器轻量的 `summarizeFile` 产出 `SessionSummary` ——
  不做完整解析，也不分配 `StoredMessage` 对象。
  昂贵的 `parseSession` 被推迟，且只对用户真正勾选的会话执行。
  导入写入既有的 `sessions` 与 `messages` 表，因此它没有自己的 schema。
</TLDR>

<StatGrid>
  <Stat label="数据源适配器" value="9" hint="claude-code（+dag、+subagent）· codex · opencode（+db）· aider · continue-dev · gemini-cli" />
  <Stat label="编解码器" value="3" hint="claude-code · codex · opencode" />
  <Stat label="前端模块" value="19" hint="lib/session-import —— 非测试 .ts" />
  <Stat label="新增 Dexie 表" value="0" hint="复用 sessions / messages" />
</StatGrid>

设计动机见 [ADR-0062](../adr/0062-external-agent-session-import)。

## 分两阶段，因为完整解析很贵

用户扫描可导入历史时，面前可能是数千个 JSONL 文件。
为了显示一个选择列表而把它们全部解析一遍是纯粹的浪费，因此适配器契约被拆成两半：

| 阶段 | 适配器方法 | 代价 | 产出 |
| --- | --- | --- | --- |
| **扫描** | `summarizeFile(content, locator)` | 每文件一次读取，不分配消息对象 | `SessionSummary`；文件不含会话时为 `null` |
| **导入** | `parseSession` | 完整解析 | 真正的消息 |

`scan.ts` 是所有「按文件组织的 JSONL 数据源」的共享驱动，
因此新增一个适配器只需提供这两个方法，而不必自带遍历器。

## 代码位置

```
lib/session-import/
  scan.ts          # 按文件 JSONL 数据源的共享桌面扫描驱动
  fs.ts            # walkFiles
  registry.ts      # 数据源注册
  types.ts  codec-types.ts
  to-parts.ts      # 外部消息形态 → Cognia 消息 parts
  usage.ts         # token / 用量重建
  watch-import.ts  # 随数据源增长持续跟随
  adapters/
    claude-code.ts  claude-code-dag.ts  claude-code-subagent.ts
    codex.ts  opencode.ts  opencode-db.ts
    aider.ts  continue-dev.ts  gemini-cli.ts
  codecs/
    claude-code-codec.ts  codex-codec.ts  opencode-codec.ts

src-tauri/src/session_import.rs   # 原生文件系统访问
hooks/session-import/  components/session-import/
lib/plugin/api/import-api.ts      # 插件可贡献数据源
```

Claude Code 有三个适配器而不是一个，因为它的历史不是一条扁平日志：
`claude-code-dag` 处理分叉的对话图，`claude-code-subagent` 处理嵌套的子 Agent 记录。
OpenCode 有两个，是因为它同时提供文件格式与数据库两种形态。

## 相关文档

<Cards>
  <Card title="ADR-0062" href="../adr/0062-external-agent-session-import" description="会话导入的决策记录" />
  <Card title="外部 Agent" href="../chat/external-agents" description="这些适配器所读取历史的来源" />
  <Card title="存储" href="../data/storage" description="导入写入的 sessions / messages 表" />
  <Card title="插件系统" href="./plugin-system" description="插件如何贡献一个导入源" />
</Cards>
