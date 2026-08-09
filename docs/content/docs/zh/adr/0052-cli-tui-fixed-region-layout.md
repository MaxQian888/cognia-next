---
title: ADR-0052 — Agent CLI TUI 固定区域(全屏)布局
description: "为 cognia-agent Ink TUI 引入固定顶栏 / 固定输入框 / 中间可滚动的布局,运行于终端备用屏幕缓冲区,带应用内滚动视口。默认全屏,在非 TTY 上按能力回退到 scrollback,并可经 /layout 实时切换。记录刻意的取舍(放弃原生 scrollback)与鼠标模式开关(/mouse):在滚轮滚动与原生文本选中之间权衡,默认 scroll。"
---

# ADR-0052 — Agent CLI TUI 固定区域(全屏)布局

**状态**:已接受(2026-06-20)
**作者**:Max Qian + Claude Opus 4.8
**承接**:[Agent CLI TUI](../subsystems/cognia-agent-tui) 子系统与 ADR-0050(TUI 操作体验加固)。

## 背景

TUI 历来用 Ink 的 `<Static>` 组合屏幕:已提交的 transcript 单元格**一次性写入终端原生 scrollback**,之后永不重绘,只有底部"活动帧"(进行中的回合、输入框、吉祥物、页脚)由 React 管理。这与 Claude Code、Codex CLI 同源,优点真实——原生滚动、文本选中、复制都可用,长会话也因旧单元格不重绘而成本低廉。

但它也意味着**没有任何东西真正固定**。欢迎 banner 是 `<Static>` 的第一行,随对话增长滚出视野;输入框只是*看起来*钉在底部,因为活动帧永远是最底部绘制块。诉求是真正的固定区域布局:顶栏钉顶、输入框钉底、中间可滚动——即 vim / htop / lazygit 的形态。

该形态与 `<Static>`/原生 scrollback 模型**不可兼得**:固定顶栏 + 可滚动中间区只有在应用接管整个视口时才存在,这需要终端的*备用屏幕缓冲区(alternate screen buffer)*与应用内滚动区。二者不能共存,所以这是一次布局模型决策,而非增量微调。

## 决策

### 1 · 能力闸控、可实时切换的布局模型

新增 `layout` 配置项(`"fullscreen"` | `"scrollback"`,默认 `"fullscreen"`)选择模型。**有效**模式由纯函数 `tui/layout-mode.resolveLayoutMode` 解析:当终端无法支持备用屏幕布局时(非 TTY 的 stdout/stdin——CI、管道,或 `TERM=dumb`)强制回退到 `"scrollback"`。这也是为什么在 jsdom 无 TTY 下渲染的所有既有测试都保持历史布局不变。

模式可经 **`/layout [fullscreen | scrollback]`** 实时切换(无参打开选择器),持久化到 `config.json`,并可用 `COGNIA_LAYOUT` 按次覆盖。

### 2 · 全屏运行于备用屏幕缓冲区

`tui/screen.ts` 持有备用屏幕转义序列(`?1049h` / `?1049l`,进入时清屏+归位)。进出在终端层面幂等,因此两个所有者无需协调:

- **`mount.tsx`** 在*首帧绘制前*进入(使开屏帧画在已清空的备用缓冲区,而非先在普通缓冲区闪一下),并在 `finally` 中退出作为硬退出安全网。
- **`App`** 用一个以有效 `fullscreen` 标志为键的 `useEffect`,使 `/layout` 实时切换就地进出,卸载时始终还原终端(及用户先前的 scrollback)。

进入转义虽然幂等,但*清屏+归位*并非如此:在 Ink 首帧绘制**之后**再次发出会抹掉该帧,而由于测量后的重渲染通常完全相同(内容放得下 → 偏移仍为 0),Ink 的 diff 不写任何东西——屏幕会一直空白,直到一次终端尺寸变化触发整屏重绘。因此 `mount.tsx` 向 `App` 传入 `altScreenPreEntered`;App 的 effect 在初次全屏挂载时*跳过*这次多余的进入/清屏(它已在首帧前发生过),仅在 `/layout` 实时切换时才进入。

### 3 · 应用内滚动视口

全屏下 transcript 以 `live` 模式渲染(普通列,**无 `<Static>`**),置于 `ScrollView` 内——一个 `flexGrow` + `overflow: hidden` 的盒子,其内容用负上边距上移(pager 技法)。`measureElement` 在布局后报告内容高与视口高;纯模块 `scroll-view-state` 将其转为夹紧后的偏移,`useScroll` 将其接到按键。视口默认**吸附底部**(跟随新输出),并在提交 / `/clear` 时自动重新吸底。

`PgUp` / `PgDn` 翻页视口(无冲突——输入框忽略 PageUp/PageDown);到底即重新进入跟随模式,故 `PgDn` 兼作"跳到最新"。上滚时显示 `↑ N more lines below` 提示。

**鼠标**行为是一项刻意的、可配置的取舍(`mouse` 配置项,`"select"` | `"scroll"`,默认 `"scroll"`;可经 `/mouse` 实时切换)。两种模式在终端层面互斥:

