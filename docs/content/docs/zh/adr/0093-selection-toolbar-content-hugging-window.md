---
title: "0093 — Selection Toolbar：内容自适应浮层与六项操作契约"
description: "系统范围的文本选择工具栏的原生窗口由渲染器大小决定，而非硬编码，拒绝有理由，六个动作会在overlay/main-window边界上折叠成三种反馈模式。"
---

# 0093 — Selection Toolbar：内容自适应浮层与六项操作契约

- **状态：** 已接受
- **日期：** 2026-07-29
- **基于：** ADR-0020（电脑使用/输入监控）、ADR-0058（桌面宠物叠加窗口）、ADR-0069（长期记忆）、ADR-0075（语音/声TTS）
- **居住地：** `src-tauri/src/selection_toolbar.rs`、`components/selection-toolbar/`、`lib/tauri/selection-toolbar.ts`、`lib/tts/speak-selection.ts`、`components/providers/initializers/selection-toolbar-initializer.tsx`

## 背景

系统范围的选择工具栏（在任何应用程序中选择文本→浮动胶囊提供动作）自带了一个大小恒定的原生窗口：

```rust
const TOOLBAR_WIDTH:  f64 = 360.0;
const TOOLBAR_HEIGHT: f64 =  44.0;
const TOOLBAR_MENU_HEIGHT: f64 = 280.0;
```

该盒子的内容并非源自其内容，单一原因导致了三个明显缺陷：

1. **投影被截断。**胶囊被`h-9`在`h-11`容器中，留有4px的余缘。`shadow-xl`远远超出那个范围，窗户被`shadow(false)`创造，`html[data-selection-toolbar]`力`overflow: hidden`——所以阴影四面都被切断了。
2. **多余宽度成了死区。**窗口始终是360像素，但胶囊更窄。`point_inside_toolbar`对*窗口*矩形块进行了测试，所以点击透明边距被视为“工具栏内”：既没有按下按钮，也没有关闭。Tauri无法实现部分窗口点击，扩大画布只会让情况更糟。
3. **打开语言菜单后，胶囊瞬移了。**`selection_toolbar_set_interactive(true)`调整了窗口大小以`TOOLBAR_MENU_HEIGHT`*并*重新固定到那个高度。由于工具栏锚定在选择（`y = anchor.y - height - margin`）上方，增加高度会使窗口顶部边缘向上移动——而窗口顶部渲染的胶囊也因此跳跃了大约236像素。

另外两个空隙是结构性的，而非视觉的：

- **没有进入或退出动画，也没有。**出现在两个rAFs后`window.show()`;离开是`window.hide()`。两者在OS层都是瞬时完成的，所以渲染器从来没有帧可以做动画。
- **空闲计时器无法取消。**每个候选人只需`sleep(IDLE_DISMISS_MS)`，即使指针放在工具栏上，工具栏也会在10秒后消失。

该子系统在子系统映射中没有ADR和行，同时获得了跨窗口协议和六个动作。

## 决策

### 1. 渲染者测量;Rust如下

一个新的`selection_toolbar_resize(width, height, capsule) -> { placement }` 命令取代常数，镜像`island_resize`（`src-tauri/src/fleet/island_window.rs`）。渲染器根据内容签名进行测量`useLayoutEffect`，并应用岛屿的“立即生长/220毫秒后缩小”规则，确保崩塌高度不会超过其CSS过渡。

`width`/`height`描述整个窗框——胶囊加上每侧`SELECTION_SHADOW_PAD`片（20像素）透明边缘，这给阴影和enter/exit比例提供了可以绘制的空间。

### 2. 测试使用胶囊，而非窗口

`resize`还将胶囊的rect地址*置于*窗口内*，以逻辑像素为单位;Rust通过窗口的比例因子进行调整并测试。因此，阴影边缘对眼睛和鼠标都是透明的：点击那里即可关闭，就像药丸外的其他地方一样。

### 3. 归还分配，而非假定

`clamp_toolbar_position`总是选择上方或下方（当锚点贴合工作区顶部时，画面会翻到下方），但从未告诉渲染器。它现在返回`ToolbarPlacement`，`resize`也返回——一旦已知真实测量高度，答案可能反转。渲染器用了两次：

- 由于胶囊的`transform-origin`，进入动画是从选择中“生长”出来的;
- 选择内容锚定在哪一边。Rust将最靠近选择的窗口边缘钉住，因此放置于上方时内容底部对齐，下方位置则顶部对齐。这正是使胶囊静止、而语言面板窗口扩大的原因——§背景 3中的缺陷。

原因与语言选择器是内联渲染的，而不是在Radix门户中：门户式`position: fixed`菜单位于测量壳体之外，因此窗口永远不会扩展到包含它。

这种交换会有明确的无障碍成本，必须明确偿还。`DropdownMenu`免费提供游动对焦、方向键、Home/End和逃脱;普通`<ul role="listbox">`完全没有这些功能，工具栏在面板打开时*会*进行聚焦，所以键盘确实能达到焦点。因此，面板实现了移动标签索引，arrow/Home/End带环绕移动，并以聚焦当前目标开场。

逃离是分层的，而非全球性的。Rust的钥匙监视器曾无条件关闭Escape，这会让面板自己的Escape无法访问。现在它会追踪一个聚焦子面板是否打开（`interactive`），当打开时，会转发`selection://escape`给渲染器而不是关闭——所以第一个Esc关闭面板，第二个关闭工具栏，和应用中其他所有弹出覆盖的图层一样。

