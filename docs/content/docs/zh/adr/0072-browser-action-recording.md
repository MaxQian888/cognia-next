---
title: ADR-0072 — 浏览器操作录制
description: "把用户在内置 /browser 预览面板中的真实交互录制为规范的 RecordedFlow，随后通过既有的 ADR-0055 引擎回放，或导出为原始 JSON、Playwright 用例、智能体上下文 markdown。flow 是唯一事实来源，每种导出都是其上的纯序列化器。导航会摧毁页面的 JS 上下文，因此缓冲区镜像到 sessionStorage、由渲染进程每 400ms 轮询、并在 browser://loaded 上以绝不丢弃既有缓冲的 resume 重新武装。密码只标记、绝不采集：导出发出 process.env，回放接收 secrets 映射并在缺键时显式失败。步骤保存持久的 CSS 选择器，回放通过 selector → ref 解析，从而守住 ADR-0055 的按 ref 操作纪律。flow 持久化到 Dexie v110，仅存本机。"
---

# ADR-0072 — 浏览器操作录制

**状态**：已采纳（2026-07-16）
**作者**：Max Qian + Claude

## 背景

ADR-0055 为智能体提供了基于内置 `/browser` 面板的 `snapshot → 按 ref 操作 → 重新
snapshot` 闭环，使模型能在人可见的同一面板中驱动本地开发预览。但反方向从未存在。用户
复现一个缺陷、走一遍登录、或逐步完成一次结算，**不会产出任何可复用的东西**：要把这个
流程交给智能体，只能凭记忆用散文重述；要把它变成回归测试，只能手写 Playwright 用例。
两种转录都在同一处失真——真正被点击的那个元素的选择器——而这恰恰是人和模型事后都无法
重建的细节。

观察这个流程所需的一切早已在面板中。注入的 overlay（`lib/browser/overlay.injected.js`）
安装在被预览页面里，已经挂钩了 `console`、`fetch`/XHR、`window.open` 与 history；它已
经铸造稳定的 `data-cognia-ref` 句柄，并为人工点选流程计算 `cssSelector` / `roleOf` /
`accessibleName`。引擎也已经能按 ref 操作。缺的只是一条采集路径，以及夹在两者之间的一
个数据模型。

## 决策

把被预览页面中的真实用户交互录制为规范的 **`RecordedFlow`**，在面板中审阅，然后要么通过
**既有的** ADR-0055 引擎回放，要么按用户选择的格式导出。

### 一个数据模型，三个导出器

`RecordedFlow`（`lib/browser/recording/protocol.ts`）是唯一事实来源：采集路径产出它，
回放路径消费它，而每一种用户可选的产物都是 `exporters.ts` 中一个纯粹的
`flow → string` 序列化器——原始 JSON（可重新导入与手工编辑）、Playwright 用例，以及给
对话输入框用的智能体上下文 markdown。

正是这个决策让「自选输出格式」变得廉价。另一条路——每个目标一个录制器——意味着三条会各自
漂移的采集路径、一个选择器缺陷要修三处，以及每新增一种格式就新增一个录制器。在这里，第四
种格式只是一个函数。`protocol.ts` 与 `exporters.ts` 刻意不引入 Tauri 与 DOM，因而留在
快速的 `node` jest project 中。

Playwright 导出器优先使用 `page.getByRole(role, { name })`，仅当元素没有映射到 role 或
没有可访问名称时才退回 CSS 定位器。这正是录制时要在选择器之外同时采集 `role` 与 `name`
的全部理由：role 定位器能扛住标记结构变动，而一份满是脆弱 CSS 路径的用例，没人会留着。

### 导航会摧毁页面的 JS 上下文

这是整条采集路径赖以成形的约束。真实导航会替换整个文档，而**触发它的那次点击——登录提交
——通常是流程中最重要的一步**。丢掉它不是「录制质量下降」，而是「录制作废」。

三层防护，每一层补上前一层的缺口：

