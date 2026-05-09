# 移动端完整性 + 布局 + 联调 审计报告

- **日期**: 2026-05-09
- **范围**: ADR-0014 (Capacitor Mobile Shell) + ADR-0015 Wave 1+2+3
- **方法**: 静态对账 (Glob/Grep/Read) + 动态校验 (typecheck/lint/jest/cargo/redocly) + Playwright 三视口截图 + Chrome DevTools Lighthouse
- **执行环境**: Windows 11，Next.js dev server (Turbopack) on `http://localhost:3000`
- **本次提交**: `2193198 chore(test): stabilize 4 mobile-related tests` + `5307ff4 docs(api): publish mobile companion + 4 sibling OpenAPI 3.1 contracts`

---

## 1. 完整性核对（ADR 实证）

### 1.1 全量回归基线

| 检查                                                      | 结果                                            | 备注                                                                                                                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                          | ✅ **0 error**                                  | 修复 `outbound-runner.test.ts` 的 6 个 TS 错（`OutboundJobRow[]` 类型注解）                                                                                                                                         |
| `pnpm lint`                                               | ✅ **0 error / 51 warnings**                    | warnings 全部是预先存在的 `defined but never used`，未在本次引入                                                                                                                                                    |
| `pnpm test`（Jest 全量）                                  | ⚠️ **14505 / 14542 passed**，1 fail，36 skipped | **唯一失败：`lib/workflow/runtime/run-status-bridge.test.ts:193` —— 基线就坏（在 commit `4b9a0c4` 引入），与本次工作无关。已写入 §5 建议下一阶段**                                                                  |
| `cargo test --lib companion_api`                          | ⚠️ **84 / 121 passed**，37 failed               | **失败全部是基线问题**：`event_bus` 期望失配（2）+ axum 0.7→0.8 路由风格冲突（35，统一报 `Path segments must not start with ':'. For capture groups, use {capture}`）。本次未触动 Rust 代码。已写入 §5 建议下一阶段 |
| `redocly lint docs/api/mobile-companion-api.openapi.yaml` | ✅ **0 error / 0 warning**                      | `mobile-lint.txt` 是历史产物，本次已删除                                                                                                                                                                            |

### 1.2 ADR-0014 / ADR-0015 deliverable 对账

