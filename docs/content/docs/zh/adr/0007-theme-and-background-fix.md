---
title: "ADR 0007：主题与背景自定义修复"
description: "接入从未挂载的主题/背景应用钩子，修复 VSCode 主题导入，补全双变体令牌模型，并加入 WCAG 对比度护栏。"
---

## 状态

提议中，2026-05-04。

## 背景

cognia-next 在 `lib/appearance/`、
`stores/settings/settings-store.ts`、`lib/db/settings.ts`，以及六个标签页的
`components/settings/appearance/` UI 下提供了一套庞大的外观子系统。从静态代码角度看，
这个功能似乎已经完整：状态结构存在、持久化已接入、VSCode
JSON/VSIX 解析器已写好、作用域感知的 CSS 也在 `app/globals.css` 中。

但实际上，几乎没有任何一部分能对最终用户生效。三条并行的
调查确认了：

- 自定义主题被激活，但页面颜色从不变化。
- VSCode JSON / VSIX 导入要么静默失败，要么应用了错误的颜色。
- 除 `all` 以外的背景 `scope` 在任何地方都不渲染背景。
- 刷新页面（或重启 Tauri）会把所有外观
  设置还原为默认值。
- 背景不透明度过低会遮住前景文字。

根本原因并非「代码缺失」——而是**从未被挂载的钩子、写反的回退
顺序，以及一个目标属性从未被应用到任何容器上的 CSS 作用域功能**。修复它们
需要一组协调一致的改动，同时也把这个半成品功能遗漏的设计
升级一并提前补上：双变体 `{light, dark}`
令牌模型、变体之间的自动 OKLCH 推导、实时 WCAG
对比度反馈，以及导入流程的显式错误呈现。

## 已确认的根本原因

| #   | Bug                             | 根本原因                                                                                                                                                                                                                                             | 证据                                                                                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 刷新后设置丢失        | `useSettingsStore.load()` 从未在应用启动时被调用。store 一直停留在 `loaded:false`；`SettingsSyncProvider` 提前 return；UI 永远显示默认值。                                                                          | `stores/settings/settings-store.ts:364` 定义了 `load()`；`app/layout.tsx` 或 `components/providers/*` 中没有任何地方调用它              |
| B1  | 自定义主题不生效       | 没有挂载 `CustomThemeApplier`。`activeCustomThemeId` 和 `customThemes` 正确持久化了，但没有任何代码把令牌转换成 `<html>` 上的 CSS 变量。                                                                                            | `app/layout.tsx:46-78` 只挂载了 `BackgroundApplier`；`lib/themes/index.ts:130` 的 `resolveActiveThemeColors()` 是个孤立的纯函数 |
| B2  | 令牌键名不匹配              | `THEME_COLOR_KEYS` 使用驼峰命名（`primaryForeground`）；CSS 期望的是 kebab（`--primary-foreground`）。有 7 个键完全缺失（`popover`、`popoverForeground`、`input`、4 个 `sidebar*`）。                                                             | `lib/appearance/vscode-theme/token-mapping.ts:75-92` 对比 `app/globals.css:47-114`                                                          |
| C1  | VSCode JSON 导入颜色错误 | `DEFAULT_FALLBACKS` 是一组硬编码的蓝色调色板，当键缺失时会覆盖主题本意。回退顺序写反了——推导值应当排在最前，硬编码排在最后。                                                                      | `lib/appearance/vscode-theme/parse-json.ts:166`：`out.ring = out.primary ?? fallback.ring`                                                |
| C2  | 令牌映射不完整                | `--popover`、`--popover-foreground`、`--input`、`--sidebar*` 没有 VSCode 映射；像 `editor.selectionBackground`、`widget.background`、`button.background` 这些常见键也未被使用。                                                               | `lib/appearance/vscode-theme/token-mapping.ts:20-72`                                                                                      |
| D1  | VSIX 导入崩溃 / 卡死     | (a) `JSZip.loadAsync` 抛出的异常逃逸了外层 catch；(b) 惰性的 `parse()` 闭包持有的 `zip` 引用可能在用户点击导入前就被 GC；(c) `commitTheme()` 静默吞掉错误，使 UI 永久停留在加载状态。 | `lib/appearance/vscode-theme/parse-vsix.ts:61, 99-108`；`components/settings/appearance/tabs/vscode-import-tab.tsx:86-99`                 |
| E1  | `scope` 是死代码            | CSS 选择器 `[data-bg-target="chat"]::before` 存在，但整个仓库里没有任何组件应用 `data-bg-target` 属性。除 `all` 以外的任何作用域都不会渲染背景。                                               | grep `data-bg-target` 只匹配到 `app/globals.css`                                                                                       |
| E2  | 低不透明度遮住文字           | 不透明度滑块没有下限，也没有对比度警告。在 `scope=all` 且图片繁杂、不透明度很低时，前景/背景对比度会跌破 4.5:1。                                                            | `components/settings/appearance/tabs/wallpaper-tab.tsx`；`lib/appearance/background-applier.tsx:113`                                      |

