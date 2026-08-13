---
title: "ADR-0065 — Agent 工作空间约束与权限模型统一"
description: "它弥合了成熟OS-level沙盒（ADR-0028）与代理实际运行的工具之间的差距。为sidecar内置file/bash工具添加了一个始终在线的跨平台“工作区约束”层（根外写入升级到审批;凭证路径硬性否认），通过单调的权限上限级联，将每个队友的沙盒OS线连接，统一了两sidecar 门禁始终允许的路径，并将同伴远程原始FS 命令从影子模式切换为强制模式。"
---

# ADR-0065 — Agent 工作空间约束与权限模型统一

**状态**：已接受（2026-07-06） **作者**：Max Qian + Claude Opus 4.8 **基于**构建**：OS沙盒（ADR-0028、`src-tauri/src/sandbox/`）、权限模型（ADR-0020计算机使用、ADR-0041 命令自动模式）、单调权限上限级联（`lib/ai/agent/external/permission-cascade.ts`）和sidecar `canUseTool` 门禁（`sidecar/dispatch/{anthropic,ai-sdk-tools}.mjs`）。**灵感**：Anthropic的[`sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)和[Claude Code sandboxed-Bash](https://code.claude.com/docs/en/sandboxing) filesystem/network模型（write=cwd，read=除凭证外整台机器），以及六步[Agent SDK权限evaluation](https://code.claude.com/docs/en/agent-sdk/permissions)。

## 当前状态修订（2026-08-13）

`TeammateConfigDialog` 现已复用现有 sandbox policy editor，展示继承的 team ceiling，并且只持久化经 `clampSandboxPolicy` 收紧后的 teammate override。没有新增 teammate 专用 sandbox schema。

## 背景

仓库有**两个成熟但不相干的**约束系统，特工从它们之间的缝隙中掉落：

- **系统A — OS沙箱**（ADR-0028）：真实的、失败封闭的，按平台（Linux 包包 / macOS SBPL / Windows 限制令牌+Job-Object），带有SSRF-filtering代理和保护路径切割。但它只能通过`cognia-sandboxed-tools`插件、Computer Use、canvas Python和终端访问——**从未连接到Agent-Team/子代理/sidecar工具调度路径**——而且默认关闭。
- **系统B — 权限模型**：两层（sidecar静态快速路径`permission-resolver.mjs`+渲染器丰富的auto-mode/modal），带有单调天花板级联。

具体的漏洞是：代理实际使用的sidecar内置工具（`read`/`write`/`edit`/`bash`/`grep`/...）默认运行于**文件系统无限制**——`resolveToolPath`逐字传递绝对路径。一个完整且经过测试的守卫（`assertPathInside`）被一个无操作占位符（`normaliseAbsolutePath`）专门保留，“以便未来的用户限制沙盒模式只有一个插入点”。另外，`src-tauri/src/files.rs`的原始fs 命令信号——可从渲染器**以及配对的远程设备**访问——处于阴影模式（记录，从未被屏蔽）。

## 决策

默认限制代理工具执行，重用现有基础设施，跨平台（包括原生Windows，System A的网络强制执行尚未完成）。四个工作流：

### P1 — sidecar工作空间限制（`sidecar/builtin-tools/confinement.mjs`）

一个始终在线的中间层，与重OS沙箱互斥（当`sandboxEnabled`时，系统A接手，系统A会退让）。在**许可层**中强制执行（不是工具本体——正体在批准后运行，不能重新请求）：

- `classifyToolCallConfinement(policy, tool, input, cwd)` 是**操作感知**的，与 Anthropic 的模型相匹配：一个**变异器**（变异器）（`write`/`edit`/`multi_edit`/`notebook_edit`/`bash`-workdir），其目标逃逸于每个工作区根 → `"ask"`（合成为现有的 `permission_request` 往返）;**读者**在根之外是不受限制的;**任何** 操作员解析为受保护的凭证路径（`.ssh`/`.aws`/`.git-credentials`/`.npmrc`/`.config/gh`/...）——直接或通过符号链接转义——→ `"deny"`。它只会*添加*限制（根内调用贡献`null`，从不自动批准）。
- 通过`combineVerdict(rulesetVerdict, confinementVerdict)`（拒绝>询问>允许）合成为**两者**的sidecar 门禁，因此在人类路径和ai-sdk路径上组成完全相同。
- 深度防御：变异器工具体调用`assertNotSecretEscape`（激活预留`normaliseAbsolutePath`插点），即使未配置策略，写入也无法对凭证路径进行后门。
- `resolveSendOptions` 从`[cwd, …additionalDirectories]`解决，默认开机（`AppSettings.workspaceConfinementEnabled`，可按 character/session 覆盖），被激活项目封锁。设置切换：`components/settings/sandbox/workspace-confinement-card.tsx`。

### P2 — `files.rs`影子→强制执行（起源门控）

原始 fs 的 fs 会被 `FsOrigin` 命令 （`Local` |`Remote`）。`enforce_check_path` **硬拒绝** `Remote`写（`write_text_file`/`ensure_dir`）逃逸注册根节点——关闭配对设备exfil/backdoor-write洞——而`Local`调用和所有读取保持在影子模式（记录，绝不阻塞），因此现有渲染器流不受影响。渲染器命令包装器传递`Local`;`companion_api/rpc.rs`通过`Remote`。

### P3 — 每个队友的沙盒策略（将系统A接入Agent Team）

`ExternalSessionPermissionSpec`获得一个通过单调层级通过`clampSandboxPolicy`（`lib/sandbox/policy-bridge.ts`）递交的`sandboxPolicy`——child/teammate可能只缩小可写根，收紧网络，降低CPU/memory上限，绝不能变宽。`teammateToCharacter`计算被压缩的策略，并在合成的字符上设置`sandboxEnabled`/`sandboxPolicy`，**激活现有的`resolveSendOptions`沙盒门禁**，用于队友调度——这是最终将系统A连接到团队运行时的步骤。队友级别的 `sandboxEnabled`/`sandboxPolicy` 实时在 `AgentTeamConfig`/`TeammateConfig` 上。

### P4 — 统一权限决策路径

- `alwaysAllowTools`现在被尊重在**两者**的sidecar 门禁中（由`resolveSendOptions`填充到`SendOptions`），因此始终允许的工具跳过了冗余的往返`permission_request`——之前只有 ai-sdk 路径读取，Anthropic 路径依赖渲染者的 `allowListRef`。
- “允许始终”通过`deriveAllowRuleFromApproval` + `setToolRule`进入`agentPermissions.toolRules`，保持**目标范围**规则（`Bash(git *)`、`Read(/path/x)`）——严格比旧的粗tool-NAME授予更窄——只有当没有目标可提取时才会回落到原始名称。

## 后果

- 代理默认在所有平台上都有限制，包括原生Windows，无需繁重的OS沙盒。工作区外写入提示只做一次（重复使用现有的批准UX）;凭证路径被无条件封锁。
- Teammates/subagents无法再超过团队的沙箱上限（单调夹），启用队友的沙盒实际上会Bash/Edit/Write通过OS沙盒。
- 约束层和OS沙箱在每个会话中是互斥的，因此不存在双重约束。
- **后续内容**（为避免同时工作而推迟）：为每队友沙盒提供`teammate-config-dialog.tsx` UI切换，本场ADR的`meta.json`+CLAUDE.md子系统地图索引条目，以及P2可选的`fs_set_root_enforcement` 运行时切换。

## 关键文件

- `sidecar/builtin-tools/confinement.mjs`（+ `safety.mjs` `assertPathInside`/`canonicalisePartial`重复使用）、`sidecar/dispatch/{anthropic,ai-sdk-tools,permission-resolver}.mjs`、`sidecar/builtin-tools/core/{write,edit,apply-patch,notebook-edit}.mjs`
- `lib/claude/{build-options.ts,types.ts}`，`lib/claude/permissions/approval-rule.ts`，`hooks/chat/use-claude-chat.ts`，`components/settings/sandbox/workspace-confinement-card.tsx`
- `lib/ai/agent/external/permission-cascade.ts`，`lib/sandbox/policy-bridge.ts`，`lib/ai/agent/team/{teammate-character,dispatch-teammate}.ts`，`types/agent/agent-team.ts`
- `src-tauri/src/files.rs`，`src-tauri/src/companion_api/rpc.rs`