1. **页面在缓冲的同时把每一步镜像到 `sessionStorage`**（`persistRecord`）。sessionStorage
   能挺过同源导航，因此新文档中 IIFE 的重新执行会调用 `restoreRecord`，看到录制标志位并
   恢复缓冲区——包括那次导致导航的点击。
2. **渲染进程每 400 毫秒轮询 `embedDrainRecord`**（`DEFAULT_POLL_MS`），并跨文档累积成
   一条 flow。抛错的 drain 会被吞掉：面板可能正处于导航中间、没有活的 JS 上下文，而页面
   仍在继续缓冲，下一次轮询就会取到。
3. **渲染进程在 `browser://loaded` 上重新武装**——复用既有事件，而非新增一个。这一层覆盖
   跨源场景：sessionStorage **不会**带过去，新文档处于未武装状态且缓冲区为空。

### `resumeRecord` 与 `startRecord` 是刻意区分的

`startRecord` 开始一次全新的录制并**清空缓冲区**；`resumeRecord` 重新武装并保留缓冲区。
这个区分是承重的，而且只有把两种导航都放到上面第 3 层里走一遍才看得出来：

- **同源**：`restoreRecord` 已经重新武装并恢复了缓冲区，因此 resume 是空操作。此处若用
  `startRecord` 重新武装，**会抹掉那次导致导航的点击**——正是第 1 层要拯救的那一步。
- **跨源**：sessionStorage 没有带过来，缓冲区本就理应为空，而这正是唯一能把页面重新武装
  起来的调用。

同一个 `browser://loaded` 处理器要服务两种场景，因此它必须使用在两种场景下都正确的那个动
词。所以 `noteLoaded()` **先 drain，再 resume**：在同源路径上，那些被恢复的步骤必须先被
收走，才能让其他逻辑碰页面状态。有一个测试钉住了调用顺序
（`expect(order).toEqual(["drain", "resume"])`），因为 drain-then-resume 这个次序在类型
层面不可见，而一次看似合理的调换会悄无声息地丢掉登录点击。

### 密码绝不采集

`input[type=password]` 只记录 `{ value: "", secret: true }`——只有标志位，没有值。这不是
针对假想风险的保守：flow 会**持久化到 Dexie**，而智能体导出会**被写进模型提示词**，因此
采集该值等于一步之内就把凭据同时置于静态存储*和*传输链路上。本仓库早已把这视作不可逾越
的红线（`packages/redact` 的 `hasNoLeakingPii` 是每一次出站 LLM/embed 调用前的关卡）；一
个悄悄把密码序列化进 IndexedDB 的录制器，不是功能，而是在那道关卡底下开的洞。

其后果是：录制下来的登录流程刻意**不是自足的**，各个界面各按自己的语汇解析这个密钥：

- **Playwright 导出**发出 `process.env.<secretKey> ?? ""`——生成的用例不含凭据，可以安全
  地落到 `tests/e2e/`。
- **智能体导出**说明该值未被记录、需要向用户索取。它不发出环境变量，因为模型没有可读的环境。
- **回放**接收 `secrets` 映射，并在缺键时**让该步骤显式失败**，而不是往凭据字段里填 `""`。
  一次静默的空填充只会在后面表现为莫名其妙的「密码错误」，把用户引向错误的排查方向。

`secretKey()` 位于 `protocol.ts`，由导出器与回放器共用，因此生成用例中的环境变量名与界面
提示用户填写的查找键，在构造上就是同一个字符串。分两处各推导一次，只会让用例去读一个界面
从未提过的变量。

### ref 随其 generation 消亡，因此步骤保存选择器

ADR-0055 按快照的 `generation` 铸造 `ref` 句柄；文档一旦重载它们就失去意义——而这恰恰是
任何现实流程中途必然发生的事。因此步骤无法记录 ref，转而保存持久的 CSS 选择器。