## 决策

### 1. 在启动时水合设置 store（修复 F1）

新增 `components/providers/settings-hydrator.tsx`。一个只挂载一次的 `useEffect`
调用 `useSettingsStore.getState().load()`。它挂载在
`ThemeProvider` 内、`SettingsSyncProvider` 之前，这样一旦 Dexie 返回，后续
provider 看到的就是 `loaded === true`。

### 2. 挂载自定义主题应用器（修复 B1、B2）

新增 `lib/appearance/custom-theme-applier.tsx`。它订阅
`activeCustomThemeId`、`customThemes`，以及 `next-themes` 的 `resolvedTheme`，
调用 `resolveActiveThemeColors(settings, isDark)`，并用一个
把驼峰转 kebab 的 `themeKeyToCssVar` 辅助函数，把 23 个 CSS 变量
写到 `document.documentElement` 上。停用时的清理
会移除这些内联覆盖，使级联回退到
`:root` 和 `.dark` 默认值。

`THEME_COLOR_KEYS` 从 16 个键扩展到 23 个。新增的键是
`popover`、`popoverForeground`、`input`、`sidebar`、`sidebarForeground`、
`sidebarPrimary` 和 `sidebarBorder`，每一个都对应 `app/globals.css`
中已定义的一个 CSS 变量。

### 3. 带 OKLCH 推导的双变体令牌模型（方案 A）

