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

**插件激活（10–45秒）、数据导入`applying`阶段、工作流步骤计数和Agent Team编排的确定进度仍然缺失。信息是存在的;披露它需要对州级报告链进行调整，这里正在超出范围。

**未经验证。** 减少动员合同仅涵盖单位保障。jsdom 不运行动画，因此仍需进行真实浏览器检查;第一次尝试发现，应用在Playwright的模拟下报告`prefers-reduced-motion: false`，尽管相同的模拟在`about:blank`上也能工作，这需要单独调查才能信任某个规范。
