---
title: "0124 — 文件系统 Viewer 注册表"
description: "把三套文件预览实现统一到一个由宿主拥有的注册表之后，并把每一次读取都限制在已打开的工作区根内。"
---

# ADR 0124 — 文件系统 Viewer 注册表

**Status:** Accepted
**Date:** 2026-08-15

## 背景

对「把这个文件显示给我看」，应用里有三个答案，而用户点得最多的那个恰恰最不安全。

terminal 的只读对话框用一个裸绝对路径调用
`lib/file/file-operations.readTextFile`：没有 root、没有 traversal 检查、没有体积
上限，且只有 Monaco 一种渲染。项目 workbench 的预览按扩展名分发内存中的编辑器
草稿，用的是仓库里最宽松的一档 iframe sandbox。task-resources 面板按 media type
分发，是三者中唯一有加固和体积上限的——而它根本不读文件系统，因此不属于本次统一
的范围。

到达 terminal store 的 `openFile(absolutePath, …)` 的调用点有五个，而不是最初以为
的两个：terminal 链接、chat 文件链接、两个堆栈视图，以及日志详情面板。

## 决策

### 宿主拥有每一次读取

contribution 拿到的是已经受限于某个工作区根、并已查过体积的文本。它永远拿不到一条
自己能解析的路径——`matches` 收到的是由扩展名、体积和来源构成的 probe，renderer
收到的是文本。

这是注册表存在的意义所在。一个能看见路径的 viewer，距离自己去读它只差一次重构，
到那时下面所有的限制都不再有意义。

### contribution 惰性加载

`FileViewerContribution.load()` 是模块加载器，不是组件引用。
`isProjectFilePreviewable` 从 `lib/context-workbench/capabilities.ts` 查询本注册表，
而 artifact dock、canvas 侧面板、workflow 侧栏与项目 workbench 都会 import 它。急切
持有的组件会把 Monaco、`MarkdownRenderer` 和 DOMPurify 拖进上述每一个 bundle，只为
回答一个关于文件扩展名的问题。

内建项在模块初始化时播种而非首次渲染时，因此答案不依赖任何组件是否已挂载。

### 文本兜底按来源限定，而不是按文件类型

`builtin.text` 匹配 `source === "terminal"`。这让 `isProjectFilePreviewable` 的答案
与它原先那份硬编码清单完全一致——没有东西认领 `.py`，所以不会在原先没有的地方长出
Preview 标签页——同时避免了在 workbench 里挂一个 `draftContent` 的只读 Monaco，而它
旁边就是显示同一个 buffer 的可编辑 Monaco。

解析顺序是 priority 降序，平局按 id。这与 `lib/artifacts/renderer-registry.ts` 刻意
不同——后者声明了 `priority` 却从不读取，并让某个 kind 的最后一次注册悄悄取胜。

### root 来自已打开的项目，而不是 `cwd`

被否决的方案是 terminal 会话的工作目录。它不是一个边界：shell 在每次 `cd` 时都会
改写它（`spawn-orchestrator` 在每个 `cwd_changed` 上调用 `setSessionCwd`），于是
`cd /` 把限制放宽到整个文件系统，而 `cd src` 又收窄到足以让片刻之前还能用的兄弟
文件链接失效。一个会随用户输入移动的边界不是边界。

之所以记录下来，是因为它所防止的失败是不可见的：看到「不在工作区内」报错的人，会
很自然地伸手去拿 `cwd` 当作显而易见的修法。

取而代之的 root 集合是所有已打开项目的根的并集——正是
`lib/files/allowed-roots-sync.ts` 推给 Rust allowed-roots 注册表的那个集合，于是渲染
端的边界与后端的边界口径一致，指向用户同样打开着的另一个 checkout 的堆栈帧也仍然
能解析。最深的 root 取胜；知道自己属于哪个工作区的调用方把它作为 `preferredRoots`
传入以打破平局。

`openFile(absolutePath, …)` 是被删除而不是被废弃的。那个签名**就是**未受限的
API；移除它才让这份限制变成无法绕过，而不只是被鼓励遵守。

### 体积由宿主设限，2 MiB

`fs_read_workspace_file` 刻意没有默认上限，且在超限时截断并追加标记而不是失败——这
一点由 `read_workspace_file_never_silently_truncates_an_editor_read` 钉住。依赖那个
行为的 viewer 会显示一个悄悄丢了尾巴的文件。

因此 surface 先 stat 并在传输之前拒绝，然后以 `MAX + 1` 字节读取：在 stat 与 read
之间长大的文件会超出上限并被拒绝，而不是安静地变短之后送达。

### 失败也会打开对话框

拒绝会以错误态打开，而不是什么都不做。一次静默失败的点击与一条坏链接无法区分——而
这恰恰是 chat 文件链接在 terminal 面板关闭时的行为，因为对话框挂在 `TerminalDock`
里。它现在挂在 app shell 上。

### HTML 沙箱按来源分档

两种来源都会得到含 `connect-src 'none'` 的 CSP，且都永远不会得到
`allow-same-origin`。旧的项目预览给了 `allow-scripts` 却完全没有策略，于是被预览的
文件可以把自身内容 fetch 到任意 origin；opaque origin 挡住的是 frame 读取宿主，不是
它对外说话。

`project-preview` 保留脚本——那是用户自己的草稿，关掉会悄悄弄坏所有现存预览。
`terminal` 关闭脚本，那里的文件更可能是工具生成或下载而来而非本人撰写，并且 body
还会经过消毒。`allow-forms`、`allow-modals` 与 `allow-popups` 在两者中都被移除。

### 诊断不携带身份信息

`fileViewer.render` 与 `fileViewer.error` 记录来源、扩展名、体积区间、耗时，以及
（失败时）一个错误码。绝不记录路径、文件名或内容：扩展名可以安全记录，文件名不行，
而精确字节数是一种弱内容指纹。该 payload 的键集合由测试钉住，这是唯一能长期挡住
后来者「为了调试」加上 `path` 的防线。

## 影响

- terminal 或 chat 中指向所有已打开工作区之外的链接现在会被拒绝而不是打开。指向
  `/usr/lib/...` 的堆栈帧是常见情形。如果拒绝率被证明过高，正确的应对是放宽 root
  集合而不是关掉这个检查——日志携带来源与错误码且不含路径，因此该比率可测量，而
  无需记录被拒绝的具体内容。
- 该对话框按平台各挂载一次，因为两个 shell 都不会在对方的平台上渲染：
  `DesktopAppShell` 在移动端只返回裸 children，`MobileShellWrapper` 在非移动端同样
  如此。移动端的挂载点放在 wrapper 而不是 `AppShellMobile`——后者只在 `/` 渲染，而
  `/me/terminal` 的终端正是文件链接真正会被点到的两处之一。
- 暂不提供面向插件的 Viewer API。契约应当先稳定一个 minor release，再被某个插件
  冻结。
