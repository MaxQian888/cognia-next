# Cognia 官网 V2 设计方案

> 状态：方向已收敛，可进入页面设计与实现  
> 更新日期：2026-07-26  
> 研究依据：[V1 标杆研究](./cognia-official-website-design-research-2026-07-26.md) · [V2 开源 Agent 官网研究](./cognia-official-website-design-research-v2-2026-07-26.md)

## 1. 最终决策

### 1.1 产品类别

Cognia 官网统一使用：

> **Open AI agent workspace**

中文表达：

> **开放的 AI Agent 工作空间**

官网不再把 Cognia 描述为普通 AI Chat、单一 Claude Code GUI、纯 workflow builder，或泛化的 “AI for everything”。

### 1.2 品牌主张

首屏采用：

**Your open workspace for AI agents.**

副标题：

**Connect your models and tools. Plan, act, and review every step in one desktop workbench.**

中文版本：

**你的开放 AI Agent 工作空间。**

**连接自己的模型与工具，在一个桌面工作台中计划、执行并审阅每一步。**

### 1.3 核心差异

Cognia 官网只突出四个差异：

1. **One workspace**：Chat、Agents、Workflows、Knowledge、Plugins 共享工作上下文；
2. **Visible work**：计划、工具调用、审批、测试和产物有明确状态；
3. **Open system**：源码、模型、MCP、插件和运行边界可检查、可选择；
4. **Desktop control**：桌面原生工作台承载本地文件、工具权限和持续任务。

### 1.4 首要用户

第一阶段优先面向：

- 开发者；
- AI power users；
- 需要同时管理模型、Agent、文件与工具的个人用户；
- 希望把 Claude Code 类能力放进可视化桌面工作流的用户。

会议、研究、内容生产等通用场景进入 Use cases，不抢占首页主线。

### 1.5 转化目标

- 主 CTA：`Download Cognia`
- 次 CTA：`View source`
- 辅助入口：`Docs`

在发布系统能可靠识别平台后，主 CTA 再动态显示为 `Download for macOS`、`Download for Windows` 或 `Download for Linux`。

首页不同时出现 Start free、Try web、Book demo、Watch video、Join community 等同级入口。

---

## 2. V2 设计方向：Open Agent Workbench

### 2.1 Design read

> **An open workbench where human intent becomes visible, reviewable agent work.**

页面应像一张安静、开放、精密的桌面工作台：

- 阅读层是骨白纸面；
- 产品层延续 Cognia 真实浅色工作区；
- 执行、日志、diff 和权限进入石墨黑舞台；
- mineral cyan 只表示连接、运行与确认关系；
- warm amber 只表示等待人工审批；
- 每个视觉对象都对应真实产品结构。

### 2.2 与 V1 的差异

| V1                         | V2                                                              |
| -------------------------- | --------------------------------------------------------------- |
| 深色页面占主导             | Light workbench + dark execution stage                          |
| 产品 UI 更像概念 dashboard | 以当前 Cognia 左侧 rail、pane 和 workspace 结构为基础           |
| 每屏可能使用不同演示任务   | 全页只推进一条任务                                              |
| “开源”主要是文字承诺       | Source、license、release、permissions 和 data boundary 形成证据 |
| 偏 command center          | 更明确的 open workbench 与社区人格                              |
| 局部存在假数据和装饰状态   | 禁止假 stars、假客户、假 KPI 和不可维护数字                     |

### 2.3 设计随机化结果

根据 Taste Skill 的确定性选择：

```text
seed: 24
hero: Editorial Split
font: Geist
components: Vertical Rhythm Lines / Gapless Bento / Off-Grid Editorial
motion: Fade-through / Image Scale
```

补充第四个主构件：

- Product UI Panel Stack

### 2.4 唯一概念主轴

**Tool / precision instrument**

贯穿整页的视觉语言：

- 细规则线；
- 上下文来源线；
- 状态点；
- 工作区边界；
- permission checkpoint；
- task receipt；
- artifact output。

唯一的 second-read moment 是 **Provenance rail**：只在 Trust 章节出现一次，用一条窄边栏把 Source、Action、Permission、Result 串起来。其他章节不使用装饰性章节编号。

---

## 3. 视觉系统

### 3.1 色彩

| Token         | 建议值         | 用途                      |
| ------------- | -------------- | ------------------------- |
| `paper`       | `#F3F1EC`      | 页面主背景、阅读层        |
| `surface`     | `#FAF9F6`      | 浅色产品表面              |
| `ink`         | `#0C1115`      | 深色执行舞台、主文字      |
| `graphite`    | `#151B20`      | 日志、diff、workflow 表面 |
| `stone`       | `#8E959B`      | 次级文字、禁用状态        |
| `hairline`    | `#D7D8D5`      | 边界与技术规则线          |
| `action`      | `#35CEDD`      | 连接、运行、主交互        |
| `approval`    | `#D99A3D`      | 等待人工批准              |
| `success`     | 复用产品 token | 真实成功状态              |
| `destructive` | 复用产品 token | 真实失败与风险状态        |

