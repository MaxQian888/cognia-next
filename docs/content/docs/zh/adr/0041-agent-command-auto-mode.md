---
title: ADR-0041 — Agent 命令自动模式（规则 + 小模型安全闸）
description: "为内置 Agent 的命令调用模块补全：OpenCode 式的权限通配规则集 + OpenClaw 式的自动批准闸——一个确定性命令安全分类器（复合命令 + 提权感知）自动放行安全命令并拒绝灾难性命令，可选的小模型裁判处理不确定的中间地带，休眠的通配规则集被接入 sidecar canUseTool，整套策略通过 ctx.terminal 暴露给插件。"
---

# ADR-0041 — Agent 命令自动模式

**状态**：已接受（2026-06-01）
**作者**：Max Qian + Claude Opus 4.8
**基于**：`feat/agent` 中休眠的通配规则集与终端子系统（ADR-0031/0033/0039）
**影响**：`lib/claude/permissions/*`（新增）、`lib/claude/build-options.ts`、`lib/claude/types.ts`、`sidecar/dispatch/{anthropic,permission-resolver}.mjs`、`hooks/chat/use-claude-chat.ts`、`lib/plugin/registries/command-safety-registry.ts`（新增）、`lib/plugin/api/terminal-api.ts`、`lib/plugin/{core/manager,core/validation,security/permission-guard}.ts`、`types/plugin/plugin.ts`、`crates/cognia-cli/src/cmd_lint.rs`、`components/settings/agent-runtime/command-auto-mode-card.tsx`（新增）、`i18n/messages/{en,zh-CN}.json`

## 背景

当内置 Agent 执行 Shell 命令（`Bash`，或 sidecar 内置工具 `shell_execute_advanced` / `start_process`）时，渲染端的 `permission_request` 处理器总是弹出手动批准框（除非该工具在用户的「始终允许」列表里）。没有任何自动安全判断：`git status` 和 `rm -rf /` 弹出完全一样的提示。同时，一个 OpenCode 启发的权限**规则集**模块（`lib/claude/permissions/ruleset.ts`，`工具 → 通配 → allow|ask|deny` 解析器）虽然写好且自带测试，却**从未被任何地方引用**——处于休眠状态。

目标：为 Agent 的命令调用模块补全一个真正的**自动模式**，仿照 OpenCode 与 OpenClaw 的执行闸自动判断命令安全性，且不削弱既有的批准路径，并把整套机制暴露给插件。

### 两个参考实现的真实做法

- **OpenCode**——纯通配匹配，无模型。`Permission.evaluate` 把复合命令（`&&`、`|`、`;`）拆成片段，逐段匹配 `工具 → 通配 → allow|ask|deny` 规则（最具体/最后匹配胜出），任一片段被拒则整条命令被拒。
- **OpenClaw**——exec-approvals：默认拒绝的闸门，组合工具策略 + 白名单 + 可选用户批准，并绑定规范化执行上下文（cwd、argv、固定路径）。

本 ADR 取 OpenCode 的分段通配规则集，加上一个确定性安全分类器（让用户无需为显而易见的情况手写规则），再为不确定的中间地带叠加**可选的小模型裁判**——即任务要求的「小模型或者规则」。

## 决策

两层设计。纯函数核心位于 `lib/claude/permissions/`（全部单测覆盖）；两个执行点做薄接线。

### 纯核心（`lib/claude/permissions/`）

- **`command-parse.ts`**——`splitCommandSegments`：引号与括号深度感知的分词器，把命令行拆成头命令片段，并递归进入 `$(...)`/反引号替换与 `(...)` 子 shell，使隐藏的 `echo $(rm -rf /)` 仍能暴露出 `rm`。
- **`command-safety.ts`**——`classifyCommand`：确定性规则层。逐段对头命令做 SAFE/ASK/破坏性集合分类，git/npm/cargo 子命令感知（`git status` 放行，`git push` 询问），`sudo`/`env`/`timeout` 包装解包并提权升级，`rm -rf <关键路径>`/`dd of=/dev/…`/`mkfs`/管道入 shell/fork 炸弹的灾难扫描，以及 curl 启发式（GET 放行，带数据/POST/-o 询问）。整条链取最坏结果。
- **`command-judge.ts`**——`judgeCommandSafety`：可选模型层。廉价后台 `LlmClient`（与标题生成同源的 `buildUtilityLlmClient`）返回严格 JSON `{safe, risk, reason}`。**PII 门控**（`hasNoLeakingPii`）——含密钥的命令绝不发送。按命令缓存；任何失败返回 null。
- **`auto-mode.ts`**——`evaluateAutoDecision`：按权威从高到低编排三个来源——显式用户/插件规则 → 确定性分类器 → 模型裁判——产出 `allow`/`ask`/`deny`。任何不确定都落到 `ask`（安全默认）。
- **`ruleset.ts`**（激活）——新增 `resolvePermissionDetailed`（报告胜出层级）与 `resolveBashPermission`（复合命令感知、仅显式匹配），让休眠模块终于被消费。
- **`command-from-tool.ts`** / **`auto-mode-runner.ts`**——把工具调用映射到命令串并据设置运行自动模式；让聊天 hook 的改动极小且可测。

### A 层——sidecar 静态规则集（`canUseTool`）

`build-options.ts` 把用户的 `agentPermissions.commandRules` 序列化进 `SendOptions.permissionRuleset`。`sidecar/dispatch/permission-resolver.mjs`（`ruleset.ts` 的 JS 镜像，**仅显式匹配**——没有会绕过一切批准的 `*: allow` 兜底）在 `canUseTool` 中被查询：显式 `allow` 不经往返直接运行，显式 `deny` 直接拒绝，其余落回正常 `permission_request`。任何错误均 fail-open。

### B 层——渲染端自动模式（`permission_request`）

在 `use-claude-chat.ts` 中，于「始终允许」检查之后、手动弹框之前，对 Shell 命令的 `permission_request` 运行 `runAutoModeForTool`。非 `ask` 结果短路：`allow` 自动批准，`deny` 自动拒绝（理由附在工具结果上）；`ask` 落回既有弹框。模型层就活在这里（渲染端异步无妨）。fail-open：任何错误都显示正常提示。

### 设置、插件、对齐

- **设置**——`AppSettings.agentPermissions = { autoApprove: { enabled, mode: "rules" | "rules+model", denyOnHighRisk, judgeModel? }, commandRules }`，默认关闭。Agent Runtime → 权限与工具 标签页新增**命令自动模式**卡片，可开关、选引擎、编辑命令规则。
- **插件**——`ctx.terminal.registerCommandSafetyRule(...)`（声明式 `命令通配 → 结果`，合并在用户规则之下）与 `ctx.terminal.classifyCommand(...)`（只读），由新的非危险权限 `terminal:safety` 门控。插件规则存于 `command-safety-registry.ts`，插件禁用时清除。Rust `cmd_lint` 同步该权限，保证 `cognia lint` 通过。

## 影响

- 安全命令不再打扰；灾难性命令在到达用户前被拦；不确定的中间地带要么提示（仅规则）要么由廉价模型裁判（规则+模型）。全部 opt-in。
- 休眠的 OpenCode 式规则集终于接入，服务于静态快速路径。
- 两个执行点都 fail-open——新代码出错只会退化为旧的「总是提示」，绝不会变成「静默执行」。
- 复合命令安全在渲染端强制（B 层有完整解析器）；sidecar 快速路径（A 层）只短路显式整条/分段通配规则即可，因为未匹配命令会往返进入 B 层。
- 隐私：模型永不接触含密钥/PII 的命令；模型层不显式开启即关闭。
