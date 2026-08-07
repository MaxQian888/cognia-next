---
title: "0086 — 任务级资源工作区"
description: "跨 Cognia 运行时的隔离 Agent 执行、本地权威补丁账本，以及显式审查、应用和撤销。"
---

# ADR 0086 — 任务级资源工作区

## 状态

已接受，受 `developer.taskWorkspace` 实验开关控制；完整运行时矩阵通过后才能 GA。

> **由 ADR-0111 修订（2026-08-07）。** Task Workspace 继续作为可逆 patch/snapshot/undo 引擎的权威。ADR-0111 在同一 crate 之上叠加 Managed Workspace Registry，将签名所有权、多根 Bundle 组合、真实的 `WorkspaceBaseSpec` 输入、敏感资源授权、`WorktreeCreate` / `WorktreeRemove` producer 接线与保留策略分离迁移到 Registry。`developer.taskWorkspace` 转为一个发布周期的 rollback kill switch。详见 ADR-0111。

## 背景

Cognia 已有 Workspace Dock、项目编辑器、Git 审查、Companion transport、外部 Agent 和 Agent Team worktree，但 Agent 写入仍由多套不完整机制观察：工具事件会漏掉 shell、脚本和编译器写入，桌面文件监听无法覆盖 headless，整仓 discard 也无法区分 Agent、用户和未知外部贡献。

## 决策

一次用户意图对应一个 `TaskWorkspace`；重试、继续执行和子 Agent 是独立 `TaskRun` 版本。每次运行都在用户主目录之外执行：Git 根目录使用独立 worktree，非 Git 根目录使用物化影子工作区；无法安全隔离时失败关闭。

`cognia-task-workspace` 是 Tauri 与 `cognia-server` 共享的 transport-neutral 实现。SQLite 保存元数据，正文以 gzip 压缩、SHA-256 内容寻址 blob 保存在执行端应用数据目录。正文和补丁不进入聊天同步、遥测或资源事件。默认保留 30 天、blob 总量 1 GiB；固定和未应用任务不会被淘汰。

工具事件只提供 provisional 提示。遵循 ignore 规则的 debounce watcher 负责低延迟摘要，settle 快照才是权威结果。事件带 revision、受 32 KiB 上限约束、支持 overflow/resync，且永不携带正文。读取返回结构化截断状态；传输使用不超过 24 KiB 的可校验分块。

settle 为文件、符号链接、权限位、二进制替换、创建、删除和重命名生成 forward/inverse 补丁。应用先原子预检，再基于 baseline hash 三方合并；支持按文件和文本 hunk 选择。撤销只应用已记录贡献的 inverse patch，遇到漂移进入冲突而不会丢弃主工作区其它修改。冲突必须显式选择重试合并、应用任务版本或保留当前版本。

敏感路径只公开锁定元数据；每次读取或下载正文都要显式授权，Companion 还必须具备既有 remote-control/service capability。HTML/SVG 静态预览先净化；显式运行进入 opaque iframe，CSP/sandbox 默认禁止网络、剪贴板、导航、额外目录和下载。

产品界面只升级现有 Workspace Dock。存在任务时默认显示“当前任务”，可按 session 恢复持久化任务；父任务聚合子运行但保留 run/Agent 归因，并提供 Source、Preview、Diff、文件/hunk 应用、精确撤销、上传下载和移动端审查。

## 兼容与发布

旧 `code_adoption` 命令保留一个兼容周期；存在任务账本时，持久化指标由权威的 Agent-origin 资源投影得到。`fs_read_workspace_file` 暂时保留，但编辑器无上限读取不再被静默截断；任务预览统一使用结构化资源接口。

实验开关保持关闭，直到内置聊天、ACP/Codex/Claude/OpenCode、Agent Team、Tauri、Companion、headless、Docker 和 Kubernetes PVC 通过同一 DTO、权限、重连、隔离和补丁语义。系统不引入第二个 AgentServer 或 WebSocket 协议。

## 影响

执行端会承担更多本地存储与后台 reconcile 工作，但任务归因和可逆性不再依赖 Git 工作区是否干净，也不依赖工具事件是否完整。当 inverse 数据无法保留时，应用会被阻止；这比把不可逆操作伪装成可撤销更安全。
