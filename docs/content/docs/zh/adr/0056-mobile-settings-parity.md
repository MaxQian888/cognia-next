---
title: "ADR-0056 — 移动端设置对等性"
description: "将Capacitor移动设置接口（/me）与桌面设置完全对等性，独立（BYOK）作为主线。解决核心矛盾——独立的Webview引擎没有运行tools/agent循环——通过模式门槛对代理类设置进行限制：它们在配对模式下远程编辑桌面sidecar，并在独立模式下隐藏，而不是直接发布，也不会阻碍更大UI引擎重写的工作。在设置存储驱动的桌面部分组件中，重新使用，并扩展配套app_settings_update允许列表，覆盖已经同步但还无法写回的代理偏好字段，permissionMode被限制在biometric/can_control后面。"
---

# ADR-0056 — 移动端设置对等性

**状态**：提议（2026-06-28） **作者**：Max Qian + Claude **基于**基础开发**：ADR-0014（Capacitor移动壳）、ADR-0015（移动端v2完成）、ADR-0021（WebRTC WAN 传输——伴随者`app_settings_update`允许列表先例）、ADR-0027（移动同步编排器）、ADR-0041（代理命令自动模式）。关于领域术语表和D1–D5判定，请参见`CONTEXT.md`。

## 背景

手机是Capacitor外壳，桌面版Tauri应用发布的静态导出功能Next.js。其设置中心是`/me`路径（NOT桌面`/settings`）：一个数据驱动的iOS-style列表（`components/mobile/me/me-entries.ts`），包含24+`/me/*`子页面，包含搜索、收藏和六个组。它已经相当可观了——外观重用了完整的桌面`<AppearanceSection/>`、BYOK 提供商、同步、存储、备份、生物识别和设备信息，这些都已通过线路测试。

目标是**完整的设置对等性，而不是简化的子集**。有两个事实决定了这一切的可能：

1. **手机运行两种模式之一**（`AppSettings.mobileRuntimeMode`、设备本地、绝不同步）：
   - **独立（BYOK）**——自给自足，聊天通过`lib/ai/chat/standalone-engine.ts`在WebView中运行。
   - **配对（伴）**——Tauri桌面的远程客户端;工作在桌面sidecar执行。

2. **独立引擎是一个纯调用AI SDK `streamText`。** 它只消耗模型和已组合的系统提示符。它运行**无工具、无MCP、无代理循环、无权限模式、无`autoMode`/`toolFilter`/thinking预算。** 任何在*独立*手机上显示的任何代理类设置，今天都没有消费者——它UI死了，是仓库中最常见的缺陷类别。

第三个事实限制了wire/security的边界。设置同步是非对称的：
- 桌面→手机镜像19个密钥（`CROSS_PLATFORM_SETTING_KEYS`），**包括**代理字段`autoMode`、`permissionMode`、`defaultSystemPrompt`、`defaultMaxThinkingTokens`、`bareMode`、`debugMode`、`briefMode`。
- 手机→桌面允许~36个密钥（`src-tauri/src/companion_api/rpc.rs`中`APP_SETTINGS_MOBILE_ALLOWED_KEYS`），服务器端强制执行OpenAPI spec-对等性+Rust测试。上面的代理字段在里面是**NOT**：手机能看到但无法编辑回去。`apiKey`、`apiBaseUrl`、提供商配置、`sidecarPath`和传输键都是在移动端*不可写*的，并且一直保持这样。

我们评估了三种解决代理与设定张力的方法：

- **A. 模式门禁代理类设置。** 仅在配对模式下暴露，在那里它们远程编辑桌面sidecar（真正的后端）;把它们单独隐藏起来。没有死去的UI;设置的努力就是设置的努力。
- ** B. 先将独立引擎扩展到真正的代理环路。** 给BYOK真正的 tools/MCP/permission 模式，这样设置中两个模式都有消费者。这是一个远远超出“设置”范围的大型功能计划，会阻碍对等性所有工作。
- **C. 展示两种模式的面板;在独立环境中，它们存在但无所作为。** 明确地已拒绝——死死了，这正是无声运UI是构建但休眠的反模式。

## 决策

这些决策在规范中记载于`CONTEXT.md`（D1–D5）;总结如下：

