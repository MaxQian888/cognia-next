---
title: "ADR-0062 — 外部 Agent 会话历史图导入"
description: "有损可见地导入 11 种本地编程 Agent 历史，保留关系、生命周期、后台任务、镜像同步、插件兼容与能力门控的原生恢复。"
---

# ADR-0062 — 外部 Agent 会话历史图导入

**状态**：已接受（2026-07-04）**作者**：Max Qian + Claude Opus 4.8 **构建内容**：ADR-0048（Codex支持）、ADR-0051（外部代理适配器插件类型——叠加模式在此镜像）、ADR-0009/0037规范`ChatSession`/及`StoredMessage`模型、聊天导出导入器（`lib/data/import-registry.ts`）。

## 背景

Cognia可以*运行*外部代理（Codex `app-server`、OpenCode、ACP）并*重用*他们的credentials/memory，但不能**读取磁盘会话历史**。只读扫描具体确认了这一差距：

- `lib/claude/replay.ts`是重新序列化**Dexie**消息，而不是`~/.claude/projects/*.jsonl`。
- 聊天导出导入器通过**封闭**的`ChatImportFormat`联合解析**web-export JSON**（chatgpt / claude.ai / gemini）——没有CLI JSONL，且其插件覆盖层（`registerChatImporter`）无法从`ctx`访问。
- Codex `app-server`适配器**声明`session/list|fork|resume`不支持**——活驱动无法枚举过去的线程。

目标是一个可扩展的机制——易于添加OpenCode和未来代理，并通过插件贡献——将过去的磁盘会话变成正常且可持续的Cognia对话。

### 磁盘格式研究