这本可能演变成一个按选择器操作的后门，悄悄废掉 ADR-0055 的按 ref 操作纪律。但它没有。新增
的页面辅助函数 **`refFor(selector)`** 为匹配到的元素铸造（或返回）一个 `data-cognia-ref`，
回放走 `selector → ref → engine.act(ref, …)`。操作仍然经由 `refMap`；选择器只是回放*找到*
节点的方式。`refFor` 之所以是铸造而非仅查表，是因为人可能点了快照并不会作为可交互节点暴露
出来的东西。

回放**没有新增引擎**。`replayer.ts` 驱动既有的 `EmbeddedEngine`，在可能触发导航的点击或按
键之后等待文档稳定，并在首个失败处停止——flow 是一个序列，越过一个坏掉的步骤继续跑，只会
报出一串最终都归因于第一个失败的级联错误。智能体导出把这个闭环也说给模型听：重新 snapshot
并按 ref 操作；选择器只是帮你找到正确节点的线索。

### 刻意不录制的内容

每一项省略，要么是噪声，要么是必然失败的步骤：

| 不录制 | 原因 |
| --- | --- |
| 文件输入框 | 合成事件的 `isTrusted:false`，选择器对话框会拒绝——这是 ADR-0055 的注入 JS 上限。该步骤永远无法回放，录了就是制造一个注定失败的步骤。 |
| 普通按键 | `change` 已把稳定后的值作为单个 `fill` 带出。逐键录制会把流程淹没在噪声里，且回放更不忠实——页面本来也只见到过稳定后的值。 |
| 对 `select` / `option` 的点击 | 该元素的 `change` 已经覆盖。点击回放出来是「展开下拉框」，随后会与 select 步骤互相打架。 |
| checkbox / radio 的 `change` | 点击步骤已经带上了这次状态跃迁。 |
| Shift + 字母 | 那是大小写，`change` 已在值里捕获——不是和弦。修饰键加单个字符（`ctrl+a`）才是。 |

**导航步骤由渲染进程铸造，而非页面。** 渲染进程本就在跟踪 `browser://navigated`；在页面里
再加一个探测器，等于让两个来源对同一事件各执一词。确实会到达的重复项由 `appendStep` 折叠
（一次导致导航的点击会经由 history 钩子与 load 事件各报一次，重定向链则每一跳都报），并对
同一字段的连续编辑做覆盖。

### Dexie v110，仅存本机

```
browserRecordings: "&id, baseUrl, updatedAt, [baseUrl+updatedAt]"
```

行**就是**领域类型：`RecordedFlow` 本就带有 `id`、索引所需的 `baseUrl` 与 `updatedAt`，以及
步骤列表，因此不存在第二个需要同步维护的行结构。复合索引 `[baseUrl+updatedAt]` 服务于面板
唯一的列表查询——当前已加载源的 flow，按时间倒序。

步骤是**内嵌的，而非关联表**：flow 只会被整体读写，关联表什么也换不来，却要为每次读取多付
一个事务。

该表**未注册到 `lib/sync`**。一条 flow 编排的是某一台机器的开发服务器；同步它只会把
`localhost` URL 推到设备之外，对任何其他设备毫无价值。仅存本机在这里是正确的默认值，而不是
被推迟的功能。

## 架构

```
human clicks in the pane ──► overlay.injected.js  [capture-phase passive listeners]
                                │  buffers steps + mirrors to sessionStorage
                                ▼
                          browser_embed_{start,resume,stop,drain}_record   [Rust]
                                │  eval_embed_with_result (strings only)
                                ▼
   browser://navigated ──► FlowRecorder (poll 400ms, accumulate)  ──► RecordedFlow
   browser://loaded ─────►   drain → resume                              │
                                                                          ├─► exporters.ts ─► json / playwright / agent
                                                                          ├─► Dexie v110 browserRecordings
                                                                          └─► replayFlow ─► EmbeddedEngine (ADR-0055)
                                                                                  selector → refFor → act(ref)
```

- `lib/browser/recording/protocol.ts` —— `RecordedFlow`、`RecordedStep`
  （`navigate` / `click` / `fill` / `select` / `press_key` / `wait_for`）、
  `appendStep`、`supersedes`、`secretKey`、`requiredSecrets`、`resolveStepUrl`。
  无 Tauri，无 DOM。