约束：

- cyan 占单屏视觉面积不超过 5%；
- amber 不能用作普通品牌色；
- 不使用紫蓝 AI 渐变；
- 允许低色度纸张纹理、ink-to-graphite 明度变化；
- 深浅章节共享同一套 token，不切换成第二套品牌。

### 3.2 字体

- Display / Body：Geist Sans；
- Status / Path / Code：Geist Mono；
- Hero H1 桌面端最多两行；
- 页面标题使用 normal 或 medium，不连续使用 ultra bold；
- 只在真实状态、路径、命令和 provenance 中使用等宽字体。

### 3.3 圆角与边界

- 普通控件：8px；
- 产品主面板：12px；
- 大型舞台：14px；
- CTA 不使用超大 pill；
- 产品面板以边界、层级和裁切建立深度，避免大面积悬浮阴影。

### 3.4 图像与产品视觉

优先级：

1. 真实 Cognia UI；
2. 基于真实 UI 录制的状态 demo；
3. 真实界面的局部 crop；
4. 仓库、diff、workflow、permission 和 artifact 视觉；
5. 仅在章节转场使用克制材质。

停止使用现有的紫蓝色通用 3D workspace 插画作为官网 hero。它可保留在旧内容或产品引导中，但不属于 V2 官网视觉主线。

---

## 4. 首页信息架构

首页保持 8 个章节。

### 4.1 Hero — 5 秒理解 Cognia

**用户问题：** 这是什么，下一步做什么？

内容：

- `Open-source AI workspace`
- `Your open workspace for AI agents.`
- 一句结果型副标题；
- `Download Cognia`
- `View source`
- 首屏内出现真实 Cognia 工作区；
- 静态 trust rail：
  - Open source
  - Bring your models
  - Permissioned actions
  - Desktop first

构图：

- Editorial Split；
- 上半屏为骨白品牌层；
- 下半屏为接近全宽的产品舞台；
- 不使用经典左文右图；
- trust rail 是结构化索引，不使用胶囊 badge。

当前设计稿：

[查看 Hero V2](./assets/cognia-website-v2/01-hero-v2.png)

### 4.2 One task, end to end — 证明 Agent 是工作系统

**用户问题：** Agent 到底如何工作，我能控制吗？

标题：

**One task. Every step visible.**

副标题：

**Plan, tools, approvals, tests, and artifacts stay in one reviewable thread.**

全页 signature task：

> Review this release, fix the failing check, and prepare the launch notes.

状态：

```text
Context ready
Plan approved
Check fixed
Permission required
Tests pending
Notes pending
```

关键界面：

- repository context；
- project instructions；
- plan；
- code / document diff；
- permission checkpoint；
- tests；
- release notes artifact。

当前设计稿：

[查看 Signature Demo V2](./assets/cognia-website-v2/03-signature-demo-v2.png)

### 4.3 Your workbench — 解释为什么是一个产品

**用户问题：** Chat、Agents、Workflows、Knowledge 和 Plugins 为什么属于同一个空间？

标题：

**Everything the task needs, in one workbench.**

采用无缝 Bento，不做五张独立功能卡：

- 主区域：Agent task；
- 左侧：Chat 与上下文；
- 下方：Artifact；
- 右侧：Workflow；
- 边缘：Knowledge + Plugins；
- 同一条 cyan context path 穿过所有区域。

所有面板必须使用同一个 signature task，不能切换成另一个市场分析或会议任务。

### 4.4 Desktop first — 解释安装价值

**用户问题：** 为什么要安装桌面应用？

标题：

**A workspace that stays close to the work.**

只展示已经存在的桌面能力：

- 文件与项目工作区；
- 集成终端与编辑器；
- 系统级快捷入口；
- 长任务和通知；
- 需要确认的本地操作。

构图：

- 大面积浅色负空间；
- 一个 Cognia shell macro crop；
- 一个 command palette / notification / terminal 的连续状态；
- 不放设备模型，不使用悬浮 MacBook。

### 4.5 Run it your way — 解释模型与运行边界

**用户问题：** 能使用什么模型，数据会到哪里？

标题：

**Choose the model. See the boundary.**

采用运行策略矩阵，而不是模型 logo 墙：

| Strategy           | 官网解释                         |
| ------------------ | -------------------------------- |
| Local              | 在设备或用户控制的本地服务中运行 |
| Bring your own key | 用户选择 provider 与凭据         |
| Hosted             | 仅在产品真实支持时显示           |
| Fallback           | 展示模型切换与失败回退策略       |

