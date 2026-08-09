---
title: "ADR-0062 — 外部智能体会话历史导入（Claude Code · Codex · OpenCode + 插件）"
description: "一种可扩展的机制，将外部编码代理会话历史从磁盘导入Cognia作为连续对话。提供第一方适配器，支持Claude Code、 Codex 和 OpenCode，并开放插件扩展点，方便添加新代理而无需更换主机。记录磁盘格式研究和适配器注册表设计。"
---

# ADR-0062 — 外部智能体会话历史导入（Claude Code · Codex · OpenCode + 插件）

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
- 增量/监听重新导入、声明式 `sessionImporters` 清单桥接以及子智能体树重建现已交付。仍不在范围内的是 Cursor/Cline/Gemini-CLI 第一方适配器，以及无法映射到 Cognia 规范模型的来源私有运行时状态。
- ADR-0107 将本会话导入器与设置、技能、子智能体、MCP、命令和记忆组合到统一迁移向导中；本注册表仍是会话导入的权威实现。

## 验证

Jest（`lib/session-import`、`hooks/session-import`、`components/session-import`、`lib/plugin/api/import-api`）绿色;Rust `cargo test --lib session_import` 3/3;排版检查 / ESLint / `lint:i18n` 对等性清洁;六个项目审计员（测试间隙、I18N、静态导出、Tauri-Rust、PII-门禁、布线）都清理干净——布线审计员确认注册表、`ctx` API、对话和Rust 命令均可运行时联系。