- **D1 — 对等性目标。** 两种模式均达到满对等性;独立（BYOK）是主线。没有简化子集。
- **D2 — Agent类设置是模式限制（选择选项A）。** Agent 运行时 / 工具过滤 / MCP / 权限模式 / 斜线命令仅在**配对**模式（远程编辑桌面sidecar）和**独立**模式下hidden/disabled暴露。将独立引擎扩展到真实代理循环是另一个未来的计划，不属于本工作的一部分。
- **D3 — 构建策略：混合，默认重用。** 纯设置商店驱动的桌面部分直接嵌入`/me/*` `SubPageShell`中（`/me/appearance`已经做到了）。带有仅限Tauri标签的复杂部分（例如agent-运行时的 sidecar/SDK 标签页）会被重用，但platform/mode 门禁这些标签页。没有完全的移动原生重写。
- **D4 — `permissionMode`远程写入是门禁的。** `permissionMode` 加入写入允许列表，但远程写入——尤其是向 `bypassPermissions`/`acceptEdits` 升级——必须通过现有的`biometricRequiredFor`/伴随`can_control` 门禁，而不是纯偏好写入。其他桶1字段则正常写入。
- **D5 — 覆盖范围：桶1+2+3（满）。** 桶4（桶4（提供商 凭证、sidecar/transport、LSP、沙箱、源代码控制、工作区信任、伴随服务器、计算机使用执行）仅在桌面上运行。

### 示范器桶

- **桶1 — 同步但不可编辑。** `autoMode`，`permissionMode`（根据D4进行门禁），`defaultSystemPrompt`，`defaultMaxThinkingTokens`，`bareMode`，`debugMode`，`briefMode`。需要允许列表扩展+移动UI。
- **第二类 — 呈现缺少选项的页面。** 对每个`/me/*`页面进行桌面版块审核，填补空白（偏好设置、对话、语音、OCR、网页搜索、通知）。
- **桶3 — 缺少桌面部分。** 外部代理、MCP（http/SSE）、斜条命令、Skills/Subagents/Characters管理、插件管理、Agent Teams、工作流程设置、网络、指令、GitHub交付、hook。根据D2，他们会接触特工运行时，是模式门控的。
- **第4桶——排除。** 如D5。

## 浪形滚出

每波都包含：共址测试≥90%lines/branches/functions）、i18n密钥在**两个**的 `en.json` 和 `zh-CN.json` + `pnpm lint:i18n`、按 D2 进行模式门控，以及提交前的 `preflight` 通过。Bucket-3 分区每 PR发一部分，每个分段需用户确认。

- **波0 — 助长者。**
  - 设置端运行时模式门槛辅助工具，使代理面板仅在配对模式（D2）下渲染。
  - 用桶1字段展开`APP_SETTINGS_MOBILE_ALLOWED_KEYS`;`permissionMode`在D4 门禁之后。保持单元测试、OpenAPI `spec_parity`检查和`lib/settings/section-keys.ts`镜同步`src-tauri` Rust。
- **波1 — 桶1 UI。** `/me/agent`（或`/me/preferences`的扩展）暴露代理默认值，重复使用桌面代理运行时默认标签页（D3）中的触控安全部分。
- **波次2 — 桶2完整性。** 按页审计和填补现有`/me/*`页。
- **波段3+——桶3。** 每PR一组，顺序如下。

## 后果

- 配套的写入允许列表是一个带有线规范和测试的安全合同;每个新增的bucket-1/bucket-3字段必须同时更新Rust const、OpenAPI spec、`section-keys.ts`镜像和对等性测试，否则CI失败。这种摩擦是有意为之。
- 移动端设置UX现在正式依赖于`mobileRuntimeMode`：同一个`/me`列表显示的是独立和配对的不同代理面板。未来的读者如果在独立手机上看到代理面板“缺失”，应该参考D2，而不是把它当作bug。
- 独立BYOK用户**不会**获得agent-runtime/MCP/tools设置，直到单独的引擎扩展计划发布。该ADR记录为有意排除。
- 提供商 凭证仍然分裂：设备本地的BYOK密钥通过`/me/providers`（从未同步，也无法远程写入）与仅桌面的提供商配置。移动端永远不会成为桌面凭证的远程编辑。

## 当前状态修订（2026-08-13）

`/me/*` surfaces 已覆盖预期的 bucket 1/2/3 family，包括 Agent、MCP、plugins、skills、teams、workflows、hooks、network 与 external agents。“完全对等”仍需要生成的 field-level matrix 以及 paired/standalone 验证；bucket 4 按原决策保持 desktop-only。
