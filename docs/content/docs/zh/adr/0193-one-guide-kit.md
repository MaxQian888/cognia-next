---
title: "0193 — 一套引导组件，设置缺口实时读取"
description: "首次运行流程、配对流程和应用内的设置提醒，原本是同一类东西的三套手工外观，现在统一使用 components/guide/ 下的一套引导组件。设置还缺什么，改为从实时状态推导，不再按记录的退出路径输出固定文案；每条提醒都直达补齐缺口的那一步。"
---

# ADR 0193 — 一套引导组件，设置缺口实时读取

**状态：** 已接受 — 已实现
**日期：** 2026-09-25
**修订：** [ADR-0122](./0122-first-run-onboarding)（决策 13，完成设置条）、[ADR-0141](./0141-onboarding-two-paths)（叙事面板、推荐路径）

## 背景

Cognia 在三个地方引导用户：

- `/onboarding` 的**首次运行流程**
- `/pair` 的**配对流程**
- 几处**应用内提醒**：标题栏下的完成设置条、Provider 页面的"开始使用"横幅，以及设置 → 发现里的重新运行区块

它们各自搭建，已经互相漂移。

**同一屏的两份拷贝。** `/pair` 的注释写着"刻意与引导外壳保持一致"，实际上是手工复制的一份：

- 品牌网格背景直接内联粘贴
- 内边距、正文宽度、场景尺寸都不一样
- 没有入场动画，也没有窗口栏，品牌字标放在面板里
- 页面标题放在面板里，而引导流程在那个位置放的是叙述
- 进度条是另一套实现，标签规则和无障碍标记都不同

两个首次接触的界面看起来像两个产品。

**同一件事，三种外观。** 完成设置条是一条灰色横条；Provider 横幅是虚线卡片，配星芒图标，关闭按钮绝对定位；设置区块只有一个标题加一个按钮。三者做的是同一件事：把用户指向下一步设置。

**提醒会过时。** 完成设置条按记录的退出路径输出一句固定文案，这句话经常是错的：

- 跳过登录后又在设置 → Provider 里添加了密钥，仍然提示"Cognia 还无法访问模型"。
- 从首个任务卡片离开，或从没有登录项的推荐页离开，会记录 `runtime_skipped`，于是条幅在一台有运行时的机器上抱怨"没有运行时"。
- 配置好 Provider 之后，Provider 横幅仍然说"先配置一个 Provider 开始使用"。

**重新进入没有目标。** 条幅按钮和设置里的重新运行都从 `lastStep` 恢复。在推荐路径上，要走到真正缺的那一项，得重新看一遍整个计划，并且重新执行。

**流程中的两个小缺陷：**

- 推荐页进入就绪阶段后，叙述仍是"正在执行……这一段不需要你操作"，画面仍是计划图，而此时正需要用户挑一张卡片。
- ADR-0148 的风格包问题出现在了推荐路径上，因为推荐路径复用了同一个首个任务步骤；而该步骤自己的注释写明它只属于自定义路径。

## 决策

### 1. 一套引导组件：`components/guide/`

两个全屏流程和所有应用内提醒都由同一组部件组成：

| 部件 | 职责 |
| --- | --- |
| `guide-motion.ts` | 具名入场配方：外壳、正文、场景、文案、提示。继续使用 CSS，理由同 ADR-0141：动画没有运行时，元素停在最终样式。 |
| `GuideBrandMesh` | 品牌底纹，只画一处。 |
| `GuideWindowBar` | 返回、字标、窗口控件。在无边框窗口上它就是拖拽区和关闭按钮，在 Web 和移动端是同一行。 |
| `GuideNarrativePanel` | 场景、一句叙述标题和一行说明、状态槽、步进器、附加区。`overflow="band"` 在 `md` 以下把它限高为约 30vh；`overflow="scroll"` 让它随页面滚动，Web 配对流程的命令块需要这种方式。 |
| `GuideShell` | 全屏框架。它提升到步骤之上，只有带 key 的正文和场景会切换。各流程的正文宽度一致。 |
| `GuideStepper` | 唯一的进度行。只有已完成的步骤可以点击；`sm` 以下只显示当前步骤的标签。 |
| `GuideHeading` | 步骤的页面 `h1`，有 `step` 和 `hero` 两种尺寸。 |
| `GuideCallout` | 应用内引导外观，分 `bar`（实时 `role="status"` 行）和 `card`（带标签的区域）。色调分 `brand` 和 `attention`，只体现在底面上，从不体现在文字颜色上；关闭按钮始终有名称。 |

