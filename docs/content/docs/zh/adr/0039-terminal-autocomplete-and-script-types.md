---
title: ADR-0039 — 集成终端 Phase 4 — 仿 Copilot 的 AI 自动补全、脚本类型运行器、插件补全提供方
description: "Phase 4 把集成终端（ADR-0031/0033）升级为有 AI 辅助的开发终端。(1) 仿 GitHub Copilot 的内联自动补全：在 shell 提示符下输入时，经防抖的建议以暗色 ghost text 显示在光标后，Tab/→ 接受（把后缀写入 PTY —— 绝不自动执行），Esc 取消。引擎是渲染层纯函数（行缓冲模型、提供方注册表、排序、prompt 构造），内置离线历史提供方 + 内置 LLM 提供方（由开关 + PII 脱敏门控）。(2) 脚本类型运行器：按扩展名/shebang 映射到正确的解释器（.sh→bash、.ps1→pwsh -File、.py→python3 …）。(3) 全部暴露给插件：ctx.terminal 新增 registerCompletionProvider / runScript / detectScriptType，新增 terminal:completion 权限，以及接入 module-bridge 派发的 terminalCompletionProviders 清单懒加载桥。"
---

# ADR-0039 — 集成终端 Phase 4

**状态**：已接受（2026-06-01）
**作者**：Max Qian + Claude Opus 4.8
**关系**：扩展 ADR-0031 + ADR-0033（不替代）；落地 ADR-0033 遗留项 #4（“AI 命令辅助 —— 已设计、未实现”）

## 背景

ADR-0031/0033 已交付完整的集成终端（xterm.js dock、`portable-pty` 后端、OSC 633 标记、移动端 WS 传输、分屏、命令导航、重载恢复、链接跳编辑器），并已提交一波 shell 体验打磨（shell 选择器、启动配置、配色、渲染选项、UTF-8 代码页修复）。仍有两处缺口：

1. **没有命令辅助**：ADR-0033 遗留项 #4 明确推迟了“dock 内 AI 命令辅助（解释报错 / 建议修复）”。
2. **不认识脚本类型**：运行脚本文件需要用户自己写出解释器；终端只认 shell *二进制*，不认 *脚本类型*。

同时项目的横切规则要求终端能力必须暴露给插件（`ctx.terminal` 已有 `spawn/write/kill/onData/readRecent/list`）。

本阶段交付仿 Copilot 的内联自动补全、脚本类型运行器，以及二者的插件接口 —— 并在隐私与权限上做足。

## 决策

### D1 — 渲染层纯函数补全引擎（`lib/terminal/completion/`）

凡是能脱离 React + xterm 的环节都做成纯函数，便于单测：

- **`line-buffer.ts`** —— 仅凭 xterm `onData` 的击键流，对*当前输入行*做尽力而为的建模。真正的行编辑发生在 shell（readline/PSReadLine）并以*输出*回显（我们无法可靠读取），所以维护一个平行模型：可打印片段在光标处插入；退格 / Ctrl-U/K/W 编辑；方向键移动；回车/Ctrl-C 重置。关键在于：任何我们*无法*建模的输入 —— 历史回溯（↑/↓）、shell tab 补全、反向搜索、bracketed paste —— 都会把行标记为 `tracked: false`，在下一个提示符边界前抑制建议。这是防止过期 ghost 覆盖错误内容的安全阀。
- **`prompt.ts`** —— 纯 prompt 构造（shell、平台、cwd、近期命令、部分输入）+ `sanitizeCompletion`（剥离代码围栏/反引号/提示符回显，取首行，保证结果是输入的延续）。`ghostSuffix` 计算光标后显示的暗色文本。
- **`registry.ts`** —— 模块级提供方注册表（仿 `extension-api`）。`getCompletions` 在每提供方超时 + 错误隔离下并发扇出，合并、按文本去重，并按 `plugin > ai > history`、再按分数排序。
- **`history-provider.ts`** —— 内置、离线、始终可用：前缀匹配会话近期命令历史，是未配置模型时的优雅降级路径。
- **`ai-provider.ts`** —— 内置 LLM 提供方（Copilot 大脑）。构造 prompt，在任何模型调用前用 `hasNoLeakingPii` 对拼装的上下文做 **PII 门控**，按 `(shell, cwd, input)` 短 TTL 记忆（含负缓存），并在调用方信号已 abort 时丢弃结果。
- **`controller.ts`** —— 脱离 React 的编排大脑：消费击键、防抖查询、在输入仍匹配时保留有效建议（不重复查询）、防过期异步结果，并暴露 `accept()`（返回要写入的后缀 —— 绝不自动提交）/ `dismiss()` / `reset()` / `getView()`。
- **`builtins.ts`** —— 一次性（幂等）注册两个宿主提供方，各自按惰性读取的 `source` 设置门控，加上 `buildAutocompleteContext`（store 行 + 输入 → 上下文）。

