# 插件 SDK UI 表面统一整改 epic

**日期**：2026-07-27
**状态**：待执行（本文件不含任何生产代码改动）
**触发**：对「插件 SDK 在 UI 方面的缺口和统一性问题」的全量审计
**相关**：ADR-0026（插件平台 v2）· `docs/content/docs/plugin-dev/surfaces.mdx` · 工作规则 3/4/7

---

## 0. 一句话结论

宿主侧接线基本齐全，问题不是「建了没接线」——是**12 种插件 UI 渲染表面各自演化，横切契约（样式作用域 / 错误边界 / i18n / 图标 / 形制）只覆盖了其中 2–3 种**，且 43 个内置插件几乎不使用这套 UI，所以绝大多数分叉从未被真实流量证伪。

---

## 1. 审计基线（全部为 2026-07-27 实测，非记忆）

### 1.1 表面清单

| #   | 表面                       | 渲染点                                                           | `data-plugin-root`（`@scope` 锚点） | ErrorBoundary                 | 可重试 |
| --- | -------------------------- | ---------------------------------------------------------------- | ----------------------------------- | ----------------------------- | ------ |
| 1   | extension slot             | `components/plugins/plugin-extension-slot.tsx`                   | ✅                                  | ✅ `PluginExtensionBoundary`  | ❌     |
| 2   | extension slot（溢出变体） | `components/plugins/plugin-extension-slot-with-overflow.tsx:113` | ❌                                  | ⚠️ 同名影子类                 | ❌     |
| 3   | context workbench panel    | `components/context-workbench/context-workbench.tsx:1041`        | ✅                                  | ✅ `PanelErrorBoundary`       | ✅     |
| 4   | context panel webview      | `components/plugins/plugin-context-panel-webview.tsx`            | N/A（iframe）                       | ❌                            | ❌     |
| 5   | modal root                 | `components/plugins/dialogs/plugin-modal-root.tsx`               | ❌                                  | ✅ `PluginModalErrorBoundary` | ❌     |
| 6   | view container panel       | `components/shell/plugin-view-container-panel.tsx`               | ❌                                  | ❌                            | ❌     |
| 7   | tree view host             | `components/plugins/plugin-tree-view-host.tsx`                   | ❌                                  | ❌                            | ❌     |
| 8   | custom view host           | `components/plugins/plugin-custom-view-host.tsx`                 | ❌                                  | ❌                            | ❌     |
| 9   | webview host               | `components/plugins/plugin-webview-host.tsx`                     | N/A（iframe）                       | ❌                            | ❌     |
| 10  | chat message-part renderer | `components/chat/message-renderer.tsx:1126`                      | ❌                                  | ✅ `PluginPartErrorBoundary`  | ❌     |
| 11  | chat tool-result renderer  | `components/chat/message-parts/mcp-tool-card.tsx:192`            | ❌                                  | ✅ 复用 #10                   | ❌     |
| 12  | quick actions menu         | `components/chat/composer/plugin-quick-actions-menu.tsx`         | ❌                                  | ❌                            | ❌     |
| —   | config component           | `components/plugins/detail/plugin-config-form.tsx:598`           | ✅（复用 #1 的边界）                | ✅                            | ❌     |
| —   | tray item                  | `lib/tray/registry.ts` → 原生托盘                                | N/A                                 | N/A                           | N/A    |

**覆盖率**：`data-plugin-root` 3/12 · ErrorBoundary 7/12 · 可重试 1/12。

### 1.2 四套 ErrorBoundary 的行为分歧

| 边界                                      | 崩溃后渲染                                | 上报通道                        | i18n   | 可重试 |
| ----------------------------------------- | ----------------------------------------- | ------------------------------- | ------ | ------ |
| `PluginExtensionBoundary`（正版）         | `null`                                    | analytics + `diagnostics-store` | N/A    | ❌     |
| `PluginExtensionBoundary`（影子，溢出槽） | `null`                                    | **仅** analytics                | N/A    | ❌     |
| `PluginPartErrorBoundary`                 | 红框 + **英文硬编码**（标 `i18n-exempt`） | `loggers.chat.warn`             | ❌     | ❌     |
| `PluginModalErrorBoundary`                | 灰字                                      | **`console.error`**             | ✅     | ❌     |
| `PanelErrorBoundary`                      | 调用方 fallback                           | `console.error`                 | 调用方 | ✅     |

