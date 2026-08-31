---
title: Computer Use
description: 让 Agent 操作宿主桌面。模型真正驱动的 revision-bound app session、为每个动作设卡的五层防御栈、带限时内存授权的 HITL 同意代理，以及底层的 sandbox crate。
---

# Computer Use

<Status variant="beta">Beta · ADR-0020 · 策略层来自 ADR-0028 Phase 5</Status>

<TLDR>
  `computer_use` 工具**无法**被进程沙箱化 —— 驱动宿主 UI 本身就是它的全部意义 ——
  所以防御是分层的，而不是筑墙。模型的意图与一次真实点击之间隔着**五道关卡**：
  按接口面取键的三级权限（`Off` / `Whitelist` / `PerCall`）、HITL 同意代理、只追加的审计日志、
  按角色的工具 id 过滤，以及按动作的策略。用户发出的同意授权**仅存于内存** ——
  应用退出与触发 kill switch 时即失效，且永不落盘。这是刻意为之：
  一个限时授权让远程操作者能开出一段工作窗口，而不会留下长期有效的授权。
</TLDR>

<StatGrid>
  <Stat label="防御层数" value="5" hint="权限 · 同意 · 审计 · 角色过滤 · 策略" />
  <Stat label="模型工具" value="9" hint="plugins/computer-use · app session + zoom + wait + OCR 兜底" />
  <Stat label="Rust 模块" value="91" hint="crates/cognia-automation/src · automation + sandbox + cua_sandbox" />
  <Stat label="前端模块" value="14" hint="lib/automation · 非测试 .ts" />
  <Stat label="授权时长" value="15 / 30 / 60" hint="分钟；默认 30，上限 60" />
  <Stat label="同意超时" value="90s" hint="默认值；夹在 5s–115s" />
  <Stat label="审计上限" value="5000" hint="AUTOMATION_AUDIT_CAP" />
</StatGrid>

设计动机见 [ADR-0020](../adr/0020-computer-use-completeness)。按动作的策略层是后来随 ADR-0028 Phase 5 加入的。

## 五道关卡

| # | 层 | 位置 | 决定什么 |
| --- | --- | --- | --- |
| 1 | **权限层级** | `automation/permission.rs` | `Off` / `Whitelist` / `PerCall`，按 `Surface` 取键 |
| 2 | **同意代理** | `automation/consent.rs` | `PerCall` 层级下的人在环审批 |
| 3 | **审计日志** | `automation/audit.rs` | 只追加地记录实际执行了什么 |
| 4 | **角色过滤** | `Character.computerUseSettings.allowedToolIds` | 该角色究竟能用哪些工具 |
| 5 | **按动作策略** | `automation/policy.rs` | 对动作本身的约束 |

第 5 层在同意解析完成后**紧接着**运行，返回 Allow / Deny。一条策略是一组约束 ——
「只能操作 Chrome」「永不点击密码管理器所在的屏幕区域」「目标 URL 必须匹配 `^https://`」——
存放在 `AppSettings.automationPolicy`，因此高级用户可从「设置 → 沙箱 → 按动作策略」卡片编辑。
空策略即表示不附加额外约束。

## 同意是限时的，不是被记住的

`PerCall` 流程是 Rust 与渲染端之间的一次 oneshot 往返：

1. 某个 Tauri 命令解析出 `Decision::RequireConsent { prompt }`。
2. `ConsentBroker::request` 先在 `session_grants` 中查找匹配
   `(session_key, surface, command, plugin_id, process_name)` 元组且未过期的「始终允许」——
   命中则立即解析为 `Allow`。
3. 否则生成一个 UUID、注册 oneshot sender、发出携带 `{ id, prompt, timeoutMs }` 的
   `automation:consent-request` 事件，并等待响应直至超时。
4. `components/automation/consent-overlay.tsx`（桌面）与
   `components/mobile/automation/mobile-consent-sheet.tsx`（移动端）渲染
   **允许一次 / N 分钟内不再询问 / 拒绝**，随后调用
   `automation_consent_respond(id, allow, persist, grantDurationMs)`。
5. `ConsentBroker::resolve` 兑现该 oneshot。若 `persist === true`，还会在 `session_grants` 写入一条带过期时间的记录，
   使后续匹配的调用在其失效前跳过 UI。

时长是一个封闭集合 —— 15、30 或 60 分钟（`CONSENT_GRANT_DURATIONS_MS`），默认 30、上限 60。
请求超时默认 90 秒，并被夹在 5–115 秒之间。授权永不落盘 —— 那是 `Whitelist` 层级的职责。

## 模型真正驱动的：revision-bound app session

这里没有 `computer(action, coordinate)` 这样的工具。模型一次读一个应用，
并针对它的一个编号 revision 行动，这正是让「点在过期画面上」变得可检测
而不是静默发生的原因。`get_app_state` 返回的 revision 携带可访问性树投影、
与上一版的 diff、一帧画面，以及一个一次性 `turnToken`。`perform_action`
花掉这个 token，作用于**元素句柄**（经可访问性 API 下发，扛得住布局变化）
或**像素目标**（它同时携带自己被测量时的画面尺寸，因此针对一张 session
已经翻过去的画面所做的点击会被拒绝，而不是落在意料之外的位置）。
`strategy` 在 `semantic` / `pixel` / `auto` 之间选择。

