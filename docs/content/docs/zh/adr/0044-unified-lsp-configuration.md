---
title: ADR-0044 — 统一 LSP 配置
description: "单一声明式语言服务器配置源 —— 内置默认可被用户全局设置与项目级 .cognia/lsp.json 覆盖 —— 同时驱动 agent 运行时 LSP 与编辑器 LSP，取代此前硬编码的 agent 注册表与分裂的 UserLspServerEntry / PluginLspServerDef 形状。加入全字段配置、真正生效的 per-server workspace/configuration、一等设置区与一次性设置迁移。"
---

# ADR-0044 — 统一 LSP 配置

**状态**：已接受（2026-06-02）
**作者**：Max Qian + Claude Opus 4.8
**基于**：agent 运行时 LSP（`sidecar/lsp/*`）、编辑器 / VS Code-shim LSP（ADR-0006 插件系统；`lib/plugin/lsp/*`、`lib/plugin/vscode-shim/*`）、多根工作区模型（`activeProject.rootDir`）、LSP 二进制信任策略
**影响**：`types/lsp/config.ts`（新增）、`lib/lsp/`（新增 `builtin-defaults`/`resolve-config`/`project-file-reader`/`migrate-settings`/`migrate-settings-initializer`）、`lib/claude/types.ts`（`AppSettings.lsp`、`SendOptions.lsp`、`UserLspServerEntry` 别名）、`types/plugin/plugin.ts`（`PluginLspServerDef` 别名）、`lib/claude/build-options.ts`、`sidecar/lsp/{servers,resolver,service-loader}.mjs`、`sidecar/dispatch/anthropic.mjs`、`sidecar/vscode-ext-host/src/{lsp-client,lsp-service}.ts`、`lib/plugin/lsp/{lsp-user-servers,lsp-bootstrap}.ts`、`lib/plugin/vscode-shim/lsp-binary-policy.ts`、`lib/plugin/core/vscode-loader.ts`、`components/settings/lsp/*`、`components/settings/developer/lsp-dev-toggle.tsx`、`components/settings/settings-nav-config.ts` + `settings-shell.tsx`、`i18n/messages/{en,zh-CN}.json`

## 背景

此前存在两套互不相通的 LSP 体系：

1. **Agent 运行时 LSP**（`sidecar/lsp/*`）为 agent 提供 `lsp_*` 工具与编辑后诊断回灌 hook。其服务器注册表**完全硬编码**为四个服务器（typescript、pyright、rust-analyzer、gopls），无任何用户配置。
2. **编辑器 LSP**（`lib/plugin/lsp/*` + `lib/plugin/vscode-shim/*`）为 Skills/Canvas/Artifact 的 Monaco 编辑器提供 hover/补全/诊断。它有可配置注册表，但 UI 只暴露四个字段，`UserLspServerEntry` 的 `env`/`initializationOptions`/`settings` 从未接入，per-server `settings`（LSP `workspace/configuration` 载荷）无运行时效果。

后果：用户在设置里加的服务器 agent 用不上；agent 默认无法扩展或覆盖；server 专属配置无处安放且不生效。形状还被 `UserLspServerEntry` 与 `PluginLspServerDef` 重复定义。

## 决策

建立**单一声明式配置源**同时驱动两套体系。

### 一种形状，一个解析器

`types/lsp/config.ts` 定义权威的 `LspServerConfig`，同时携带 `languages`（编辑器选择）与 `extensions`/`rootMarkers`（agent 文件匹配 + 根解析），以及 `env`/`initializationOptions`/`settings`/`workspaceFolderRequired`/`enabled`。`UserLspServerEntry` 与 `PluginLspServerDef` 现为其别名。

`lib/lsp/resolve-config.ts:resolveLspServers` 按 `id` 分层合并：内置默认 ← 插件贡献 ← 用户全局（`settings.lsp.servers`）← 项目 `.cognia/lsp.json`。标量/数组被高层替换；`settings`/`env`/`initializationOptions` **深合并**。`enabled:false` 剔除服务器。四个硬编码服务器降级为 `lib/lsp/builtin-defaults.ts` 中可覆盖/可禁用的声明式条目。

### 跨越 sidecar 边界

`sidecar/` 是独立 Node 工程，无法 import `lib/`。因此**渲染端负责解析**：`build-options.ts:resolveSendOptions` 把合并结果序列化到 `sendOptions.lsp`，sidecar 消费它 —— `servers.mjs` 改为 `buildServers` + `serversForFile(file, servers)`，不再硬编码；agent 仍懒启动 + PATH 探测。

### per-server settings 真正生效

两套体系都经同一个 `CogniaLspClient` spawn，故只在此一处接入：它按请求的 `section` 从 server `settings` 应答 `workspace/configuration`，并在 `initialized` 后推送 `workspace/didChangeConfiguration`（`updateConfiguration` 同理）。

### 编辑器激活策略

编辑器注册即时 spawn，故只运行**用户 / 项目 / 被覆盖的内置**服务器（`editorEligibleServers` 保留 `source !== "builtin"`），纯默认内置仍只给 agent（懒启动 + PATH 探测），避免未安装工具链产生 crashed 噪声。`lsp-bootstrap.ts` 现从 `settings.lsp` + active project 解析并在两者变化时重同步。

### 设置面与迁移

Language Servers 升为一等设置区：内置行（只读 + 来源徽章 + 禁用 + 覆盖）与用户行（增/改/删），全字段添加/编辑对话框含校验式 JSON `settings` 编辑器。配置从 `developer.userLspServers` / `developer.unsignedLspAllowed` 迁至一等的 `AppSettings.lsp`；`lib/lsp/migrate-settings.ts` 在启动、注册表 bootstrap 前做一次性幂等迁移；二进制策略读新字段并兼容旧位置。

## 影响

- 加一次服务器，agent 与所有编辑器都能用。
- 内置默认可在一处覆盖/禁用；agent 注册表不再硬编码。
- per-server `settings` 终于在两侧驱动 `workspace/configuration`。
- 仓库可携带 `.cognia/lsp.json` 固定每个工作区的 LSP 配置。
- 配置形状只存在于一个文件（`types/lsp/config.ts`）。

**接受的取舍**：纯内置默认不在编辑器内自动起（仅其覆盖会），以免即时 spawn 用户未安装的工具链。未来可用「按语言懒激活」的编辑器注册消除此限制而无即时开销。