五套实现、**五条不同的上报通道**，其中只有一条进得了 `/plugins` 诊断面板。

### 1.3 其余实测数据

- 57 个 canonical extension point，`pnpm audit:slots` 全绿（`implemented/stable` × 57）。
- `formFactor` 映射覆盖全部 57 个（icon 9 / row 22 / block 15 / panel 11），但 `grep -rn formFactor packages/plugin-sdk/src` = **0 命中**。
- catalog `manifestContributions` 共 51 项，**不含 extension slot**（`packages/plugin-sdk/contract/catalog.json`）。
- 43 个内置插件的 UI 贡献使用量：`viewsContainers=1` `webviews=1` `contextPanels=1` `registerExtension=1`；`views` / `modalMounts` / `messageRenderers` / `toolRenderers` / `quickActions` / `a2uiComponents` / `configComponent` / `trayItems` **全部为 0**。
- 全仓唯一 `registerExtension` 调用：`plugins/pet-daily-quests/src/index.ts:70`，写法是 `(ctx as FullPluginContext).extensions.registerExtension(...)`。
- `activate` 的上下文构造点全仓唯一：`lib/plugin/core/manager.ts:2070` `createFullPluginContext(...)` → `:2080` `definition.activate(context)`。`loader.ts` 的 hybrid 包装器只是转发。
- `@cognia/plugin-ui` 导出 27 个 primitive；宿主 `components/ui/` ~57 个。README 仍写 "ten of them"（陈旧）。
- `PLUGIN_SHARED_MODULES` = 5 项；`ESBUILD_EXTERNALS`（`crates/cognia-cli/src/engine/frontend_build.rs:120`）= 8 项。**两者均不含 `lucide-react`**。
- `components/shell/plugin-view-container-panel.tsx:13` 已经 `import { icons } from "lucide-react"` —— 全量图标集**今天就在 app bundle 里**。

---

## 2. 已推翻的两个前提（勿重蹈）

1. **「webview 是独立表面，应收敛进 contextPanel」——已经做完了。**
   `types/plugin/plugin-context-panel.ts` 的 `PluginWebviewContextPanelDef` 就是「`webview` 字段指向同 manifest 的 `webviews[]` 条目，宿主渲染 iframe 并通过 postMessage 镜像 context-panel API」。不要再设计一遍。

2. **「以 contextPanels 为唯一面板真相，viewsContainers 标休眠」——会砍掉真能力。**
   `contextPanels` 必填 `resourceKinds` + `activity`，天然绑定资源、挂 Context Workbench 右栏。
   `viewsContainers` 走 `components/shell/guild-rail.tsx:134` → `setSelected({kind:"plugin-view", containerId})` → 插件在最左 guild rail 拿图标 + **独占中间列**。这是应用级顶层导航入口，contextPanels 给不了。
   **定论**：两者均为正统，按位置划定职责。

---

## 3. 十一条既定决定

