# Cognia 官网设计研究 V2：开源 Agent 产品的可信转化

> 研究日期 / 页面访问日期：2026-07-26  
> 目标：补充第一版研究未覆盖的开源 Agent、可视化 AI 平台、本地 AI 工作空间与多 Agent 开发环境，形成可直接进入官网设计的 V2 建议  
> 来源纪律：只使用品牌官网、官方产品页及官方 GitHub 入口；不引用评测、设计画廊、博客转载或第三方统计  
> 与 V1 的关系：已先阅读 [第一版研究](./cognia-official-website-design-research-2026-07-26.md)。本次 14 个样本与 V1 的 12 个核心样本不重复，重点补齐“开源如何成为产品证据”和“多 Agent 工作如何被看见”

## 1. 证据标记与研究边界

本文严格区分两类内容：

- **观察事实（O）**：2026-07-26 在官方页面直接看到的文案、信息顺序、界面、CTA、数据、导航或图像；
- **设计推断（I）**：基于观察事实得出的可迁移设计判断，不代表样本品牌公开解释过其设计意图。

页面中的 GitHub stars、下载量、用户量、客户评价和安全承诺均按品牌官网当日展示记录，本文不独立背书。Cognia 若采用相似证明，必须从仓库或发布系统读取真实数据。

## 2. V2 先给结论

第一版提出的 “Precision Command Center” 方向仍成立，但 V2 应增加一个更难复制的核心：

> **Cognia 不只是让 Agent 工作可见，还要让它的开放边界可验证。**

14 个新增样本共同显示出三条高价值规律：

1. **开源产品最强的首屏证据不是一句 “open source”，而是可立即行动的开放入口。** OpenCode、Cline、Zed、Langflow、Flowise、OpenHands 把安装、GitHub、可选模型或本地运行放在首屏或首屏附近。
2. **Agent demo 正从“聊天输出”转向“工作状态”。** Devin Desktop、GitHub Copilot、OpenHands、Cline 和 Zed 展示任务分派、进行中、等待 review、diff、undo、PR 等状态。
3. **信任需要拆成可核验的多个边界。** AnythingLLM、Open WebUI、LM Studio、OpenCode、Dify 分别写清设备、模型、部署、数据和源代码边界，而不是只使用笼统的 “private and secure”。

因此建议把 Cognia V2 定义为：

> **Open Agent Workbench — 一个让用户连接任意模型与工具、查看每一步行动、在本地或自选环境中完成工作的开放 AI 工作台。**

这不是放弃“桌面指挥中心”，而是给它增加开放性、可验证性和社区人格。

---

## 3. 14 个官方样本比较矩阵

所有 URL 均为官方页面，访问日期均为 **2026-07-26**。