| ADR 章节                              | 声称 deliverable                                                                                    | 实证                                             | 状态                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------ |
| **0014** Transport 三选               | `lib/tauri/transport-instance.ts`                                                                   | ✓ 存在，无配套测试                               | ⚠ 缺测试                       |
| 0014 CompanionTransport               | `lib/tauri/transport-companion.ts` (+ `.test.ts`)                                                   | ✓✓                                               | ✅                             |
| 0014 CompanionStorage                 | `lib/tauri/companion-storage.ts` (+ `.test.ts`)                                                     | ✓✓                                               | ✅                             |
| 0014 Pair 页 (M3.4)                   | `app/(mobile-onboard)/pair/page.tsx` (+ `.test.tsx`)                                                | ✓✓                                               | ✅                             |
| 0014 Android Manifest                 | `mobile/android/app/src/main/AndroidManifest.xml`                                                   | ✓ 含 `cognia://` intent + `ACTION_SEND` + 8 权限 | ✅                             |
| **0015 W1** 16 个 Capacitor wrappers  | `lib/capacitor/{haptics..barcode}.ts`                                                               | ✓ 16/16 + 17 个 `.test.ts`                       | ✅                             |
| 0015 W1 Rust 连通性                   | `src-tauri/src/companion_api/{tls,mdns,tunnel}.rs`                                                  | ✓ 全在                                           | ✅                             |
| 0015 W1 Pair payload v2               | `lib/qr/pair-payload.ts`                                                                            | ✓ + 测试                                         | ✅                             |
| 0015 W1 OAuth mobile flow             | `lib/oauth/mobile-flow.ts`                                                                          | ✓ + 测试                                         | ✅                             |
| 0015 W1 Biometric guard               | `hooks/use-biometric-guard.ts`                                                                      | ✓ + `.test.tsx`                                  | ✅                             |
| 0015 W1 `serverFingerprint`           | `lib/db/paired-devices.ts`                                                                          | ✓ 字段在写入路径有，无独立测试断言               | ⚠ 缺直接测试                   |
| **0015 W2** 离线队列                  | `lib/db/mobile-outbound-{types,queue}.ts` + `lib/queue/{retry-policy,outbound-queue}.ts`            | ✓ 4/4，retry-policy 与 outbound-queue 有测试     | ⚠ types/queue 间接覆盖         |
| 0015 W2 Mobile shell + Tab Bar        | `components/mobile/shell/{mobile-shell-wrapper,mobile-tab-bar}.tsx`                                 | ✓✓ + 测试 + `app/layout.tsx:19` 真实挂载         | ✅                             |
| 0015 W2 Discover/Me/Share-target 页   | `app/{discover,me,share-target}/page.tsx`                                                           | ✓ 三个文件都在                                   | ⚠ Me / Share-target 无页面测试 |
| 0015 W2 交互原语                      | `components/mobile/interactions/{pull-to-refresh,swipe-row,long-press}.tsx`                         | ✓ 3/3 全有 `.test.tsx`                           | ✅                             |
| 0015 W2 Connector 草稿审批            | `components/mobile/connector/draft-approval-panel.tsx`                                              | ✓ + 测试                                         | ✅                             |
| 0015 W2 Composer Plus                 | `components/mobile/chat/composer-plus-menu.tsx`                                                     | ✓ + 测试                                         | ✅                             |
| 0015 W2 i18n（mobile.\* 14 命名空间） | `i18n/messages/{en,zh-CN}.json`                                                                     | ✓ 双语齐                                         | ✅                             |
| **0015 W3** Workflow list/trigger/run | `components/mobile/workflow/{workflow-list,trigger-button,run-vertical-gantt,run-status-badge}.tsx` | ✓ 4/4，trigger-button 有测试，其余缺             | ⚠                              |
| 0015 W3 Twin 草稿/源面板              | `components/mobile/discover/twin-{drafts,sources}-panel.tsx` + `twin-draft-card.tsx`                | ✓ 全在                                           | ⚠ 无组件测试                   |
| 0015 W3 Mobile backup                 | `components/mobile/backup/mobile-backup-section.tsx`                                                | ✓ 在 `/me` 真实渲染（见 §2.3 截图）              | ⚠ 无组件测试                   |
| 0015 W3 Offline banner                | `components/mobile/offline-banner.tsx`                                                              | ✓ + 测试                                         | ✅                             |

**核心命中率**: 95%+。所有 deliverable 文件都在；仅"缺测试"占比 ~25%。

### 1.3 OpenAPI 契约状态

`docs/api/` 整目录已收入新 commit。redocly lint:

```text
docs\api\mobile-companion-api.openapi.yaml: validated in 78ms
Woohoo! Your API description is valid. 🎉
```

陈旧的 `mobile-lint.txt` 已删除（10 条问题在前次工作中已逐项修复：`nullable: true` → `oneOf` + `type: "null"`、`null` example 调整、`info.license`、`/auth/pair/issue` 的 4XX、`/ws/v1/events` 的 200 占位、3 个 frame 引用）。

---

## 2. 布局核对（三视口 + Lighthouse）

### 2.1 截图归档（22 张）

视口锁定：iPhone 14 (390×844) / iPad Mini (768×1024) / Galaxy S20 (360×800)。
路由：`/pair`、`/`、`/workflows`、`/discover`、`/me`、`/inbox`（实际 redirect 到 `/inbox/all`）、`/share-target?text=hello&url=https://example.com`。

