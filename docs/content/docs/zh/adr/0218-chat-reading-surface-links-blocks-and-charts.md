---
title: "0218 — 聊天阅读面：链接、富内容块与内联图表"
description: "助手正文、链接和富内容块共用一组阅读令牌和一个块框架，因此一轮回复在流式输出时和定稿后读起来一致。外部链接带有站点标识，在消息和输入框中悬停（触屏上长按）会打开预览卡片；预览在桌面端和移动端经平台传输层抓取，受 SSRF 与 PII 闸门约束，浏览器构建则降级为本地卡片。围栏 `chart` 块按现有图表契约绘制内联图表。字号、段落间距、链接样式、预览、块密度、代码高度和代码主题成为消息显示设置。"
---

# ADR 0218 — 聊天阅读面：链接、富内容块与内联图表

**状态：** 已接受
**日期：** 2026-10-06
**修订：** [ADR-0127](./0127-chat-render-transport-efficiency)（§4：消息显示契约新增 `reading`、`links` 和四个 `markdown` 字段，Shiki 主题成为设置项）、[ADR-0139](./0139-visual-output-routing)（路由表新增内联图表围栏）
**相关：** [ADR-0060](./0060-personal-knowledge-capture-and-insights)（网页阅读器）、[ADR-0094](./0094-conversation-anchors-and-jump)、[ADR-0114](./0114-chat-message-presentation)

## 背景

对两条 markdown 分支（流式经 Streamdown，定稿经 react-markdown）以及 `components/chat/renderers/`
下所有块渲染器做了逐项对照审查，发现四个问题。

**链接几乎不像链接。** 网页链接是 `text-primary` 加上 typeset 的 30% 下划线。默认主题里 `--primary`
是接近黑色的中性色，所以链接和正文只差字重。没有站点标识，没有已访问或外链提示，悬停时也没有任何反馈。
文件链接用的是另一种更重的下划线。输入框已经会把粘贴的 URL 折叠成品牌图标加短标签
（`lib/chat/link-fold.ts`、`lib/chat/link-display.ts`），于是输入框对链接展示的信息比它产生的消息还多。

**各个块没有共用外框。** 代码、diff、mermaid、公式、表格、图片和提示框各画各的框。工具栏按钮有五种尺寸、
三种位置（标题行、悬浮层、表格上方单独一行）。圆角有 `md`、`lg`、`xl`，外边距从 `my-2` 到 `my-4`，
另有四套全屏实现和三种错误样式。提示框、任务列表和 diff 的颜色是原始 Tailwind 色值。表格单元格是
`px-4 py-2`，方角合并网格，上方还有一行从不隐藏的 28px 工具栏。

**流式块和定稿块不一致。** Streamdown 把代码画成卡片套卡片，高度上限 400px；mermaid 用其自带的浅色主题和
等宽字体。因此一轮回复定稿时两者都会明显重新排版。两条分支里的 mermaid 都不跟随应用配色。

**没有内联图表。** ADR-0139 把定量回答路由到停靠栏里的图表 artifact。这适合读者要保留、导出或修改的图表；
但回答中一个顺带的小比较仍然得离开对话记录，或者退化成表格。

## 决策

### 1. 阅读令牌

`app/globals.css` 新增 `--link` 令牌（浅色和深色各一，按与背景 4.5:1 的对比度调校），与 P0 修复加入的
`--mark` 令牌并列。自定义主题可以通过主题令牌目录设置这两个值。不提供已访问颜色：聊天链接在系统浏览器或
浏览器面板中打开，WebView 的历史从不记录它们，已访问状态无法如实显示。助手正文通过消息外壳上的属性读取
这些设置，属性值来自解析后的显示选项：

| 属性 | 取值 | 效果 |
| --- | --- | --- |
| `data-chat-text-size` | `sm`、`md`、`lg` | 在聊天栏 14px 基准下，`--typeset-size` 为 13 / 14 / 15 px |
| `data-chat-spacing` | `compact`、`comfortable`、`relaxed` | `--typeset-flow` 为 0.75 / 1 / 1.25 em |
| `data-link-color` | `link`、`primary`、`text` | 链接颜色：`--link` 令牌、`--primary` 或继承正文颜色 |
| `data-link-underline` | `subtle`、`solid`、`hover` | 下划线 30% 强度、全强度，或仅悬停时显示 |
| `data-block-density` | `compact`、`comfortable` | 块内边距、表格单元格内边距、块外边距 |
| `data-code-max-height` | `short`、`medium`、`tall`、`none` | `--rich-code-max-h` 为 16 / 24 / 36 rem 或不限，两条分支一致 |
| `data-block-border` | `on`、`off` | 关闭时框架边框透明；代码和 diff 正文保留底色 |
| `data-block-header` | `on`、`off` | 关闭时隐藏标题栏的图标、标签和附注，操作按钮以悬浮按钮组的形式移入块内 |

