---
title: ADR-0085 — Cloud/Headless 共享浏览器
description: "在保留 Tauri EmbeddedEngine 的同时，增加按 workspace 持久化的 runtime 与产品自有 RemoteChromiumEngine；Agent 使用结构化 snapshot/ref，人类通过单次 ticket 鉴权的媒体网关观察与接管。"
---

# ADR-0085 — Cloud/Headless 共享浏览器

**状态**：已采纳；实验性、默认关闭（2026-07-18）
**基于**：ADR-0055、ADR-0059、ADR-0065、ADR-0072、ADR-0073

## 背景

Tauri 内嵌浏览器为桌面端提供了有效的人机共享界面，但 cloud、mobile-companion 与 headless 部署没有这个 webview。既有 T2 runner 的生命周期也不合适：每个 external Agent 都是一次性容器的 PID 1，浏览器、dev server 与多次 Agent 进程无法共享同一个持久 workspace 隔离边界。

直接移植 Aiden/Lynx room、公开 Playwright/CDP，或把 Playwright MCP 当产品后端，都会把 Cognia 绑定到其他产品协议，或把高权限 endpoint 泄露给客户端。

## 决策

### 持久 WorkspaceRuntime

在既有 local/container/Kubernetes backend 旁新增 `WorkspaceRuntimeBackend`。只有列入 `COGNIA_WORKSPACE_RUNTIME_WORKSPACES` 的 workspace 才迁移，其余保持旧行为。

新镜像固定 Playwright/Chromium 1.61.1。root entrypoint 仅修正 workspace/profile volume 权限，随后 `exec` 为非 root `pwuser` 的 Node supervisor（PID 1）。它同时托管可多次启停的 external-Agent 子进程和浏览器服务；仅挂载一个 workspace，不使用 privileged、host filesystem 或原始 Docker socket。

`cognia-server` 通过私网 URL 模板与每-runtime secret 文件定位 runtime。私有 v1 协议仅暴露 health、control、Agent events 与 latest-frame media；客户端永远得不到 runtime、Playwright 或 CDP endpoint。

### BrowserSession 与统一引擎

父 ChatSession 独占一个 `BrowserSession`，team 子会话复用父绑定。一个 remote session 对应一个 Playwright `BrowserContext`，最多八个 page，且全局只有一个 active page。默认 ephemeral；named profile 按 workspace 隔离且互斥占用。

既有 `BrowserEngine` 继续作为模型侧契约，并补充 page、file、download 操作。桌面 localhost 仍默认 `EmbeddedEngine`。`RemoteChromiumEngine` 是 Companion RPC adapter，真正的 Playwright 实现在 WorkspaceRuntime。保留既有 `browser_*` 名称，新增 `browser_pages`、`browser_switch_page`、`browser_close_page`、`browser_set_files` 与 `browser_downloads`。

模型看到的 ref 始终不透明；runtime 绑定 `{browserSessionId, pageId, generation}`，跨 session/page、导航后、重启后的访问统一返回 `browser_stale_ref`。共享注入脚本在每个 Playwright frame execution context 中运行，保留 accessibility、layout、React component/source 与 annotation 信号。

### Gateway、画面与控制

所有公网连接终止于 `cognia-server`。device/OIDC JWT 只能申请随机的 60 秒单次 stream ticket；ticket 绑定 account、device、BrowserSession，WebSocket URL 不携带长期 JWT。

控制消息使用 v1 JSON envelope。JPEG 帧使用固定 24 字节 header，包含协议、codec、sequence、宽高、timestamp 与 payload 长度。WorkspaceRuntime 最多保留一个未 ACK 的 CDP frame；server 收到即 ACK，并用 latest-only watch channel 分发，因此慢 viewer 不会形成积压。

可多人观察，但只有一个 server-authoritative epoch writer。Agent mutation 最长租约 15 秒；人类接管立即增加 epoch，使 Agent 旧输入失效。人类 30 秒无输入后过期，断线保留 5 秒重连窗口。snapshot/console/network 只读操作不需要写租约。

### 安全与生命周期

允许本 WorkspaceRuntime 的 loopback dev server。公开顶层域名必须有 session/workspace grant；其他 RFC1918、CGNAT、link-local、ULA、multicast、云 metadata 与 DNS rebinding 地址始终拒绝。已授权域名解析并校验后，通过 Chromium host-resolver rule 固定地址。

上传最多十个 workspace 相对路径，使用 realpath 校验 symlink containment，单文件 100 MiB。下载先写入 0600 quarantine，单文件 250 MiB、每 session 1 GiB；只有用户明确操作后才能保存到 workspace 或附加聊天。password、OTP、token、secret 字段不得进入 snapshot 与日志。frame 默认不落盘，截图、trace、录制必须显式创建。

默认配额为每 workspace 三个活动 session、每 session 八个 page/五个 viewer、空闲 30 分钟、绝对最长 8 小时。runtime 崩溃使 ephemeral session 失效；named profile 可由新 session 恢复。

能力默认由 `COGNIA_REMOTE_BROWSER_ENABLED=false` 硬关闭；只有 server gate、用户实验设置、runtime image 与 health probe 同时通过才广告 `browser`。活动 session 不自动迁移 backend。

## 影响

- 桌面 localhost 保持零额外基础设施与向后兼容。
- cloud/mobile/headless 获得同一套结构化工具与可接管画面，同时不接触高权限 endpoint。
- 持久 runtime 是更大、更长寿命的隔离边界，需要资源上限、镜像补丁、健康监控与 workspace 灰度。
- v1 仅支持 Chromium，但 gateway 契约不写死 CDP，未来可替换为 WebRTC 或其他 producer。

## 放弃的方案

- 复制 Aiden/Lynx room 与消息协议。
- 向客户端公开 Playwright 或 raw CDP。
- 把 Playwright MCP 当产品后端。
- 同一版本替换 `EmbeddedEngine` 或删除旧的一次性 runner。
- 默认持续保存 frame、凭据或 trace。
