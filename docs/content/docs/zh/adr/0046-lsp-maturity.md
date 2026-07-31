---
title: ADR-0046 — LSP 成熟度
description: "为缺失的语言服务器提供 npm 优先的自动安装阶梯、带退避重启与 broken 集合的崩溃监督器、诊断防抖/去重/版本守卫、sidecar 日志环形缓冲，以及渲染端状态面（健康徽章、一键安装、日志对话框、编辑器提示）。内置注册表扩充到 9 个服务器。"
---

# ADR-0046 — LSP 成熟度

**状态**：已接受（2026-06-07）
**作者**：Max Qian + Claude Opus 4.8
**承接**：ADR-0044（统一 LSP 配置）— 本 ADR 同时找回了 ADR-0044 因并发树覆写而丢失的另一半（迁移接线、`settings.lsp` 读取方、全字段对话框、`buildServers`、`workspace/configuration` 支持，这些只存活在 `qc-stash-backup` 基线中，本次恢复）
**影响**：`sidecar/vscode-ext-host/src/{lsp-installer,lsp-diagnostics-buffer}.ts`（新增）、`sidecar/vscode-ext-host/src/{lsp-client,lsp-service,host}.ts`、`sidecar/lsp/{servers,resolver,service-loader}.mjs`、`sidecar/dispatch/anthropic.mjs`、`types/lsp/config.ts`、`lib/lsp/{builtin-defaults,lsp-status-store}.ts`、`lib/claude/build-options.ts`、`lib/plugin/lsp/lsp-client-adapter-tauri.ts`、`components/settings/lsp/*`、`components/editor/lsp-server-hint.tsx`、`hooks/use-lsp-status-for-language.ts`

## 背景

ADR-0044 统一了**配置**，但运行时仍然脆弱，缺少 OpenCode / Claude Code 级别的行为：

- 二进制缺失时**静默降级** — agent 跳过该服务器，编辑器毫无提示，用户除了读文档没有安装途径。
- 服务器崩溃后整个会话保持死亡；`initialize` 挂死会永久阻塞调用方。
- 诊断原样透传：突发帧、重复项，以及最糟的——**过期的编辑前帧**可能被归因到编辑后的文本（Claude Code 曾为此发布修复的缺陷类别）。
- 服务器 stderr 只进 sidecar 自己的 stderr，对用户完全不可见。
- 只有 4 个内置服务器，且没有任何安装元数据。

## 决定

### npm 优先安装阶梯（`sidecar/vscode-ext-host/src/lsp-installer.ts`）

解析顺序，先命中先赢：

1. 显式路径（绝不覆盖安装）→ 2. 项目 `node_modules/.bin` 逐级上溯 → 3. 托管目录 `<appData>/lsp/node/<npmPackage>/node_modules/.bin` → 4. PATH（支持 PATHEXT）→ 5. `npm install <pkg> --prefix <托管目录>` 后重查第 3 级。

托管目录按**包**而非服务器 id 作键 — `vscode-langservers-extracted` 一个包带四个二进制，只装一次。开关：`COGNIA_DISABLE_LSP_DOWNLOAD` 环境变量（硬开关）与 `AppSettings.lsp.autoInstall`（用户开关）。并发安装通过原子 mkdir 咨询锁串行化。`LspServerConfig` 新增 `install?: { npmPackage, version? }`；内置注册表扩到 **9 个**（新增 json/css/html（`vscode-langservers-extracted`）、yaml、bash；eslint 因需要 ESLint 专属的配置握手而刻意缺席；rust-analyzer/gopls 仅做检测 — 二进制/go-install 阶梯留作后续）。

两个消费方共享同一实现：渲染端走 `lsp:detect` / `lsp:install` RPC；agent 走 `resolver.mjs` 的 `ensureCommand` 注入点（动态导入 `dist/lsp-installer.js`），并带 **30 秒回合预算** — npm 安装绝不会扣住一个 agent 回合；安装在后台继续，之后的文件触达会捡起新装好的二进制。resolver 还会按会话缓存失败的服务器，缺一个工具链不会每次编辑都重跑阶梯。

### 崩溃监督器（`lsp-service.ts`）

`CogniaLspClient` 新增 `startupTimeout`（默认 10 秒，与 `initialize` 竞速，超时杀掉挂死子进程）、`onStateChange` 与 `onLog`。服务层监督：意外的 `crashed` 转移会调度退避重启（`min(30s, 1s·2ⁿ)`）；连续 4 次失败后该键进入 **broken**（不再自动重启；手动 `lsp:start` 重置）。打开的文档会重放（以最后文本 `didOpen`）进重启后的客户端。`stop`/`stopAll` 取消待定的重启定时器。状态转移推送 `lsp:state` 通知。

### 诊断质量（`lsp-diagnostics-buffer.ts`）

位于客户端与消费方之间：按 `key:uri` 的 150 毫秒防抖（远低于 agent 的 800 毫秒等待）、完全重复丢弃（severity|code|source|message|range），以及**版本守卫** — 帧上标注的文档版本早于客户端当前 `didChange` 版本即丢弃，根治编辑后误归因。

### 可观测性

服务层维护 500 条的 stderr + 生命周期日志环（`lsp:logs`）。渲染端 `lib/lsp/lsp-status-store` 合并 `lsp:detect`（installed/managed/missing）与 `lsp:status` + 实时 `lsp:state` 推送（agent 复合 id `<id>#<rootHash>` 按基础 id 归并）。出口：设置 → 语言服务器 每行的状态/健康徽章与一键安装、日志对话框，以及编辑器内可关闭的提示条（`components/editor/lsp-server-hint.tsx`，服务器缺失或 broken 时出现）。Web/移动端全部惰性。

## 后果

- 打开 TS/Python/JSON/YAML/bash 文件可以自助供给其服务器（UI 一键，agent 下自动），不再静默失败。
- 反复崩溃的服务器收敛到 `broken` 且原因留在日志环里，不再不可见地崩溃循环；正常崩溃会带着文档完整恢复。
- 模型不会再看到被归因到编辑后文本的编辑前诊断。
- 接受的取舍：本轮仅 npm 供给（无 GitHub release / go-install 阶梯）；编辑器提示先挂在 Skill 编辑器（Canvas/Artifacts 随移动端编辑器工作跟进）；`startupTimeout` 仅配置文件可设（对话框暂无该字段）。
