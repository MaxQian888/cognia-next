# Cognia 官网动效与版式工艺研究

> 状态：结论可用于实现
> 日期：2026-08-01
> 上游：[V2 设计方案](./cognia-official-website-v2-design-spec-2026-07-26.md) · [V1 标杆研究](./cognia-official-website-design-research-2026-07-26.md) · [V2 开源 Agent 官网研究](./cognia-official-website-design-research-v2-2026-07-26.md)
> 方法：在真实浏览器（Chromium 148）里对每个站点运行同一个 DOM 探针，读取顶层章节的**实测高度、实测 padding、标题字号字重**，以及动效驱动方式。不是看截图目测。

前两份研究的轴是**信息架构与定位**。这一份只回答三个执行层问题：

1. 章节纵向节奏怎么建立疏密？
2. 描线 / 扫线 / 阶梯揭示怎么编排？
3. second-read moment 怎么构造？

外加一个必须先关掉的技术问题：`web/components/hairline.tsx` 里拒绝 `animation-timeline: view()` 的两条理由，今天是否仍然成立。

---

## 1. 实测数据

探针：从 `<main>` 向下穿过单子节点包装层，取第一个多子节点容器，测其每个高度 >60px 的直接子元素。视口统一 **1512×900**。

### 1.1 Cognia 官网现状（localhost:3002，8 个首页章节）

| #   | id            | 高度 | padding 上/下 | 章节标题         |
| --- | ------------- | ---- | ------------- | ---------------- |
| 0   | `hero`        | 1393 | 0 / 0         | H1 **72px w500** |
| 1   | `task`        | 1026 | **160 / 160** | 48px w500        |
| 2   | `workbench`   | 1223 | **160 / 160** | 48px w500        |
| 3   | `desktop`     | 1158 | **160 / 160** | 48px w500        |
| 4   | `run`         | 1422 | **160 / 160** | 48px w500        |
| 5   | `connections` | 997  | **160 / 160** | 48px w500        |
| 6   | `trust`       | 1215 | **160 / 160** | 48px w500        |
| 7   | `start`       | 764  | **160 / 160** | 48px w500        |

**高度极差比 = 1422 / 764 = 1.86×**。七个正文章节的 padding **完全相同**，标题字号字重**完全相同**（48px w500，行高 60px）。

### 1.2 四个参考站

| 站点        | 章节高度序列                                                                   | 极差比    | padding 策略                          | Hero → 章节标题                     |
| ----------- | ------------------------------------------------------------------------------ | --------- | ------------------------------------- | ----------------------------------- |
| **Linear**  | 1027 · 132 · 360 · 1223 · 1215 · 1171 · 1089 · 1194 · 417 · 564 · 172          | **9.27×** | 五个正文章节 128/128，其余全 0        | 64px w510 → 48px w510（**0.75**）   |
| **Zed**     | 448 · 868 · 728 · 1115 · 450 · 567 · 755 · 809 · 587 · 579 · 450               | **2.49×** | **全部 0**，间距全在内部              | 48px w340 → 25.6px w390（**0.53**） |
| **Raycast** | 672 · 1487 · 969 · 1365 · 2310 · 1192 · 1857 · 1463 · 1622 · 3636 · 867 · 2656 | **5.41×** | 168/168 与 0 **交替**，另有一个 0/224 | 36px w600 → 18px w500（**0.50**）   |
| **Warp**    | 1450 · 878 · 3989 · 1022 · 664 · 540                                           | **7.39×** | 全部 0                                | 40px w400 → 28px w400（**0.70**）   |
| **Cognia**  | 1393 · 1026 · 1223 · 1158 · 1422 · 997 · 1215 · 764                            | **1.86×** | 全部 160/160                          | 72px w500 → 48px w500（**0.67**）   |

---

## 2. 结论：「节奏平」的真实成因

### 2.1 不是标题字号

Cognia 的 hero→章节比是 **0.67**，落在四个参考站的 0.50–0.75 区间正中。**这条不用改。**

### 2.2 也不是「章节标题应该各不相同」

四个站**全部**对所有正文章节使用同一个标题字号字重（Linear 48/w510、Zed 25.6/w390、Raycast 18/w500、Warp 28/w400）。统一章节标题是常态，不是缺陷。**这条也不用改。**

### 2.3 真正的成因，以及 Linear 给出的反直觉证据

Linear 的**五个正文章节高度是 1027–1223，极差比仅 1.19×——比 Cognia 的 1.86× 还要均匀**。但 Linear 的页面完全不平。差别在于它在这五个高章节的前后插入了：