### 4. 解雇必须有理由

`dismiss(app, inner, reason)`需要`Interrupted | Idle | Completed`。

- `Interrupted`（点击别处，按键，滚动，功能停止）会**同步**隐藏。用户已经在做别的事情了;一颗总是在上面的药丸在刚刚点击的部分上消失，这更像是延迟，而不是打磨。
- `Idle`和`Completed`先发射，`EXIT_ANIMATION_MS`后隐藏（160毫秒），由现有的`generation`计数器保护，延迟隐藏不会吞噬新候选物。

### 5. 用保活计时器替代一次性放置计时器

`keep_alive: AtomicBool`加上一个500毫秒的看门狗跳动。渲染器在指针Enter时提高它，语言面板打开时，以及所有待处理的操作或播放过程中。现在胶囊以图标为先，这一点更重要：用户*必须*悬停才能阅读标签。

### 6. 六个动作，三种反馈模式

`SELECTION_ACTIONS`（`components/selection-toolbar/selection-toolbar-actions.ts`）是渲染器的单一枚举;`SelectionToolbarAction`和`SELECTION_ACTION_SHORTCUTS`是它的Rust半。

| 模式 | 行动 | 对焦主窗口 | 工具栏 |
| --- | --- | --- | --- |
| `local` | 收到 | — | ✓ 420毫秒后离开 |
| `handoff` | 解释、翻译、提问、convertUnit | **是的** | 立刻离开 |
| `await` | 记住，说话 | 不 | 留下，被结果驱动 |
| `launch` | openLink，composeEmail，searchWeb | 不—— 提升了*浏览器* | 立刻离开 |

`launch`（加上上下文动作，ADR-0095）这就是为什么`holds_toolbar()`是显式`match`而非`!focuses_main()`。这种身份只在每个动作要么升起主窗口，要么完成时才成立;`launch`既不这样做——它又出现了第三个应用——而一个始终在顶部的药丸漂浮在已经放在前面的浏览器旁边，正是§4存在的需要避免的延迟。

`SelectionStagePayload`获得了`focusMain`，`bring_window_to_front`现在对此有条件。把整个申请表提高到大声朗读句子或藏便条，就失去了两者的意义。

`await`模式存在是因为`storeExternalMemory`*返回*`{ok: false, reason: "pii_blocked"}`而不是投掷（`lib/memory/api/store-memory.ts`）。乐观地拒绝会让被阻塞的人在主窗口还在托盘时写一个静默的no-op。

### 7. 主窗口播放语音

工具栏渲染传输，但`ttsOrchestrator.speak`在主窗口运行，进度会被推回`selection://speech`。原因有两个：叠加窗口是有意的最低权限展示壳（`lib/pet/window-role.ts`;`/selection-toolbar`处于`PET_WINDOW_ROUTE_PREFIXES`中，因此只挂载最小的外壳），编排器拥有每个网页视图的`<Audio>`元素——从覆盖层中说话会打开第二个播放器，在已阅读的聊天消息上进行对话。

### 8. 全局快捷方式，与特征绑定

`alt+shift+1..6`通过现有的`ShortcutRegistry`映射到六个动作，绑定在`selection_toolbar_start`中，`selection_toolbar_stop`释放——故意*不*在`seed_builtins`中，否则用户从未启用该功能时会被深陷六个和弦。用户已经重新绑定的和弦保持原样。调度是一种**通知**（`selection://shortcut`），而不是第二条执行路径：渲染器拥有所选的翻译目标、相位机和退出动画，Rust中分叉这些可以保证漂移。

被动`CGEventTapOptions::ListenOnly`显示器无法消耗按键，因此对原始按键的反应会将数字输入到用户文档中。真正的全球捷径是这里唯一安全的机制。

## 后果

- 每次变更尺寸都要来回IPC。悬停是豁免的：窗口被钉在最宽的悬停状态，从每个动作的屏幕外幽灵行计算，因此标签展开纯粹是布局动画。
- 渲染器是窗口几何的权威。未能测量的渲染器会将窗口留在`MIN_*`占位符处——但占位符是在第一次成功调整后才`visible(false)`创建并显示的，因此占位符永远不会出现在屏幕上。这种揭示顺序也为`transparent(true)`窗口提供了调整尺寸的提示，避免涂黑（见`lib/pet/reveal.ts`）。
- `MemorySourceChannel`获得了 `"selection"`。它只是一个来源标签——上面没有分支。
- Linux 没有变化：AX/UIA选择读取从未实现。
- **按动作排序是固定的;可见性则不然。** 被ADR-0095取代。上述六个动作保持它们的相对顺序和和弦，但当纯分类器匹配选择时，四个上下文动作（打开链接、电子邮件、搜索、转换）会加入它们，并且一个面向用户的开关关闭分类器。可见动作上限为六个，溢出会从尾部剔除一个*通用*动作——从未匹配上下文，也绝不会`copy`。因为上下文动作也会在尾部渲染，行长保持不变，没有通用按钮横向移动。
- **`§8`的和弦独立性现在是承重的。**和弦会在整个动作表中解决，从未在可见列表中解算，因此`⌥⇧6`在`speak`被淘汰时仍会朗读。情境动作故意没有和弦：只有在选择恰好是URL时才有效，无法成为习惯，必须从稳定动作中提取才能存在。
