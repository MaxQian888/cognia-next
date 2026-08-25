---
title: "0145 — Python 插件获得与 TypeScript 插件对等的能力"
description: "Python 插件能被调用，却无法回调：宿主进程是纯粹的请求应答器，因此每一个 ctx.* 命名空间都不可达，contextPanels 更是被直接拒绝。在既有管道上加一条反向 RPC、把宿主改成 asyncio、再加两种声明式面板类，补齐这道缺口，且不引入第二张权限表。"
---

# ADR 0145 — Python 插件获得与 TypeScript 插件对等的能力

**状态：** 已接受
**日期：** 2026-08-25
**相关：** [ADR-0006](./0006-plugin-system)、[ADR-0026](./0026-marketplace-integrations)、[ADR-0087](./0087-plugin-contract-truth)、[ADR-0090](./0090-unified-agent-execution)、[ADR-0130](./0130-cost-and-trace)

## 背景

Python 插件运行时以子进程 + stdio 上的 NDJSON 形式发布，而且是能用的——只对一个方向能用。
`crates/cognia-plugin-runtime/src/python/host.py` 是一个请求应答器：读一个 `request` 帧、
分发一个 tool 或 hook、写回 `response`，外加四种单向通知（`progress`、`chunk`、
`chunk_end`、`emit`）。**没有任何一种帧能让插件反过来向宿主要东西。**

后果比 manifest 上看起来的严重：

| 插件需要什么 | 它实际有什么 |
| --- | --- |
| 跑一轮模型 | 没有。它能*实现* `aiProviders`，却不能*调用*。连 WASM 运行时都有 `cognia:plugin/ai → generate-text`。 |
| 读写任何持久化数据 | 没有。`ctx.storage`、`ctx.secrets`、`ctx.fs`、`ctx.git` 在 TypeScript 侧都在，Python 侧一个都够不着。 |
| 贡献一个右侧栏面板 | 直接拒绝。契约里 `contextPanels` 是 `execution: "javascript"`，所以在 `type: "python"` 上声明它是校验错误——无论那个面板实际渲染的是什么。 |

契约本来就是为此设计的，只是从未被填上：`catalog.schema.json` 的 `runtimes` 枚举
一直包含 `"python"`，而 67 个命名空间全写着 `["frontend", "hybrid"]`。这正是
ADR-0087 记录过的形状——**契约描述的是意图，不是代码**。

同一轮调研还挖出三个问题，且都不是 Python 独有的：

- **`ctx.workspace` 只有半截契约。** 插件能注册一个 backend、能读回自己注册的那个；
  但没有任何东西能*获得*一份检出。有三种机制能产出检出（`cloneToWorkspace`、
  `git_clone`、任务工作区的 worktree 管理器），它们返回三种互不兼容的句柄，
  而且一个都不能从插件侧触达。
- **一个检出说不出自己停在哪个 commit 上。** `PluginWorkspaceHandle` 现在带
  `headRef`，在 acquire 时填好。没有它，`changedSince` 除了增量路径以外就不可用：
  空 diff 与「宿主算不出来的 diff」分不开，于是「什么都没变」和「根本没人查过」
  是同一个答案。
- **没有任何命令能枚举一个仓库。** `fs_list_workspace_dir` 按设计是 depth-1
  （项目树是懒加载的）；`fs_search_workspace` 封顶 200 条、深度 12。
  「这个根下所有未被忽略的文件」这件事，无处可问。
- **`git_clone` 完全没有护栏**——没有主机白名单、没有深度、没有大小上限、没有超时。

还有一个只在通道打通之后才浮现：**`ctx.a2ui` 能建 surface，却永远无法把它标记为可渲染。**
surface 创建时是 `ready: false`，协议里一直有 `surfaceReady` 消息，而插件 API 没有
任何方法能发出它。这个命名空间在整棵树里零消费者——所以从来没人撞上。

## 决策

### 一条通道，就在已有的那根管道上

插件→宿主的帧，走同一根 stdio 管道，用 id 对齐的应答回来：

```
host_request   {"type": "host_request", "id": <int>, "method": "agent.run", "params": {...}}
host_response  {"id": <int>, "ok": true,  "result": <json>}
               {"id": <int>, "ok": false, "error": "..."}
```

不开第二个 socket、不开端口、不用共享内存。管道本身已经是信任边界，
再加一条传输就是再加一条要守的边界。

`host.py` 改成 asyncio 循环，配一个**专用的 stdin 读取线程**——这样即使工作线程池被打满，
也不会饿死那个必须把答案送回给阻塞中工作线程的读取者。同步 tool 照旧可用：
它们跑在工作线程上，通过 `ctx.run_sync` 显式桥接，而 `run_sync` 在事件循环上会
**拒绝执行**而不是在那里死锁。

重入是允许的——插件在等 `agent.run` 时继续服务入站请求——配深度上限，
以及每插件一个出站并发闸（默认 8），这样跑飞的插件耗不尽宿主。

### 权限不在这道缝上重查

`lib/plugin/python/host-request-router.ts` 把 `namespace.method` 解析到插件
**已经被守护过的** context 上——就是 `createFullPluginContext` 用 `createGuardedAPI`
包过的那个对象。Python 插件撞上的，正是 TypeScript 插件撞上的那道 manifest 权限门，
因为那是同一个对象。

