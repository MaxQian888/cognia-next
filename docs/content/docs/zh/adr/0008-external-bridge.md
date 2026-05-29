---
title: "0008 — 外部桥接（LLM Wiki + MCP 服务器）"
description: "Cognia 通过一个可选开启的 MCP 服务器，把自身的知识暴露给外部编码 agent，底层由一份自动生成的代码 wiki 支撑。"
---

# ADR 0008 — 外部桥接（LLM Wiki + MCP 服务器）

**状态：** 已实现（Phase 1 MVP——2026-05-04）
**实现者：** External-Bridge MVP，分支 `feat/external-bridge-phase1`

## 背景

cognia-next 与 LLM 编码 agent 生态有三个不对称的集成
表面：

1. **出站**——对 ACP / OpenCode / Anthropic
   SDK 的完整客户端覆盖，使 Cognia 能把 Claude Code、Cursor 等
   作为子 agent 驱动。
2. **进程内插件**——位于 `lib/plugin/` 的丰富插件系统，
   带有工具/模式/钩子/市场。
3. **入站**——_什么都没有_。外部 agent 没有任何途径查阅
   Cognia 的知识：既无法访问数字孪生运行时数据，也无法访问已安装的
   技能/角色，甚至（由于没有 wiki 存在）连
   Cognia 自身源码的形态都看不到。

这种不对称很重要，因为用户在 Cognia _之外_ 运行的每一个 LLM 编码 agent
（他们日常的 Claude Code 会话、内嵌的 Cursor
助手）都隐式地对 Cognia 已为用户提炼好的一切处于盲视状态。
反转流向——给这些 agent 一个对 Cognia 的只读窗口——就能闭环，
而不必强迫它们活在 Cognia
外壳之内。

业界向 **Model Context Protocol**（MCP）的收敛使
线路格式的选择显而易见。阅读两个参考系统直接
塑造了设计：

- **DeepWiki**（Cognition Labs）——为每个仓库预先生成结构化
  Markdown + 一小组 MCP 工具（`read_wiki_structure`、
  `read_wiki_contents`、`ask_question`）——印证了「以 wiki 内容
  作为规范检索底座」的模式。
- **zilliztech/claude-context**——完整生命周期的 MCP 表面
  （`index_codebase`、`search_code`、`clear_index`、`get_indexing_status`）
  展示了「用户拥有流水线」相对于 DeepWiki 只读模式的正确形态。

我们选择了混合方案：预先交付**读**的一半（DeepWiki 形态），
把入站**写**的一半推迟到 Phase 4（届时它与消费外部 agent
对话记录的提炼流水线配对）。

## 决策

构建一个自包含的「External Bridge」子系统，它：

1. **在索引时为 Cognia 自身源码生成一份 wiki**，存放
   在 4 张新的 Dexie 表中（v17）。编排器复用现有的
   数字孪生摄取分块器（`lib/twin/ingest/chunk.ts:prepareChunks`），但
   **不**复用数字孪生的提炼流水线——wiki 文章不是
   「待审草稿」，它们是持久化的产物。
2. **通过 `lib/external-bridge/` 下的桥接，把 wiki + Cognia 运行时实体经由 MCP 暴露出去**。
   工具与资源由一个 OptIn 白名单
   把关；默认安装只允许
   `wiki:cognia` + `rag:cognia`（仅公开代码）。
3. **在 Phase 1 交付 stdio 传输**；HTTP 传输会在
   Phase 1.5 / 2 接入 Tauri Rust 路径（基于 axum）时落地。
   我们刻意避开 Next.js `app/api/mcp` 路由，因为
   `next.config.ts:output:"export"`（Tauri 构建所必需）会丢弃
   服务器运行时——见计划中的 R1。
4. **在 `mcpAuditLog` 中存储逐次调用的审计日志（上限保留最新 5000 条）**，
   这样用户可以看到外部 agent 一直在问些什么。

### 架构

```
                 ┌────────────────────────────────────┐
                 │      Cognia Tauri / Web App         │
                 ├────────────────────────────────────┤
External Agent   │  lib/external-bridge/mcp-server     │
(Claude Code,    │     server.ts ── McpServer SDK      │
 Cursor, …)      │     transport-stdio.ts              │
                 │     standalone-entry.ts (node CLI)  │
       ──MCP────►│                                     │
                 │  lib/external-bridge/handlers/      │
                 │     wiki / rag / runtime / resources│
                 │     ↓                               │
                 │  lib/external-bridge/permission-gate│
                 │     ↓                               │
                 │  lib/wiki/orchestrator.ts ──────────┤
                 │     RepoMap + ModuleArticle +       │
                 │     CrossRef + IndexPage agents     │
                 │     ↓                               │
                 │  Dexie:wikiArticles + wikiSections  │
                 │        wikiManifest + mcpAuditLog   │
                 └────────────────────────────────────┘
```

### MCP 表面

工具（Phase 1）：

- `wiki_search(query, scope?, k?)` → 前 K 条文章摘要
- `wiki_read(slug)` → 完整 Markdown + sourceRefs
- `rag_search(query, scope?, k?)` → 章节级分块（类 BM25）
- `runtime_query(entityType, op, id?, filter?)` → 对
  skill / character / twin / plugin / agent-team 的 list/get

资源（Phase 1）：

- `cognia://wiki/<slug>`
- `cognia://skill/<id>`（渲染为 SKILL.md）
- `cognia://character/<id>`（JSON）

权限作用域（除前两项外默认 OFF）：

- `wiki:cognia`、`rag:cognia` ← Phase 1 默认 ON
- `wiki:user-repo`、`rag:user-repo` ← Phase 3
- `runtime:skills`、`runtime:characters`、`runtime:twins`、
  `runtime:plugins`、`runtime:agent-teams` ← 用户选择开启

