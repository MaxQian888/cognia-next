---
title: Agent 会话导入
description: 面向 11 种本地编程 Agent 历史的有损可见图导入，保留子 Agent、后台任务、关系、生命周期与验证后的原生恢复。
---

# Agent 会话导入

<Status variant="stable">Stable · ADR-0062 · 复用 sessions / messages</Status>

<TLDR>
  11 个适配器读取本地历史或用户主动提供的导出文件，并投影为版本 1 的 canonical session
  graph。来源提供的信息会保留父子关系、subagent、后台任务、生命周期、tool 状态、checkpoint、
  rollback/rewind、compaction、多模态内容与显式 loss。扫描保持轻量，只有选中的会话才做完整图解析。
</TLDR>

<StatGrid>
  <Stat label="数据源适配器" value="11" hint="由 registry 派生，support-matrix.test.ts 防漂移" />
  <Stat label="图适配器" value="11" hint="parseGraph；旧插件继续兼容 parseSession" />
  <Stat label="所有权状态" value="3" hint="source-mirror · cognia-owned · native-bound" />
  <Stat label="新增 Dexie 表" value="0" hint="复用 sessions / messages" />
</StatGrid>

设计动机见 [ADR-0062](../adr/0062-external-agent-session-import)。

## 分两阶段，因为完整解析很贵

用户扫描可导入历史时，面前可能是数千个 JSONL 文件。
为了显示一个选择列表而把它们全部解析一遍是纯粹的浪费，因此适配器契约被拆成两半：

| 阶段 | 适配器方法 | 代价 | 产出 |
| --- | --- | --- | --- |
| **扫描** | `summarizeFile(content, locator)` | 每文件一次读取，不分配消息对象 | `SessionSummary`；文件不含会话时为 `null` |
| **导入** | `parseGraph` | 完整解析 | canonical sessions、关系、来源 revision 与逐会话 loss |

`parseSession` 继续作为插件兼容入口；Cognia 会将其包装为扁平图并明确标记 fidelity 降级。

## 当前支持（验证于 2026-08-29）

| 来源 | 最后验证版本 | 重点保留 | 已知边界 |
| --- | --- | --- | --- |
| Claude Code | 2.1.251 | 独立 subagent transcript、恢复后同一 agent、teams、依赖、后台任务 | 私有运行态仅保留为 diagnostic/loss |
| Codex | 0.150.1 | parent/fork、工具、plan/goal、rollback、compaction、协作消息 | 未知 rollout item 转为有界脱敏 diagnostic |
| OpenCode | 1.18.25 | 任意深度 child、后台 job、attachment、patch/snapshot、tool lifecycle | 不虚构 schema 私有字段 |
| Gemini CLI | 0.57.0 | `$set`、`$rewindTo`、JSON 导出、多模态、token/tool 状态、`agentId` | 不可获取的 provider scratch state 会报告 loss |
| Continue | 2.1.0 | mode/model/usage、结构化内容、tool result 关联 | 上游不存在 subagent transcript 契约 |
| Aider | 0.86.2 | 可配置 history 路径、Markdown 对话 | Markdown 始终有损 |
| Pi | 0.84.4 | branch/subagent 区分、direct bash、label/session info、compaction | 原生恢复仍需已连接兼容 preset |
| Cursor | 1.7 | 本地 SQLite、Markdown 导出、本地 subagent 工件 | 不授权读取 Cursor 云端/后台历史 |
| Cline | 3.38 | `sessions.db`、manifest/message/compaction、旧 task folder | 仅本地工件 |
| Copilot CLI | 0.0.350 | `session-state`、SQLite 子集、task/checkpoint/background | 仅本地 chronicle |
| Qwen Code | 0.16-alpha | JSON/JSONL 导出、resume/branch/fork/rewind | 不依赖未公开私有布局 |

`buildExternalSessionSupportMatrix()` 直接从导入 registry 与 external preset catalog 生成恢复映射。
Kiro、Droid 与 DeepSeek Harness 因缺少稳定公开 transcript 格式，保持 runtime-only。

## 镜像与恢复语义

- `source-mirror` 会跟随来源 rewind、删除、关系移除与 child tombstone，同时保留 Cognia 本地装饰。
- 使用 Cognia 模型继续后转为 `cognia-owned`；之后的来源变化只标记真实 divergence，不覆盖本地续聊。
- 仅在存在 native session id 与匹配 preset 时提供原生恢复。preset 必须已配置并连接，
  `session/resume` 必须经实时验证，原 cwd 必须存在，且握手成功；之后才转为 `native-bound`。
- native-bound 的运行事件与文件监听回声按 native session/revision 去重。

`scan.ts` 是所有「按文件组织的 JSONL 数据源」的共享驱动，
因此新增一个适配器只需提供这两个方法，而不必自带遍历器。

## 代码位置

```
lib/session-import/
  scan.ts          # 按文件 JSONL 数据源的共享桌面扫描驱动
  fs.ts            # walkFiles
  registry.ts      # 数据源注册
  types.ts  codec-types.ts  graph.ts  support-matrix.ts  native-resume.ts
  to-parts.ts      # 外部消息形态 → Cognia 消息 parts
  usage.ts         # token / 用量重建
  watch-import.ts  # 随数据源增长持续跟随
  adapters/
    claude-code.ts  codex.ts  opencode.ts  gemini-cli.ts
    aider.ts  continue-dev.ts  pi.ts
    cursor.ts  cline.ts  copilot-cli.ts  qwen-code.ts
    portable-agent-source.ts
  codecs/
    claude-code-codec.ts  codex-codec.ts  opencode-codec.ts

src-tauri/src/session_import.rs   # 原生文件系统访问
hooks/session-import/  components/session-import/
lib/plugin/api/import-api.ts      # 插件可贡献数据源
```

桌面 SQLite 读取由只读 Rust transport 完成，并限制来源 allowlist。文件树、SQLite、固定参数运行时
transport 与用户导出文件保持独立信任边界；不会把来源内容拼接成 shell 命令。

## 相关文档

<Cards>
  <Card title="ADR-0062" href="../adr/0062-external-agent-session-import" description="会话导入的决策记录" />
  <Card title="外部 Agent" href="../chat/external-agents" description="这些适配器所读取历史的来源" />
  <Card title="存储" href="../data/storage" description="导入写入的 sessions / messages 表" />
  <Card title="插件系统" href="./plugin-system" description="插件如何贡献一个导入源" />
</Cards>