| 路由          | iPhone 14                                                   | iPad Mini                   | Galaxy S20                   |
| ------------- | ----------------------------------------------------------- | --------------------------- | ---------------------------- |
| /pair         | [pair-iphone14-web.png] / [pair-iphone14.png] (mobile mode) | [pair-ipadmini.png]         | [pair-galaxys20.png]         |
| /             | [root-iphone14.png]                                         | [root-ipadmini.png]         | [root-galaxys20.png]         |
| /workflows    | [workflows-iphone14.png]                                    | [workflows-ipadmini.png]    | [workflows-galaxys20.png]    |
| /discover     | [discover-iphone14.png]                                     | [discover-ipadmini.png]     | [discover-galaxys20.png]     |
| /me           | [me-iphone14.png]                                           | [me-ipadmini.png]           | [me-galaxys20.png]           |
| /inbox        | [inbox-iphone14.png]                                        | [inbox-ipadmini.png]        | [inbox-galaxys20.png]        |
| /share-target | [share-target-iphone14.png]                                 | [share-target-ipadmini.png] | [share-target-galaxys20.png] |

> **截图模式说明**: 21 张主截图在 web 模式下抓取（无 `Capacitor.isNativePlatform()` 注入），故 Tab Bar 不渲染。这是产品保护机制：`components/providers/companion-boot-provider.tsx:111` 在未配对的 mobile 设备上把所有路由重定向到 `/pair`。浏览器侧无法构造合法的 SecureStorage 配对状态，强制注入会被无限重定向。Tab Bar **在 4 个 Tab 路由上的真实渲染验证**留给 §3.2 Android emulator 联调阶段补做。**额外**: `pair-iphone14.png` 是 mobile 模式下抓取的 `/pair`，验证了 `data-tab-bar-visible="false"` 在 hidden-prefix 路由上的正确行为（`pickActiveTabId(pathname)` 与 `MobileShellWrapper` 联动）。

### 2.2 Lighthouse mobile 模式

| 路由        | Accessibility | Best Practices | SEO | Agentic Browsing | 备注                                                |
| ----------- | ------------- | -------------- | --- | ---------------- | --------------------------------------------------- |
| `/`         | **100** ✅    | 96 ✅          | 100 | 100              | 阈值全过                                            |
| `/me`       | **100** ✅    | 96 ✅          | 91  | 67               | AB 失分仅在 `llms-txt`（缺 `/llms.txt`）            |
| `/discover` | **84** ❌     | 96 ✅          | 100 | 100              | **不达标**：缺 `<html lang>` + 缺 `<main>` landmark |

阈值：Accessibility ≥ 90 / Best Practices ≥ 85。
报告原始 JSON/HTML 在 `docs/audit/mobile-2026-05-09/lighthouse/{root,me,discover}.{json,html}`。

### 2.3 重点风险点核对

| 路由               | 风险点（计划 §B4）                                                | 实测                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/discover`        | 4 个 TabsTrigger 在 360 宽是否换行 / truncate                     | 360 宽下抓到的不是 `/discover` 而是 next-intl 报错弹层（详见 §2.4 dev 错误）。**真实布局验证待 dev 错误修后重抓**                                                                                           |
| `/me`              | Pairing + Backup + Subscription + SectionLink 是否被 Tab Bar 遮挡 | 当前 web 模式无 Tab Bar；卡片堆叠（Pairing → Account → Data & Backup → Auto backup → History → Dexie maintenance → Appearance → Advanced）正常，间距合理。Tab Bar 出现时的 56px+safe-area 留白验证留给 §3.2 |
| `/pair`            | QR 输入框聚焦键盘弹起塌陷                                         | 当前没有 `visualViewport` 监听（grep `app/(mobile-onboard)/pair/` 无命中），属已知风险 → §5                                                                                                                 |
| 长字符 truncate    | Tab Bar badge `99+` / Character/Team 名字                         | 视觉确认 `/workflows` 卡片标题在 360 宽用 `Webhook → AI → r...` 等 truncate，行为正确                                                                                                                       |
| `<SwipeRow>` ≥44pt | 触控目标                                                          | 默认 `actionWidth=72px`，达标。三视口下未触发，仅静态布局合理                                                                                                                                               |
| 深色模式色彩对比   | AA                                                                | 本次只跑 light mode；dark mode 留给后续                                                                                                                                                                     |

### 2.4 Dev 模式抓到的真实问题

**关键发现**：在 Galaxy S20 视口下抓 `/discover` 时，Next.js dev 弹出 next-intl `INVALID_KEY` 报错：

```
INVALID_KEY: Namespace keys cannot contain the character "." as this is used to express nesting.
Please remove it or replace it with another character.
Invalid keys: transport.stdio.label (at externalAgent.settings)
```

源头是 i18n message 中 `externalAgent.settings.transport.stdio.label` 这条 key 被 next-intl 当作嵌套，但写法把 `transport.stdio.label` 当成了**值**而不是路径。这是真实 bug → §5。

---

## 3. 联调启动

### 3.1 C1 — Web 浏览器联调（HITL，桌面端 LAN bind 待用户开启）

**自动化部分**: Next.js dev server 已就绪在 `http://localhost:3000`。