- `"scroll"`(默认)启用 SGR 鼠标追踪(`screen.ts` 写入 `?1000h` + `?1006h`):终端以 `ESC[<b;col;row(M|m)` 上报滚轮,纯函数 `input/mouse.parseMouseEvent` 解码它,App 把一格滚轮路由到 `scroll.lineUp` / `lineDown`(3 行)——因此滚轮开箱即可滚动 transcript,如同任何 pager。代价是失去原生选中——追踪开启时只能 `Shift`+拖拽选中。
- `"select"` **不捕获**鼠标,因此原生拖拽选中 / 复制可用。为避免滚轮被伪造成 `Up`/`Down` 方向键(否则输入框会当成历史切换),`screen.ts` 写入 `?1007l` **禁用 alternate-scroll**——滚轮因此变为惰性,改用 `PgUp`/`PgDn` 滚动视口。

两种模式下每个文本输入都用 `isMouseSequence` 守卫其兜底插入,使杂散上报永不被当作字面 `[<…M` 键入。`applyMouseMode` / `resetMouse` 与备用屏幕生命周期一起管理这些转义(`mount.tsx` 在首帧前应用配置的模式)。`scroll` 模式下同一处理器也滚动 `DocumentViewer` 阅读器。

### 4 · banner 升级为实时固定头

由于全屏 banner 在整个会话期间常驻(不同于会滚走的 scrollback banner),它承载一行实时状态——权限模式(`bypassPermissions` 带 `⚠`)、上下文窗口占用、累计会话 token——复用既有 `format/usage` 辅助函数。页脚保留详细/活动段;scrollback banner 不变。

### 5 · 输入框增强

输入框新增空态**占位提示**(开始输入或弹层打开即隐藏),以及**随模式变色的边框**:`bypassPermissions` 时转为醒目警告色——使危险模式在任一布局下都一目了然。

## 接受的取舍

- **全屏下无原生 scrollback。** 已提交历史不再进入终端 scrollback,因此退出后不保留,跨已滚走内容的鼠标选中也更难。这是备用屏幕缓冲区的固有代价,也是固定顶栏的明确代价。偏好原生模型的用户用 `/layout scrollback` 切换(也是非 TTY 下的自动回退)。
- **整视口重渲。** 无 `<Static>`,可见 transcript 每帧 reconcile。对有界长度的 agent 会话可接受;若会话异常增长,后续可加窗口化/虚拟化。

## 刻意延后

- **滚动视口的逐单元格虚拟化**(见取舍)。

> **更新。** 鼠标滚轮滚动最初被延后,随后通过 SGR 追踪(`?1000h`)捕获滚轮来实现。
> 然而捕获鼠标会破坏原生拖拽选中(只剩 `Shift`+拖拽可用),用户立刻就会撞到。
> 滚轮与选中的矛盾在终端层面不可调和,因此现在改为**模式**(`mouse` 配置 / `/mouse`):
> 默认 `"scroll"` 捕获滚轮滚动 transcript(交互式终端的常见预期);
> `"select"` 为偏好原生拖拽选中的用户恢复选中并禁用 alternate-scroll(`?1007l`)以防滚轮扰乱输入框历史。详见第 3 节。

## 影响

固定区域布局成为交互式终端上的新默认,并在其他场景透明降级到历史 scrollback 模型。新纯模块(`layout-mode`、`screen`、`scroll-view-state`)与 `useScroll` 钩子 / `ScrollView` 组件均有完整单测;reducer 新增 `SET_LAYOUT` 动作,命令面新增 `/layout` 命令。未触碰 sidecar、Rust 或桌面代码。

## 2026-08 跟进——虚拟化 viewport 与实测 chrome 预算

此前延后的逐 cell 虚拟化现已实现。纯 variable-height block index、精确终端行数、上下各
两个 viewport 的 overscan，以及 block-id/cell 内行锚点取代整段 transcript 渲染。append、
resize 和高度校正会保留读者锚点；`End`/`G` 恢复 follow-tail。chrome 按 100/60/40 列与
12 行断点分配。`COGNIA_TUI_RENDERER=legacy` 是保留一个版本的回滚开关，virtualized 默认启用。

native scrollback resize replay 默认上限为 10,000 个渲染行
（`render.terminalResizeReplayMaxRows`；`0` 表示不限）。该限制只影响终端重绘；
`/transcript`、export 与 session storage 仍保持完整。

## 2026-08 正确性跟进——权威视口与输入所有权

全屏弹层现在使用 Ink/Yoga 在固定底部 chrome 分配后测得的真实区域高度。各 panel 从该
viewport 派生内容行数，动态列表始终保留活动行，多行输入框真正使用既有行预算，所有依赖
宽度的 transcript 渲染都接收根节点的响应式列数。Unicode 编辑以 grapheme 为边界，
`useCursor` 为 IME 锚定到可见光标。单一 active 输入 provider 按优先级分发并在 handled
后停止，避免 modal 按键泄漏到输入框。Jest 组件测试继续保持快速，同时子进程探针加载真实
Ink/Yoga 与生产 `TuiViewportFrame`，PTY harness 则通过确定性 agent session 挂载生产 `App`。