| #   | 决定                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 交付物 = 可执行整改 epic（本文件），每项含「证据 → 改法 → 门禁」                                                                                           |
| D2  | 统一语义 = 先收敛再对齐                                                                                                                                    |
| D3  | 面板类按位置分层：`contextPanels` = 资源范围右栏；`viewsContainers` = 顶层导航中列；收敛只发生在容器内的 3 种 view host                                    |
| D4  | 引入 `<PluginSurface>`，12 种表面**强制**走，静态门禁钉住                                                                                                  |
| D5  | 失败语义按 `formFactor` 分级：`icon`/`row` → 静默移除 + 上报；`block`/`panel` → 可 i18n 内联诊断 + 重试按钮                                                |
| D6  | `formFactor` 提升为通用 `PluginSurfaceFormFactor`，12 种表面全标注，SDK 导出类型 + 57 项映射表 + parity 测试                                               |
| D7  | manifest 新增 `extensions[]` 声明式贡献；宿主自动派生 `onView:<point>`；CLI 校验 canonical；命令式 API 保留                                                |
| D8  | `PluginContext` 吸收 `PluginContextAPI`；`FullPluginContext` 降为弃用别名                                                                                  |
| D9  | i18n 合并为一套，以 `manifest.i18n` 为真相；`ctx.i18n.t()` 改读 next-intl；`*Key` 铺到所有 manifest UI 标签                                                |
| D10 | 图标统一为 `PluginIconName`（lucide 全集名字）；废除 11 项 allowlist；`lucide-react` 进共享白名单 + CLI externals；`plugin-ui` 只补 Dialog / Sonner / Form |
| D11 | 验收 = 静态门禁 + 一个真实 in-tree 参考插件占满 12 表面 + 真 Chromium E2E                                                                                  |

**明确不做**：反向收敛为命令式 · `plugin-ui` 全量对齐到 ~57 个 · `viewsContainers` 标休眠 · 给 `icon`/`row` 形制加重试入口。

---

## 4. P0 —— 真 bug 与承重件

### P0-0 参考插件先行（先红）

**为什么排第一**：43 个内置插件几乎不用这些表面，光靠单测极易变成「测试自己造参数」——本仓已多次踩到。先写一个占满全部 12 种表面的真插件，让它在改动前就暴露每一处断裂，后续每个 P0/P1 条目都以「参考插件的哪一条从红变绿」作为验收。

**改法**

- 新建 `plugins/ui-surface-reference/`，manifest 同时声明：`extensions[]`（P1-5 落地后）、`contextPanels[]`（module + webview 两种）、`viewsContainers[]` + `views[]`（tree / custom 两种）、`webviews[]`、`modalMounts[]`、`messageRenderers[]`、`toolRenderers[]`、`quickActions[]`、`trayItems[]`、`configComponent`。
- 每个表面渲染两个东西：一个正常组件；一个由 URL query / 配置开关触发 `throw` 的组件（用于验证失败分级）。
- 每个表面各带一条 `manifest.styles` 规则（例如 `.ref-badge { outline: 2px solid red }`）用于验证 `@scope` 是否生效。
- 每个表面的标签走 `*Key` + `manifest.i18n.locales`，中英各一份。

**验收门禁**

- `tests/e2e/plugin-ui-surfaces.spec.ts`（Chromium，**不是 jsdom**——`@scope` 在 jsdom 中完全不实现）：
  - 每个表面断言 `[data-plugin-root="ui-surface-reference"]` 存在；
  - 断言 `.ref-badge` 的 computed `outline-color` 生效，且**宿主同名类不受影响**；
  - 断言崩溃组件按形制分级降级；
  - 切换语言后断言标签文本变化。
- 首次提交时该 spec **应当大面积失败**，失败清单即 P0-1..P1-5 的工作面。

---

### P0-1 影子 `PluginExtensionBoundary`（真 bug）

**证据**
`components/plugins/plugin-extension-slot-with-overflow.tsx:113` 定义了一个与 `plugin-extension-slot.tsx` 导出版**同名但完全独立**的 `PluginExtensionBoundary`，它：

- 不 stamp `data-plugin-root` ⇒ 插件的 `manifest.styles` 在该 slot 内**完全失效**；
- 只发 analytics，不写 `diagnostics-store` ⇒ 崩溃不进 `/plugins` 诊断面板、不上插件徽标；
- 不应用 `minWidth`/`maxWidth` ⇒ 插件声明的宽度提示被静默忽略。

