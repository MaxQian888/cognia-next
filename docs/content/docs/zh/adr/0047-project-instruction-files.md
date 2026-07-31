---
title: ADR-0047 — 项目指令文件
description: "为内置 Agent 增加磁盘指令文件加载：在活动工作区中发现 AGENTS.md / AGENT.md / CLAUDE.md，支持可配置的嵌套遍历（分层向上累加，Claude Code；或最近命中，opencode）、全局用户文件、.cognia/instructions/ 目录、递归 @import 展开，并接线此前休眠的 markdown-agents 解析器到 .cognia/agents/*.md 项目子代理。"
---

# ADR-0047 — 项目指令文件

**状态**：已接受（2026-06-09）
**作者**：Max Qian + Claude Opus 4.8
**承接**：ADR-0030（角色/人格提示栈）与 `lib/claude/build-options.ts` 中的 `resolveSendOptions` 装配；复用 ADR-0044/0046 确立的"纯解析器 + Tauri 读取器"拆分（`lib/lsp/resolve-config.ts` + `project-file-reader.ts`）
**影响**：`lib/claude/instructions/*`（新模块）、`lib/claude/build-options.ts`、`lib/claude/types.ts`（`AppSettings.instructions`、`Character.instructionsOverride`）、`lib/claude/agents/markdown-agents.ts`（现已接线）、`components/settings/instructions/instructions-card.tsx`（新增）、`components/settings/general-section.tsx`、`i18n/messages/{en,zh-CN}.json`

## 背景

内置 Agent 的系统提示完全由应用内来源装配——角色提示、人格、技能、模式、Twin、记忆——却**对磁盘上的指令文件视而不见**。Claude Code 与 opencode 用 `CLAUDE.md` / `AGENTS.md` 约定为项目（及每个子目录）提供常驻指令，而这套约定被忽略：打开一个带根级 `CLAUDE.md` 的真实工作区，对 Agent 毫无影响。

markdown 子代理的解析+合并层（`lib/claude/agents/markdown-agents.ts`）虽已存在却**处于休眠**——其文档字符串自己写道"文件系统发现是注入进来的……Tauri/全局目录的接线在调用点"，而这段接线从未实现。于是 `.cognia/agents/*.md` 项目子代理也从未加载。

## 决策

新建 `lib/claude/instructions/` 模块，采用**纯逻辑、fs 注入的核心**（完全可单测）+ **薄 Tauri 适配层**——与 LSP 解析器同款拆分，使发现/合并逻辑从不直接引用文件系统，真实 I/O 复用 `lib/file/file-operations.ts`（`exists`/`readDir`/`readText`，已对 web/mobile 安全 → 非 Tauri 返回空/false）。

### 发现（`discover.ts`）

产出有序、去重的文件列表，**最低优先级在前**，使靠近 cwd 的块凭"就近"覆盖较早的块：

1. **全局**用户文件——显式 `globalPath`，否则取首个存在的 `~/.cognia/{AGENTS,AGENT,CLAUDE}.md`。
2. **祖先文件**——`mode: "layered"`（Claude Code）从工作区根到 cwd 收集每一个指令文件；`mode: "nearest"`（opencode）在首个含文件的祖先目录停止。同目录优先序为 `AGENTS.md > AGENT.md > CLAUDE.md`（可配置）。遍历以所属工作区根为边界，否则退化为带深度上限的向上攀爬，使错误的 cwd 永不触发全盘扫描。
3. 每个根下的 **`.cognia/instructions/*.md`**。
4. **`extraPaths`**——opencode 风格的 `instructions[]`：相对路径加一个简单的末尾 `*.md` glob（无 globbing 依赖）。

去重用以大小写归一化绝对路径（Windows 感知）为键的 `Set`——这正是 opencode/Claude Code 的规范守卫。路径运算放在 `paths.ts`——无依赖助手，其分隔符跟随**输入串**（`C:\proj` 的 cwd vs `/home/x` 的 cwd），避开 Node 的 `path`（在静态导出/移动端打包中被打桩）。

### 导入（`imports.ts`）

`@path` 引用递归展开（Claude Code 特性，opencode 缺失）：相对于文件所在目录解析，先展开其自身的导入再内联，由 `seen` 集合（循环）与 `maxDepth` 守卫。围栏代码块内的 `@` 记号被忽略，读不到对应文件的记号原样保留——因此 `user@host` 之类文本永不触发探测。

### 渲染 + 加载（`render.ts`、`load.ts`）

文件渲染为带标签的 `## <相对路径>` 块，以 `\n\n---\n\n` 连接，`maxFiles` / `maxFileBytes` 上限会**告警**而非静默截断。`load.ts` 在一个 per-`(cwd+config)` 记忆缓存（3 秒 TTL、`clearInstructionCache()`）后编排 发现 → 读取 → 展开 → 渲染 → 子代理发现，因为 `resolveSendOptions` 每轮都跑，绝不能每次发送都重走目录树。非 Tauri 或禁用 → 空。

### 项目子代理（`discover-agents.ts`）

跨各根加全局 agents 目录遍历 `.cognia/agents/*.md`，产出既有 `buildMarkdownAgents` 消费的 `MarkdownAgentFile[]`——全局在前、**主根在最后**，使项目的 `.cognia/agents/foo.md` 在 id 冲突时胜出。

### 接线（`build-options.ts`）

`cwd` 解析上提到系统提示装配之前；发现的 `instructionSection` 加入**稳定提示前缀**（在 base/人格之后、记忆之前），使供应商提示缓存持续命中。它在 `--bare` 下跳过（不做磁盘自动发现，Claude Code 一致），并在 `workflow-editor` 会话中自然被丢弃（该路径整体覆写提示）。发现的子代理在 registry/template 子代理**之后**并入 `opts.agents`，使项目胜出。配置解析为 `Character.instructionsOverride ?? AppSettings.instructions ?? 默认值`，由新增的双语「项目指令」设置卡呈现。

## 后果

- 工作区的 `CLAUDE.md` / `AGENTS.md`——包括逐目录嵌套文件与 `@import` 片段——现已抵达 Agent，契合用户已有的 Claude Code / opencode 心智模型。
- 项目可以 `.cognia/agents/*.md` 形式自带子代理，激活了一个"已建成却惰性"的解析器。
- 一切均为尽力而为，且在 web/mobile 上惰性无害（无项目文件系统）；加载失败绝不阻塞发送。
- 本轮取舍：仅本地路径/glob（不支持 opencode 的远程 URL `extraPaths`）；不做逐消息"读文件时就近注入 AGENTS.md"（目录遍历已覆盖嵌套需求）；GEMINI.md / `.cursorrules` 文件名不在范围内。真实桌面壳（Tauri）对 home 目录与任意根读取的 smoke 验证仍待完成。