`CustomTheme.tokens` 变为 `{ light: ThemeColors; dark: ThemeColors }`。
新增的 `baseVariant: "light" | "dark"` 记录用户意图。相反的
变体由 `lib/appearance/derive-variant.ts` 用 OKLCH
数学（经由 [`culori`](https://culori.js.org/)，gzip 约 25 KB）填充：

1. 把输入颜色解析为 OKLCH `{ l, c, h }`。
2. 中性色（`c < 0.04`）翻转明度：`l_new = 1 - l`。
3. 饱和色保留色相，在暗色模式下将色度衰减 8%，并
   通过 `l_new = 0.4 + 0.4 * (1 - l)` 重映射明度，以避免
   纯黑/纯白两个极端。
4. 当结果的 WCAG 对比度跌破 4.5:1 时，`enforceReadable(fg, bg)`
   会调整前景明度。

一个 Dexie `.version(16).upgrade(tx)` 迁移会遍历 `settings`
单例中的 `customThemes`，把每个 `tokens` 字段从旧的
单组结构重写为双组结构。Schema v15 是当前的头部
（插件表，ADR 0006）；settings 表本身的结构
不变。本项目尚未发布，因此迁移风险很低。

### 4. 反转 VSCode JSON 回退顺序（修复 C1、C2）

`parse-json.ts` 被重写为推导优先、硬编码回退
垫底。当某个 VSCode 键缺失时，解析器会尝试：

1. 从已匹配的 `background` / `foreground` 推导（例如
   `card` 用 `darken(bg, 0.05)`，`mutedForeground` 用
   `mix(fg, bg, 0.7)`）。
2. 在可用时使用兄弟令牌（`ring` 用 `primary`）。
3. 只有作为最后手段才使用 `DEFAULT_FALLBACKS`。

`VSCODE_COLOR_MAP` 表覆盖了从
`code.visualstudio.com/api/references/theme-color` 提取的 25 个键的 VSCode 标准，
新增了 `editorWidget.background` /
`dropdown.background` / `quickInput.background` → `popover`、
`input.*` → `input`、`sideBar.*` → `sidebar*`、`errorForeground` →
`destructiveForeground`，以及 `descriptionForeground` →
`mutedForeground` 的映射。

`readableForeground` 从二选一的「近黑/近白」
取舍升级为感知调整后的明度，在保留色相和色度的同时
命中目标 4.7:1 对比度。

`parse-json` 输出单个 `ThemeColors`。调用方根据
`theme.type`（或清单的 `uiTheme`，或 `editor.background` 的
感知明度）确定 `baseVariant`，并调用
`deriveOppositeVariant` 推导缺失的那一侧。

### 5. 带显式错误的预先 VSIX 解析（修复 D1）

`parse-vsix.ts` 不再返回惰性的 `parse()` 闭包。`readVsix()`
同步解析每个贡献的主题 JSON，返回完全
填充的 `ParsedTheme[]`。`zip` 实例在函数
返回前就被丢弃，消除了 GC 竞态。

`vscode-import-tab.tsx` 新增了一个顶层 `error: string | null` 状态，
并通过 `<Alert variant="destructive">` 渲染失败。一个 30 秒的
加载状态超时会在解析卡住时显示「解析超时，可能是文件损坏」。

### 6. 让 scope 真正生效（修复 E1，决策 D-1）

五种壁纸作用域——`all`、`global`、`chat`、`canvas`、`sidebar`
——全部变为可用：

- `all` 继续使用 `body::before`。
- `global` 在没有稳定容器时，把主内容包进
  `<div data-bg-target="global">`。
- `chat`、`canvas`、`sidebar` 把各自的根容器标记为
  `data-bg-target="chat" / "canvas" / "sidebar"`。容器在
  执行期间定位（候选：聊天外壳、数字孪生工作台、
  全局导航侧边栏）。

壁纸标签页的 `scope` 选择器从 `<Select>` 升级为五张
迷你卡片，渲染一张高亮覆盖区域的应用布局缩略图。
悬停某张卡片会在根节点设置 `data-bg-preview="<scope>"`，
在实时应用中围绕匹配区域绘制一圈对比轮廓。

### 7. 不透明度可读性护栏（修复 E2）

`lib/appearance/contrast.ts` 暴露 `wcagContrast(fg, bg)` 和
`evaluateReadability(...)`。壁纸标签页的不透明度滑块下方
长出一个实时徽标：绿色 `OK 6.2:1` / 黄色 `WARN 3.8:1` / 红色
`FAIL 2.1:1`。当对比度落入
`fail` 时会出现一个 `Auto-fix` 按钮，把不透明度重置为推荐值。

当 `opacity < 0.5` 且壁纸类型为
`image` 时，`background-applier.tsx` 会在激活的
目标容器上翻转 `data-bg-scrim="true"`。一条新的 `globals.css`
规则通过 `::after` 渲染一层淡淡的 `--background`
渐变，在不遮住图片的前提下保护文字可读性。

### 8. 主题 JSON 导出 / 导入

`lib/appearance/theme-export.ts` 提供 `exportThemeToJson(theme)` 和
`importThemeFromJson(text)`。输出使用与 `BackupPackageV3` 相同的
`$schema` + `integrity` 校验和约定。
`custom-theme-tab` 为每张卡片新增导出和导入按钮；web 使用
`<a download>`，Tauri 使用原生 `dialog.save` IPC。

### 9. 自定义主题的对比度审计

`lib/appearance/contrast-audit.ts` 暴露
`auditThemeContrast(tokens)`，返回一组不达标的配对（fg/bg、
cardFg/card、popoverFg/popover、primaryFg/primary、destructiveFg/
destructive、mutedFg/muted、accentFg/accent、sidebarFg/sidebar）。
自定义主题标签页为每个令牌行渲染对比度数值，并展示一个汇总
健康徽章。保存时若存在不达标项会发出警告。

### 10. 重置与内置 VSCode 预设

`lib/appearance/built-in-vscode-themes.ts` 内联了四个真实的
市场主题（Dracula、One Dark Pro、Tokyo Night Dark、GitHub
Light Default），并让它们走同一条 `parse-json` 流水线，
这样用户无需离开应用就能验证「VSCode 导入可用」。这些
内联 JSON 同时兼作解析器回归测试夹具。

`appearance-section.tsx` 在头部新增一个「Reset appearance」按钮。
它会清空 `customThemes`、`customCss` 和 `background`，但
保留 `wallpapers`（用户上传的图片库——清空它们
会销毁用户内容）。

### 11. E2E 覆盖

`tests/e2e/appearance.spec.ts` 演练完整的用户路径：暗/亮
切换、自定义主题的创建与激活、JSON 导入、
多主题 VSIX 导入、带壁纸的作用域切换、不透明度护栏
与自动修复、刷新持久化。

单元测试夹具落在 `lib/appearance/vscode-theme/__fixtures__/`：
四个真实主题 JSON、两个真实 `.vsix` 包、一个被截断的
`corrupt.vsix`、一个合法但为空的 `no-themes.vsix`。

## 范围之外

- 壁纸幻灯片（在多张图片间轮换）。
- 按角色 / 按对话的主题覆盖。
- 应用内 VSCode Marketplace 搜索 / 安装。
- 用 Monaco 替换自定义 CSS 文本框。
- 消费 VSCode `tokenColors`（语法高亮）——应用当前
  通过 `highlight.js` / `prism` 渲染代码，而非 TextMate 语法。
  导入的主题保留该字段但不应用它。

## 来源

- [VSCode Theme Color Reference](https://code.visualstudio.com/api/references/theme-color)
- [VSCode Color Theme Guide](https://code.visualstudio.com/api/extension-guides/color-theme)
- [Better dynamic themes in Tailwind with OKLCH (Evil Martians)](https://evilmartians.com/chronicles/better-dynamic-themes-in-tailwind-with-oklch-color-magic)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [APCA Contrast Calculator](https://apcacontrast.com/)