使用点：`components/chat/composer/bottom-toolbar.tsx:149,158`，即 `chat.input.actions` + `chat.input.menu` —— **composer 工具栏**，第三方插件最可能放按钮的位置。三个能力在此同时静默失效。

**改法**
删除影子类，改为从 `plugin-extension-slot.tsx` 导入正版 `PluginExtensionBoundary`（它已导出）。P0-2 落地后再一并换成 `<PluginSurface>`。

**验收门禁**

- 回归测试：在 `plugin-extension-slot-with-overflow.test.tsx` 中断言溢出槽渲染出的节点带 `data-plugin-root`、崩溃时 `diagnostics-store` 收到一条 `plugin.silent-failure`、宽度提示落到 style。
- 新增 lint 规则或 `audit:plugin-surfaces`（P0-2）静态禁止「本地定义与已导出边界同名的类」。

---

### P0-2 `<PluginSurface>` 落地 + 12 表面接入 + 门禁

**改法**

- 新建 `components/plugins/plugin-surface.tsx`，单一职责：
  - stamp `data-plugin-root={pluginId}`（`@scope` 锚点）；
  - 无宽度提示时 `display: contents`（保持现有 flex 直接子元素语义），有提示时按 `min(<hint>, 100%)` 生成盒子——直接搬 `plugin-extension-slot.tsx` 现有的 `widthHintStyle`；
  - 外层挂 `container-type: inline-size`（**不含** context panel，`contain: layout` 会重锚绝对定位后代——现有注释已记录此陷阱）；
  - 内建 ErrorBoundary，按 `formFactor` 分级（见 P1-2）；
  - 崩溃统一写 `diagnostics-store` + analytics，**取消 `console.error` 与 `loggers.chat.warn` 两条旁路**。
- 12 种表面全部改为经由它渲染；`configComponent` 一并切换。
- iframe 类表面（#4 #9）不需要 `@scope`，但仍需边界与诊断上报，走同一个组件的 `variant="iframe"`。

**验收门禁**

- 新增 `scripts/gates/audit-plugin-surfaces.ts` + `pnpm audit:plugin-surfaces`，**仿 `audit-plugin-slots.ts` 的 TS AST 扫描**：
  - 维护一份「渲染插件供给的 React 节点」的调用点清单（类似 `SLOT_HOST_COMPONENTS`）；
  - 任一调用点未被 `<PluginSurface>` 包裹 ⇒ FAIL；
  - 任一文件本地重新定义 ErrorBoundary 用于插件内容 ⇒ FAIL。
- 加进 `scripts/gates/check-all.mjs` 的 `audit` 分组 + `check-gate-registry.test.mjs`。

---

### P0-3 `PluginContext` 合并

**证据**
`activate: (context: PluginContext)`（`types/plugin/plugin.ts:3089`）藏掉了 `extensions` / `theme` / `i18n` / `notifications` / `canvas` / `artifact` / `messagePart` / `toolResult` / `session` / `permissions` 等命名空间（它们在 `PluginContextAPI`，`types/plugin/plugin.ts:4709+`）。但运行时构造点全仓唯一且永远是 full 版 ⇒ **这是纯类型层面的谎**，收紧零运行时风险。现有受害者：`plugins/pet-daily-quests/src/index.ts:70` 的 `as FullPluginContext` 强转。

**改法**

- `PluginContext` 吸收 `PluginContextAPI` 的全部成员；
- `lib/plugin/core/context.ts:206` 的 `FullPluginContext` 改为 `type FullPluginContext = PluginContext`（保留名字，标 `@deprecated`），确保现存 `as FullPluginContext` 仍可编译；
- 删除 `pet-daily-quests` 的强转，作为「不再需要」的证明；
- `PluginDefinition.deactivate?: (context?: PluginContext)` 同步。

**验收门禁**

- `pnpm typecheck` 通过（以未包装的 `pnpm typecheck` 退出码为准，`rtk tsc` 过滤器会假绿）。
- 新增类型测试：`packages/plugin-sdk/src/context/index.test.ts` 断言 `ctx.extensions` / `ctx.theme` / `ctx.i18n` 在 `activate` 参数上直接可达，无需断言。
- 全仓 `grep -rn "as FullPluginContext" plugins/ lib/` 应为 0。