- 一个 **132px** 的独立陈述句 `<h2>`；
- 一个 **360px** 的 benefits 紧凑条；
- 一个 **417px** 的 Changelog 块；
- 一个 **172px** 的 prefooter。

**节奏不是来自正文章节之间的差异，而是来自插在它们中间的短块。** 一个 132px 的块夹在两个 1200px 的块之间，读者才感觉到「换气」。

Raycast 用另一条路径达到同一效果：**padding 在 168 和 0 之间交替**，而不是在 128/160/192 之间做三档缩放。Zed 和 Warp 则把 padding 全设为 0，让内容体量自己说话（高度极差 2.49× / 7.39×）。

Cognia 现在是**唯一一个所有正文章节 padding 完全相同的站**，且没有任何短块。1.86× 的极差比又恰好落在「不够均匀到像刻意的网格，也不够悬殊到有节奏」的中间地带。

### 2.4 对实现的直接影响

原方案里 `Section` 的 `density: tight | normal | open` 三档缩放是**必要但不充分**的。按实测证据，优先级应调整为：

1. **引入短插入块（最高杠杆）**——在 8 个高章节之间插入 120–400px 的短块：一句独立陈述、一条紧凑索引条、一个数据行。这是 Linear 的机制，也是 Cognia 完全缺失的机制。
2. **padding 走交替而非三档缩放**——Raycast 的 168↔0 模式比 128/160/192 的等差缩放对比度高得多。`tight` 应该敢于取 0，让相邻章节靠内容边界而非空白分隔。
3. **章节标题字号不动**——四站一致证明统一是对的。

---

## 3. 动效驱动方式：四站零 scroll-driven CSS

| 站点       | `animation-timeline` 元素数 | GSAP | Lenis | `html scroll-behavior` | canvas / video            |
| ---------- | --------------------------- | ---- | ----- | ---------------------- | ------------------------- |
| Linear     | **0**                       | 否   | 否    | `auto`                 | 未测                      |
| Zed        | **0**                       | 否   | 否    | `auto`                 | 0 / 0                     |
| Raycast    | **0**                       | 否   | 否    | `auto`                 | **1 canvas（WebGL）** / 0 |
| Warp       | **0**                       | 否   | 否    | `auto`                 | 0 / **1 video**           |
| **Cognia** | 0                           | 否   | 否    | **`smooth`**           | 0 / 0                     |

三条发现：

1. **没有一个站使用 scroll-driven CSS animations**，尽管 Chrome/Edge 135+ 与 Safari 26+ 已全量支持。
2. **没有一个站使用 GSAP 或 Lenis**。「高级动效必须上动画库」是错觉。
3. **四个站的 `scroll-behavior` 全是 `auto`**，只有 Cognia 开了 `smooth`（`web/app/globals.css:111`）。

   **更正**：本研究初稿断言「它不受 `prefers-reduced-motion` 安全带约束」——这是**错的**。`globals.css:124-136` 的安全带显式覆盖了它，`html` 与 `*` 两处都设 `scroll-behavior: auto`（第 123 行还有注释说明这是「双保险」）。无障碍上没有缺口。

   剩下的差异纯属取向：长页面上的锚点跳转会有数百毫秒的滑行，四个参考站都选择不要。**不构成必须修改的理由**，列在这里只作为取向参考。

Raycast 是唯一上 WebGL 的（1 个 canvas），这与「首屏之外一个克制的 Canvas 时刻」的定位一致——不是满屏 shader，是一个受控构件。

---

## 4. `animation-timeline: view()` 复审

`web/components/hairline.tsx` 记录了两条拒绝理由。逐条核验：

### 4.1 理由一：Chrome 147 的 `ViewTimeline.currentTime` 恒为 null —— **未能复验，按存疑处理**

Chrome 147 发布于 2026-04-07，当前稳定版已是 Chrome 151（2026-07-28），相隔四个版本。

本次在 Chromium 148 引擎内做了实测：`CSS.supports("animation-timeline","view()")` 返回 `true`，`ViewTimeline` 实例被创建，但 `timeline.currentTime` 为 `null` 且目标 transform 未应用——症状与记录一致。

**但这次复现不可采信**：测试运行在隐藏的浏览器面板中（`document.visibilityState === "hidden"`），`requestAnimationFrame` 被节流，滚动驱动时间线本就无法推进。同一环境下，站内现有的 `motion/react` 入场动画也被冻结在 `opacity: 0.174` 的中途状态——这同样是节流假象，不是缺陷。

**结论：这条理由既未被证实，也未被推翻。不应作为决策依据。**