`StepShell`、`NarrativePanel`、`StepStepper`、`OnboardingWindowBar`、`PairShell`、`PairStepper` 保留为薄适配层，所以 e2e 用例依赖的 `onboarding-*` / `pair-*` 测试 id 不变。

两个流程都是面板负责叙述、步骤正文承载页面标题。配对各步骤的标题从卡片里移到了 `GuideHeading`。

### 2. 设置缺口由推导得出，而不是读取记录

`lib/onboarding/setup-status.ts` 以 `SetupGap[]` 回答还缺什么：`model`、`task-failed` 或 `first-task`，按阻塞程度从高到低排列。

- **设置是否中途离开**仍然看记录：`isSetupUnfinished`，即跳过路径、有 `skippedAt`、且没有 `completedAt`。新记录上占位用的 `runtime_skipped` 不再算作主动离开。
- **缺什么**从实时来源读取：
  - **model** 缺口只在 `resolveLiveModelAccess` 给出确定的 `false` 时出现。该函数沿用流程里同一条 `hasModelAccess` 规则，用已连接的外部 agent 代替流程里的进程扫描。`null`（仍在探测，或已配对的手机）从不产生缺口。
  - **`task-failed`** 来自记录的 `task_failed` 路径。
  - **`first-task`** 只在这台设备还没有任何会话时出现。

`hooks/onboarding/use-setup-status.ts` 用同一份结果同时供给完成设置条和设置里的状态区块，两者不会互相矛盾。

- 条幅先检查一个只读设置的廉价前置条件，通过后才挂载实时探测。
- 设置区块忽略条幅的"关闭"：关掉提醒不等于完成了设置。

Provider 横幅使用范围更窄的 `useBuiltInModelAccess`。外部 agent 自带凭据可以工作，这改变的是添加 Provider 的*用途*，并不让添加变得没有意义。

退出记录也保持真实：

- `skipOnboarding` 会清除遗留的 `completedAt`，`completeOnboarding` 会清除遗留的 `skippedAt`。
- 只有在没有模型的情况下离开，流程才记录 `provider_skipped`，无论从哪个页面离开。

### 3. 带目标的重新进入

`onboardingHref(focus)` 生成 `/onboarding?focus=model|task`。流程在挂载时通过 `useSearchParams` 读取一次，外面套着 `app/onboarding/page.tsx` 中的 Suspense 边界。不读取 `window.location`，因为客户端 push 时 Next 要等页面渲染之后才提交新 URL。然后由 `stepForFocus` 定位：

| 目标 | 自定义路径 | 推荐路径 |
| --- | --- | --- |
| `model` | 登录步骤 | 带内联登录的计划页 |
| `task` | 首个任务卡片 | 就绪阶段，不会重新执行计划 |

目标只会落到本设备步骤序列中实际存在的步骤上。没有路径记录的带目标重新进入（迁移来的旧用户，或通过"我之前设置过"离开的用户）会走分步路径，因此"连接模型"会直接落到登录步骤，而不是介绍页。

### 4. 推荐路径的就绪阶段与风格包

- 就绪阶段有自己的叙述 `narrative.express-ready`，并显示首次运行的场景。
- `FirstRunStep` 接收 `showStylePack`，流程传入 `mode === "custom"`。

## 影响

- 新的引导界面从 `components/guide/` 起步，而不是复制某个现有页面；其行为由同目录的测试（`components/guide/*.test.tsx`）固定。
- 每条设置提醒都会在对应缺口于应用任何位置被补齐的那一刻自动消失，也不会提示设备上已有的东西。
- `/pair` 在手机上多了一行 40px 的窗口栏，与 `/onboarding` 一直以来的那一行相同。
- 关闭条幅后，设置状态区块仍会显示缺口。这是刻意设计，不是漂移。
- `onboarding.finishBar.*` 文案按缺口而非退出路径组织，旧的按路径组织的文案已移除。