每个策略必须链接到版本化文档，明确：

- 哪些内容离开设备；
- 哪个 provider 接收；
- 哪些工具会被调用；
- 哪些动作需要确认。

禁止把 local、offline、self-hosted 和 private 当作同义词。

### 4.6 Connections with consequences — 解释生态价值

**用户问题：** 可以连接什么，连接后能做什么？

标题：

**Connect tools without losing the task.**

首页只展示四个任务级连接：

1. Repository：读取代码与 issue；
2. MCP tool：执行受控工具调用；
3. Plugin：生成或更新 artifact；
4. IM / notification：请求人工审批。

每个连接回答：

- Reads；
- Can act；
- Requires approval。

不使用滚动 logo ticker。完整 provider、MCP、plugin 和 connector 进入独立目录页。

### 4.7 Trust receipts + Built in the open — 把信任变成证据

**用户问题：** 为什么可以相信它，如何核验？

标题：

**Built in the open. Controlled in use.**

采用 2×2 无缝 Bento：

- Source：仓库与 AGPL-3.0-or-later；
- Data：local / external model 数据边界；
- Permission：工具权限与确认点；
- Record：行动记录、结果与可用的恢复路径。

底部提供：

- Source code；
- License；
- Release history；
- Contributing；
- Security；
- Changelog。

不写死 stars、contributors、downloads 或 release 数量。动态数字必须来自 GitHub API 或发布 manifest，并显示更新时间。

当前开源视觉探索：

[查看 Open-source Proof V2](./assets/cognia-website-v2/02-open-source-proof-v2.png)

### 4.8 Final CTA + Footer — 单一明确收口

标题：

**Bring your agents into one open workspace.**

CTA：

- `Download Cognia`
- `View source`
- `Read the docs`

支持文案：

**Desktop first. Open source. Built for real work.**

Footer 是可核验索引：

```text
Product
  Chat
  Agents
  Workflows
  Knowledge
  Plugins

Project
  Source
  License
  Releases
  Changelog
  Contributing

Resources
  Docs
  Trust
  Security
  Roadmap
  Community
```

未真实公开的 Roadmap、Status 或 Community 不上线空链接。

---

## 5. 导航

一级导航：

```text
Product · Workflows · Plugins · Trust · Docs · GitHub · Download
```

规则：

- Product 下收纳 Chat、Agents、Knowledge；
- OCR、Computer Use、IM、Digital Twin 等能力进入产品子页或 Use cases；
- Download 始终保持主 CTA；
- 桌面宽度不足时优先收起 Product、Workflows、Plugins；
- Docs、GitHub 和 Download 保持可达；
- 移动端使用全屏 sheet，不使用横向挤压导航。

---

## 6. 动效方案

整站只使用两套主运动语言。

### 6.1 Cinematic fade-through

用于：

- hero 任务状态；
- signature demo 状态替换；
- workbench 面板切换。

规则：

- 250–400ms；
- 状态变化必须伴随真实内容变化；
- 不使用无限循环 typing；
- hero 在 `Waiting for approval` 停止，等待用户理解。

### 6.2 Image scale

用于：

- 大型产品截图进入视口；
- repository、workflow、diff 的 macro crop；
- scale 从 0.96 到 1；
- 同时保持清晰边界，不添加强视差。

### 6.3 Sticky task rail

Signature demo 在桌面端固定任务标题与状态线，右侧依次切换：

```text
Context → Plan → Action → Approval → Test → Artifact
```

Reduced motion：

- 禁止 pin、scrub 和自动播放；
- 改为静态 stepper；
- 所有状态一次性可见；
- 不影响内容顺序与 CTA。

---

## 7. 响应式规则

### Desktop

- 最大内容宽度：1440–1520px；
- hero H1 最大两行；
- 产品舞台可超出版心，但不能造成横向滚动；
- 每个 major section 使用 128–192px 垂直间距。

### Tablet

- Hero 上下堆叠；
- 产品工作区保留主内容和一条侧栏；
- signature rail 转为顶部 stepper；
- Bento 从 12 列降为 6 列。

### Mobile

- 每屏只保留一个主要视觉；
- 产品截图使用裁切后的关键状态，不缩小完整桌面 UI；
- 主 CTA sticky 到底部仅用于下载页，不用于整个首页；
- trust rail 改为两行索引；
- integrations 改为四个纵向 task receipts；
- footer 使用 accordion。

---

## 8. 可访问性与性能

### 可访问性

- 所有状态不能只靠颜色；
- approval、success、error 同时提供图标和文字；
- 动效支持 `prefers-reduced-motion`；
- 产品 demo 提供暂停、上一步和下一步；
- 所有交互支持键盘；
- 截图与视频必须有等价文字说明；
- CTA、导航和正文满足 WCAG AA 对比度。