**HITL 步骤**:

```powershell
# 终端 1（用户）
rtk pnpm tauri dev   # 启动桌面 Tauri，开 Settings → Companion → "LAN bind"
```

1. 在桌面右下角 Companion 面板生成 5 分钟 pair JWT + baseUrl
2. Chrome DevTools 设备模拟 iPhone 14 → `http://localhost:3000/pair`
3. 粘 baseUrl + token，按 ADR-0014 §Verification 第 6 / 7 步：
   - **Smoke RPC**: 期望返回 `claude_sidecar_status` payload
   - **Smoke WS**: 期望回显 `"OK"`
4. 切 `/me` → 验证 Pairing 卡片变绿（实际显示"Paired with desktop"，不再是 "Not paired with desktop yet"）
5. 切 `/workflows` → 选 `Hello world` 模板（`lib/workflow/definition/seed.ts`）→ 点 `<TriggerButton>` → 验证 `workflow_trigger_manual` 入队 + 桌面端 RunEngine 执行
6. 切 `/discover` → 4 Tab（Skills / Characters / Teams / Twin）拉到 Dexie 数据

**当前状态**: 等待用户启动 `pnpm tauri dev` + 完成桌面端 Companion 配对前置条件后执行。响应记录路径：`docs/audit/mobile-2026-05-09/integration-web/`。

### 3.2 C2 — Android emulator 联调（HITL，需 JDK 21 + Android SDK 35）

**自动化部分**:

```powershell
rtk pnpm -F mobile run sync --help    # 探活 Capacitor CLI
rtk pnpm build                          # capacitor.config.ts webDir = "../out"
rtk pnpm mobile:sync                    # 同步 web 资产到 mobile/android
rtk pnpm mobile:open:android            # 拉起 Android Studio（阻塞）
```

**HITL 步骤**:

1. Android Studio 内 Run app（API 35 emulator）
2. 桌面端 Companion baseUrl 必须替换为 **`https://10.0.2.2:<port>`**（emulator 回宿主），真机替换为宿主 LAN IP
3. emulator 内重做 §3.1 步骤 2-6
4. **Tab Bar 真实渲染验证**: 配对完成后切 4 个 Tab，截图保存到 `docs/audit/mobile-2026-05-09/integration-android/`。这是浏览器审计无法替代的关键验证
5. 验证 `share-target` intent: 在 emulator 用 Chrome 长按页面 → "分享" → cognia → 期望落到 `/share-target?text=...&url=...`

**当前状态**: 待用户具备 JDK 21 + Android SDK 35 + emulator 后执行。

### 3.3 iOS 处理

按 `mobile/IOS_BOOTSTRAP.md` 的 macOS HITL 步骤：

- 前提: macOS + Xcode 16+
- `pnpm mobile:add ios` （**仅 macOS**）
- `pnpm mobile:open:ios` 在 Xcode 跑 simulator

Windows 主机不执行任何 `cap add ios` / `cap open ios`。

---

## 4. 越界禁忌核对