- **Claude Code**：`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，一个record/line（`type` user/assistant/summary/system，嵌套的拟人`message.content[]`块：文本/思考/tool_use/tool_result/图片，加上顶层`toolUseResult`）。Encoded-cwd = 路径，路径为`/`，`.`，`\` → `-`（重复使用`encodeClaudeProject`）。
- **Codex**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（荣誉`$CODEX_HOME`），每行行`{ timestamp, type, payload }`，分别为`type` ∈ session_meta / response_item / event_msg / turn_context / 压缩。`response_item` 载荷：消息（`input_text`/`output_text`）、推理、function_call / function_call_output（+ custom_tool_call变体）、`ghost_snapshot`（过滤）。
- **OpenCode**：当前构建仍保留在**SQLite**`~/.local/share/opencode/opencode.db`（会话/消息/零件表，多态性 `data` JSON），加上共享导出JSON。比特工pure-JSONL还重。

## 决策

引入专用的**会话-源代码注册表**（`lib/session-import/`），以干净`SubagentSourceAdapter`模式为蓝本，而不是让内存`ChatImporter`过载。源代码实现了磁盘历史的两步现实：

```ts
interface AgentSessionSourceAdapter {
  id; displayName; labelKey; acceptedExtensions
  scanRoots(home): string[]                              // desktop auto-scan roots
  detect(files): "match" | "maybe" | "no"                // picker auto-detect
  listSessions(input): Promise<SessionSummary[]>         // cheap: titles + counts
  parseSession(ref, input): Promise<ImportedConversation> // full parse on demand
}
```

- **目标重用**：适配器会发出`ImportedConversation { session: ChatSession; messages: StoredMessage[] }`——由现有`applyImported`（一个Dexie txn，`sessions` + `messages`）持续存在。部分只使用聊天`MessageRenderer`已经处理的形状（文本/推理/`tool-<name>`/文件），并与`lib/ai/agent/external/event-to-parts.ts`交叉核对。稳定的ID `import:<source>:<originalId>`让重扫描变成upsert而不是重复。每个会话都会有一个`branchSeed:{kind:"transcript"}`，所以是**可延续**的。
- **注册表 + 插件叠加层**（`registry.ts`）：静态`[claude-code, codex, opencode]`加上一个运行时叠加层（`registerSessionSource` / `unregisterSessionSourcesByPlugin`），由`pluginId`追踪，命名空间`${pluginId}:${id}`，静态胜利——完全ADR-0051形状。
- **FS**：`SessionFs`（超集 的 `ExternalFs` 41，加`readTextFile`）对 `lib/file/file-operations.ts`;递归`walkFiles`用于日期嵌套的Codex树。仅限桌面扫描;file/folder拣选器回退在线上运行。
- **OpenCode SQLite**：只读Rust 命令 `opencode_sessions_read`（`src-tauri/src/session_import.rs`、`rusqlite`、模式容忍）返回归一化会话;TS适配器会映射它们（同时解析拣选路径中的共享导出JSON）。
- **插件扩展点**：`ctx.import.registerSessionSource(adapter)`（命令式双元，`lib/plugin/api/import-api.ts`）将插件ID委托到覆盖层，并返回一个处理器——插件可以添加代理（OpenCode变体、光标、Cline等），无需更换主机。
- **UI**：`SessionImportDialog`（设置→数据→域传输）+ `useSessionImport`状态机（空闲→扫描→列表→导入→完成）。桌面会自动扫描所有来源;网页选择文件。进口的录音会进入主`ChannelList`。

## 后果

- Claude Code、Codex和OpenCode历史作为一流、可连续的对话导入，由现有流水线渲染，无需更改渲染器。
- 添加新代理是一个静态适配器（或一个调用`ctx.import.registerSessionSource`的插件）——注册表、规范目标、持久化汇、FS和UI共享。
- 续写通过标准`branchSeed`路径，因此在第一次发送时有**PII编辑门禁**。
- 增量/监听重导入、声明式 `sessionImporters` manifest 桥接、图重建与 11 个 first-party source 已交付。没有公开表达的来源私有运行态会记录为明确 loss，而不是虚构 canonical 字段。
- ADR-0107 将本会话导入器与设置、技能、子智能体、MCP、命令和记忆组合到统一迁移向导中；本注册表仍是会话导入的权威实现。

## 验证

Jest（`lib/session-import`、`hooks/session-import`、`components/session-import`、`lib/plugin/api/import-api`）绿色;Rust `cargo test --lib session_import` 3/3;排版检查 / ESLint / `lint:i18n` 对等性清洁;六个项目审计员（测试间隙、I18N、静态导出、Tauri-Rust、PII-门禁、布线）都清理干净——布线审计员确认注册表、`ctx` API、对话和Rust 命令均可运行时联系。

## 2026-08-29 修订 —— canonical graph 与原生恢复

`CanonicalSession` 继续使用 version 1，并增加可选的来源溯源、runtime binding、lineage、lifecycle、
更完整的 turn/tool/usage、task、plan/goal、checkpoint、历史操作与 inter-agent message。未知上游事件
会保存为有界、脱敏 diagnostic，并生成精确 loss entry；适配器可以忽略未知字段，但不能静默丢弃未知事件。

所有内建来源都实现 `parseGraph`。旧插件的 `parseSession` 仍可读取，会被包装为扁平且明确降级的图。
registry 派生的来源集合为 Claude Code、Codex、OpenCode、Gemini CLI、Continue、Aider、Pi、
Cursor、Cline、Copilot CLI 与 Qwen Code。

重导入 digest 覆盖消息内容、parts、tool state、关系与 lifecycle。`source-mirror` 跟随 rewind 与删除，
tombstone 消失的 child，并保留本地装饰；在 Cognia 续聊后转为 `cognia-owned`。原生恢复要求匹配
preset 已存在、runtime 已连接且可执行、`session/resume` 经实时验证、cwd 存在且握手成功；只有之后才
转为 `native-bound`，执行时复用已验证的 native id。系统不会自动创建 preset、凭据或命令。

Cursor 云端/后台历史，以及 Kiro、Droid、DeepSeek Harness 等没有稳定公开格式的来源仍不在导入范围；
其 runtime preset 会单独出现在自动生成的 support matrix 中。