### Wiki 生成流水线

```
file walker → merkle diff → twin chunker → repo-map agent
            → module-article agent (one LLM call per module)
            → cross-ref agent (insert [[slug]] links)
            → persist to wikiArticles + wikiSections
            → index-page agent → exporter (optional) → docs/.mdx
```

Phase 1 中 `RepoMapAgent` 里的 PageRank 是基于体量的启发式
（对 `index.ts` / `page.tsx` / `mod.rs` 加权）；带 tree-sitter
导入图的完整个性化 PageRank 推迟到 Phase 2。

## 后果

**正面：**

- 外部 Claude Code 会话可以问「Cognia 的数字孪生
  提炼是怎么工作的？」并得到带 file:line 引用的有据答案。
- 对 Cognia 自身运行时零开销——桥接只在
  用户在设置中启用它时才启动。
- 默认拒绝 + 按作用域 OptIn 让用户内容默认
  保持私密；除非用户明确为某个实体族系切换
  作用域，否则什么都不会泄漏。
- 审计日志让「外部 agent 问了什么？」可被检查，
  而无需翻查 agent 侧的日志。
- 复用了数字孪生摄取分块器 + LlmClient，因此我们没有分叉
  embedding/LLM 表面。

**负面：**

- 新增了一个依赖（`@modelcontextprotocol/sdk`），我们现在需要
  跟踪它的升级波动。
- 两块非平凡的工作被推迟到后续阶段：
  - HTTP 传输（Rust hyper/axum，计划中的 M3）
  - 入站写工具 + IDE 日志扫描器 + 网页抓取（Phase 4–6）
- Wiki 内容是 LLM 生成的 → 质量取决于 prompt + 模型。
  CrossRefAgent 的硬校验（`findDeadLinks` 在断链时抛错）
  能捕获结构性 bug，但捕获不了事实性错误。

**中性：**

- 设置 UI 原本拆成的 5 个子组件被合并成
  单个 `external-bridge-section.tsx`（约 250 行）。当 UI 增长
  超过一屏时再做按组件重构。

## 新增文件（Phase 1）

- `types/wiki/index.ts`
- `lib/db/{wiki-articles,wiki-sections,wiki-manifest,mcp-audit-log}.ts`
- `lib/db/schema.ts`（新增 v17 stores；无需 upgrade 钩子——
  新表是纯增量）
- `lib/external-bridge/{types,permission-gate,token,audit-log}.ts`
- `lib/external-bridge/handlers/{wiki,rag,runtime,resources}.ts`
- `lib/external-bridge/mcp-server/{server,transport-stdio,standalone-entry}.ts`
- `lib/wiki/{file-walker,merkle,types,prompts,orchestrator,exporter}.ts`
- `lib/wiki/agents/{repo-map-agent,module-article-agent,cross-ref-agent,index-page-agent}.ts`
- `components/settings/external-bridge/external-bridge-section.tsx`
- `components/settings/settings-nav-config.ts`（新增 `external-bridge`）
- `components/settings/settings-shell.tsx`（路由 case）
- `i18n/messages/{en,zh-CN}.json`（每个 locale 3 个键）
- `CLAUDE.md`（External Bridge 章节）
- `lib/claude/types.ts`（新增 `AppSettings.externalBridge`）

合计：41 个源文件 + 21 个同目录测试文件；横跨
24 个测试套件的 349 个测试全绿。

## 已推迟（Phase 2+）

- **Phase 1.5/M3**：Tauri Rust HTTP MCP 服务器（`src-tauri/src/mcp_server/{http_server,sidecar,ipc_to_main,commands}.rs`）。
  向 `src-tauri/Cargo.toml` 新增 `axum` + `hyper` crate。
- **Phase 2**：`packages/claude-code-plugin/`——以 npm 分发的
  插件外壳，捆绑 MCP 服务器二进制 + 技能 + 斜杠
  命令 + agents。
- **Phase 3**：用户仓库 wiki——同一条编排流水线，
  `scope: "user-repo"`，附带添加仓库的设置 UI。
- **Phase 4**：入站写工具（`record_lesson`、`save_skill_draft`、
  `ingest_note`）+ `inboundDrafts` 表 + `InboundDistiller`。
- **Phase 5**：被动 IDE 日志扫描器（`~/.claude/projects/`、
  Cursor 历史、Cline 日志）。
- **Phase 6**：在现有 `lib/scheduler/` cron 上运行的网页爬虫
  （awesome-claude-code、Anthropic 文档 RSS、
  MCP 服务器注册表）。

## 遗留风险（继续跟进）

- **R1**（已解决）：HTTP MCP 绝不能放在 `app/api/mcp` 下——
  Tauri 的静态导出排除了 API 路由。决策是 Rust hyper。
- **R2**：Node 独立包中的 Dexie。Phase 2 插件打包
  在运行时需要 `fake-indexeddb`（已是 devDep），或者一个
  以 `better-sqlite3` 为后端的 Dexie 适配器。
- **R3**：完整 wiki 重建成本。约 15 万行代码 × N 个模块，每次调用 8K 输入
  / 2K 输出令牌 ≈ 每次重建 5–15 美元。设置 UI 会显示
  一个确认对话框；增量刷新是默认。
- **R7**：wiki 内容中的提示注入。缓解：写工具
  默认 OFF；经 MCP 返回时 wiki 内容用 `<untrusted_content>` 标签
  包裹（Phase 4）。

完整计划 + 进度日志见
`~/.claude/plans/llm-wiki-cognia-claudecode-agent-sleepy-moonbeam.md`。
