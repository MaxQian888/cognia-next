# Cognia 现代化官网设计研究与方向建议

> 研究日期：2026-07-26  
> 目标：为 Cognia 新官网确定产品定位、信息架构、视觉方向和评审标准  
> 研究范围：12 个现代 AI、桌面生产力、Agent、开发者工具与产品系统官网  
> 证据原则：外部判断只引用品牌官网、官方产品页、官方文档和官方品牌指南；Cognia 判断以当前仓库实现为准

## 0. 先给结论

Cognia 不应该被包装成“又一个 AI 聊天客户端”，也不适合在首页平铺 Claude Code、插件、工作流、数字分身、IM、Computer Use、OCR、移动端等十几项能力。

推荐的官网定位是：

> **Cognia 是面向个人与团队的 AI 桌面工作空间。它把聊天、Agent、工作流和插件放进同一上下文，并让每一步行动可见、可控、可复用。**

推荐采用“桌面原生工作空间 + 透明 Agent 系统”的组合方向：

- 用“桌面工作空间”建立清晰类别和下载理由；
- 用“可见、可控、可复用”与纯聊天产品拉开差异；
- 用一条真实任务闭环证明 Agent 和 workflow，而不是播放逐字输出动画；
- 用本地上下文、权限、确认点和执行记录建立信任；
- 用插件、多模型、知识和跨端能力解释扩展性，但不让它们抢占首屏。

视觉上建议采用 **Precision Command Center**：

- 深墨黑和石墨灰作为基础；
- 骨白文字和表面层级保持高级、安静；
- 现有冷青色只作为“行动、连接、运行中”的信号色；
- Geist Sans + Geist Mono 延续产品本体；
- 真实产品界面、任务状态、workflow canvas 和工具调用是主视觉；
- 不使用紫蓝 AI 渐变、发光球、无意义粒子、假图表和卡片海。

这不是照抄 Linear 或 Raycast。要借的是它们“产品人格、信息结构和视觉语言一致”的方法。

---

## 1. Cognia 当前事实基线

正式设计前，官网文案必须服从产品事实。

### 1.1 产品是什么

根据 [README_zh.md](../../README_zh.md) 和 [DESIGN.md](../../DESIGN.md)，Cognia 当前是：

- 桌面优先的 Claude Code AI 客户端；
- 同一套 Next.js UI 交付浏览器、Tauri 桌面和 Capacitor 移动端；
- Rust 核心和 Node agent sidecar 支撑本地与原生能力；
- 扩展到插件运行时、可视化工作流、数字分身、IM 连接器、Computer Use、OCR 和跨端协同；
- 默认产品 UI 是安静、技术化、信息密集的中性色工作台。

### 1.2 官网必须解释的差异

访客需要在前两屏得到四个答案：

1. 为什么不是继续使用 Claude Code CLI 或普通聊天网页？
2. 为什么值得安装桌面应用？
3. Agent 能做什么，用户如何看见和控制它？
4. 聊天、工作流、插件和知识为什么属于同一个产品？

### 1.3 现阶段不能过度承诺

- 仓库明确标注当前处于重大重构期，官网不能使用“稳定、成熟、生产级”等未经验证的承诺；
- 没有可信用户数据前，不做虚构 logo wall、节省时间百分比或采用率；
- “本地优先”“隐私”“自托管”“跨平台”必须逐项写清适用范围，不能用一句口号覆盖不同运行时；
- 下载平台、系统要求、模型支持和功能可用性必须从发布流程实时生成或维护。

---

## 2. 研究方法

样本覆盖四类相邻产品：

- 通用 AI 工作空间：ChatGPT、Claude、Notion AI；
- 桌面与个人生产力：Raycast、Dia、Granola；
- Agent、自动化与开发平台：Cursor、n8n、Replit、Vercel；
- 高完成度产品系统：Linear、Figma。

统一观察六个维度：

1. **类别锚点**：访客能否在 5 秒内理解产品；
2. **消息架构**：主张、证据、信任和 CTA 的顺序；
3. **产品证明**：截图或 demo 是否展示真实行为；
4. **视觉与交互**：排版、色彩、动效是否服务认知；
5. **转化路径**：下载、注册、试用和销售如何分层；
6. **可迁移性**：能否解释 Cognia 的复合产品形态。

