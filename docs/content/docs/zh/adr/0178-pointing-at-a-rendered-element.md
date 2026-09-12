---
title: "0178：指向一个已渲染的元素"
description: "让 artifact 预览变成可以被指着说话的东西：一个取点器覆盖三种渲染通道且不放宽任何沙箱；浏览器的评审队列变成两个界面共用的队列。"
---

# ADR 0178：指向一个已渲染的元素

**状态：** 已接受
**日期：** 2026-09-12
**相关：** ADR-0158（Artifacts 与 Canvas）、ADR-0139（视觉输出路由）、ADR-0055（Agent 浏览器循环）、ADR-0083（上下文工作台）、ADR-0155（插件作者边界）

## 背景

从结构上看，artifacts 右侧栏是完工的：一个外壳（ADR-0083）、十六个已注册面板、`audit:unreachable-components` 全绿。再加一个面板只会是噪音。

它做不到的是——你没法指着里面的任何东西说话。

artifact 里的选择只有文本一种（`selection-comment-button.tsx` 读 `window.getSelection()`），而且只在 `code`、`review`、`split` 三个视图里出现。`preview` 里根本没有任何选择入口，而且结构上也不可能有：每个渲染出来的 artifact 都住在 iframe 里，父文档的 `getSelection()` 看不见它内部。恰恰是"把**这个**元素改一下"最自然的那几类 artifact——`html`、`react`、`svg`、`chart`——完全没有表达这句话的办法。

而隔着一个图标的内嵌浏览器，早就把整套词汇备齐了：带选择器、DOM 路径、计算样式、无障碍信息、React 组件名/组件栈/props 以及 inspector 源码位置的 `BrowserSelection`；四档详情级别；一个提示词写入器；一个带意图、严重程度、状态和讨论串的持久标注队列。全部被 `isTauri()` 挡着，而且 artifact 这边一个都够不着。

## 决定

### 1. 一个取点器，按它所运行的 Document 参数化

artifact 有三种渲染方式，区别在于应用能否够到渲染后的 DOM：

| 通道 | 类型 | 能否够到 |
| --- | --- | --- |
| `renderer` / `jupyter` | code、document、mermaid、chart、math | 能——就在宿主树里的活 React |
| `iframe`，`allow-same-origin` | html（静态）、svg | 能——父文档本来就在**写**这个 document |
| `iframe`，`allow-scripts` | react、interactive html | 不能——不透明源（ADR-0158） |

前两种是同一个问题。第三种是同一个问题被挪到了 `postMessage` 的另一侧。所以 `lib/artifacts/runtime/element-pick.ts` 把目标 `Document` 作为参数，并且**同时**被打包进应用和帧内 shell。

**为此没有放宽任何沙箱。** `allow-same-origin` 的帧本来就可被父文档写入，`allow-scripts` 的帧本来就有一个说 `postMessage` 的 shell；取点器只是那条为 `capture-snapshot` 而存在的通道上多出来的一条消息。

两个很容易搞错、并且被测试钉住的后果：

- 这个模块从不碰环境里的 `window`。在同源 iframe 这一支里，目标 document 的 view 是**帧的** window，读 `window.innerWidth` 会描述错视口，`getComputedStyle` 会被喂进一个外来节点。所有依赖 view 的读取都走 `doc.defaultView`。
- 取点器接受一个 **root**。`renderer` 通道的 artifact 画在应用自己的树里，没有 root 的取点器会把右侧栏、导航栏和整段对话都当成可选目标——而且因为它在捕获阶段吞掉点击，武装期间整个应用会变得不可用。

### 2. 通道分支归预览组件所有，其它地方一律不许知道

`ArtifactPreview` 向 `lib/artifacts/element-pick-registry.ts` 注册一个控制器，工具栏只负责说"武装"。这和 `frame-capture-registry.ts` 为导出所用的形状一致，理由也一样：只有预览组件知道自己是怎么把东西画出来的。

注册表**主动广播**变化，而不是被读一次。预览是在挂载过程中注册的，那时工具栏已经渲染完并判定按钮该禁用；用普通 `Map` 读一次，按钮就会在一个完全可取点的预览上方一直灰着，而且没有任何东西会去重渲染它。

### 3. 一次取点有两个去处，而且它们确实是两件事

- 普通点击把一个 `ArtifactSelectionRef` 暂存进输入框。该类型被明确记为*唯一有资格成为编辑目标的种类*：正是它让回复能以针对这个 artifact 的修订提案形式回来。
- ⌘/Ctrl + 点击立即发送，走浏览器那侧已有的投递路径。

早先的草案把取点**只**路由进标注队列。一次全新上下文的审查否掉了它：只变成标注的元素永远无法变成修订提案，而那恰恰是"在 artifact 里选中元素"最想要的东西。输入框 chip 是易逝的那条路（被下一条消息消费，可加宽、可刷新、可提升、可移除）；标注是持久的那条（意图、严重程度、结果、讨论串）。合并两者会丢掉其中一个。