- `lib/browser/recording/exporters.ts` —— `toJson`、`toPlaywrightSpec`、
  `toAgentContext`，由 `exportFlow(flow, format)` + `exportFilename` 分发。
- `lib/browser/recording/recorder.ts` —— `FlowRecorder`：轮询循环、`noteNavigation`、
  `noteLoaded`（drain→resume）、断言、步骤删除。
- `lib/browser/recording/replayer.ts` —— 基于 `BrowserEngine` 的 `replayFlow`；
  `secrets` 映射；步骤之间可中止。
- `lib/browser/overlay.injected.js` —— “Action recording (ADR-0072)” 代码块
  （`startRecord` / `resumeRecord` / `stopRecord` / `drainRecord` / `restoreRecord`，
  以及捕获阶段的 `click` / `change` / `keydown` 监听器），外加 `refFor(selector)`，
  经 `window.__cognia*Record` / `__cogniaRefFor` 暴露。
- `src-tauri/src/browser/embedded.rs` —— `browser_embed_ref_for`、
  `browser_embed_{start,resume,stop,drain}_record`。全部返回**字符串**：
  `eval_with_callback` 只能在 WKWebView/WebView2 上可靠地编组字符串。
- `hooks/browser/use-flow-recorder.ts` —— React 绑定；掌管页面自身看不到的那两个面板事件；
  用 `safeUnlisten` 处理 StrictMode 竞态；卸载时取消录制，以免页面处于已武装却无人 drain
  的状态。
- `components/browser/browser-recorder-panel.tsx` —— 录制 → 审阅 → 回放/导出，三个状态由
  推导得出而非存储。
- `lib/db/browser-recordings.ts` —— v110 表的 CRUD。

断言（`wait_for`）**从不自动采集**，由人从步骤列表中添加。没有断言，录制只是脚本；有了断言
它才是测试——而只有人知道这个流程本该证明什么。

## 诚实的能力边界

- **eval 桥无法被 jest 或 cargo 覆盖。** 桥之上的一切都有单测（protocol、exporters、
  recorder、replayer、hook、面板、Dexie CRUD），overlay 的纯函数也在 jsdom 下测过。但
  `eval_with_callback` 对活的 WKWebView/WebView2 的行为，两个 runner 都跑不到。人工门禁
  是用 `pnpm tauri dev` 冒烟跑一次 record → replay 闭环。**截至撰写本文时尚未执行。** 这与
  ADR-0055 为其 snapshot→click→snapshot 闭环所声明的上限是同一个。
- **上限 500 步，保留头部。** `MAX_RECORD_STEPS` 达到后停止推入，而非环形缓冲。环形缓冲会
  悄悄*砍掉录制的头部*，而开头几步正是定义这条流程的部分——长到这个地步的录制本身已属病态。
- **一切都继承 ADR-0055 的第一阶段能力边界**：跨源 iframe 不可见、合成事件
  `isTrusted:false`、closed shadow DOM 不可达。依赖这些的流程本来就无法回放。
- **录制下来的选择器，其寿命等同于标记结构。** role/name 的采集是 Playwright 导出得以稳健
  的原因；JSON 与回放路径仍以 CSS 为锚，会随重构而漂移。

## 后果

- 用户走一遍面板，现在能产出一等公民的产物：一次复现可以变成 Playwright 用例、智能体上下文
  或一条保存下来的 flow，无需重新誊写。这正是 ADR-0055 闭环所缺的回程。
- 回放复用 ADR-0055 的引擎及其按 ref 操作纪律，因此录制没有引入第二种驱动页面的方式——
  `refFor` 是解析器，不是后门。
- 录制下来的登录流程刻意不是自足的：回放或导出时需要另行提供其密钥。这个摩擦正是目的所在。
- flow 永不离开本机，且永不含凭据。
- 新增第四种导出格式的成本是一个纯函数。
