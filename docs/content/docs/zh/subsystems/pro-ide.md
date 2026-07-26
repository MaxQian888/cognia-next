---
title: Pro IDE
description: 作为真实编辑器面板内嵌的 code-server —— 通往伴生 VS Code 扩展的回环 TCP 控制通道，使 Agent 能施加可撤销的编辑；以及让内嵌工作台真正「长得像、说得像」本应用的主题与语言链路。
---

# Pro IDE

<Status variant="beta">Beta · ADR-0088 · 磁盘 + settings.json（无 Dexie）</Status>

<TLDR>
  Pro IDE 是一个跑在 webview 里、由应用驱动的真实 code-server 实例。打开文件很简单 ——
  code-server 自带 CLI 的 `--reuse-window <file>:<line>:<col>` 就够了。再往后就不行了：
  该 CLI **只能**打开与定位，因此「可撤销的编辑」或「读取*当前活动编辑器*」必须运行在
  VS Code 扩展宿主内部。这正是伴生扩展（`sidecar/codeserver-agent-ext/`）与回环控制通道
  （`src-tauri/src/codeserver/agent_channel.rs`）存在的原因。该通道是跑在
  **`127.0.0.1` TCP 套接字上的换行分隔 JSON，而不是 WebSocket**，
  并且托管在 `codeserver` 模块而非可选开启的 companion API ——
  因此一项核心编辑器能力绝不依赖于「远程访问」是否被打开。
</TLDR>

<StatGrid>
  <Stat label="Rust 模块" value="6" hint="src-tauri/src/codeserver" />
  <Stat label="前端模块" value="6" hint="lib/codeserver，含 theme/" />
  <Stat label="React hooks" value="5" hint="hooks/codeserver" />
  <Stat label="控制传输" value="TCP" hint="127.0.0.1 上的换行分隔 JSON" />
  <Stat label="持久化" value="无" hint="磁盘 + settings.json —— 没有 Dexie 表" />
</StatGrid>

设计动机见 [ADR-0088](../adr/0088-pro-ide-code-server)。

## 为什么要专用通道，又为什么用 TCP

这条通道的两端都是我们自己的，且都不会穿过代理或浏览器。
WebSocket 的握手、分帧与客户端掩码在此纯属仪式，
所以通道就是回环 TCP 上的换行分隔 JSON。

更有意思的决策是它的**托管位置**。它位于 `codeserver` 模块，而不是可选开启的
`companion_api` 服务，因此它随其驱动的 code-server 进程一同启停。
一个从未开启远程访问的用户，依然能得到功能完整的编辑器 ——
agent↔IDE 这条路径不会被一个与它毫无关系的远程访问开关卡住。

## 代码位置

```
src-tauri/src/codeserver/
  process.rs         # 启动 / 守护 code-server 实例
  download.rs        # 拉取 code-server 发行包
  webview.rs         # 内嵌 webview 宿主
  agent_channel.rs   # 回环 TCP 控制通道 ↔ 伴生扩展
  commands.rs        # Tauri 命令面
  PHASE2_AGENT_DRIVE.md   # Phase 2 agent↔IDE 设计说明

lib/codeserver/
  client.ts              # 渲染端通道客户端
  pane-manager.ts        # 应用布局内的编辑器面板
  open-file-queue.ts     # 实例就绪前收到的打开请求
  locale.ts              # 显示语言 ↔ argv.json
  theme/vscode-chrome-map.ts   # 应用调色板 → VS Code Theme Colors
  theme/build-settings.ts      # 产出实例读取的 settings.json

hooks/codeserver/       # 面板 · 编辑器事件 · 语言同步 · 设置同步 · 支持性判定
components/settings/pro-ide/pro-ide-section.tsx
sidecar/codeserver-agent-ext/    # 伴生 VS Code 扩展
```

`open-file-queue.ts` 的存在是因为打开请求可能早于实例就绪；
把它们排队，正是「早到的打开文件请求不会被静默丢弃」的原因。

## 主题：并不是把导入表反过来用

<Callout type="warn">
  `lib/appearance/vscode-theme/token-mapping.ts` 映射的是**反方向** ——
  它把任意第三方 VS Code 主题*读入* cognia 的 27 个 `ThemeColors` 槽位，
  并且是一张**采样**表：每个槽位只列出几个流行主题大概率会定义的 key，取第一个命中。
  把它反转只能得到约 30 个 key，因为采样本来就只需要这么多。
  工作台的其余部分 —— `titleBar.*`、`statusBar.*`、`tab.inactiveBackground`、
  `terminal.*`、`menu.*`、`notifications.*` —— 会全部落空、无人上色。
</Callout>

因此 `theme/vscode-chrome-map.ts` 是一张独立的**正向**表：应用调色板 → VS Code Theme Color，
按覆盖整个工作台外壳来编写，而不是沿用导入器恰好采样到的那个子集。

## 语言在 `argv.json`，不在 `settings.json`

VS Code 的显示语言是**运行时参数**，不是设置项。
「Configure Display Language」命令会把 `{"locale": "…"}` 写进用户数据目录下的 `argv.json`，
而工作台只在启动时读取它。`lib/codeserver/locale.ts` 拥有这个文件 ——
这正是「改语言必须重启实例，而改主题既不需要重启、也不需要本模块拥有的文件」的原因。

## 相关文档

<Cards>
  <Card title="ADR-0088" href="../adr/0088-pro-ide-code-server" description="Pro IDE 的决策记录" />
  <Card title="源代码管理" href="./source-control" description="应用自带的 Git 面板" />
  <Card title="集成终端" href="./integrated-terminal" description="另一处开发者接口面" />
  <Card title="主题与 i18n" href="../ui/theming-and-i18n" description="主题映射表所消费的应用调色板定义处" />
</Cards>
