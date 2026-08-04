---
title: "ADR-0096 — 加载状态动效与无障碍"
description: "按本质性分级动画，修正反转速度偏好，并赋予加载区域单一语音。"
---

## 状态

已接受 — 2026-07-29。

## 背景

该应用拥有完整的动态基础设施（`MotionSettings`、`MotionApplier`、`useFlowMotion`、动作标记、`ChatThinkingIndicator`），没有合同区分**加载反馈**和**装饰**。这一次遗漏导致了四个缺陷。

**减少运动保护冻结了所有加载指示器。** `app/globals.css`在三条路径上对`*`应用`animation-duration: 1ms; animation-iteration-count: 1`（`.reduce-motion`类、`[data-reduce-motion="true"]`属性和`prefers-reduced-motion`媒体查询）。装饰方面没错。对`animate-spin`来说，这意味着旋转1毫秒后停顿——220个文件的旋转器被渲染成静态、破碎的字形，骨架则变成惰性的灰色块。要求减少动作的用户失去了应用仍在运行的所有信号。没有任何测试。

**动画速度偏好被反转了。** 设置UI标注为“快速（1.5×）”和“慢（0.5×）”，但`resolveMotionState`直接写入`--motion-duration-scale`，消费者乘以基准时长：`calc(200ms * var(--motion-duration-scale))`。选择“快速”后，每个对话、工作表、码头和面板的过渡速度都慢了50%。JS侧则是相应的：`0.18 * speed`延长一个渐进距离以获得更快的偏好，`damping: 30 / speed`降低阻尼，使得“快速”弹簧振荡时间更长。

**无障碍功能两端都颠倒了。** `Skeleton`在~174个呼叫站点中完全没有任何 ARIA，而`Spinner`硬编码的`role="status"`加上一个英文`aria-label="Loading"`——因此其呼叫站点，大多是已经显示自己状态的按钮，每次坐骑都会触发第二次未翻译的实时区域更新。（`components/ui/`免于`lint:i18n`，这也是英国字符串的运输方式。）

**没有任何防闪烁的措施。** 这个应用中的读取是Dexie优先的，通常会在画面内，因此`isLoading`上渲染的骨骼会出现又消失。

## 决策

### 1. 三个运动层级

| 分级 | 减速运动 | 成员 |
| --- | --- | --- |
| 装饰性 | 抑制（未更改） | 闪光扫荡，化身脉冲，入口揭示 |
| 现状 | **不停奔跑**，速度达到 | `.animate-spin`，`[data-slot="skeleton"]` |
| 前庭 | 一直发信号，**只有透明度** | `.animate-bounce`，`.animate-ping` |

小型旋转器不是前庭触发器，移除它就失去了应用唯一存在的证据。平移和缩放才是真正影响前庭不适的部分，所以第三层保留信号，并通过`motion-safe-fade-pulse`关键帧降低运动。

容易出错的实施说明：

- 豁免必须在**所有**三条**守卫路径上重复。错过媒体质询，OS-level减少动议——多数情况——依然被冻结。
- 仅仅恢复`animation-duration`还不够：守卫还压制了`animation-iteration-count: 1`，所以两人都必须回来。
- 具体性决定，而非顺序。`html.reduce-motion *`分（0,1,1）;`html.reduce-motion .animate-spin`得分（0,2,1）。两者都是`!important`。
- 航线经过`--motion-duration-scale`;Tailwind的`animate-*`公用事业会硬编码时间，否则会忽略这个优先级。

**`data-slot="skeleton"`承重。** 这是该层唯一的hook，只有`components/ui/skeleton.tsx`会发射。手掷的`bg-muted animate-pulse`方块对该层来说是隐形的，并且会冻结。

### 2. 速度和持续时间是倒数

`MotionSettings.speed`保持面向用户的*速度*倍增器。`speedToDurationScale`（`lib/appearance/motion-applier.tsx`）在单一写字处反转一次。每个CSS `calc()`消费者和插件SDK的`durationScale`令牌都正确无误，无需修改。`useFlowMotion`现在只暴露`durationScale`——两者在每个呼叫站点都被混淆，这导致同一反转扩散到13个呼叫站点。

### 3. 地区宣布;画面则不然

`Skeleton`默认是`aria-hidden`的。除非有装饰`Spinner` `label`。`LoadingRegion`（`components/ui/loading-region.tsx`）拥有整个区域的`aria-busy`和一条礼貌`role="status"`消息，只有在等待升级或设备离线时才会重新宣布。

### 4. 反闪烁存在于hook，而非原始人

`useDeferredLoading` 门禁显示前180毫秒，最小显示320毫秒。这是个hook，因为等待是否值得展示是数据层的知识（热Dexie访问与冷网络拉取），而非表现原语能推断出的内容——保持原语同步使得约30个现有套语断言骨架渲染即时有效。

阈值不是按`--motion-duration-scale`缩放的：它们是感知阈值，不是动画。喜欢较慢动画的用户没有要求展示更多骨骼。

## 后果

**冻结的旋转器现在是bug，而不是政策本身。** 如果有人“修复”了豁免块，因为看起来它能抵消减小运动，他们会重新引入原有缺陷。这正是本文件存在最重要的目的。

