---
title: "0139 — 可视化输出路由"
description: "五种画图方式、一张常驻的决策表，以及第一次被写下来、模型能读到的图表数据契约。"
---

# ADR 0139 — 可视化输出路由

**状态：** 已接受
**日期：** 2026-08-21

## 背景

Cognia 有五种画图方式：

| 通道 | 渲染位置 | 是否"活的" |
| --- | --- | --- |
| `mermaid` 围栏 | 消息内行内 | 否 |
| chart artifact | artifact dock（Recharts） | **是** —— 跟随主题、可悬停、有版本、可导出、可重绑数据 |
| A2UI 面 | 行内，并投影到 IM | **是** —— 带回调 |
| canvas 文档 | `/canvas/<id>`，行内预览 | **是** —— 可编辑 |
| `diagram-design` skill | 自包含 HTML + 内联 SVG artifact | 否 |

没有任何东西告诉模型这五者的差别，由此产生两个缺口。

**图表的数据契约从未被写下来。** `components/artifacts/chart-renderer.tsx` 早就
能画七种图形。它的数据契约由三处分别强制执行，而每一条被违反时都是**静默失败**：

- artifact 检测器同时依赖 `json` 围栏**和**一个行数下限，所以单行 JSON 永远不会被
  提升进 dock —— 用户在转录里看到的是裸 JSON；
- 渲染器**只从 `data[0]`** 推导系列列表，所以第一次出现在第二行的系列根本不会被画；
- `scatter` 读的是 `x`/`y`，而不是 `name` 加系列；
- 配色属于渲染器，所以手挑的十六进制在一个主题下好看、在另一个主题下看不见。

这些都不可能被猜出来，于是实际发生的是：模型转而手绘 SVG —— 一张图表的图片，而不
是一张图表。

**五者之间没有任何路由。** 观察到的失败正如所料：往没有 dock 的 IM 线程里发 chart
artifact；在读者本该做选择的地方给一张静态图；趋势才是重点时给了 markdown 表格；
为三个数字画一张图。

## 决定

### 契约放进 skill，路由写进系统提示

两个不同的问题，两个不同的归属。

**"具体怎么产出一张图表？"** 篇幅长、只在已经决定要画时才有意义、在那之前不该花任
何代价。这就是新的内置 skill `chart-design`（`skills/built-in/chart-design/SKILL.md`）：
JSON 契约、选型表、可读性护栏（饼图超过约 6 片、不存在多系列饼图、雷达图需要可比
量纲），以及"图表本身就是错答案"的那些情形。

**"这件事应该是五者中的哪一个？"** 必须在模型知道有某个 skill 之前就被回答，而
skill 只有在有人想到去加载时才会被读到。所以路由是常驻的：
`lib/ai/prompts/visual-output-prompts.ts` 里的 `buildVisualOutputSection`，在每次发
送时与 A2UI 提示、连接器能力段落并列追加到 `appendSystemPrompt`。它刻意只是一张决
策表——它向每一轮收费，所以必须靠"短"来挣回预算（它自己的测试钉住了这个上限）。

### 路由按通道裁剪

`artifacts: !session?.platformBinding?.adapterId`。绑定 IM 的会话没有 artifact
dock，因此那一支撤下图表与 canvas 选项**并说明原因**，而不是悄悄略过——一个仍然发
了的模型应当知道读者拿到的是裸 JSON。`a2ui` 复用 A2UI 提示块已经解析出的那个标志。

这与连接器能力段落（ADR-0026 §G6）对 A2UI kind 所做的事同构：把这个通道真正能渲染
什么告诉模型，而不是让它通过读者来发现答案。

### 播种不需要版本号

`lib/db/skills.ts` 在每次启动时 `put` 每一条目录条目并保留用户覆盖，所以
`chart-design` 会在下一次启动时到达既有安装。

## 后果

- 每一轮多带约 150 token 的路由。接受：它避免的那个失败要付出的是一整条回复。
- 图表契约现在有了唯一的书面归属。如果 `chart-renderer.tsx` 改了解析方式，skill 与
  它的契约测试必须同步改——那个测试断言的是具体条款（`first row only`、
  `at least three lines`、`Do not specify colours`），而不是"文件非空"。
- 手绘 SVG 图表依然可行，但在 dock 可用的地方现在被明确劝阻。
- 长尾：`jupyter` 与插件注册的渲染器不在路由表里。它们是被刻意抵达的（一个 notebook、
  一个插件自己的输出），而不是从菜单里挑的，加进去只会花预算而不产生任何决策。

## 参考

- ADR-0026 —— 市场集成、内置 skill 清单、连接器能力提示
- ADR-0138 —— 阅读区布局稳定（渲染工作的另一半）
- `skills/built-in/chart-design/SKILL.md`、
  `lib/ai/prompts/visual-output-prompts.ts`、
  `components/artifacts/chart-renderer.tsx`、
  `lib/ai/generation/artifact-detector.ts`