### D2 — React 胶水刻意保持轻薄

`hooks/terminal/use-terminal-autocomplete.ts` 把 controller 接到设置 + 终端 store 与 LLM 工具客户端（`buildUtilityLlmClient`），并注册内置提供方。`components/terminal/terminal-ghost-text.tsx` 是纯展示层覆盖物（`pointer-events: none`、继承终端字体），定位在 xterm 光标处。`terminal-instance.tsx` 把 `onData` 片段喂给 hook、渲染覆盖物、在 `attachCustomKeyEventHandler` 里拦截 **Tab/→ 接受**、**Esc 取消**（无建议时放行，使 Tab 仍到达 shell、→ 仍移动光标），并在 OSC 633 `prompt_start` / `command_start` 重置行模型。

接受时后缀直接经 `session.write` 写入 —— 而非经 `onData` —— 故不会重复喂入，也绝不替用户按回车。

### D3 — 隐私与权限严谨度

- AI 来源**默认关闭**（`terminal.autocomplete.enabled`），`source` 为 `history | ai | both`（默认 `both`）。仅历史完全离线。
- 任何模型调用前，拼装的上下文（部分命令 + cwd + 近期历史）都过共享的 `hasNoLeakingPii` 门；检测到 API key / 令牌 / 凭据 / 邮箱 / 卡号则静默跳过 —— 终端上下文绝不外泄给模型。
- 未配置模型时 `buildUtilityLlmClient` 返回 null，AI 提供方降级为空（历史仍可用）。
- 接受只填充行；用户仍需按回车。无自动执行。

### D4 — 脚本类型运行器（`lib/terminal/script-runner.ts`）

`detectScriptType(path, { shebang, platform })` 把文件映射为 `{ kind, interpreter, interpreterArgs }`：`#!` shebang（解析，含 `/usr/bin/env prog`）优先，否则按扩展名（`.sh`→bash、`.ps1`→`pwsh -NoLogo -File`、`.py`→`python3`/`python`、`.js`→node、`.ts`→tsx、`.rb`/`.pl`/`.php`/`.lua`/`.nu`/`.R`、`.bat`/`.cmd`→`cmd /c`）。`buildScriptSpawnRequest` 把它变成 dock 能 spawn 的 `SpawnRequest`。渲染层新增 `ShellKind` + `detectShellKind`，对齐 Rust `ShellKind::from_shell_path`，使两侧的 shell 感知一致。

### D5 — 完整插件暴露

