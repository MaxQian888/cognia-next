---
title: Computer Use
description: 让 Agent 操作宿主桌面 —— 为每个动作设卡的五层防御栈、带限时内存授权的 HITL 同意代理、降采样截图的坐标回缩，以及底层的 sandbox crate。
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
  <Stat label="Rust 模块" value="37" hint="crates/cognia-automation/src —— automation + sandbox + cua_sandbox" />
  <Stat label="前端模块" value="15" hint="lib/automation —— 非测试 .ts" />
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

## 坐标必须被缩放回去

当截图降采样开启时（设置 → 自动化 → 行为），模型只会看到缩放后的画面，
因此它输出的每个坐标都处在缩放空间，必须在下发前乘回去。
`lib/automation/coordinate-scaler.ts` 复刻了 Anthropic `computer-use-demo` 中
`scaling.py` 的双向缩放。其状态按捕获目标取键 —— `sessionKey`、cua 连接 id 或 `"local"` ——
并在每一张流经 `anthropic-action-mapper.ts` 的截图上刷新。关闭缩放时，
源尺寸等于缩放尺寸，运算退化为恒等，因此两种情况走的是同一条代码路径。

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
  types.ts                  # Platform · Capabilities · ElementRef · Locator · Screenshot · ClickTarget
  client.ts  plugin-tauri.ts
  anthropic-action-mapper.ts  coordinate-scaler.ts
  ocr-screen.ts  ocr-click.ts        # 按屏幕文字点击
  audit.ts  audit-retention.ts       # 镜像 + 保留策略
  consent-durations.ts
  sandbox-client.ts  sandbox-target.ts
  computer-use-pip.ts  picture-in-picture-layout.ts

components/automation/consent-overlay.tsx
plugins/computer-use/src/index.ts     # 工具注册
```

## 相关文档

<Cards>
  <Card title="ADR-0020" href="../adr/0020-computer-use-completeness" description="Computer Use 的决策记录" />
  <Card title="沙箱" href="./sandbox" description="本 crate 共享的限制原语" />
  <Card title="OCR" href="./ocr" description="ocr-click 借以按屏幕文字点击的能力" />
  <Card title="插件系统" href="./plugin-system" description="computer-use 工具如何注册" />
</Cards>