| 工具 | 作用 |
| --- | --- |
| `get_app_state` | 某个应用的一个 revision：树投影、diff、画面、`turnToken` |
| `list_apps` | 有哪些目标可选 |
| `query_elements` | 在当前 revision 内按 locator 搜索 |
| `expand_element` | 对被截断的子树继续翻页 |
| `perform_action` | 八种动作词汇，作用于句柄或像素 |
| `zoom` | 裁剪当前 revision 那一帧的一个区域 |
| `wait` | 等 UI 稳定后再读 |
| `find_text` / `click_text` | 主显示器上的 OCR 兜底，用于树看不见的东西 |

动作契约只写一次，以 zod 形式落在 `lib/automation/action-schemas.ts`，
同时服务于工具发布的 JSON Schema、TypeScript 类型，以及一个从 `session.rs`
读取 Rust `UiAction` 枚举的 parity 测试，两侧因此不会各走各的。

画面经 `lib/automation/model-frame.ts` 以 MCP `image` 块离开，而不是
stringify 后的 base64。JSON 那一半保留截图尺寸、丢掉 bytes，因为像素目标
要靠这些尺寸校验。同一份投影同时服务应用内工具与 External Bridge 的
`computer_use`。

## 降采样不花代价，因为 zoom 读的是原生帧

截图降采样（设置 → 自动化 → 行为，默认 1280x800）约束的是交给调用方的那一帧。
采集会分成两份：展示帧按该预算缩放，`UiSurface.pixelWidth` / `pixelHeight`
描述的就是**它**，从而让穿过 session 的每个像素坐标都说同一种语言；
原生分辨率的那份则作为 session 的 zoom 取材保留。

这正是降采样不花代价的原因。`zoom` 裁的是原生帧而非展示帧，于是基础帧保持
便宜，细节仍然可以一区一区拿回来。`ZoomedRegion` 用展示帧的坐标汇报
`region`，并以 `scale` 表示每个 region 像素对应多少裁剪像素，因此在 zoom 里
量出的点按 `region.origin + cropPoint / scale` 映射回去。没有发生缩放时
`scale` 为 1，映射退化为「加上原点」。

凭据窗口遮蔽（ADR-0020 W1）作用在采集处而非返回途中，因此 session 存下的
那一帧本身就是遮蔽后的。只遮蔽即将返回的那个 revision，会导致密码框在
`get_app_state` 里被涂黑，却在针对同一 revision 的下一次 `zoom` 中被原样交回。

## 限流

`PermissionGate::check_rate` 把驱动类调用限制在每分钟 150 次，并拒绝连续
20 次同签名（命令、进程、窗口、点击坐标）的调用。读永不限流：饿死
`get_app_state` 恰好会拿走 agent 发现自己卡住所需的那份反馈。kill switch
会重置这个窗口，新一轮运行不会被上一轮的预算拒掉。

## 代码位置

```
crates/cognia-automation/src/
  automation/
    permission.rs  consent.rs  policy.rs  audit.rs     # 关卡
    backend.rs  dispatcher.rs  worker.rs  tool_exec.rs # 执行
    cua_route.rs  model_view.rs  events.rs  persist.rs
    platform/  record/  virtual_display/
  sandbox/
    seccomp.rs  net_proxy.rs  protected.rs  limits.rs  # 限制原语
    macos.rs  linux.rs  windows.rs  launcher.rs  env.rs
  cua_sandbox/
    lifecycle.rs  protocol.rs  registry.rs  remote_client.rs

lib/automation/
  types.ts                  # Platform, Capabilities, ElementRef, Screenshot, UiStateRevision
  action-schemas.ts         # 动作词汇的 zod 契约，渲染成 JSON Schema
  model-frame.ts            # revision 到 MCP image + JSON 块（与 External Bridge 共用）
  client.ts                 # desktop_* 命令面
  policy.ts
  ocr-screen.ts  ocr-click.ts        # 按屏幕文字点击
  audit.ts  audit-retention.ts       # 镜像 + 保留策略
  consent-durations.ts
  sandbox-client.ts  sandbox-target.ts
  computer-use-pip.ts  picture-in-picture-layout.ts

components/automation/consent-overlay.tsx
plugins/computer-use/src/index.ts     # 九个模型工具
lib/external-bridge/mcp-server/server.ts   # 同一个 session，面向外部 MCP 客户端
```

## 相关文档

<Cards>
  <Card title="ADR-0020" href="../adr/0020-computer-use-completeness" description="Computer Use 的决策记录" />
  <Card title="沙箱" href="./sandbox" description="本 crate 共享的限制原语" />
  <Card title="OCR" href="./ocr" description="ocr-click 借以按屏幕文字点击的能力" />
  <Card title="插件系统" href="./plugin-system" description="computer-use 工具如何注册" />
</Cards>