`ArtifactSelectionRef.element` 是增量的：`range` 仍然是 diff 锚点，并且从元素反解——先找逐字出现的标记，再在渲染器规范化过属性时退到 id 或 class 锚点，最后当一个渲染节点在源码里根本没有对应物时（例如由数据画出来的图表）落到整个 artifact。

### 4. 评审队列是共享的，并且是分域的

artifact 标注和浏览器标注住在**同一张表**里，用同一批组件渲染，由同一个写入器格式化。关于一个元素的评审备注，不会因为这个元素当时挂在哪个界面上就变成另一种东西。

要让这件事安全，必须先修掉一个早于本次改动的缺陷。`listActionableBrowserAnnotations` 和 `listPendingBrowserAnnotations` 扫全表，然后**只**按 `sessionId` 过滤。在浏览器是唯一写入方时这无害；一旦有第二个写入方，artifact 标注就会出现在浏览器面板的队列里，自动撑开它的检查栏——那会发出 `embedSetBounds` 并真的改变原生 webview 的尺寸——然后被以 `# Browser annotation batch` 为标题、附带一张浏览器截图批量发给模型。现在两个读取函数都必须接收一个域过滤器。

**没有升 schema 版本。** 域是在内存里判定的，就在这两个读取函数本来就扫描的位置，所以没有任何索引发生移动。这不是偷懒：加一个 `scope` 索引会让所有已存在的行在 `BROWSER_ANNOTATION_RETENTION_MS` 的整整 30 天里掉出该索引，而且 `CURRENT_SCHEMA` 的 `.upgrade()` 回调会在任何一次升版时重写每一条 `messages` 行。

`target` 在写入边界被规范化，所以**落库的行**永远明确说明自己是关于什么的，而该字段在类型上保持可选——`BrowserAnnotationRow` 与 `saveAnnotation` 是向插件作者发布的表面（ADR-0155/0156），按旧形状写入的插件仍然能编译。没有 `target` 的行就是 web 标注：这不是猜测，而是当时这张表唯一能装下的东西。

### 5. 界面自报家门

有三处把 "in-app browser" / "Browser annotation batch" 写死了。顶着这个名头出现的 artifact 元素，等于让模型去找一个从未存在过的网页。`ElementSelectionCore.originLabel` 跟着选择一起走——它必须如此，因为一条入队的标注是在很久以后、由一个根本不知道哪条行来自哪个界面的批量写入器格式化的。

`BrowserSelection` 现在增量地继承 `ElementSelectionCore`：DOM 不会因为宿主不同就变成另一种东西，而对外发布的字段集合逐字节不变。

## 刻意没做的事

- **没有抽出浏览器的检查栏。** 它闭包了大约二十六个绑定，其中好几个是浏览器专属的——原生截图矩形、`embedSetBounds` 的动画时钟、Adjust 控件的页面 URL。一个把这些全部作为 props 接收的"共享"组件，比两个组件更糟。搬走的是意图/严重程度选择器和队列列表，检查栏没动。
- **没有复用 `lib/browser/overlay.injected.js`。** 那是一个 3155 行的 ES5 IIFE，由 Rust 注入进原生 webview，安装时会替换全局定时器。`cssSelector` 和 `domPath` 在 TypeScript 里重新实现，并由一个对拍测试在 jsdom 中求值真实的 overlay 文件、在九种 DOM 形状上断言两者一致——这样两份实现不会悄悄漂移。
- **没有给 `browserAnnotations` 表改名。** 这个名词是错的，而修正它的代价是打断一个已发布的插件表面。改为在模块顶部把这件事说清楚。

## 后果

- 每一种已渲染的 artifact 界面都可以被指向，包括沙箱化的 React artifact，不放宽任何沙箱，也不新增传输通道。
- 打包新鲜度哨兵改为记录 esbuild 真实的 `metafile.inputs`，而不是一个写死的路径。它的前身已经放过一次静默回归（"capture-snapshot 处理器写好了、测过了，然后悄悄没被发布"），并且保留了那个 bug 的形状：第一个出现的第二个模块就会让它重演。
- `capture-snapshot` 现在序列化的是一份剥掉取点器自身装饰的克隆。否则在武装状态下导出，高亮框会被烤进 PNG 里。
- 19 条标注文案离开了 `browser` 命名空间——后者还留着 "Browser Adjust" 这类字符串。动态 key 对 `lint:i18n` 不可见，因此有一个目录覆盖测试在两种语言里钉住每一个意图、严重程度和状态。

- **仅桌面与平板。** 两个控件都在 `renderActionZone()` 里，而 `ArtifactPanelContent` 只在 `panelMode !== "mobile"` 时渲染它。Capacitor 外壳拿得到预览，但拿不到取点器；取点器本身没有任何对手机不友好的地方，所以这是界面缺口而非决定。
- **取点位是被显式认领的，不是推断出来的。** 注册表按 artifact id 建键，但同一个 artifact 会被多个挂载同时预览——最要紧的是消息流里的内联预览，它在消息滚入视野时就会打开。`ArtifactPreview` 接受 `pickable`（默认 false），只有同时渲染开关的那个界面才认领它。