### 4.2 理由二：scroll-driven 动画逃出 `globals.css` 的 reduced-motion 安全带 —— **成立，且是结构性的**

`web/app/globals.css` 的安全带是：

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

它压的是 `animation-duration`。而 scroll-driven 动画的进度由 `animation-range` 决定，**必须声明 `animation-duration: auto`**（默认的 `0s` 会让它完全不可见）。把 `auto` 覆写成 `0.01ms` 既不是「停在终态」，也不是「正常播放」，而是一个未定义的中间行为。

换言之：**一条基于 `view()` 的 Draw 会绕过全站唯一的动效安全带**，必须自带 `@media (prefers-reduced-motion: reduce)` 守卫。而这恰恰就是现有 `useReducedMotion()` 实现已经在做的事——换成 CSS 反而要多写一层守卫。

### 4.3 新增理由三：Firefox stable 不支持 —— **决定性**

- Chrome / Edge：135+ 全量支持
- Safari：26 起支持（26.4 加入线程化，26.5 修 bug）
- **Firefox stable：仍在 `layout.css.scroll-driven-animations.enabled` flag 之后**
- caniuse 全球支持率约 **82.6%**（2026-06），**未达 Baseline**

`Hairline` 的动画是 `scaleX: 0 → 1`。在不支持的浏览器里，若无 `@supports` 守卫，起始关键帧不生效、终止关键帧也不生效——但如果按 CSS 写法把 `transform: scaleX(0)` 作为元素基础样式，**Firefox 用户看到的是一条根本不存在的线**。要避免这点就必须写 `@supports (animation-timeline: view())` 分支 + 一份 fallback，等于两套实现都要维护。

### 4.4 裁决

**维持 `motion/react` 实现，不改用 `animation-timeline: view()`。**

理由二与理由三各自独立成立且足够。理由一（Chrome bug）应在 `hairline.tsx` 的注释里**改写为「未复验」**，不要继续把一条未经证实的浏览器缺陷当作架构依据——那是技术债，不是文档。

---

## 5. 可执行清单

给批次 ②③ 的具体输入：

| #   | 动作                                                                                                                   | 依据                 |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | 在 8 个高章节之间引入 120–400px 短插入块（陈述句 / 索引条 / 数据行）                                                   | §2.3 Linear 机制     |
| 2   | `Section` 的 `density` 走**交替**（含敢取 0），而非等差三档                                                            | §2.3 Raycast 机制    |
| 3   | **不改**章节标题字号字重（48px w500 保持）                                                                             | §2.1 §2.2 四站一致   |
| 4   | ~~收窄 `scroll-behavior: smooth`~~ **不改**：安全带已覆盖它，无障碍无缺口；四站用 `auto` 只是取向差异                  | §3（含更正）         |
| 5   | `Hairline` 维持 `motion/react`；把注释里的 Chrome 147 断言改写为「未复验」，并补上 Firefox stable 与安全带两条真实理由 | §4.4                 |
| 6   | Provenance rail 的 Canvas 时刻定位为「一个受控构件」，非满屏效果                                                       | §3 Raycast 单 canvas |

---

## 6. 方法与局限

- 探针在 Chromium 148 引擎、视口 1512×900 下运行；每站一次采样，未做多次或多视口复测。
- **未能取得可用截图**：浏览器面板处于隐藏状态，滚动后的内容不参与合成，且 rAF 节流使入场动画冻结在中途。本研究的全部结论来自 DOM 实测数值，不含目测。
- Linear 的 canvas / video 数量未采集。
- 四个参考站均为单次快照，站点随时可能改版。
- 借鉴范围严格遵循 V2 方案 §13：只取信息结构、节奏机制与设计纪律，不复制品牌色、插画、组件外观或文案。

## 参考来源

- [WebKit — A guide to Scroll-driven Animations with just CSS](https://webkit.org/blog/17101/a-guide-to-scroll-driven-animations-with-just-css/)
- [MDN — `animation-timeline`](https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline)
- [MDN — `AnimationTimeline.currentTime`](https://developer.mozilla.org/en-US/docs/Web/API/AnimationTimeline/currentTime)
- [Chrome for Developers — Chrome 147 release notes](https://developer.chrome.com/release-notes/147)
- [Chrome Releases 2026](https://chromereleases.googleblog.com/2026/)
- [Josh W. Comeau — Scroll-Driven Animations](https://www.joshwcomeau.com/animation/scroll-driven-animations/)
- 实测站点：[Linear](https://linear.app) · [Zed](https://zed.dev) · [Raycast](https://www.raycast.com) · [Warp](https://www.warp.dev)
