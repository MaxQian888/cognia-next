---
title: "0088 — Pro IDE（内嵌 code-server）"
description: "内嵌 code-server 编辑器的所有权、布局与主题规则：单例原生 webview 由 React 之外持有，在两个宿主间交接，用 App 调色板上色，且永不因组件卸载而销毁。"
---

# ADR 0088 — Pro IDE（内嵌 code-server）

**状态：** 已接受
**日期：** 2026-07-21

## 背景

"Pro IDE" 是可选的内嵌 [code-server](https://github.com/coder/code-server)
（浏览器版 VS Code），用于**增强而非替代** Monaco 项目编辑器。第一版已经把难的部分
做完了：钉版本 + 校验和的下载（`src-tauri/src/codeserver/download.rs`）、每个项目根
一个 loopback 子进程（`process.rs`）、专用原生子 webview（`webview.rs`），以及经
`lib/files/project-editor-bridge.ts` 的 agent 文件自动跟随。

但它是按**可选逃生舱**建的，而产品定位是**一等编辑器面**——与 Monaco 平级、用户会
长期停留的地方。这个落差催生了一簇缺陷，它们共享同一个根因：**这个 pane 被建模成了
一个 React 组件，而它实际上是一个生命周期长于任何组件的原生资源。**

本 ADR 之前的具体表现：

- 切走 Editor tab 会卸载 pane，进而销毁 webview 并重启整个 VS Code workbench——
  打开的编辑器、光标、终端全部丢失。进程活着，**会话**没了。
- `codeserver_stop` / `stop_all` / `status` / `download` **零**生产调用方。
  code-server 比任何 pane 活得都久，只能靠退出 App 才能停掉，且没有任何界面显示
  它的存在。
- Editor tab 位于滚动页面中、高度写死 `70vh`。原生 webview 跟不上 DOM 滚动，
  于是可见地撕裂。
- 实例崩溃后，死掉的页面仍钉在 DOM **之上**，把 pane 自己的错误与重试 UI 挡住了。
- 一个已主题化的 App 里，内嵌编辑器却是 VS Code 的原厂配色。

## 决策

### 1. webview 的所有权在 React 之外

`lib/codeserver/pane-manager.ts` 是 `codeserver_embed_*` 命令的唯一调用方。React
侧只做 `claim` 与 `release`，永不创建或销毁。

- `release`（卸载、切 tab、换路由）**把 webview 停靠到屏外并释放持有权，不销毁。**
  下一次 claim 会重新显示同一个存活的 VS Code。
- `destroy` 仅保留给显式停止与 App 退出。
- 所有原生往返走同一条串行 promise 链。针对同一个 webview 的 create / navigate /
  `set_bounds` 绝不能交错，否则一个迟到的 `create` 会复活刚被并发 `release`
  停靠掉的 webview。

**代价：** 用户在 App 别处时，一个存活的 VS Code webview 会常驻内存。这是"不丢
编辑器状态"的价钱，也正是决策 3 存在的原因。

### 2. 两个宿主，一个 pane，显式交接

`CODESERVER_EMBED_LABEL` 是单例（主窗口的唯一子 webview），但有两个宿主承载项目
编辑器：Agent Team 工作区的 Editor tab 和聊天侧的 workspace dock。第二个宿主 claim
会**撤销**第一个，后者自动回退 Monaco。不存在双持，也不会出现第二个 webview。

引擎选择按 scope 持久化在 `project-editor-session-store`，开关本身是一个共享组件
（`editor-engine-toggle.tsx`），两个宿主因此无法漂移。

### 3. 进程生命周期归共享注册表；安装不归

运行中的实例是统一托管进程注册表（`src-tauri/src/process_registry/`）里的行，与
chat sidecar、MCP server、终端完全一致——因此性能面板的「托管进程」页会列出它们，
带实时 CPU/内存和 kill 按钮。`ManagedSubsystem::CodeServer` 以**规范化项目根**为
控制路由键，那也正是实例的键。code-server 是唯一支持原生 `Restart`（停止 +
重新 ensure）的子系统，因为它没有需要同步的渲染进程状态。

安装状态是另一件事，有自己的家：**设置 → Pro IDE** 负责钉定版本、磁盘占用、
预下载、旧版本清理和完整卸载。

### 4. 原生叠加层决定布局与动效

webview 浮在 DOM 之上。它不能被 CSS 裁剪、覆盖或补间，且其 bounds 大约每帧经 IPC
重推一次。由此推出三条规则，它们都不是审美问题：

- **宿主不得滚动。** Editor tab 采用与 chat 相同的满高处理（`overflow-hidden` +
  `min-h-0 flex-1`）。滚动的页面会让 pane 撕裂。
- **祖先动画要消除，而不是补偿。** 当某个宿主持有 pane 时，
  `html[data-pro-ide-active]` 把侧栏外壳的过渡压到 1ms（`app/globals.css`）。
  让 200ms 的过渡跑完，等于强迫 VS Code 在它的每一帧上重排。取 1ms 而非 0 是为了
  与既有的 reduce-motion guard 保持一致，让 `transitionend` 仍能触发。
- **任何需要用户阅读的东西都要求把 pane 停靠掉。** 有效可见性 =
  `region 可见 && phase === "ready"`。没有这一条，崩溃的实例会盖住它自己的重试按钮。

### 5. 主题走 `workbench.colorCustomizations`，不是主题扩展

App 调色板被投射进 code-server 的 `settings.json`。VS Code 的
`WorkbenchThemeService` 监听该文件并通过 `updateDynamicCSSRules()` 重新应用，
**无需重载窗口**，且该设置接受全套 Theme Color 键。

生成主题**扩展**的方案被考虑过并否决了：扩展在启动时被发现，因此每次调色板变化都
需要重载——那会摧毁决策 1 想保护的会话——而且它并不能提供设置键之外的任何东西。

另外两条规则：

- 颜色映射**不是手写的**。它是 `lib/appearance/vscode-theme/token-mapping.ts` 的
  逆向，与 VS Code 主题**导入器**使用的是同一张已策展的表。一张表，双向使用。
- 语法配色交给基础主题（`workbench.colorTheme`），与 Monaco 侧对应实现
  （`lib/canvas/themes/cognia-active-theme.ts`）继承其基础主题 `tokenColors` 的做法
  一致。我们只拥有外壳。

写入采用"读取—合并—写回"，用户在 VS Code 内部所做的设置得以保留。注释不会在
往返中存活。

### 6. 威胁模型：接受 loopback + `--auth none`，及其理由

code-server 运行在临时 loopback 端口上并带 `--auth none`。这一点是对照上游查证的，
而非假设：

- `--auth none` 下仍会执行 `authenticateOrigin`（自 4.10.1 起）：`Origin` 头必须
  匹配 `Host`。因此来自浏览器的 CSRF / DNS-rebinding 已经被挡住。
- **没有** `Origin` 头的请求会完全跳过该检查。残余暴露面是同机的其他本地进程与其他
  本地用户账户——不是网页。
- `--trusted-origins` 曾被提议并**否决**：它只会在默认的 `Origin == Host` 规则之上
  **追加**被允许的 origin。它无法收紧任何东西，也完全够不着无 Origin 的情形。
- `--auth password` 对内嵌 pane 不可用：code-server 不支持 URL token 或预置 cookie，
  只有交互式登录页。

接受的立场：在单用户桌面上，以该用户身份运行的进程本就拥有这些文件、也能执行代码，
因此 code-server 对该攻击者没有新增任何权限。**多用户机器不在保障范围内。** 唯一能
覆盖它的修法见下面被否决的备选。

## 考虑过的备选

**unix socket + 带 token 的 loopback 代理。** `--socket` / `--socket-mode` 能把暴露面
收缩到文件权限，但 webview 无法导航到 unix socket，因此需要一个代理正确转发
VS Code 重度依赖的 WebSocket 升级。工作量真实、失效模式微妙；记为债务而不是做一半。

**独立操作系统窗口而非内嵌 pane。** 能绕开决策 4 的全部原生叠加层约束，但放弃了
"编辑器与 agent 并排在同一个工作区"这个前提。

**伴生扩展 + loopback WebSocket** 实现毫秒级 open/reveal。设计见
`src-tauri/src/codeserver/PHASE2_AGENT_DRIVE.md`，若将来确有需要，形态依然正确。
暂缓原因：它主要要解决的进程风暴风险已由合流队列
（`lib/codeserver/open-file-queue.ts`）处理，剩余收益只是单次跳转的延迟。

## 后果

- 切 tab 或换路由都会保住 VS Code 会话。代价是一个常驻 webview，由决策 3 让它
  可见且可终止。
- `codeserver_open_file` 仍然 shell out 到 `code-server --reuse-window`，即每次跳转
  一次 Node 冷启动（约 0.5–2s）。last-write-wins 去抖 + 单飞串行使 agent 自动跟随
  既不会引发进程风暴，也不会去追已经过时的目标。
- 健康看门狗轮询 `/healthz`，连续两次未命中（约 10s）后发出
  `codeserver://instance-exited`，让崩溃表现为可重试的错误而非一个死页面。它的任务
  句柄存在实例上，并在所有退役路径上 abort——游离的轮询循环会比它的进程活得更久，
  并挂住 `cargo test`。

## 已知债务

- **两套互不相通的 VS Code 扩展生态。** App 的 Open VSX 市场
  （`lib/plugin/vscode-shim/`）把 `.vsix` 装进插件运行时，与 code-server 的
  `--extensions-dir` 毫无共享。两个宿主能力不对等，粗暴打通会产出"装了但不工作"。
- **没有更新通道。** `CODE_SERVER_VERSION` 被钉死，配手工维护的 SHA-256 摘要
  （code-server 不发布校验和文件），并带 `--disable-update-check`。升级需要用
  `gh api repos/coder/code-server/releases/tags/v<ver> --jq '.assets[].digest'`
  刷新那张表。设置 → Pro IDE 只回收**旧**版本目录。
- **多用户机器的暴露面**，见决策 6。
- **`components/ui/progress.tsx` 从未把 `value` 转发给 Radix root**，因此 App 里
  每一个 `<Progress>` 对辅助技术都自称"不确定进度"。这是既有的、全仓范围的问题；
  下载进度条视觉正常，但不会被播报。