---

## 5. P1 —— 契约对齐

### P1-1 `formFactor` 通用化 + SDK 导出

**改法**

- 定义 `PluginSurfaceFormFactor`（沿用 `icon` / `row` / `block` / `panel`），为 12 种表面各标注默认值（modal / 面板类 = `panel`；chat renderer = `block`；quickAction / tray = `icon`）；
- 从 `@cognia/plugin-sdk` 导出类型 + 57 项 `EXTENSION_POINT_FORM_FACTORS` 映射表（纯字面量，不引入新的 `@/` 耦合）；
- `<PluginSurface>` 接收并透传，`PluginExtensionBoundary` 现在拿不到 `formFactor`（只有 `Cmp` 拿得到），需要一并接上。

**验收门禁**

- parity 测试：宿主 `lib/plugin/contracts/plugin-points.ts` 与 SDK 导出的映射表逐键相等，任一漂移 FAIL（参考 `CANONICAL_EXTENSION_POINTS` 已有的 parity 写法）。
- `pnpm build:packages` 通过（`@cognia/plugin-ui` 已在过滤器内；确认新导出未把 `@/` 带进 SDK）。

### P1-2 失败语义分级 + 重试

**改法**

- `icon` / `row`：渲染 `null`，写 `diagnostics-store`；
- `block` / `panel`：渲染可 i18n 的内联诊断（插件名 + 错误摘要）+ 「重试」按钮，直接搬 `context-workbench.tsx:137` 的 `fallback(retry)` 写法；
- 文案进 `i18n/messages/{en,zh-CN}/`；类组件读不了 hook，用与 `plugin-modal-root.tsx` 相同的「函数式 fallback 子组件 + `useTranslations`」结构，**消除现有的 `i18n-exempt` 硬编码英文**。

**验收门禁**

- 单测覆盖四种形制 × （正常 / 崩溃 / 重试成功）；
- P0-0 的 Chromium spec 断言 statusbar 崩溃后布局宽度不变（分级正确的实证）；
- `pnpm lint:i18n` 不新增 finding。

### P1-3 i18n 合并

**证据**
两套互不连通的存储：`manifest.i18n.locales` → `manager.ts:2254` 加前缀 `plugin.<id>.<key>` → `registerPluginI18n` → next-intl（宿主可读，`context-workbench.tsx:377` 即用此解析 `labelKey`，且注册时机在 `activate` **之前**）；而 `ctx.i18n.registerTranslations` / `t()` 写的是 `lib/plugin/api/i18n-api.ts` 的模块级 `pluginTranslations` Map（`grep registerPluginI18n` 在该文件 = 0）。作者必须把同一份文案维护两遍。

**改法**

- `ctx.i18n.t(key)` 改为解析 next-intl 的 `plugin.<pluginId>.<key>`；
- `ctx.i18n.registerTranslations` 改为写入同一个 store（走 `registerPluginI18n`），保留 API 供运行时动态补充；
- `*Key` 字段铺到所有 manifest UI 标签：`views[].titleKey` `viewsContainers[].titleKey` `webviews[].titleKey` `quickActions[].labelKey` `trayItems[].labelKey` `modalMounts[].labelKey` `extensions[].labelKey`（P1-5），全部沿用 `contextPanels` 现有的「`*Key` 优先，回退裸 `label`」语义，**不破坏现有裸串**。

**验收门禁**

- 新增 manifest 校验：声明了 `*Key` 但 `manifest.i18n.locales` 中无该键 ⇒ 校验错误（不是 warning）；
- 单测：`ctx.i18n.t()` 能读到 manifest 声明的键；宿主 `useTranslations` 能读到 `registerTranslations` 写入的键；
- P0-0 的 spec 切语言后断言全部 12 表面标签变化。