**强制执行。** `pnpm audit:loading-states` 当新建或更名文件手掷转盘或骨架时失败。其基线记录了有意的非迁徙，且可能只会缩小。门禁区分了占位符和脉冲的*运行状态点*——后者不是骨架，重写成骨架会有bug。

**故意非作用域。** `components/settings/**`（116个文件）和~100个按钮旋转站点未被迁移：它们通过共享CSS和原语继承了正确性修正，无需编辑，触碰它们会拖拽200+文件通过90%更改文件覆盖率的覆盖门禁，以获得美观优势。

**确定性进度仍然缺失**：~~插件激活（10–45 秒）、~~数据导入的 `applying` 阶段、工作流步骤计数、以及 Agent Team 编排。信息是存在的；要把它暴露出来需要改动那几条状态上报链，不在本轮范围内。（插件激活已于 2026-08-03 交付 —— 见下方修订。）

---

## 修订 — 2026-08-03（确定性的插件激活进度）

补上上面记录的缺口中"插件激活"这一半。另外三个面仍然没有确定性进度。

### 新增：七阶段模型，单调性来自结构而非维护

`preflight → dependencies → schema → runtime → contributions → hooks →
commit`，其中 `processedForPhase(phase)` **只**返回该阶段的下标，别无其他。

正是这一个决定，让两个难点属性自然成立，而不需要有人去持续维护：

- **单调** —— `processed` 是阶段名的函数，永远不是"实际完成了多少工作"
  的函数，因此不可能回退。
- **被跳过的可选工作照样推进** —— 一个没有 `manifest.dexie`、也没有依赖的
  插件，仍然会*进入* `schema` 与 `dependencies` 阶段，仍然上报 2/7 和 1/7。

对应到 `lib/plugin/core/manager.ts` 的规则是：**任何 `advance` 调用都不得
放在条件分支里。** 有一个回归测试专门跑"无 Dexie 表、无依赖"的 manifest，
断言它产出的阶段序列与满配置的完全一致 —— 这正是用来抓住"某人后来把
`advance` 挪进了某个 `if`"的测试。

依赖子激活完全不需要额外记账：递归走的是同一层包装，因此每个依赖有自己的
条目独立从 0/7 跑到 7/7，而父插件在循环返回之前一直冻结在 `dependencies`
1/7。这是调用图的性质，不是状态管理的性质。

### 裁定：回滚顺序，以及为什么没有 `finally`

`enablePluginInner` 自己的 catch 会跑完整个回滚 —— 反注册 contributions、
写入插件错误、发 `PLUGIN_ENABLE_FAILED_EVENT` —— 然后才把异常抛给记录失败
的外层 catch。因此在回滚期间，条目仍然处于失败阶段的 `running` 状态，这是
对的：工作确实还没结束。`fail` 严格发生在所有回滚副作用（包括 toast）之后。

如果给内层 try 加 `finally`，它会在异常抵达外层 catch 之前触发，把顺序整个
颠倒过来。改动点的注释写明了这一条，因为这个写法看上去像是疏忽。

### 新增：`LoadingRegion` 增加确定性变体

`progress?: { processed, total, phaseLabel? } | null`，纯增量。

- 仅供读屏的 `role="status"` 文本变成 `"<base> — <阶段> — <n>/<total>"`，
  一次激活最多变化七次 —— 恰好是本 ADR 所设计的重播报节奏。
- 可见的 `<Progress>` 渲染为状态 span 的**兄弟节点，绝不是子节点**，这样
  Radix 隐含的 `role="progressbar"` 位于 live region 之外，数值更新不会被
  播报。
- `total <= 0` 时**忽略** `progress`，回退到不确定态。确定性的 0% 进度条是
  一个断言；转圈才是事实。
- **没有 `onCancel`。** `enablePlugin` 没有取消令牌，而本 ADR 规定：只有在
  取消真的能停止工作时才提供取消。

### 修复：`Progress` 从未输出 `aria-valuenow`

`components/ui/progress.tsx` 解构出 `value` 却只用于 CSS transform，从未把它
传给 `ProgressPrimitive.Root`。全应用每一个进度条都是"视觉上确定、无障碍上
不确定"。改动一行；而上面那条确定性无障碍契约正是建立在它之上。

### 修复：`/plugins` 的开关从来没有真正激活任何东西

四个开关调用点都只写 Dexie 的 `enabled` 标志，而没有任何 reconciler 订阅它
—— `manager.enablePlugin` 能从启动恢复、更新器、远程控制到达，唯独到不了
面板。现在它们改走 manager，Dexie 写入成为状态迁移的*结果*而不是它的替代品，
并在失败时回滚乐观开关。

这也让此前形同死代码的 `PluginStatusPill` `loading` 分支复活：既然没有任何
代码路径往 Dexie 行里写 `enabling`/`loading`，那条 `isLoading` 推导就永远不
会从面板触发。批量操作条的 `Promise.all` 改成了顺序循环 —— 对存在相互依赖的
插件做并行激活，并不是 manager 的生命周期锁让人可以放心假定的事。

**未经验证。** 减少动员合同仅涵盖单位保障。jsdom 不运行动画，因此仍需进行真实浏览器检查;第一次尝试发现，应用在Playwright的模拟下报告`prefers-reduced-motion: false`，尽管相同的模拟在`about:blank`上也能工作，这需要单独调查才能信任某个规范。