网页链接和文件链接共用一种样式。默认值是 `md`、`comfortable`、`link`、`subtle` 和 `compact`，
所以默认外观的变化只有两点：链接有了真正的链接色，块更紧凑。

### 2. 链接呈现与预览

消息中的外部链接经 `ChatLink` 的兜底分支渲染（插件链接匹配器仍然优先）。链接前面加上站点标识，依次选择：

1. `brandIdForHost` 认识该主机时，使用本地品牌图标（离线可用，符合桌面端 CSP）；
2. 允许抓取预览时，使用站点 favicon；
3. 通用地球图标。

在指针设备上短暂悬停后打开预览卡片；触屏上长按，通过 popover 打开，做法沿用 `session-environment-chip.tsx`。
输入框在折叠后的链接上打开同一张卡片：覆盖层是 `pointer-events: none`，因此由 textarea 对覆盖层的
`[data-chip="link"]` 矩形做命中测试，并用虚拟 `PopoverAnchor` 定位卡片。

元数据来自 `lib/web/link-preview/`：

- **传输：** `createPlatformFetch()`（Tauri `proxy_http_request`、Capacitor 原生 HTTP），并屏蔽私有主机。
  浏览器构建没有服务器就读不了跨域页面，而 `app/api` 在运行时并不存在，所以不抓取，只显示本地卡片：
  站点标识、主机名、`describeLink` 标签和路径。
- **闸门：** 只允许 `http`/`https`；经过 `assertFetchTargetAllowed`；未通过 `lib/chat/link-context.ts`
  所用 PII 扫描的 URL 一律不抓取。
- **解析：** 用 WebView 的 `DOMParser` 解析文档头，读取 Open Graph、Twitter card、`<title>`、description、
  `theme-color` 和图标链接。不使用 `packages/document` 的 cheerio 解析器：悬停不应加载 cheerio，而且那个
  解析器不读图标和 `og:site_name`。读取在 512 KiB 或 `</head>` 处停止，超时 8 秒。非 HTML 响应生成一张注明
  类型的基础卡片；图片 URL 直接预览自身。
- **图片：** 桌面端 CSP 只允许 `self`、`data:` 和 `blob:` 图片，因此 Tauri 上的 `og:image` 和 favicon
  经同一传输层抓取（上限 4 MiB，只接受图片类型），以 `data:` URL 显示。`data:` URL 不需要回收，
  所以被淘汰的缓存项不会弄坏仍在屏幕上的图片。Capacitor 直接加载图片。
- **缓存：** 只在内存中。元数据用 200 项的 LRU，成功结果 TTL 30 分钟，失败结果 5 分钟，并共享进行中的请求。
  图片 data URL 放在第二个按大小加权的 LRU 中，上限 24 MB。不建 Dexie 表：预览重新抓取的代价很小，
  不值得为此升级 schema。
- **流式输出：** 仍在流式输出的回合里的链接不抓取，只显示本地卡片。

设置：`links.preview`（`hover` 或 `off`）和 `links.siteIcon`（开或关）。关闭预览后，不会为链接抓取任何内容，
站点标识退回品牌图标或地球图标。

### 3. 统一的块框架

`components/chat/renderers/rich-block/` 提供所有块共用的框架：

- `RichBlockFrame`：`rounded-lg border bg-card`，32px 标题栏，包含类型图标、标签和操作区。操作按钮统一用
  `RichBlockAction`（一个 24px 带提示的图标按钮），并遵循 `data-message-rich-control`，因此富控件设置可以在
  所有地方（包括图片和 diff）隐藏操作或悬停时显示。
- `RichBlockFullscreen`：代码块原有的响应式对话框/抽屉，现在由表格、mermaid、公式和图表共用。
- `RichBlockError`：唯一的错误状态。

`markdown.blockBorder` 和 `markdown.blockHeader`（默认都开启）让读者去掉外框装饰。关闭标题栏不会丢掉工具栏：
标题栏元素仍在 DOM 中，标题部分隐藏，操作按钮以与悬浮模式框架和图片相同的按钮组形式悬浮在块内，沿用相同的
悬停显示类。两者都通过消息外壳属性和不分层的 CSS 作用于框架的 `data-rich-block-header` / `-title` / `-actions`
钩子以及 Streamdown 代码块钩子，因此流式和定稿两条分支同步变化。图表载荷中的标题位于标题栏，关闭标题栏后它只
作为图形的无障碍名称保留。

表格把操作移到框架上的悬停浮层，不再占用上方一行；采用分隔网格、圆角、着色表头、行悬停，数字列右对齐。
提示框、任务列表和 diff 的颜色改用 `--info`、`--success`、`--warning` 和 `--destructive`。