- **`ctx.terminal`**（`lib/plugin/api/terminal-api.ts`）新增 `registerCompletionProvider`（`terminal:completion` 门控）、`runScript` + `detectScriptType`（`terminal:spawn` 门控），复用同样的归属校验 dock 原语。
- **新增权限 `terminal:completion`** —— 非危险级（提供建议并读取在输入中的命令行；敏感但不破坏性，类同 `git:read`）。加入权限联合、`PERMISSION_GROUPS`、`PERMISSION_DESCRIPTIONS`、`validation.ts` 的 `VALID_PERMISSIONS`，以及 Rust `cognia plugin lint` 白名单。
- **清单 `terminalCompletionProviders`** —— 惰性 `{ id, label, entry, export, priority }` 工厂，由 `lib/plugin/bridge/terminal-completion-bridge.ts`（仿 `ai-providers-bridge`）解析，并接入 `MODULE_BRIDGE_CAPABILITIES` 派发，使其在启用/禁用时真正触发。桥的适配器 + `registerPluginCompletionProvider` 同时支撑声明式与命令式（`ctx.terminal.registerCompletionProvider`）两条路径，卸载时一并清理。

### D6 — 设置与 i18n

`AppSettings.terminal.autocomplete`（`{ enabled, source, debounceMs }`）驱动终端设置卡里的“AI 命令自动补全”分组（开关 + 来源选择 + 防抖 + 一段隐私说明，明确说明发送给模型的内容）。新 i18n 键落入 `en.json` 与 `zh-CN.json`（`terminal.ghost.acceptHint`、`settings.terminal.autocomplete.*`）；`pnpm lint:i18n` 校验一致。

## 测试覆盖

按文件就近测试（CLAUDE.md 规则 #3，新代码 ≥90%）：

- 引擎：`line-buffer`(29)、`prompt`(18)、`registry`(12)、`history-provider`(6)、`ai-provider`(8)、`controller`(10)、`builtins`(4)。
- 脚本：`script-runner`(24) + `shell-detect`(`detectShellKind`)。
- 插件：`terminal-api`（扩展）、`terminal-completion-bridge`(12)、`module-bridge-map`（计数锁 11→12）、`permission-guard`/`validation`（terminal:completion）。
- React：`terminal-ghost-text`(4)、`use-terminal-autocomplete`(4)、`terminal-instance`（扩展 —— 7 个自动补全集成测试）、`terminal-card`（扩展 —— 3 个）。

全绿；`pnpm lint:i18n` 绿。树中仅有的 `tsc` 报错是无关的并行在建工作（`perf-api`/`connectors-api`）中已存在的问题。

## 文件清单

**新增**：`lib/terminal/completion/{types,line-buffer,prompt,registry,history-provider,ai-provider,controller,builtins}.ts`（+测试）、`lib/terminal/script-runner.ts`（+测试）、`hooks/terminal/use-terminal-autocomplete.ts`（+测试）、`components/terminal/terminal-ghost-text.tsx`（+测试）、`lib/plugin/bridge/terminal-completion-bridge.ts`（+测试）、`types/plugin/plugin-terminal-completion.ts`、本 ADR（en + zh）。

**扩展**：`lib/terminal/shell-detect.ts`（+`ShellKind`/`detectShellKind`）、`components/terminal/terminal-instance.tsx`、`components/settings/terminal/terminal-card.tsx`、`lib/plugin/api/terminal-api.ts`、`lib/plugin/contracts/module-bridge-map.ts`、`lib/plugin/core/validation.ts`、`lib/plugin/security/permission-guard.ts`、`types/plugin/plugin.ts`、`lib/claude/types.ts`、`crates/cognia-cli/src/cmd_lint.rs`、两个 i18n 文件。

## 明确推迟的后续

1. **Ghost text 像素对齐** —— `cursorPixelPosition` 读取 xterm（内部）渲染服务的单元尺寸；在 DOM 渲染器或首帧前返回 null，覆盖物不显示。公开 API 测量路径会更稳。
2. **内联报错解释 / 修复** —— ADR-0033 #4 的另一半（解释失败命令、建议修复）是自然的下一个提供方，本期未做。
3. **移动端自动补全** —— WS 传输目前不下发 OSC 633（ADR-0031 #2），且软键盘下 ghost text 价值有限，推迟。
4. **更多脚本类型 / shell** —— elvish、tcsh、xonsh 等各需一条映射项（OSC 633 还需一份 Rust shell-integration 脚本）。