### 性能

- 首屏 H1、CTA 和第一帧产品 UI 不依赖视频加载；
- hero 默认使用静态 poster，交互 demo 延迟加载；
- 避免首屏 WebGL；
- 产品截图使用 AVIF / WebP；
- 字体仅预加载必要字重；
- 动画只改变 transform 与 opacity；
- 移动端不加载桌面端完整 demo 视频。

---

## 9. 内容与事实治理

每条官网承诺必须绑定真实来源。

| 内容                       | 数据源                             |
| -------------------------- | ---------------------------------- |
| License                    | 仓库 `LICENSE`                     |
| Latest release             | GitHub Releases / release manifest |
| Supported OS               | 发布产物 manifest                  |
| Provider support           | 产品 provider registry             |
| Plugins / MCP              | 实际 registry                      |
| Permission behavior        | capability matrix 与实现文档       |
| Local / external data flow | 版本化 architecture / privacy 文档 |
| Contributors / stars       | GitHub API，带缓存和更新时间       |

上线前禁止：

- production-ready；
- enterprise-grade；
- fully private；
- everything stays local；
- unlimited；
- fake KPI；
- fake testimonials；
- 手写长期不更新的生态数量。

---

## 10. 页面与内容扩展

首页之后优先建设：

1. `/product`
2. `/workflows`
3. `/plugins`
4. `/trust`
5. `/download`
6. `/use-cases/development`
7. `/use-cases/research`
8. `/changelog`

优先级理由：

- Product 解释整体系统；
- Workflows 承接核心差异；
- Plugins 形成生态入口；
- Trust 支撑开放与权限主张；
- Download 完成按平台转化。

---

## 11. 实施顺序

### Phase 1 — Signature asset

- 用真实 Cognia 环境录制 signature task；
- 准备 hero poster；
- 准备 Context、Plan、Approval、Test、Artifact 五个状态；
- 清除概念稿中的假路径、假 diff 和演示占位内容。

### Phase 2 — Static homepage

- Navigation；
- Hero；
- 8 个章节静态布局；
- Footer；
- 响应式；
- i18n；
- SEO 与 Open Graph。

### Phase 3 — Motion

- hero fade-through；
- sticky task rail；
- product image scale；
- reduced-motion fallback；
- 性能预算验证。

### Phase 4 — Evidence

- GitHub release 数据；
- license 与 source 链接；
- provider / plugin registry；
- Trust receipts；
- 下载平台识别。

### Phase 5 — Quality

- Desktop / tablet / mobile visual QA；
- 键盘与屏幕阅读器；
- Lighthouse；
- 静态导出；
- Tauri / browser 链接验证；
- 文案事实审计。

---

## 12. 当前设计稿状态

| 设计稿               | 状态         | 说明                                                     |
| -------------------- | ------------ | -------------------------------------------------------- |
| Hero V2              | 已完成方向稿 | 使用真实 Cognia shell 结构，正式实现需替换为真实任务录制 |
| Signature Demo V2    | 已完成方向稿 | 已确立 sticky task rail、diff 和 approval checkpoint     |
| Open-source Proof V2 | 已完成方向稿 | 已确立 repository + license + proof index                |
| Workbench            | 方案已锁定   | 待基于真实产品 UI 出稿                                   |
| Desktop first        | 方案已锁定   | 待基于 shell、terminal、notification 出稿                |
| Run it your way      | 方案已锁定   | 待核验 provider 与运行能力后出稿                         |
| Connections          | 方案已锁定   | 待选定四个真实连接案例                                   |
| Final CTA            | 方案已锁定   | 待与 download 页面能力同步                               |

这些图片是视觉方向稿，不应直接作为官网截图上线。正式页面必须替换为真实 Cognia 界面或真实界面录制。

---

## 13. 参考官网

核心参考：

- [Warp](https://www.warp.dev/)
- [OpenCode](https://opencode.ai/)
- [Cline](https://cline.bot/)
- [OpenHands](https://www.openhands.dev/)
- [Dify](https://dify.ai/)
- [Langflow](https://www.langflow.org/)
- [Flowise](https://flowiseai.com/)
- [Open WebUI](https://openwebui.com/)
- [AnythingLLM](https://anythingllm.com/)
- [Jan](https://www.jan.ai/)
- [LM Studio](https://lmstudio.ai/)
- [Zed](https://zed.dev/)
- [Devin Desktop](https://devin.ai/desktop)
- [GitHub Copilot](https://github.com/features/copilot)
- [Linear](https://linear.app/)
- [Raycast](https://www.raycast.com/)
- [Cursor](https://cursor.com/)
- [n8n](https://n8n.io/)

设计借鉴只限于信息结构、产品证明、转化路径和设计纪律，不复制具体品牌色、插画、组件外观或文案。
