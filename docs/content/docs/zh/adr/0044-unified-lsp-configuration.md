---
title: ADR-0044 — 统一 LSP 配置
description: "单一声明式语言服务器配置源——内置默认值可被用户全局设置和项目本地覆盖。cognia/lsp.json ——驱动BOTH代理运行时 LSP和编辑器LSP，取代了之前硬编码的代理注册表和不同的UserLspServerEntry/PluginLspServerDef形状。增加了全字段配置、真实的每服务器workspace/configuration布线、一流的设置部分以及一次性设置迁移。"
---

# ADR-0044 — 统一 LSP 配置

**状态**：已接受（2026-06-02）**作者**：Max Qian + Claude Opus 4.8 **基于**：代理 运行时 LSP（`sidecar/lsp/*`）、编辑器/VS Code-shim LSP（ADR-0006插件系统;`lib/plugin/lsp/*`，`lib/plugin/vscode-shim/*`）、多根工作区模型（`activeProject.rootDir`），以及LSP二进制信任策略 **影响**：`types/lsp/config.ts`（新建）、`lib/lsp/`（新：`builtin-defaults`、`resolve-config`、`project-file-reader`、`migrate-settings`、`migrate-settings-initializer`）、`lib/claude/types.ts`（`AppSettings.lsp`、`SendOptions.lsp`、`UserLspServerEntry`别名）、`types/plugin/plugin.ts`（`PluginLspServerDef`别名）、`lib/claude/build-options.ts`、`sidecar/lsp/{servers,resolver,service-loader}.mjs`、`sidecar/dispatch/anthropic.mjs`、`sidecar/vscode-ext-host/src/{lsp-client,lsp-service}.ts`、`lib/plugin/lsp/{lsp-user-servers,lsp-bootstrap}.ts`、`lib/plugin/vscode-shim/lsp-binary-policy.ts`、`lib/plugin/core/vscode-loader.ts`、`components/settings/lsp/*`、`components/settings/developer/lsp-dev-toggle.tsx`， `components/settings/settings-nav-config.ts` + `settings-shell.tsx`，`i18n/messages/{en,zh-CN}.json`

## 背景

两个LSP子系统并行存在，且互不共享：

1. **Agent 运行时 LSP**（`sidecar/lsp/*`）为Claude代理提供了`lsp_*`工具以及编辑后诊断hook。其服务器注册表被**硬编码**为四台服务器（typescript、pyright、rust-analyzer、gopls），用户无需任何配置。
2. **编辑器LSP**（`lib/plugin/lsp/*` + `lib/plugin/vscode-shim/*`）在技能、画布和产物 Monaco编辑器中实现悬停/完成/诊断。它有一个真正可配置的注册表，但设置UI暴露四个字段，`UserLspServerEntry`型号的`env`/`initializationOptions`/`settings`字段从未有线连接，且每个服务器的`settings`（LSP `workspace/configuration` 载荷）没有运行时影响。

后果：用户在设置中添加的服务器对代理来说是不可见的;代理的默认设置无法扩展或覆盖;服务器特定的配置（如`rust-analyzer.cargo.features`）无处存在且从未生效。该形状也被复制为`UserLspServerEntry`（`lib/claude/types.ts`）和`PluginLspServerDef`（`types/plugin/plugin.ts`）。

## 决策

建立**一个声明式配置源**，驱动两个子系统。

### 一个形状，一个解析器

`types/lsp/config.ts`定义了`LspServerConfig`——权威形状同时承载`languages`（编辑器选择）和`extensions` / `rootMarkers`（代理文件匹配+工作区根分辨率），加上`env`、`initializationOptions`、`settings`、`workspaceFolderRequired`和`enabled`。`UserLspServerEntry`和`PluginLspServerDef`现在是它的别名，因此形状只存在于一个位置。

`lib/lsp/resolve-config.ts:resolveLspServers`层，按`id`：

```
builtin defaults  ←  plugin-contributed  ←  user global (settings.lsp.servers)  ←  project .cognia/lsp.json
```

Scalar/array字段被更高层替换;`settings` / `env` / `initializationOptions` 被**深度合并**，因此项目文件可以调整单个子键。`enabled: false` 会丢弃服务器（包括用户希望删除的内置服务器）。原本四台硬编码的服务器变成声明式`LspServerConfig` `lib/lsp/builtin-defaults.ts`条目，可覆盖且可禁用。

### 跨越sidecar边界

`sidecar/` 是一个独立的节点项目，无法导入 `lib/` 或 `@/types`。所以渲染器拥有分辨率：`lib/claude/build-options.ts:resolveSendOptions` 解析合并后的列表并将其序列化到 `sendOptions.lsp`（`{ enabled, servers }`）。sidecar 消耗它——`sidecar/lsp/servers.mjs` 现在是 `buildServers(configList)` + `serversForFile(file, servers)`（没有硬编码的注册表）;`resolver.mjs` / `service-loader.mjs` / `anthropic.mjs` 串程通过列表。代理人保持懒惰+PATH-probed。

### 每个服务器的设置实际上会生效

两个子系统都通过同一个`CogniaLspClient`（`sidecar/vscode-ext-host/src/lsp-client.ts`）生成，所以布线只能存在一次：它通过根据服务器`settings`解决每个请求的`section`来回`workspace/configuration`应拉取，然后在`initialized`后（以及在`updateConfiguration`上）推送`workspace/didChangeConfiguration`。`settings`从已解析的配置→ `LspStartParams` →客户端流出。

### 编辑激活政策

编辑器注册表在寄存器上迅速生成，因此输入四个默认工具链会接口未安装二进制文件的噪声“崩溃”状态。决策：编辑器仅运行**user / project / overrideden-builtin**服务器（`editorEligibleServers`保持`source !== "builtin"`）;纯内置默认保持仅代理（懒惰、PATH-probed）。用户添加和项目服务器——统一的核心价值——两者都能工作。`lib/plugin/lsp/lsp-bootstrap.ts`现在从`settings.lsp`+活跃项目解析，并在任一更改时重新同步。

### 设置接口 + 迁移

语言服务器升级为一流设置部分，内置行（只读、源徽章、禁用、覆盖）和用户行（添加/编辑/移除），以及包含validated-JSON `settings`编辑器的全字段add/edit对话框。切片从`developer.userLspServers` / `developer.unsignedLspAllowed`移动到一类`AppSettings.lsp`（`{ servers, enabled, unsignedAllowed }`）。`lib/lsp/migrate-settings.ts`在注册表启动前执行一次性、幂等迁移，连接应用启动;二进制策略读取新字段并使用遗留回退。

## 后果

- 设置中添加一次的服务器对代理和每位编辑者开放。
- 内置默认值可以从一个地方覆盖和禁用;代理注册表不再硬编码。
- 每个服务器`settings`终于在两侧驱动`workspace/configuration`。
- Project 仓库 可以`.cognia/lsp.json`每个工作区LSP配置的 pin 配置。
- 配置形状只存在一个文件（`types/lsp/config.ts`）。

**权衡已接受**：纯内置默认不会在编辑器内自动运行（只有其覆盖会自动），以避免用户急切生成未安装的工具链。未来懒惰的语言激活编辑器注册可以消除这一问题，而无需频繁生成。