### P1-4 图标契约统一 + 共享 lucide

**证据**
6 种不兼容的 icon 字段类型（`PluginContextPanelIcon` 11 项 allowlist / 裸 `string` 多处 / `iconName: string` × 4 / `{emoji?,color?}` / `string | {light,dark}` / `{light,dark}`），且两套矛盾的解析策略打在同一个库上：`plugin-view-container-panel.tsx:38` 用 `icons[name]` 打 lucide 全集（打错静默回退拼图图标），contextPanels 却锁到 11 个名字（其类型注释自陈「手抄进三个地方，只对过两个」）。

**改法**

- 定义 `PluginIconName = keyof typeof import("lucide-react").icons`，从 SDK 导出；
- 所有原生（非 VS Code 兼容层）icon 字段收敛到它；废除 `PLUGIN_CONTEXT_PANEL_ICONS` 与宿主的手写 name→component 映射，统一走 `ResolvedRailIcon` 的解析；
- `lucide-react` 加入 `PLUGIN_SHARED_MODULES`（`lib/plugin/core/shared-modules.ts`）与 `ESBUILD_EXTERNALS`（`crates/cognia-cli/src/engine/frontend_build.rs:120`）——**全集已在 bundle 内，零新增体积**；
- VS Code 兼容层的 `{light,dark}` 形状保持不动（它服务的是导入的 VS Code 扩展，不是原生作者路径）。

**验收门禁**

- `frontend_build.rs` 已有的 `esbuild_externalises_every_host_shared_module` 测试自动覆盖新增项（两份清单必须一致）；
- CLI 安装期校验图标名拼写，未知名字 ⇒ 校验错误（取代当前的静默回退）；
- `character-pack` 的 `{emoji,color}` 保留，但在文档中明确它是**独立语义**而非 icon 字段。

### P1-5 manifest `extensions[]` + `onView` 派生

**证据**
extension slot 是唯一没有 manifest 声明字段的 UI 贡献点（catalog 51 项中无它）。作者必须把 point ID 手打两遍（`activationEvents: ["onView:<point>"]` 一遍、`registerExtension(point, ...)` 一遍），没有任何东西校验二者一致。且 `onView:` 命名空间被两套不兼容 ID 方案占用：

- `components/plugins/plugin-extension-slot.tsx:73` → `onView:${point}`（如 `onView:chat.input.actions`）
- `components/context-workbench/context-workbench.tsx:363` → `onView:context-workbench:${resource.kind}`

**改法**

- manifest 新增 `extensions[]`：`{ point, entry, export, priority?, when?, minWidth?, maxWidth?, labelKey? }`，照搬 `contextPanels` / `modalMounts` 已有的 entry+export 模块解析配方；
- 加入 `packages/plugin-sdk/contract/catalog.json` 的 `manifestContributions`，**必须跑 `scripts/plugin/generate-contract.mjs`**（它同时生成 `crates/cognia-cli/src/engine/contract.rs` 与 `plugin-sdk/python/src/cognia/_generated_contract.py`，漏跑即三方漂移）；
- 宿主从声明**自动派生** `onView:<point>` 激活事件，作者不再手打；
- CLI 安装期校验 `point` 属于 `CANONICAL_EXTENSION_POINTS`；
- `onView:context-workbench:*` 一并纳入 canonical 校验（保留现有字符串形状，只补校验，避免破坏 `plugins/context-inspector` 与 `plugins/prompt-templates` 现有清单）；
- 命令式 `ctx.extensions.registerExtension()` 保留，用于运行时动态贡献。

**验收门禁**

- 新增 `defineExtension` SDK helper + 类型测试；
- 单测：声明式贡献在插件 `activate` **之前**即对 `/plugins` 设置页可见；
- `first-party-manifests.test.ts` 的精确告警断言更新；
- 参考插件（P0-0）改用声明式，删掉手打的 `activationEvents`。

---

## 6. P2