---

## 3. 标杆官网横向比较

| 官网                                           | 首屏类别主张                                 | 页面组织                                       | 视觉与交互特征                                | Cognia 应学习什么                                      |
| ---------------------------------------------- | -------------------------------------------- | ---------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| [ChatGPT](https://chatgpt.com/overview/)       | Chat、Work、Code 合在一处                    | 先按三类工作模式，再按交付结果扩展             | 大型场景化产品图，弱化模型参数                | 用少量动词压缩复杂能力，但 Cognia 需要更明确的类别名词 |
| [Claude](https://claude.com/)                  | Think fast, build faster                     | 首屏直接登录和下载，随后进入方案               | 极简、文案先行，转化入口前置                  | 安装足够简单时，让“开始使用”成为 hero 的组成部分       |
| [Notion AI](https://www.notion.com/product/ai) | 24/7 AI team                                 | Agents、Search、Meeting Notes、Admin 四个支柱  | 大量真实产品片段，用统一角色语言解释套件      | 用 3 到 4 个稳定支柱建立产品地图                       |
| [Cursor](https://cursor.com/)                  | Coding agent                                 | 任务 demo、Agent、跨工具、Automation、企业证据 | 展示任务状态、并行执行和 review，而非聊天气泡 | Cognia 必须展示计划、行动、确认和产物                  |
| [Linear](https://linear.app/)                  | Product development system                   | 原则、Intake、Plan、Build、Review、Insights    | 大留白、超大字、精密产品 UI、完整生命周期     | 用“系统”定位复杂产品，按用户旅程而非内部模块叙事       |
| [Raycast](https://www.raycast.com/)            | Shortcut to everything                       | 速度、键盘、原生、稳定、扩展、AI、自动化       | 红黑强识别、悬浮导航、按 OS 下载              | 明确桌面产品的安装理由和原生品质                       |
| [Dia](https://www.diabrowser.com/)             | 不让人厌烦的浏览器                           | 用一天中的场景串联能力，再讲隐私               | 真人、编辑感、幽默感和极少导航                | 能力之外还要表达使用后的情绪收益                       |
| [Granola](https://www.granola.ai/)             | AI notepad for meetings                      | 会前、会中、会后，隐私信息前置                 | 真实内容、清晰状态、人类与 AI 文本可区分      | 用“新类别 + 明确反差”迅速建立认知和信任                |
| [Replit](https://replit.com/)                  | What will you build?                         | 首屏 prompt，随后解释 Agent 和完整平台         | 官网直接成为产品入口，示例降低空白焦虑        | 可用安全体验 demo 替代纯视频                           |
| [n8n](https://n8n.io/)                         | Agents and workflows you can see and control | 角色用例、集成、可视与代码、调试、案例         | workflow canvas、逐步输入输出、重跑和日志     | 把“可控性”做成主卖点和产品界面                         |
| [Vercel](https://vercel.com/)                  | Agentic Infrastructure                       | Build agents、Ship apps、Host platforms        | 深色模块、技术结构和代码语言                  | 按用户交付对象拆平台，不按内部服务拆                   |
| [Figma](https://www.figma.com/)                | Intelligent canvas                           | Design、Build、AI-native shared canvas         | 作品和产品 UI 同时担任主角                    | 用“共享空间”统摄多个产品能力                           |

---

## 4. 关键样本详析

### 4.1 Linear：复杂产品先定义成“系统”

[Linear 首页](https://linear.app/) 首屏把自己定义成服务团队与 agents 的 product development system，后续不按按钮或数据表介绍功能，而按 Intake、Plan、Build 等生命周期展开。

最值得借鉴的不是黑色背景，而是：

- 一个明确类别词统摄大量功能；
- 三条产品原则先建立判断标准；
- 同一组真实产品对象贯穿整页；
- [Linear 品牌指南](https://linear.app/brand) 的留白和单色原则与官网、产品 UI 一致。

对 Cognia 的启示：先定义“AI desktop workspace”，再用 Ask、Create、Act、Remember 解释工作如何推进。

### 4.2 Cursor：证明 Agent 是任务系统，不是聊天框

[Cursor 首页](https://cursor.com/) 直接展示任务从进行中到待审阅的状态变化，并扩展到 Desktop、CLI、Slack、GitHub 和自动化。

对 Cognia 的启示：

- hero demo 应展示任务状态和可审阅结果；
- 用户输入、Agent 计划、工具调用、人工确认、结果产物要有清晰边界；
- 多入口和多工具应在核心闭环被证明后再展开。

### 4.3 Raycast：桌面安装必须有独特理由

[Raycast 首页](https://www.raycast.com/) 在首屏直接提供按操作系统下载，随后用 Fast、Keyboard First、Native 和稳定性证明桌面产品价值，再进入扩展生态与 AI。

对 Cognia 的启示：

- 下载按钮应识别操作系统；
- 首屏后立即证明本地上下文、快捷唤起、跨应用行动和原生体验；
- 插件数量不是核心卖点，关键是“不离开当前工作就完成什么”。

### 4.4 n8n：透明本身就是价值

[n8n 首页](https://n8n.io/) 使用 “see and control” 作为核心主张，产品视觉重点是 workflow、每步输入输出、测试、日志和重跑。

对 Cognia 的启示：

- 可视化工作流应成为首页标志性产品证据；
- 权限、确认点、失败、重试和 provenance 要可视化；
- “安全”不能只出现在页尾，而要在任务过程里被看见。

### 4.5 Granola：用明确反差建立新类别

[Granola 首页](https://www.granola.ai/) 用 “AI notepad” 建立熟悉类别，再用 “without a meeting bot” 表达差异。页面按会前、会中、会后叙事，并在 logo wall 前先解释隐私和兼容性。

对 Cognia 的启示：

- 可使用“不是另一个聊天标签页”作为反差；
- 人类输入、AI 补充和工具结果必须可区分；
- 先解释关键差异，再使用社会证明。

### 4.6 Notion AI：稳定支柱管理套件扩张

[Notion AI](https://www.notion.com/product/ai) 将大量能力稳定收敛为 Agents、Search、Meeting Notes 和 Admin controls，并在后续展开具体用例与安全。

对 Cognia 的启示：首页支柱建议固定为：

1. AI Chat；
2. Agents；
3. Visual Workflows；
4. Knowledge + Plugins。

其余能力应该归入支柱，不能成为同级导航。

---

## 5. Taste Skill 的引入与采用边界

本项目已引入：

- `gpt-taste`：面向 GPT/Codex 的版式、动效和 anti-slop 约束；
- `imagegen-frontend-web`：官网分章节视觉参考生成规范。

官方来源：

- [Taste Skill 官网](https://www.tasteskill.dev/)
- [Taste Skill 文档](https://www.tasteskill.dev/docs)
- [GitHub: Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)

### 5.1 本方案采用的规则

- hero 标题控制在两行以内；
- 首屏只保留一个明确主 CTA；
- 页面遵循 Attention、Interest、Desire、Action 的转化逻辑；
- 不连续重复居中区块或左文右图；
- 整站只使用一个主色系统、一个圆角系统和一致的图像处理；
- 每一屏有独立任务，构图和密度有节奏变化；
- 产品图使用真实连续故事，不使用无意义假 dashboard；
- 避免紫蓝 AI 渐变、发光球、卡片海、假 KPI 和空洞文案；
- 下一阶段每个官网章节单独生成一张横向设计参考图，避免一张长图压缩细节。

### 5.2 不机械采用的规则

`gpt-taste` 强调大幅 GSAP 动效和随机化构图，但 Cognia 官网最终仍需服从：

- 性能和静态导出约束；
- `prefers-reduced-motion`；
- 键盘、屏幕阅读器和移动端可访问性；
- 品牌连续性；
- 产品实际内容和转化目标。

动效只用于解释任务推进和上下文流动，不为了“看起来高级”而增加。

---

## 6. 推荐品牌与视觉方向

### 6.1 Design read

> **A quiet, precise desktop command center where human intent becomes visible, controllable agent work.**

中文解释：它应像一台安静而精密的工作仪器，不像科幻 AI 展台，也不像传统企业 SaaS。

### 6.2 概念主轴

选择 Taste Skill 的 **Tool / precision instrument** 作为叙事主轴：

- 对齐、刻度、连接线和状态点表达精密；
- 任务、工具、工作流和产物像同一台仪器的不同读数；
- 每个视觉元素都对应真实产品对象，不做纯装饰；
- “上下文线”贯穿聊天、Agent、workflow 和结果，形成记忆点。

### 6.3 色彩

| 角色      | 建议                                         | 用途                           |
| --------- | -------------------------------------------- | ------------------------------ |
| Primary   | Ink black / graphite                         | 页面背景、导航、主要产品舞台   |
| Secondary | Bone white / cool stone                      | 文本、浅色章节、呼吸区         |
| Accent    | Mineral cyan                                 | 运行中、连接、主 CTA、关键状态 |
| Signal    | 复用产品现有 success / warning / destructive | 真实任务状态，不作为装饰       |

约束：

- 矿物青使用面积应小于页面视觉面积的 10%；
- 不使用紫到蓝的 AI 渐变；
- 允许低色度 ink-to-graphite 光照和微噪点，但必须服务层次；
- 深浅章节可以变化，但不能像两套不同品牌。

### 6.4 字体与排版

- Display：Geist Sans，正常或中等字重，避免每一屏都超粗；
- Body：Geist Sans；
- Code / status / path：Geist Mono；
- hero 标题桌面端最多两行；
- 说明文案保持短句，不使用 “revolutionize”“next-gen”“seamless”等空洞词；
- 大标题用于类别和结果，小字号只用于真实状态、路径和来源。

### 6.5 图像与产品视觉

优先级：

1. 真实 Cognia 产品 UI；
2. 同一任务在聊天、Agent、workflow、产物之间流动的连续画面；
3. 经过构图的局部 UI crop 和任务状态；
4. 必要时使用抽象材质作为过渡。

不建议使用：

- 无关人物图库；
- AI 机器人形象；
- 大量模型 logo；
- 通用 3D 球体；
- 假终端和假数据图。

### 6.6 动效

只建议两套主要动效语言：

- **Pinned narrative**：滚动时固定任务主线，右侧依次出现计划、工具、确认和结果；
- **Cinematic fade-through**：产品层在 250 到 500ms 内切换，展示上下文连续性。

必须支持：

- `prefers-reduced-motion`；
- 暂停或手动切换；
- 无动效时仍能理解全部内容；
- 首屏 LCP 不依赖视频完成。

---

## 7. 推荐首页信息架构

建议使用 8 个章节。下一阶段如生成视觉参考，应严格输出 8 张独立横向画面，一章一张。

| 章节                  | 用户问题         | 内容                                                           | 推荐构图                                           | 参考                    |
| --------------------- | ---------------- | -------------------------------------------------------------- | -------------------------------------------------- | ----------------------- |
| 1. Hero               | 这是什么？       | 类别主张、结果副标题、下载、任务闭环起点                       | Top-left lead + 底部全宽产品舞台，不做普通左右分栏 | Linear、Cursor、Raycast |
| 2. Why Cognia         | 为什么要装？     | One workspace、Your models and tools、Visible and controllable | 三条横向原则，不做三个等宽卡片                     | Raycast、Granola        |
| 3. Work loop          | 它如何工作？     | Ask、Create、Act、Remember                                     | 固定任务主线 + 滚动状态变化                        | Linear、Granola         |
| 4. Signature workflow | Agent 是否可控？ | 计划、工具、输入输出、确认、失败、重试                         | workflow canvas 占主视觉                           | n8n、Cursor             |
| 5. Product pillars    | 产品范围多大？   | Chat、Agents、Workflows、Knowledge + Plugins                   | Hover accordion 或错位 editorial panels            | Notion AI、Figma        |
| 6. Local and trust    | 数据和权限呢？   | 本地/云边界、模型、权限、确认、撤销                            | 深浅反转的“权限剖面图”                             | Dia、Granola、n8n       |
| 7. Ecosystem          | 能连接什么？     | Models、MCP、plugins、IM、desktop/mobile                       | 用具体任务连接图，不做 logo ticker                 | Raycast、Vercel         |
| 8. Final CTA          | 下一步是什么？   | 按 OS 下载、GitHub、Docs                                       | Mini minimalist closing scene                      | Claude、Raycast         |

### 7.1 导航

建议：

```text
Product
Use cases
Plugins
Security
Docs
GitHub
Download
```

`Product` 下再展开 Chat、Agents、Workflows、Knowledge，不把 OCR、IM、Computer Use 等内部能力全部放到一级导航。

### 7.2 首屏产品 demo

建议使用一个 8 到 12 秒可理解的闭环：

1. 用户输入：“整理今天的会议，生成发布计划，并把行动项创建成任务。”
2. Cognia 展示将读取的上下文和计划。
3. Agent 进入 workflow，工具调用和权限状态可见。
4. 页面出现文档、任务和下一步。
5. 最终状态是“等待确认”或“已完成”，不是无限 loading。

这条故事可以同时证明聊天、Agent、workflow、连接器和产物，不需要五张互不相关截图。

---

## 8. 首屏文案方向

以下均为探索稿，需结合目标用户进一步验证。

### A. 推荐：统一工作空间

**One workspace for you and your agents.**  
Chat, automate, and finish real work across your models, tools, and apps.

中文：

**你和你的 Agents，共用一个工作空间。**  
连接模型、工具与应用，从对话到执行，把工作真正完成。

优点：能统摄完整产品；与纯聊天、纯工作流产品都有差异。  
风险：需要 demo 立即证明“一个工作空间”不是抽象口号。

### B. 桌面指挥中心

**Your AI desktop command center.**  
Run agents, build workflows, and stay in control of every action.

中文：

**你的 AI 桌面指挥中心。**  
运行 Agents、编排工作流，并掌控每一步行动。

优点：类别清晰，下载理由强。  
风险：对非技术用户可能偏硬，需要场景降低门槛。

### C. 从想法到完成

**From thought to finished work.**  
Cognia turns your intent into visible, reviewable action.

中文：

**从一个想法，到真正完成。**  
Cognia 把你的意图变成看得见、可审阅的行动。

优点：更有情绪和结果感。  
风险：类别识别较弱，必须在副标题中补充 desktop AI workspace。

---

## 9. 三个可评审视觉方向

### 方向 A：Precision Command Center

**推荐。**

- 深色精密仪器感；
- 产品 UI 是绝对主角；
- 矿物青只标记行动和连接；
- 任务时间线与上下文线成为识别符号；
- 适合技术用户，也能通过真实场景扩展到知识工作者。

参考组合：[Linear](https://linear.app/) 的系统感、[Raycast](https://www.raycast.com/) 的桌面人格、[n8n](https://n8n.io/) 的可控性。

### 方向 B：Quiet Intelligent Workspace

- 骨白和暖灰为主；
- 更像高端编辑工具或工作室；
- 产品界面以纸张、文档和轻量窗口层叠出现；
- 更友好、更宽泛，适合知识工作者。

参考组合：[Granola](https://www.granola.ai/) 的清晰人机边界、[Notion AI](https://www.notion.com/product/ai) 的产品支柱、[Cursor](https://cursor.com/) 当前浅色产品舞台。

风险：桌面指挥感和 Agent 差异可能变弱。

### 方向 C：Agent Activity Atlas

- workflow canvas 和行动轨迹成为品牌图形；
- 不同任务像地图节点和路线；
- 视觉更大胆、更具生成艺术气质；
- 适合强调 Agent 编排、数字分身和连接器。

参考组合：[Figma](https://www.figma.com/) 的共享画布、[Vercel](https://vercel.com/) 的技术结构、[Dia](https://www.diabrowser.com/) 的品牌人格。

风险：容易滑向科幻装饰，必须坚持每个节点对应真实产品对象。

---

## 10. 应避免的反模式

1. **“AI for everything” 没有类别名词**  
   Cognia 需要明确的 workspace 或 command center，不能只说万能。

2. **首屏六个同级 CTA**  
   主 CTA 只保留 Download Cognia；Watch it work、GitHub、Docs 依次降级。

3. **用抽象光效代替产品证明**  
   氛围不能替代任务状态、workflow 和结果。

4. **四个能力区各放一张无关联截图**  
   应使用同一任务和同一批对象贯穿全页。

5. **巨大的 integrations logo wall**  
   展示连接如何完成任务，而不是连接数量。

6. **只在页尾写 private and secure**  
   数据边界、权限和确认点应出现在产品流程里。

7. **照抄 Linear 的黑色或 Raycast 的红色**  
   学习品牌一致性，不复制表面审美。

8. **紫蓝 AI 渐变、发光球、玻璃卡片海**  
   这些已经成为生成式官网的默认噪声。

9. **假 KPI、假客户、假证言**  
   没有可信数据时，使用可验证产品事实、GitHub activity 和 changelog。

10. **为了动效牺牲速度和可访问性**  
    动效必须可降级，首屏内容和 CTA 不依赖动画。

---

## 11. 需要产品负责人拍板的五件事

### 决策 1：类别主张

- A. One workspace for you and your agents，推荐；
- B. Your AI desktop command center；
- C. From thought to finished work。

### 决策 2：首要用户

- A. 开发者和 AI power users，推荐作为第一阶段；
- B. 广泛知识工作者；
- C. 需要 Agent 治理的团队。

### 决策 3：视觉方向

- A. Precision Command Center，推荐；
- B. Quiet Intelligent Workspace；
- C. Agent Activity Atlas。

### 决策 4：首屏主 CTA

- A. Download Cognia，推荐；
- B. Try in browser；
- C. View on GitHub。

### 决策 5：首个真实 demo

- A. 会议到发布计划和任务，易理解；
- B. Issue 到代码变更和 review，最贴近 Claude Code；
- C. 多应用信息收集到自动化执行，最能体现平台性。

---

## 12. 建议的下一步

通过上述五项决策后，进入视觉评审：

1. 使用已引入的 `imagegen-frontend-web`；
2. 按第 7 节生成 8 张独立横向设计参考图，一章一张；
3. 同时生成推荐方向和一个对照方向，不同时做三套完整站；
4. 用真实 Cognia 截图替换视觉稿中的任何假 UI；
5. 审核后再进入 Next.js 实现；
6. 实现阶段验证桌面、移动、暗色、浅色、低动效和首屏性能。

建议先做：

- 方向 A：Precision Command Center；
- 文案 A：One workspace for you and your agents；
- demo B 或 A：Issue 到 review 更贴产品根基，会议到任务更易扩展用户。

---

## 13. 官方参考入口

### 通用 AI 工作空间

- [ChatGPT Overview](https://chatgpt.com/overview/)
- [Claude](https://claude.com/)
- [Notion AI](https://www.notion.com/product/ai)
- [Notion AI Security & Privacy](https://www.notion.com/help/notion-ai-security-practices)

### 桌面与个人生产力

- [Raycast](https://www.raycast.com/)
- [Raycast Manual](https://manual.raycast.com/)
- [Dia](https://www.diabrowser.com/)
- [Granola](https://www.granola.ai/)
- [Granola Product Announcement](https://www.granola.ai/blog/announcement)

### Agent、自动化与开发平台

- [Cursor](https://cursor.com/)
- [Cursor Brand Guidelines](https://cursor.com/en-US/brand)
- [Replit](https://replit.com/)
- [Replit AI](https://replit.com/ai)
- [n8n](https://n8n.io/)
- [Vercel](https://vercel.com/)
- [Vercel AI](https://vercel.com/ai)

### 产品系统与设计

- [Linear](https://linear.app/)
- [Linear Brand Guidelines](https://linear.app/brand)
- [Figma](https://www.figma.com/)

### 设计方法

- [Taste Skill](https://www.tasteskill.dev/)
- [Taste Skill Documentation](https://www.tasteskill.dev/docs)
- [Taste Skill GitHub Repository](https://github.com/Leonxlnx/taste-skill)

---

## 14. 最终建议

先不要开始写官网组件。

先确认：

1. 类别主张选 A、B 还是 C；
2. 核心用户先服务谁；
3. 视觉方向选 A、B 还是 C；
4. hero demo 用哪条真实用户路径；
5. 哪些产品事实可以公开承诺。

如果这五项没有锁定，越早写代码，后续返工越大。确认后再用 Taste Skill 的 image-first 流程出 8 张章节级视觉稿，会比直接生成一个完整网页更容易把关，也更容易保持设计一致性。