流式分支保留 Streamdown 的增量 Shiki 高亮。其代码块外框通过稳定的 `data-streamdown` 属性改成同一框架，
高度上限跟随 `markdown.codeMaxHeight`。mermaid 和 `chart` 围栏注册为 Streamdown 自定义渲染器
（`components/chat/markdown/streaming-fence-renderers.tsx`），Streamdown 会先于其内置 mermaid 卡片查询它们，
所以流式中的图表就是定稿消息挂载的同一个 `MermaidBlock`。围栏尚未闭合时，在同一框架中显示固定尺寸的占位。
mermaid 使用 `base` 主题，`themeVariables` 在渲染时从应用令牌解析（转为 sRGB 十六进制，因为 mermaid 的颜色
运算读不了 `oklch`），并使用应用的无衬线字体，因此两条分支中的图表都跟随配色和明暗切换。渲染缓存以解析后的
配色为键。全屏图表提供缩放档位，但不提供 PNG 导出：mermaid 用 `foreignObject` 绘制标签，会污染 canvas。

### 4. 内联图表

围栏 `chart` 块承载 `lib/artifacts/chart-contract.ts` 已定义的载荷。`parseChartPayload` 仍是解释载荷含义的
唯一入口；内联块与 artifact 渲染器共用绘图代码。系列颜色来自 `--chart-1` 到 `--chart-5`，不再使用 recharts
示例里的十六进制色值。该块提供数据表视图、复制 JSON、PNG 导出和全屏。围栏仍在流式输出时显示固定尺寸的占位，
闭合后再绘制（流式分支用 Streamdown 的 `renderers` 钩子，定稿分支用 `code` 覆盖）。`markdown.charts`
可关闭此功能，此时围栏按 JSON 代码渲染。artifact 检测器（`lib/ai/generation/artifact-detector.ts`）跳过
`chart` 围栏，所以内联图表不会同时变成停靠栏 artifact。

ADR-0139 的路由段新增 `inlineCharts` 通道标志：当回复由 Cognia 的 markdown 渲染（没有 IM 绑定、不是 CLI）
且 `markdown.charts` 开启时为真。此时对小的定量旁注提供该围栏，而读者要保留、导出或修改的图表仍走 artifact。
IM 会话不变。

### 5. 设置

`MessageDisplayOverrides` 新增：

```ts
reading?: { textSize?: "sm" | "md" | "lg"; spacing?: "compact" | "comfortable" | "relaxed" }
links?: {
  color?: "link" | "primary" | "text"
  underline?: "subtle" | "solid" | "hover"
  siteIcon?: boolean
  preview?: "hover" | "off"
}
markdown?: {
  // ADR-0127 的字段，另加：
  charts?: boolean
  blockDensity?: "compact" | "comfortable"
  blockBorder?: boolean
  blockHeader?: boolean
  codeMaxHeight?: "none" | "short" | "medium" | "tall"
  codeTheme?: ChatCodeThemeId
}
```

解析仍在 `resolveMessageDisplayOptions` 中完成（会话 → 全局 → 预设），每个预设都提供上述默认值。
这些控件加入 `MessageDisplayControls`，桌面端外观页、会话面板和移动端设置面板都挂载它。

**代码主题。** ADR-0127 因为两个渲染器必须一致而把 Shiki 主题写死。现在仍须一致，所以设置项从
`CHAT_CODE_THEMES`（`lib/chat/code-theme.ts`）中选择一对精选的浅色/深色主题，两条分支读取同一对解析结果。
流式插件集按主题对缓存，定稿高亮缓存以主题对为键。工具审批的代码区域保持默认主题对。

## 影响

- 链接的默认外观改变。`link` 令牌调校到在两种背景上都达到 4.5:1，想保留旧外观的用户可设置 `color: primary`。
- 在桌面端或移动端悬停链接会抓取该页面，也就是向模型给出的主机发请求。它只在上述闸门之后运行，流式输出中从不
  运行，`links.preview: off` 可完全关闭。
- 所有块渲染器都依赖 `RichBlockFrame`，外框改动只需改一处。
- 流式代码块依赖 Streamdown 的 `data-streamdown` 属性。渲染器测试固定了这些属性名，若 Streamdown 升级后改名，
  失败的是测试而不是布局。

## 实施状态

| 部分 | 状态 |
| --- | --- |
| P0 修复（字体作用到正文和代码、提示框结构、行内代码一致、`mark`/`u`/`abbr`、图表提示框） | 已在 `c8cdaf667` 落地 |
| §1–§5：阅读令牌、链接呈现与预览、块框架、流式一致、mermaid 配色、内联图表与路由、设置 | 已落地 |