| #    | 条目                       | 说明                                                                                                                                                                                                                                               |
| ---- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | 容器内 3 种 view host 收敛 | `tree` / `custom` / `webview` 三种 host 统一到一个带 `<PluginSurface>` 的壳，`viewsContainers` 对齐 `contextPanels` 已有的 `labelKey` / `icon` / `order` 契约                                                                                      |
| P2-2 | `plugin-ui` 补三件         | `Dialog`（现在只能靠 `ctx.modal`，插件内联确认框无解）· `Sonner`（无 toast 原语）· `Form`（无受控表单原语）。**不做**全量对齐到 ~57——README 明确写了「分叉是目的」                                                                                 |
| P2-3 | 文档补写                   | `surfaces.mdx`（225 行，已覆盖 `formFactor`，**缺**图标契约与失败语义——`grep lucide` = 0）· `packages/plugin-ui/README.md`（"ten of them" 已陈旧，实为 27 个）。`packaging.mdx` 已在上一轮重写，externals 与 `(0,eval)` 描述**现已正确**，不需要动 |

---

## 7. 风险与执行约束

1. **共享工作树**。`types/plugin` / `lib/plugin` / `packages/plugin-*` / `components/plugins` 在 2026-07-27 审计时**全部 clean**，但整棵树有 173 个脏文件属于其他会话（`components/artifacts` `components/chat` `components/inbox` 一片）。
   ⇒ 严格遵守 `concurrent-tree-safety`：绝不 bare-stash、按模块分提交、提交前重跑 `git status types/plugin lib/plugin`。P0-3 触碰 4600+ 行的 `types/plugin/plugin.ts`，冲突面最大，**开工前必须重新确认该文件仍 clean**。

2. **catalog 是生成源**。改 `packages/plugin-sdk/contract/catalog.json` 必须跑 `scripts/plugin/generate-contract.mjs`，否则 Rust CLI 与 Python SDK 静默落后。

3. **`@scope` 在 jsdom 中完全不实现**。所有样式作用域相关断言只能在真 Chromium 中做；jsdom 单测只能验注入文本。这是 P0-0 必须是 E2E 而非单测的原因。

4. **`@cognia/plugin-sdk` 目前 standalone 构建不了**（实测 403 个 `@/` 导入，其中 185 个来自 `@/types/plugin` = 46%）。P1-1 / P1-4 要往 SDK 加导出——两者均为纯字面量，预期安全，但**必须实跑 `pnpm build:packages` 验证**而非假设。注意 P0-3 把 `PluginContextAPI` 并进 `PluginContext` 会改变 `types/plugin` 的形状，与「把 `types/plugin` 折进 SDK」的既定解耦方向需要对齐，避免两轮互相返工。

5. **测试基线**。改动的文件按工作规则 3 需达 ≥90% 行/分支/函数，用 `pnpm test:coverage:changed -- --strict` 验证；`pnpm audit:colocated-tests` 的 baseline 只能缩小。

6. **changeset**。P1-2（用户可见的崩溃提示变化）、P1-3（语言切换行为）、P1-4（图标校验从静默回退改为报错）均为用户可感知变更，各需 `pnpm changeset`（`cognia-next`，`minor`）。P0-1 为 `patch`。

---

## 8. 验收总览

| 层   | 手段                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 静态 | `pnpm audit:plugin-surfaces`（新）· `pnpm audit:slots`（已有）· `pnpm lint:i18n` · `pnpm typecheck`（未包装，以真实退出码为准）· `pnpm build:packages` |
| 单测 | 每个改动文件 ≥90%；formFactor parity；i18n 双向可读；四形制 × 三状态的失败分级                                                                         |
| E2E  | `tests/e2e/plugin-ui-surfaces.spec.ts`（Chromium）——参考插件占满 12 表面，断言 `@scope` 生效、崩溃分级、语言切换、宽度提示                             |
| 人工 | 参考插件在真实 app 中逐表面走查一遍（`@scope` 与形制这两件事静态分析给不出结论）                                                                       |