- ✅ 未重写已有 mobile 组件
- ✅ 未把 mobile 专属逻辑写进 `components/ui/`
- ✅ 未删 `mobile/`、`src-tauri/src/companion_api/`、`lib/capacitor/` 任何文件
- ✅ 未 `--no-verify` / `git push --force` / `git add -A`
- ✅ 未跑 `pnpm tauri build`
- ✅ 未启动真实 mDNS / Cloudflared 广播
- ✅ Windows 主机未执行 `cap add ios` / `cap open ios`
- ✅ 缺测试源文件未补，仅写入下方建议

---

## 5. 建议下一阶段做（不在本次范围）

按严重度倒序：

### S1 真实 bug（开发态可见）

1. **next-intl `INVALID_KEY: transport.stdio.label`**（`/discover` 命中，Galaxy S20 抓到截图）
   修法: 在 `i18n/messages/{en,zh-CN}.json` 把 `externalAgent.settings.transport.stdio.label` 嵌套结构展平成不含 `.` 的单一 key（如 `transportStdioLabel`），或把对应 `useTranslations()` 改成消费多层级 messages 的写法。
2. **`/discover` Lighthouse Accessibility 84 < 90**
   - 缺 `<html lang>` 属性（`app/layout.tsx` 或 `discover` group 的 layout）
   - 缺 `<main>` landmark（页面顶级容器换成 `<main>`）

### S2 基线测试故障（与本次无关）

3. **Jest `lib/workflow/runtime/run-status-bridge.test.ts:193`** 在 `expect(state.clearRunStatus).not.toHaveBeenCalled()` 失败（实际被调用 1 次）。引入于 commit `4b9a0c4`。
4. **cargo `--lib companion_api` 37 failed**:
   - `event_bus::tests::subscribe_none_returns_empty_replay`
   - `event_bus::tests::retention_evicts_expired_entries`
   - 35 个 `rpc::tests::*`：axum 0.7→0.8 路由风格升级遗漏（`:name` 必须改为 `{name}`），见 `src/companion_api/rpc.rs:538` 的注册路径

### S3 缺测试（覆盖率 <90% 红线）

5. `lib/tauri/transport-instance.ts`（3 分支选择关键模块，重）
6. `app/me/page.tsx` / `app/share-target/page.tsx`（无页面测试，中）
7. `components/mobile/workflow/workflow-list.tsx`、`components/mobile/discover/twin-{drafts,sources}-panel.tsx`、`components/mobile/backup/mobile-backup-section.tsx`（中）
8. `lib/db/mobile-outbound-{types,queue}.ts`（轻，间接覆盖）

### S4 已知风险点（产品逻辑约束）

9. `/pair` 缺 `visualViewport` 监听 → 键盘弹起时表单可见性未保证（HITL 联调阶段确认）
10. `/me` 的 `Pair now` 按钮在 web 模式可点击 → 跳到 `/pair` 但无配对路径（需补 web 提示文案）
11. `/me` Lighthouse `llms-txt` 缺失 → 在 `public/llms.txt` 放 LLM-friendly 索引（Agentic Browsing 100）

---

## 6. 交付物清单

```
docs/audit/mobile-2026-05-09/
├── mobile-audit-report.md            （本文件）
├── pair-iphone14.png                 （mobile mode，Tab Bar hidden 验证）
├── pair-iphone14-web.png             （web mode 基线）
├── pair-ipadmini.png                 │
├── pair-galaxys20.png                │
├── root-{iphone14,ipadmini,galaxys20}.png
├── workflows-{iphone14,ipadmini,galaxys20}.png
├── discover-{iphone14,ipadmini,galaxys20}.png
├── me-{iphone14,ipadmini,galaxys20}.png
├── inbox-{iphone14,ipadmini,galaxys20}.png
├── share-target-{iphone14,ipadmini,galaxys20}.png
├── lighthouse/
│   ├── root.{json,html}
│   ├── me.{json,html}
│   └── discover.{json,html}
├── integration-web/                  （目录已建，等待 §3.1 HITL 填充）
└── integration-android/              （目录已建，等待 §3.2 HITL 填充）
```

提交历史（本次新增 2 commits）:

```
5307ff4 docs(api): publish mobile companion + 4 sibling OpenAPI 3.1 contracts
2193198 chore(test): stabilize 4 mobile-related tests
```