在 router 上重查意味着第二份权限表，而第二份表就是会漂移的那份。
router 真正强制的是**路径卫生**：`__proto__` / `prototype` / `constructor`
以及任何下划线开头的段都被拒绝，所以手写的帧伸不进 SDK 发不出的地方。

### 契约仍然是唯一真相源

一个命名空间对 Python 可达，当且仅当它的 catalog 条目列了 `"python"`。
Python SDK 的 `ctx` 代理是从生成的镜像里**读**这张表，而不是自带一份副本，
并且有一个 parity 测试拿真实 context 验证两边一致。

在已开放的命名空间内部，**把回调交给宿主**的方法会按名字被拒绝，并说明原因：

> `ctx.chat.use` 注册的是宿主侧回调，无法穿过插件的 stdio 边界。请改为在
> plugin.json 中声明该贡献。

这条规则是**推导出来的**，不是列出来的：契约里这些方法已经标了
`resourceEffect: "returned-disposer"`。而这句话本身也是对「Python 插件如何注册东西」
最诚实的表述——**通过 manifest**，那是宿主自己解析的数据。

### 两种声明式面板类

`contextPanels` 改为 `execution: "conditional"` 加 `javascriptWhen: {path: "entry"}`
——只有当面板指名了模块时才需要 JavaScript。仅这一条就修好了一个对**所有运行时**
都存在的潜伏 bug：`webview` 型面板同样没有 `entry`，此前也被判定为「需要 JS」。

新增两种 kind，都不向宿主递交代码：

- **`kind: "a2ui"`** 渲染插件用 `ctx.a2ui.*` 推上来的 surface。`activateTool`
  是那个「该建了」的信号：声明式面板在渲染端没有任何代码在跑，所以必须有*某个东西*
  说「用户现在在看这个资源」，而宿主→插件的回调穿不过这条线，tool 调用可以。
  点击通过 `onA2UIAction` 钩子回来——Python 运行时一直支持它。
- **`kind: "chat"`** 渲染 artifact 与 canvas 界面早就在用的那个资源侧对话，
  接地文本由宿主调用插件自己的一个 tool 取得。`requiresChatScope` 无论 manifest
  怎么写都强制为 true：没有会话的对话面板渲染出来是一块空白，这不是作者该做的决定。

两者在 TypeScript、Python、hybrid 插件上行为完全一致，因为两个工厂都不闭包插件代码。

### 两个组件，以及一个写入面

A2UI 目录新增 `Markdown`——它是聊天渲染器的**包装**，不是第二条 markdown 管线，
所以清洗 schema、Shiki、Mermaid 是共享而非分叉的；插件编写的界面正是弱清洗器
最先被利用的地方——以及 `Tree`，任意深度的导航，而 `Sidebar` 卡死在两级。

`ctx.chat` 新增 `addContextSelection` / `appendToComposer` / `stageIntent`，
走 `session:write`，外加一个**插件通用**的 `ContextSelectionRef` 变体。
不是每个插件一个变体：宿主不可能知道某个插件的词汇表，而在那个联合里写 `kind: "wiki"`
等于把一个插件的名词塞进宿主类型系统，下一个插件还得让它重新编译一次。
宿主真正需要的，和它从任何一种 kind 那里需要的一样——一个 chip 标签、一个提示词标题、
以及摘录的出处——所以字段就是这些，其余一切留在不透明的 `ref` 里。

### 依赖：新插件永远不能弄坏已装好的插件

环境默认共享（`<python_dir>/venvs/_shared/<bucket>`），uv 优先、pip 回落。
新插件加入共享桶之前，会把它的约束与**现有贡献者的约束一起**求解一次。
解不出来，新来者单开独享环境，原因显示在它的详情页里。共享环境一个字节不动。

## 结果

**Python 插件现在是一等公民插件。** 参考插件自带一个声明式 A2UI 面板——
这正是让这个面板类不至于沦为「没有消费者的能力」的东西，而那是本仓库最常见的缺陷。

**声明式面板需要的四个 `ctx.*` 方法里，有两个对 Python 永远不可达。**
`contextPanels.register`、三个 `onDidChange*` 订阅、`a2ui.registerComponent`
与 `a2ui.registerTemplate` 都收发函数。它们被**具名拒绝**而不是藏起来，
因为「没有这个方法」只会把作者送去找拼写错误。

**`ctx.i18n` 已开放，除了它的两个订阅方法。** 插件可以读到应用当前的 locale，
并翻译自己 manifest 里的词条——这正是让一个 Python 编写的界面不至于只能是英文的东西。
`onLocaleChange` 与 `registerTranslations` 被自动拒绝：它们本来就标着
`resourceEffect: "returned-disposer"`，所以那条**推导出来的**规则不写一行新代码就抓住了它们
——这正是「推导」的意义。代价是插件只能**重新问**而不能被通知：它在要绘制的那一刻去轮询 locale。

**`ctx.dexie` 与 `ctx.db` 对 Python 保持关闭。** 两者都返回活的句柄。
需要持久化结构数据的插件用 `ctx.storage`，或者在 `ctx.fs.getDataDir()`
返回的数据目录下写自己的文件。

**审计流现在带运行时。** `PluginApiAuditEvent.runtime` 是必填的，
因为一条说不清「这次调用有没有跨进程」的审计记录，也解释不了它自己的判定。