| 样本                                                  | 观察事实（O）                                                                                                                                                                                                                                                                     | 最值得迁移的设计推断（I）                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Warp](https://www.warp.dev/)                         | Hero 为超大左侧标题 “From the terminal to the cloud, with any agent”，右侧短说明；下载按钮与 `brew install` 命令并排。随后展示 any harness / tool / inference provider / model、产品分层、开源公告、评价和分平台下载。                                                            | 桌面产品可以同时服务新用户和 CLI 用户：一个按钮负责低门槛，一个可复制命令负责开发者可信度。        |
| [OpenCode](https://opencode.ai/)                      | Hero 直接定义 “The open source AI coding agent”，紧接多包管理器安装命令和产品视频；功能以 LSP、multi-session、share links、75+ providers、terminal/desktop/IDE 列出；GitHub、贡献者、月活和隐私单独成段。                                                                         | 极简页面也能完成转化，只要类别、安装、能力、社区规模和数据边界的顺序非常清楚。                     |
| [Cline](https://cline.bot/)                           | Hero 使用 “The Open Coding Agent”，按 IDE / CLI / SDK 切换入口；页面展示 Understand / Refactor / Automate 三种任务视频，随后列出 diff、checkpoint、undo、Plan/Act、审批、模型选择、MCP 和多 Agent。Apache 2.0、contributors、GitHub stars 与安装量直接进入证明链。                | 不要按技术模块演示 Agent；先让用户选择任务，再在任务里看见计划、行动、review 和撤销。              |
| [OpenHands](https://www.openhands.dev/)               | Hero 为 “AI that builds”，同时提供 Desktop、Cloud 和 npm 安装；首屏产品图后立即给出修漏洞、审 PR、迁移代码、处置事故等结果型任务。后续按个人、团队、企业分层，并展示自动化模板、集成、GitHub stars、self-host、sandbox、audit logs 等。                                           | 一套复杂平台可以用“任务结果 → 运行位置 → 组织规模”来组织，比功能总表更容易理解。                   |
| [Dify](https://dify.ai/)                              | Hero 明确 “Production-Ready Agentic Workflows”，大标题配建筑材质图；产品叙事依次为 Workflow、Agent、Knowledge Pipeline、Plugins、Publish & Monitor，并用真实产品截图。Cloud、Enterprise、Community Edition 在前半页并列解释。                                                     | 对复合 AI 产品，部署选择本身就是产品架构，应在功能之前或同时出现，而不是埋在 pricing。             |
| [Langflow](https://www.langflow.org/)                 | Hero 用 “Stop fighting your tools”，右侧放可操作感很强的模型参数面板；首屏同时提供 Get Started 和 Star on GitHub，并展示 GitHub、Discord、X、YouTube 数字。页面从 drag/drop 到 Python custom、agents、API、部署和集成。                                                           | Hero 中展示一个有输入、参数和状态的真实“工作台切片”，比大而全 dashboard 更能表达控制感。           |
| [Flowise](https://flowiseai.com/)                     | Hero 为 “Build AI Agents Visually”，双 CTA 是 Get Started / GitHub；紧接客户 logo。能力被归入 Multi Agents、Chat Assistants、Human in the Loop、Execution Traces、API/SDK/Embed、Production Scale，并给出真实客户评价和页面内 pricing。                                           | “Human in the Loop” 和 “Execution Traces” 应成为一级卖点，而不是安全页中的实现细节。               |
| [Open WebUI](https://openwebui.com/)                  | Hero 为 “The freedom AI stack”，文案明确 any model、extend with code、your data、your machine；CTA 为 GitHub 安装入口和社区。页面使用乡间房屋、道路、图书馆、宇宙等编辑性图像讲 self-host、community 和 ownership，并给出 downloads、members、stars。                             | 开源官网不必只做终端美学；鲜明的编辑性隐喻可以建立情绪价值，但必须由可执行安装和真实社区入口托底。 |
| [AnythingLLM](https://anythingllm.com/)               | Hero 为 “Own your intelligence”，副标题直接列出 entirely on your computer、no accounts、no API keys、no token limits；主 CTA 是 Download Free，次 CTA 是 GitHub stars。页面按生产力场景、四步上手、MIT license、contributors 和 self-host 组织。                                  | 隐私主张越具体越可信；“无账号 / 无 API key / 本地处理”比抽象盾牌图标更有效。                       |
| [Jan](https://www.jan.ai/)                            | Hero 为 “Personal Intelligence that answers only to you”，按系统提供下载并显示下载量；随后先讲 built in public，再用 GitHub、Discord、Hugging Face 和模型选择证明开放。功能采用编号叙事，页面视觉以简洁产品 UI 和人格化记忆示例为主。                                             | 先表达用户与 AI 的关系，再讲技术自由，可以让开源桌面产品不局限于工程师语气。                       |
| [LM Studio / Bionic](https://lmstudio.ai/)            | 页面只围绕 “An Agent made for Open Models” 展开，强调 work、code、document editing、automation、computer control、real-time voice 和 local processing；产品图连续展示文档、语音和模型选择。页尾再次下载，导航再连接 runtime、SDK、CLI 和 enterprise。                             | 产品能力很多时，单一角色名和少量连续场景能比产品矩阵更有记忆点；开发者入口可放在页尾体系化承接。   |
| [Zed](https://zed.dev/)                               | Hero 为 “Your last next editor”，副标题给出 minimal / speed / collaboration with humans and AI，CTA 为 Download / Clone source；紧接 Fast / Agentic / Collaborative。页面用大量真实编辑器界面和短视频讲 parallel agents、review、Git、ACP、MCP、extensions、roadmap 和 releases。 | 品牌承诺应由产品基础品质托底：先证明“这是好用的编辑器”，再证明“它也是 Agent 工作台”。              |
| [Devin Desktop](https://devin.ai/desktop)             | 页面本身像一个放大的产品界面：Hero 展示 agent sessions、Kanban 状态、PR ready、waiting for CI、done。后续依次讲 agent command center、IDE、ACP、多 Agent shared spaces、review、local-to-cloud handoff、客户评价、MCP/LSP extensions 和 pricing。                                 | 多 Agent 的最佳 hero 不是多个聊天窗，而是可扫描的任务队列、状态和审阅入口。                        |
| [GitHub Copilot](https://github.com/features/copilot) | Hero 为 “Command your craft”，CTA 为 Get started / plans；用三条原则说明 model choice、agents 和跨 surface。核心叙事依次展示 desktop workspace、IDE agent mode、issue assignment/cloud agent、customer story、knowledge、governance、MCP security 和分层 pricing。                | 面对宽产品面，先给统一工作流，再按“在哪里工作”展开 surfaces，最后进入组织治理，层次最清晰。        |

---

## 4. 可复用模式：观察与推断分离

### 4.1 Hero composition

**观察事实（O）**

- Warp、Dify、Cline 使用大字号、非居中的类别主张，副文案或视觉与标题形成明显不对称。
- OpenCode、AnythingLLM、Jan、Zed 把下载、安装或 clone source 放在首屏。
- Langflow 在 hero 中直接呈现模型、API key、temperature 等产品控制项；Devin Desktop 直接呈现任务看板；OpenHands 在 hero 产品图周围绑定具体任务。
- Dify 用实体建筑材质做品牌图像；Open WebUI 用油画式场景讲 ownership；大多数其他样本让产品 UI 成为 hero 主体。

**设计推断（I）**

- Cognia 的 hero 应采用 **60/40 非对称结构**：左侧类别与 CTA，右侧不是一张静态聊天截图，而是一个任务从计划到等待确认的工作台。
- 可保留一张具有材质感的品牌图像，但只应作为开场或章节转场；首屏必须在无需滚动时看到真实产品状态。
- 主 CTA 用操作系统识别下载，旁边放 `GitHub` 或可复制安装命令；不要并列四个同权按钮。

### 4.2 Product demo storytelling

**观察事实（O）**

- Cline 先让用户选择 Understand / Refactor / Automate，再播放对应任务。
- OpenHands 按 Fix Vulnerabilities / Review PRs / Migrate Code / Triage Incidents 描述产出。
- Devin Desktop 使用 Working、Waiting for review、Waiting for CI、Done；GitHub Copilot 展示 issue 分派、agent mode 中的 changed files 与 Keep/Undo。
- Dify、Flowise 明确展示 workflow、human input、execution traces；Zed 展示 delegate、live progress 和 review。

**设计推断（I）**

- Cognia 的核心 demo 应围绕**一个连续任务**，并明确显示 `Plan → Tool → Approval → Artifact`，而不是轮播互不相关的功能截图。
- 最适合官网 V2 的故事是：  
  **“读取 issue 与仓库上下文 → 生成执行计划 → 修改代码和文档 → 等待权限确认 → 运行测试 → 生成 PR 与发布清单。”**
- 这条任务同时能诚实证明 Claude Code 根基、知识、Agent、workflow、工具调用和可审阅产物；面向非开发者的会议/研究场景可放在 use cases。

### 4.3 Scroll and motion

**观察事实（O）**

- Devin Desktop 用长页面持续复现同一产品表面，状态从任务队列推进到 IDE、diff、handoff 和 integrations。
- Zed 的能力区给出多个短视频入口；Cline 用任务 tabs 切换 demo；Dify 以 Workflow → Agent → Knowledge → Plugins → Publish 的顺序切换产品图。
- Warp、Open WebUI、AnythingLLM 主要依靠清楚的章节切换和重复 CTA，不依赖首屏视频才能理解主张。

**设计推断（I）**

- Cognia 应使用一段 **sticky task rail**：滚动时固定任务标题和状态线，只替换右侧真实界面层。
- 动效只解释四件事：状态改变、上下文进入、权限暂停、产物生成。避免粒子、连续视差和无意义 logo ticker。
- 每个关键状态停留时间应足以阅读；`prefers-reduced-motion` 下改为四张静态状态图和显式 stepper。

### 4.4 Proof

**观察事实（O）**

- OpenCode、Cline、OpenHands、Langflow、AnythingLLM、Jan、Zed 在主要转化路径中直接连接 GitHub，并展示 stars、contributors、downloads 或 community。
- Flowise、Dify、OpenHands、Devin Desktop、GitHub Copilot 同时使用客户 logo、案例或具名评价。
- Zed 还展示 roadmap、releases 和 extensions；Open WebUI 展示社区共享的 prompts、models、tools、functions。

**设计推断（I）**

- Cognia 在没有成熟客户数据前，应优先使用 **repository proof**：license、release、contributors、commit activity、可公开 roadmap、changelog 和测试状态。
- 只展示可追溯的客户或社区证言；不要把“GitHub stars”写死在页面源码中。
- Proof 顺序建议为：真实任务产物 → GitHub/community → release cadence → 用户案例。

### 4.5 Integrations

**观察事实（O）**

- OpenHands 用自动化模板解释 Slack、GitHub、Linear 等连接完成什么任务。
- Devin Desktop 对每个 MCP/LSP extension 写明可执行动作，而不只展示 logo。
- Dify 把 model providers、tools、data sources 和 MCP 放进 Marketplace；Cline 和 Zed 将 MCP 与“任意 agent / tool”并列。
- Langflow 展示大量 provider logo；Open WebUI、OpenCode 更强调 any model / compatible endpoint。

**设计推断（I）**

- Cognia 不应把 integrations 做成无限滚动的 logo 墙。每个连接至少回答：**读取什么、可以执行什么、何时需要确认**。
- 首页只展示 4 个任务级连接例子；完整 providers、MCP、plugins 和 connectors 进入可筛选目录。
- 模型选择应表达为运行策略，而不是品牌收藏：local、bring your own key、hosted、fallback。

### 4.6 Open-source trust

**观察事实（O）**

- AnythingLLM 明确 MIT licensed、desktop / self-host；Cline 明确 Apache 2.0；Dify 明确 Community Edition 的 license 类型和 Docker 部署；Zed 同时提供 Download 和 Clone source。
- Open WebUI 用 “your models, your data, your machine” 解释所有权；OpenCode 写明不存储 code/context；LM Studio 写明语音本地处理和云服务 ZDR。
- OpenHands 将 open source、model-agnostic、self-host、sandbox、audit trail 与组织控制放在同一证据链。

**设计推断（I）**

- Cognia 应新增一个 **Trust Receipts** 区块，用表格而不是口号分别列出：
  - 哪些代码开放、对应 license 和仓库；
  - 哪些数据默认留在设备、哪些功能会调用外部模型；
  - 每种工具权限、确认点、日志和撤销能力；
  - desktop / browser / mobile / self-host 的能力差异。
- “Open source” 不能只链接 GitHub；必须告诉非开发者开放给了他什么实际控制权。

### 4.7 Conversion CTAs

**观察事实（O）**

- 开源桌面产品常见 CTA 配对为 Download / GitHub 或 Get Started / Star：OpenCode、Cline、OpenHands、Langflow、Flowise、AnythingLLM、Jan、Zed 均采用类似结构。
- Warp 在同一下载组件中同时提供 GUI 下载和 shell command；OpenHands 和 Dify 则按 local/cloud/enterprise 分流。
- 几乎所有样本都在页尾重复主 CTA；Flowise 和 GitHub Copilot 还直接把 pricing 放进主页。

**设计推断（I）**

- Cognia Hero CTA：`Download for macOS`（主）+ `View source`（次）+ install command（辅助）。
- 页面中段根据用户意图分流：`Run locally`、`Try in browser`、`Deploy for a team`，但必须只显示当前真实可用的路径。
- 页尾只重复下载、GitHub 和 Docs，不新增新的转化目标。

### 4.8 Navigation and footer

**观察事实（O）**

- OpenCode 的导航极短；Cline、Warp、Dify、GitHub Copilot 对成熟产品使用 product / solutions / resources 的 mega navigation。
- OpenHands、AnythingLLM、Zed 在导航或页尾保持 Docs、GitHub、Community、Changelog / Releases 可见。
- Zed 的 footer 特别完整，覆盖 download、pricing、releases、extensions、roadmap、docs、GitHub、status、community、privacy 和 brand。

**设计推断（I）**

- Cognia 现阶段不需要企业 SaaS 式 mega nav。建议一级导航：

```text
Product · Workflows · Plugins · Trust · Docs · GitHub · Download
```

- Footer 应承担开源项目的“可核验索引”：Source、License、Releases、Changelog、Roadmap、Security、Status、Contributing、Community。

### 4.9 Visual system

**观察事实（O）**

- Warp 使用白底、黑色大字、细边框、命令行等宽字和少量淡紫状态纹理。
- OpenCode 使用窄版心、页面边界线、像素 wordmark、等宽字体和近乎无色的视觉系统。
- Cline 以白底、黑字和单一紫色 headline accent 建立识别。
- Dify 使用白底、极大黑字、钴蓝强调和混凝土建筑材质。
- Langflow 使用黑底、青绿到蓝紫的受控渐变、参数面板和发光 CTA。
- Open WebUI 使用强编辑性自然图像；AnythingLLM、Jan、LM Studio、Zed 更依赖真实产品界面与克制的产品色。

**设计推断（I）**

- V2 不建议把 Cognia 固定为全站深黑。更适合使用 **light workbench + dark execution stage**：
  - 骨白 / 冷灰作为阅读与社区内容背景；
  - 石墨黑用于 hero demo、workflow、日志和权限章节；
  - mineral cyan 只标记运行、连接和主 CTA；
  - warm amber 仅用于 waiting for approval；
  - Geist Sans 承担叙事，Geist Mono 只用于状态、路径、命令和 provenance。
- 这样既保留第一版的精密仪器感，也避免与 Linear、Raycast 式全黑官网表面相似。

---

## 5. Cognia 官网 V2 具体方案

### 5.1 Design read

> **An open workbench where human intent becomes visible, reviewable agent work.**

中文表达：

> **一个开放的 AI 工作台：连接你的模型与工具，让每一步 Agent 行动看得见、可审阅、可掌控。**

### 5.2 Hero

建议首屏文案：

**Your open workspace for AI agents.**  
Connect your models and tools. Plan, act, and review every step in one desktop workbench.

中文：

**你的开放 AI Agent 工作空间。**  
连接自己的模型与工具，在一个桌面工作台中计划、执行并审阅每一步。

构图：

- 左 55%：headline、副标题、`Download for [OS]`、`View source`、可复制安装命令；
- 右 45%：真实 Cognia 任务队列，固定显示一个任务的 plan、tool call、permission、artifact；
- hero 底部一条静态 trust rail：

```text
Open source · Bring any model · Local + cloud · Permissioned actions
```

只有在这些描述与当前实现完全一致时才上线。

### 5.3 首页章节顺序

| 章节                             | 内容                                                    | 证明对象                     |
| -------------------------------- | ------------------------------------------------------- | ---------------------------- |
| 1. Hero                          | 类别、桌面下载、source、任务起点                        | 5 秒理解产品和开放性         |
| 2. Repository proof              | License、release、contributors、changelog、supported OS | 开源项目真实活跃             |
| 3. One task, end to end          | Plan → Tool → Approval → Artifact sticky demo           | Agent 不是聊天动画           |
| 4. Your workbench                | Chat、Agents、Workflows、Knowledge + Plugins            | 一个空间统摄产品             |
| 5. Run it your way               | Local model、BYOK、hosted、team/self-host（按真实能力） | 数据与部署边界               |
| 6. Connections with consequences | 4 个任务级 integration 示例                             | 能读什么、能做什么、何时确认 |
| 7. Trust receipts                | source、data boundary、permissions、logs、undo          | 信任可核验                   |
| 8. Built in public               | roadmap、releases、contributing、community              | 长期开放承诺                 |
| 9. Final CTA                     | Download、GitHub、Docs                                  | 单一清晰下一步               |

### 5.4 Signature demo storyboard

1. 用户分派：“处理这个 issue；更新实现、测试和发布文档。”
2. Cognia 读取 issue、仓库规范和相关知识，列出来源。
3. Agent 生成可编辑计划，用户批准。
4. Workflow 展示文件修改、工具调用和测试状态。
5. 遇到外部写入或高风险操作时暂停，显示权限说明。
6. 完成后展示 diff、测试结果、文档、PR 草稿和一键撤销。

页面滚动只推进这一个任务，不在中途切换成会议、图片生成或 IM 等另一条故事。

### 5.5 Motion specification

- Hero：任务状态在 6–8 秒内从 `Planning` 到 `Waiting for approval`，停在可审阅状态；
- Sticky demo：每滚动一个章节推进一个状态，界面变化 250–400ms；
- Integrations：连接线只在工具被调用时出现，不常驻流动；
- Reduced motion：所有状态同时以 stepper 展示，禁用自动播放和视差；
- 性能：首屏文案、CTA 和第一帧产品 UI 不依赖视频下载完成。

### 5.6 Open-source trust specification

官网上线前为每条承诺建立真实数据源：

| 官网承诺                           | 推荐来源                            |
| ---------------------------------- | ----------------------------------- |
| Latest release / supported OS      | GitHub Releases 或项目发布 manifest |
| Contributors / repository activity | GitHub API，带缓存与更新时间        |
| License                            | 仓库 LICENSE 文件                   |
| Local / cloud data flow            | 版本化 architecture / privacy 文档  |
| Model support                      | 产品 provider registry              |
| Plugins / MCP                      | 实际 registry，不手写 logo          |
| Permission / undo                  | 产品真实 capability matrix          |

若数据不能自动或人工稳定维护，就不要在 hero 使用数字或绝对化文案。

---

## 6. 应避免的 V2 反模式

1. 用 GitHub stars 代替产品 demo；
2. 把 “open source” 当装饰 badge，却不说明 license、部署和数据边界；
3. 多 Agent 首屏放四个同步打字的聊天窗；
4. integrations 只展示 logo，不解释读取、写入和审批；
5. 把 local、self-hosted、offline、private 当同义词；
6. 使用假任务、假 diff、假测试状态或假终端；
7. 首屏同时让用户 Download、Try web、Start free、Book demo、Watch video、Join Discord；
8. 动效只制造“忙碌感”，不传达状态变化；
9. 复制 Langflow 式霓虹或 Dify 式建筑材质，却没有与 Cognia 产品对象的对应关系；
10. 在产品尚处重构期时使用 production-ready、enterprise-grade、always secure 等未经验证承诺。

---

## 7. 决策建议

建议 V2 评审直接拍板以下五项：

1. **类别**：`Open AI agent workspace`，而不是泛化 `AI assistant`；
2. **首屏任务**：issue → implementation → test → docs → PR；
3. **首 CTA**：按 OS 下载；GitHub 为次 CTA；
4. **视觉**：light workbench + dark execution stage；
5. **信任**：首屏 trust rail + 中后段 Trust Receipts，所有条目链接到真实文档或源码。

如果只能优先完成一件事，应先制作带真实 Cognia UI 的 signature demo。它同时决定 hero 构图、滚动节奏、产品截图、权限叙事和最终 CTA，是整站最具杠杆的设计资产。

---

## 8. 官方来源登记

以下均为本研究直接访问的官方页面，访问日期均为 **2026-07-26**：

1. Warp — <https://www.warp.dev/>
2. OpenCode — <https://opencode.ai/>
3. Cline — <https://cline.bot/>
4. OpenHands — <https://www.openhands.dev/>
5. Dify — <https://dify.ai/>
6. Langflow — <https://www.langflow.org/>
7. Flowise — <https://flowiseai.com/>
8. Open WebUI — <https://openwebui.com/>
9. AnythingLLM — <https://anythingllm.com/>
10. Jan — <https://www.jan.ai/>
11. LM Studio / Bionic — <https://lmstudio.ai/>
12. Zed — <https://zed.dev/>
13. Devin Desktop（Windsurf 的当前官方页面）— <https://devin.ai/desktop>
14. GitHub Copilot — <https://github.com/features/copilot>
