# 浏览器 AI 与侧边栏产品市场对比（2026-08-27）

**研究问题：** Cognia 是否应该开发浏览器侧边栏插件；它是否应该成为 Browser Use 的依赖；相比现有产品，应该做哪些能力、避免做哪些能力。  
**研究截止：** 2026-08-27。  
**证据标准：** 以产品官方帮助中心、官方发布说明、官方商店页和官方仓库为主；没有一手证据的能力不按“已支持”计算。  
**相关前置研究：** [Browser Use extension requirement and upstream architecture](./browser-use-extension-upstream-2026-08-26.md)。

## 执行结论

**建议做侧边栏插件，但它应该是可选的 `Cognia Browser Companion`，而不是新的聊天产品、也不是 Browser Use 的必需运行时。**

市场已经证明“侧边栏 + 当前页面问答”只是入场券。Gemini in Chrome、Edge Copilot、Comet、Dia、Brave、Opera、Firefox、ChatGPT、Claude、Sider 都已经覆盖这一基本形态。真正形成差异的能力是：

1. 能否明确复用用户正在使用的标签页、登录态和浏览器扩展；
2. 能否把任务限制在清晰可见的标签页或标签组中；
3. 能否把读取、建议、执行拆成不同权限，并对敏感动作即时确认；
4. 能否让用户随时 Pause、Take over、Resume、Stop，并看到完整动作记录；
5. 能否在本地浏览器、应用内浏览器和云浏览器之间按任务路由；
6. 能否把网页工作与本地文件、代码、终端、MCP、插件、工作流和最终交付物连起来。

Cognia 的机会不在于复制一个 Sider/Monica 式多模型聊天栏，而在于把浏览器变成 Cognia 现有 Agent 工作区的一个**可授权、可观察、可接管的执行面**。

因此推荐的三层架构是：

| 层                | 职责                                             | 推荐实现                                                                                             |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Browser Companion | 当前标签交接、选择上下文、权限、任务状态、接管   | 可选 Chrome/Edge MV3 侧边栏扩展                                                                      |
| Cognia Host       | 统一任务、模型、文件、终端、插件/MCP、审计与路由 | 现有 Tauri/Companion 与 Agent loop                                                                   |
| Browser runners   | 实际页面操作与长任务                             | 现有 embedded engine、Playwright existing-browser、Remote Chromium；Browser Use/CDP 可作为额外执行器 |

这也符合当前最强产品的收敛方向。OpenAI 已在 2026-08-09 停止 Atlas，把浏览器工作拆到 ChatGPT 桌面内置浏览器、Chrome 扩展和 cloud browser；Claude 同时提供 Chrome 扩展与 Cowork 内置浏览器；Manus 和 Sider 也同时保留真实本地浏览器与云浏览器。单押一个“AI 浏览器”或单押一个“CDP 自动化器”都不是最完整的产品形态。

## 市场地图

### 1. 浏览器原生只读/轻操作助手

代表产品：Brave Leo、Opera One AI/Aria、Firefox Smart Window。

这类产品的核心价值是低打扰阅读、总结、翻译、写作和多标签理解。Brave 强调隐私、BYOM 和本地聊天历史；Opera One 支持页面上下文及本地 Tab Commands；Firefox Smart Window 支持页面、标签、历史和本地 Memory，但明确不点击页面、不填表、不购买或登录。

**对 Cognia 的意义：** 只读模式仍然是高频入口，应作为默认安全级别；但单独做到这里没有足够差异。

### 2. 浏览器原生/AI 浏览器 Agent

代表产品：Gemini in Chrome、Microsoft Copilot in Edge、Perplexity Comet、Dia、Opera Neon。

它们拥有浏览器级上下文和登录态，能自然处理当前标签、多标签、历史、下载、密码管理器和任务通知。Gemini、Edge、Comet、Neon 已将多步页面操作纳入主流程；Dia 更侧重 Memory、Skills、连接器、Reports 和主动工作组织。

**对 Cognia 的意义：** 原生浏览器的上下文体验是 UX 高水位，但 Cognia 不需要因此自建 Chromium 浏览器。扩展桥接加应用内/云端 runner 能覆盖大部分价值，且维护成本更低。

### 3. 桌面 Agent 的真实浏览器桥

代表产品：ChatGPT/Codex Chrome extension、Claude in Chrome、Manus Browser Operator。

这是与 Cognia 最接近的路线。扩展不是独立产品后端，而是把真实 Chrome Profile、已登录网站、当前标签和浏览器状态交给更强的桌面 Agent。ChatGPT 把浏览器与既有任务、插件和文件系统结合；Claude 把浏览器与代码、console、network、DOM、工作流和 scheduled tasks 结合；Manus 用一次性授权、专用任务标签组、动作日志和跨设备监控把本地浏览器变成远程可监督执行器。

**对 Cognia 的意义：** 这是主对标组，也是“值得做侧边栏”的最强理由。

### 4. 通用多模型扩展

代表产品：Sider、Monica、MaxAI；其中 Sider 已从 Chat/Reader/Writer 扩展到 Claw browser agent。

它们擅长模型聚合、网页/PDF/YouTube 总结、翻译、选中文本、邮件回复和模板化 prompt。Sider 官方宣称拥有超过 1000 万活跃用户，并支持登录态、跨站多标签任务、可见执行、云端计算机、跨会话记忆和文件产出。

**对 Cognia 的意义：** 它们证明侧边栏有分发价值，也说明“多模型 + 总结 + 翻译”已经高度商品化。Cognia 不应在这一层正面同质化竞争。

### 5. 开发者浏览器执行层

代表产品：Browser Use、Playwright MCP Extension、Browserbase/Stagehand、BrowserMCP。

这类产品提供 CDP、DOM/accessibility snapshot、截图、云浏览器、持久 Profile、Live View、HITL 和 MCP 工具。它们通常不提供完整消费级权限策略、侧边栏任务 UX 或跨产品工作区；这些责任留给上层应用。

**对 Cognia 的意义：** 应复用为执行层，不应把它们误当成侧边栏产品替代品。

## 代表产品能力矩阵

图例：`●` 强支持；`◐` 部分支持或范围较窄；`—` 当前一手资料未证明。这里比较的是产品行为，不比较模型质量。

| 产品                    | 当前/多标签上下文                       | 复用真实浏览器状态          | 通用页面操作                                 | 细粒度审批与接管                                      | Memory / Skills / 长任务                     | 最值得借鉴的设计                                |
| ----------------------- | --------------------------------------- | --------------------------- | -------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| Gemini in Chrome        | ●，当前页默认，可显式共享最多 10 个标签 | ●                           | ● Auto Browse                                | ● 计划、敏感动作确认、Take over                       | ◐ Google 生态上下文                          | 明确显示共享标签与任务所属标签                  |
| Edge Copilot            | ●，页面、PDF、视频、标签、历史          | ●                           | ● Browse with Copilot                        | ● 可中断/接管，敏感动作暂停                           | ◐ 企业策略与连接数据                         | 操作时显式光标/页面色调，不隐藏 Agent 行为      |
| Perplexity Comet        | ●，`@tab`、最近标签、并行 errands       | ●                           | ●                                            | ◐ once/always/deny，域级 read/control/no access       | ◐ 并行任务与个人上下文                       | 域级“只读/可控制/禁止”三态策略                  |
| Dia                     | ●，标签、历史、选中文本、连接器         | ●                           | ◐ 连接器与结构化工作，不以任意页面点击为核心 | ◐ 安全提醒，广泛动作审批证据不足                      | ● Memory、Skills、Reports、Live Work         | 从聊天升级到可编辑、可检索、可分享的产物        |
| Opera Neon              | ●，Task 内多标签/文档上下文             | ●                           | ● Neon Do + MCP/CLI                          | ● 可见、Pause、Take over                              | ● Tasks、Skills、云端 Make                   | 每个 Task 是隔离的“mini-browser”工作区          |
| ChatGPT/Codex extension | ●，跨标签、side chat                    | ● Profile、登录态、扩展     | ● 后台驱动浏览器                             | ● 新站点、历史、上传下载等确认                        | ● 既有任务、插件、文件系统；云任务可离线继续 | 扩展只是桌面 Agent 的浏览器执行面               |
| Claude in Chrome        | ●，任务标签组、DOM/视觉/console/network | ●                           | ●                                            | ● Manual/Auto/Skip、站点级 once/always/deny、硬禁止项 | ● workflow、scheduled tasks、通知            | 权限模式、任务标签组和开发验证闭环最完整        |
| Manus Browser Operator  | ◐ 任务专用标签                          | ● 本地 IP、登录态、付费站点 | ●                                            | ● 一次性会话授权、实时接管、关标签即停止、审计日志    | ◐ 可跨设备启动/监控                          | 任务命名标签组和“一关即停”的清晰心智模型        |
| Sider / Claw            | ● 页面、文件、跨站多标签                | ●                           | ●                                            | ◐ 可见步骤和 Stop；细粒度策略公开证据较弱             | ● Memory、重复 workflow、云计算机、文件      | 从阅读侧边栏平滑升级成产出导向 Agent            |
| Brave Leo               | ● 当前页与多标签                        | ●                           | ◐ 广泛 AI browsing 仍处早期测试              | ◐                                                     | ◐ 本地历史、偏好、BYOM                       | 最小化上传、无账号使用、本地/自带模型           |
| Opera One AI/Aria       | ● 页面、多标签、视频                    | ●                           | ◐ 主要是 tab group/close/pin/save            | ◐ Tab Commands 可撤销                                 | —                                            | 将标签命令在本地执行，服务端只生成指令          |
| Firefox Smart Window    | ● 当前页、`@tab`、历史                  | ●                           | —，官方明确禁止页面动作                      | —                                                     | ◐ 本地 Memory、BYOM                          | 清楚声明非 Agent 边界，不把所有助手都做成自动化 |

### 开发者执行层对比

| 执行层                   | 真实本地浏览器                       | 云端隔离/并行                      | Human takeover                 | 自带消费级侧边栏/审批 | 适合 Cognia 的角色                        |
| ------------------------ | ------------------------------------ | ---------------------------------- | ------------------------------ | --------------------- | ----------------------------------------- |
| Browser Use              | ● 直接 CDP、运行中 Chrome 或 Profile | ● Cloud、Profile、recording、proxy | ● `liveUrl` + follow-up 恢复   | —                     | 可选 Agent/CDP runner；不要求 Cognia 插件 |
| Playwright MCP Extension | ● 用户选定既有标签，复用登录态/扩展  | ◐ isolated profile 可并行          | ◐ 状态页断开、标签可移入移出组 | —                     | Cognia 已有的现成 existing-browser 桥     |
| Browserbase / Stagehand  | — 主要是云 Chromium                  | ● Context、Live View、Keep Alive   | ●                              | —                     | 高可靠云 runner 和观测层候选              |
| BrowserMCP               | ● 本地 MCP + 扩展                    | —                                  | ◐                              | —                     | 可参考协议，不建议作为当前主依赖          |

## 市场已经形成的产品基线

### 1. 上下文必须由用户看得见、选得清

“AI 能看到当前页面”已经不够。Google 显式展示共享标签并限制最多 10 个；Claude 和 Playwright 用任务标签组划定边界；Comet、Dia、Firefox 用 `@tab` 让用户点名上下文；OpenAI 对浏览历史单独请求授权。

Cognia 应把上下文显示成可编辑的 chips，而不是隐式抓取整个浏览器：

- Current tab；
- Selected text / selected region；
- 明确添加的其他标签；
- 可选的 DOM、截图、console、network；
- 每项显示来源、范围和是否会发送给模型。

### 2. 权限模型已经成为核心 UX

市场主流正在从单一开关转向多层能力：

- `Read`：读取页面、选中文本、标题、URL；
- `Suggest`：生成草稿、填写建议，但不提交；
- `Act`：点击、输入、导航、下载、上传；
- `Protected actions`：发送、发布、购买、删除、授权、账户/金融/健康相关操作始终单独确认；
- `Prohibited actions`：即使用户开了高权限也不执行的硬边界。

Claude 的 Manual/Auto/Skip、Comet 的 Read Only/Browser Control/No Access，以及 OpenAI cloud browser 的 Always ask/Auto approve/Always allow 都说明：权限模式本身就是用户信任的重要产品表面。

### 3. Agent 必须有任务边界，而不是在整个浏览器里游走

Claude、Manus、Playwright MCP、Opera Neon 都采用任务标签组或 Task workspace。它同时解决四个问题：

- 用户知道哪些页面正在被控制；
- 并行 Agent 不容易串台；
- Stop/cleanup 的范围明确；
- 历史、日志和最终产物可以归属到一个任务。

### 4. Take over 不是异常兜底，而是正常协作状态

Gemini、Edge、Manus、Opera Neon、OpenAI cloud browser、Browser Use Cloud 和 Browserbase 都把人工接管放进正式流程。登录、2FA、CAPTCHA、支付、复杂拖拽以及 Agent 卡住时，应允许：

`Agent running → Paused for user → User controlling → Resume agent → Completed/Stopped`

侧边栏最适合承载这个状态机，因为它在网页旁始终可见。

### 5. 最强产品交付的是产物，不是聊天记录

Dia Reports、Sider Claw、Opera Neon Make、ChatGPT/Codex 和 Manus 都在把浏览结果变成表格、报告、文件、代码或可分享结果。浏览器只是输入与执行环境，最终价值要回到工作区和可复用交付物。

### 6. 混合执行正在胜出

本地真实浏览器适合登录态、付费站点、本地 IP 和人与 Agent 共用页面；云浏览器适合隔离、并行、长任务、代理和设备离线后继续；应用内浏览器适合开发预览、标注和可控状态。

因此 Cognia 不应让一个 runner 承担所有任务，而应显式路由：

- **Existing browser**：必须使用当前登录态、浏览器扩展或用户当前页面；
- **Embedded browser**：本地开发、预览、标注、可复现验证；
- **Cloud/remote browser**：长任务、并行研究、隔离风险、远程继续；
- **Direct connector/MCP**：网站已有结构化 API 时，优先于脆弱的页面点击。

### 7. MCP/WebMCP 正在把浏览器从“被自动化对象”变成工具提供者

Opera Neon 已把 live tabs、page content、screenshots、form actions 暴露为 MCP；Playwright MCP 把选定标签暴露给不同客户端；ChatGPT built-in browser 开始使用网站提供的 WebMCP site tools。Cognia 应保留协议层抽象，避免把产品永久绑定在某个 DOM click engine 上。

## 对 Cognia 现状的映射

前置研究确认，Cognia 已经拥有三个浏览器路径：

1. [`EmbeddedEngine`](../../lib/browser/agent-engine.ts) 驱动 Tauri WebView；
2. [`RemoteChromiumEngine`](../../lib/browser/remote-chromium-engine.ts) 通过 Companion RPC 调用远端 Chromium；
3. [`playwright-existing-browser`](../../plugins/playwright-mcp/src/index.ts) 使用微软官方 `@playwright/mcp --extension` 连接用户授权的 Chrome/Edge 标签。

对应架构还记录在 [ADR-0055](../content/docs/en/adr/0055-agent-browser-loop.md) 和 [ADR-0085](../content/docs/en/adr/0085-cloud-shared-browser.md)。这意味着自有扩展是**第四个产品表面**，不是现有 browser loop 的缺失依赖。

### Cognia 已有优势

- 同一 Agent 可访问浏览器、本地文件、代码、终端、工作区、插件和 MCP；
- 已有 embedded、existing-browser、remote 三种执行面；
- 已有桌面 Host 与远程 Companion，可承载任务、状态和跨设备控制；
- 已有工作流、任务、会话和产物体系，不需要在扩展里再造一套账号与聊天历史。

### 真正缺口

- 浏览器内没有“一键把当前标签交给 Cognia”的稳定入口；
- 用户看不到当前共享/控制的标签和权限范围；
- 没有浏览器原生的审批、Pause/Resume/Stop/Take over 表面；
- 缺少 task ↔ tab/tab group 的 lease 与生命周期模型；
- `chrome-extension://<id>` 还不能直接假设适配现有只接受 HTTP(S) origin 的 Companion browser-access allowlist；
- Direct CDP、Playwright extension、未来 `chrome.debugger` 与 content script 之间还没有单一控制权定义；
- 浏览器动作、模型上下文和最终产物之间缺少用户可读的审计链。

## 推荐的 Cognia Browser Companion

### 产品定位

一句话定义：**在用户现有浏览器中，把当前工作安全地交给 Cognia，并让用户持续看到、授权和接管 Agent。**

它不应该：

- 复制 Cognia 主应用的完整聊天 UI；
- 自建第二套模型选择、账号、记忆或任务数据库；
- 自己成为 Browser Use/CDP 的替代执行引擎；
- 安装时直接请求不必要的 `<all_urls>`、`debugger`、history、downloads 等全量权限；
- 把“浏览器本地执行”宣传成“页面数据绝不出设备”；
- 默认读取全部标签、历史、表单输入或敏感网站。

### Phase 1：只读 Companion MVP

目标是验证入口价值和信任模型，而不是一次性完成通用自动化。

必须有：

1. 点击 toolbar 打开原生 Side Panel；
2. 与本机 Cognia Host 配对，显示明确的设备和任务身份；
3. `Attach current tab`，默认只授权当前标签；
4. 可选发送 title、URL、selected text、bounded visible text 或用户框选区域；
5. 以 chips 显示当前共享的标签/上下文，可逐项移除；
6. 选择“发送到现有任务”或“新建 Cognia 任务”，不复制完整任务 UI；
7. 显示 task status、最近动作/读取记录、Open in Cognia、Stop/Detach；
8. 站点级 `Allow once / Always allow read / Deny`，并能查看和撤销历史；
9. 默认使用 `activeTab`/可选 host permission，避免安装即获得全站访问；
10. 清楚标明哪些数据只在本地、哪些将进入模型上下文。

Phase 1 不需要 `chrome.debugger`。现有 Playwright MCP extension 或 embedded/remote engine 继续负责动作执行。

### Phase 2：受监督的现有浏览器操作

在证明 Phase 1 有持续使用后，再增加：

- `Read / Suggest / Act` 三档任务能力；
- 每个任务独立命名和着色的 tab group；
- 任务 tab lease，防止多个 Agent 同时控制同一标签；
- `Pause / Take over / Resume / Stop` 状态机；
- 可恢复的 action timeline 与页面来源记录；
- 敏感动作确认与硬禁止项；
- 对开发任务开放可选 DOM、screenshot、console、network 上下文；
- 通过 password manager/native fill 完成凭证步骤，密码和 OTP 不进入模型；
- 必要时再评估 `chrome.debugger` 或 Native Messaging，并将它们作为单独、可解释的高权限升级。

### Phase 3：混合执行与长期工作

- 根据任务自动建议 existing / embedded / cloud runner，并允许用户改选；
- 本地浏览器离线时转移到允许的 cloud runner；
- 移动端查看进度、批准和接管；
- saved workflows、scheduled tasks、失败恢复和通知；
- WebMCP/MCP 站点工具优先，DOM 点击作为 fallback；
- 结果直接沉淀为 Cognia 文档、表格、代码变更或工作流 artifact。

## `browser-extension-starter` 应该怎么用

可以复用，但只能把它当作工程脚手架。

可复用：

- WXT 的 Chrome MV3 / Firefox 构建与打包；
- React Side Panel、popup、options 页骨架；
- content script、background service worker、typed messaging；
- storage、manifest 检查和 CI 发布流程。

不应直接继承：

- Supabase 登录；Cognia 应使用自己的 Host pairing 和任务身份；
- OpenPanel analytics；是否采集浏览器上下文相关遥测必须单独做隐私决策；
- 当前宽泛的 `<all_urls>` host access；应改成 `activeTab` 和按站点逐步授权；
- demo content injection；应替换成最小上下文提取和明确的 attach/consent 协议；
- “扩展自己执行 Agent”的架构假设。

前置研究已确认 starter 没有 CDP relay、tab lease、Cognia pairing、动作协议或 reconnect/backpressure。复用它能省下扩展 UI 和发布骨架，但不能省下安全模型与浏览器控制协议的核心工作。

## 收益、成本与最终判断

| 维度       | 主要收益                               | 主要成本/风险                              |
| ---------- | -------------------------------------- | ------------------------------------------ |
| 用户价值   | 一键使用当前页和登录态，不切换应用     | 容易退化成低价值聊天栏                     |
| 信任       | 权限、状态、接管始终在网页旁可见       | 高权限会触发安装警告和商店审查             |
| Agent 能力 | 浏览器与文件、代码、终端、MCP 形成闭环 | 多个控制路径需要严格 tab ownership         |
| 可靠性     | 用户可处理登录、2FA、CAPTCHA、复杂交互 | MV3 service worker、浏览器更新、重连较复杂 |
| 分发       | 浏览器工具栏形成高频入口               | Chrome/Edge/Firefox 能力和发布流程分裂     |
| 隐私       | 可默认最小授权、按站点撤销             | 页面、历史、截图、表单数据都可能高度敏感   |

最终判断：

- **要做侧边栏插件**，如果目标是复用用户当前登录态、形成高频浏览器入口、提供可见审批/接管，并把网页任务接入 Cognia 的完整工作区。
- **不要做或先不做**，如果目标只是“让 Browser Use 跑起来”、连接 managed Chromium、连接 Browser Use Cloud，或已有 Playwright extension 已足够完成选定标签自动化。
- **最合理的第一步**是只读、显式 attach 的 Companion MVP；通过使用率、重复任务率、批准/接管次数和从网页产生的有效 artifact 数量验证价值，再引入 `debugger` 和通用页面操作。
- **Browser Use 与扩展保持解耦**：Browser Use/CDP 是 runner，扩展是 context/consent/status/takeover control plane。

## 研究边界

- 产品能力更新很快，本报告固定在 2026-08-27；价格与 rollout 只在影响产品形态时记录。
- “支持多标签”“支持 Memory”“本地执行”在不同产品中含义不同，不能直接视为等价能力。
- 没有运行所有付费产品做黑盒测试；功能判断以当前一手文档为准。
- 下面保留消费者产品的逐项证据记录，便于后续复核和更新。

## 附录 A：消费者/浏览器原生产品一手证据记录

_Primary-source evidence collected for the consumer/in-browser copilot lane. This is a draft input to the final comparison, not the final report._

### Scope and reading key

- Cut-off: 2026-08-27. Primary sources only: vendor help centers, product pages, privacy notices, release notes, and vendor engineering/security posts.
- `High` means the cited first-party page directly states the behavior and appears current. `Medium` means the source is first-party but describes a preview, staged rollout, older product name, or an adjacent surface whose parity is not explicit.
- “Not evidenced” means this research pass did not locate a current first-party claim. It is not proof that a feature does not exist.
- Distribution shorthand: **browser-native** means shipped in the browser rather than installed as a third-party extension; **AI-native browser** means the vendor asks the user to adopt a separate browser; **adjacent host** means the browser is embedded in a desktop AI app rather than living beside an arbitrary existing tab.

### Fast classification matrix

| Product at cut-off                      | Distribution                                | Persistent side surface                    | Page/multi-tab context                                                                         | General page actions                                                                                         | Human-control evidence                                                                  | Memory / cross-device posture                                                                                   |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Gemini in Chrome                        | Browser-native in Chrome                    | Side panel; dock/pop-out                   | Current tab by default; explicitly add up to 10 recent open tabs                               | Auto browse can navigate, click, fill forms, and run multi-step tasks                                        | Plan review, confirmations, stop, take over, resume                                     | Recent chats, Chrome-history search, past-conversation context; Chrome desktop plus staged mobile availability  |
| Copilot in Edge                         | Browser-native in Edge                      | Edge side pane                             | Current page, title, open tabs, screenshots, and browsing history depending on prompt/settings | Browse with Copilot selects, types, scrolls, navigates in current/new tabs                                   | Real-time visibility, interrupt/takeover; site permission modes                         | Copilot memory/personalization and 18-month conversation history controls; Edge mobile support                  |
| Perplexity Comet                        | Separate AI-native Chromium browser         | Assistant sidecar plus inline selection UI | Current visible page; explicit `@tab`; multi-tab summaries and parallel jobs                   | Click, navigate, fill forms; complex multi-site workflows                                                    | First-run allow once/always/deny; pause; enterprise read-only/control/no-access domains | Optional encrypted browser sync; assistant context retained up to 30 days when used                             |
| Dia                                     | Separate AI-native Chromium browser         | Chat/side panel                            | Current/other tabs, selected text, tab groups, history, connected work tools                   | Strong tab/tool actions (read/open/close tabs); arbitrary in-page click/form control not evidenced           | Tool-call receipts; general approval/takeover pattern not evidenced                     | Local memory and chat history; end-to-end-encrypted sync; Mac current, Windows announced for fall 2026          |
| Opera One AI (Aria successor)           | Browser-native in Opera One                 | Sidebar, command line, full tab            | Current page/PDF/Docs; tab classification and tab commands                                     | Tab actions only in confirmed stable evidence: close/group/pin/bookmark                                      | Recap plus undo for tab actions; general approval/takeover not evidenced                | Account-free baseline; desktop, Android, iOS; AI continuity/sync not evidenced                                  |
| Brave Leo                               | Browser-native in Brave                     | Sidebar and full-page chat                 | Current page, selected text, one or multiple `@` tabs, files                                   | Experimental AI browsing in isolated profile; ordinary Leo also manages tabs                                 | Visible open-tab execution, inspect/pause, permission on misalignment                   | Local chat history and local memories; desktop + Android + iOS, but AI-context sync not evidenced               |
| Firefox Smart Window                    | Optional browser-native Firefox window type | Built-in assistant in Smart Bar/sidebar    | Current page automatically; add recent tabs; browsing-history retrieval                        | Only tab grouping/closing; help explicitly says no clicking, forms, purchase, booking, or independent action | User remains actor; assistant can only advise/manage tabs                               | Local expiring memories; desktop early beta, Mozilla account required; chats/memories sync not established here |
| Opera Neon (adjacent premium benchmark) | Separate premium AI-native browser          | Task workspace with Chat/Do/Make agents    | Task-scoped tabs, documents, logged-in live browser session                                    | Broad local-browser action across tabs; external MCP clients can also click/fill/open tabs                   | Real-time visible actions, pause, take control                                          | Task isolation is explicit; retention and cross-device details need more sourcing                               |

### Provenance records

#### Google Gemini in Chrome

**G-1 — Browser-native side panel, page sharing, multi-tab, and voice.**

- **Claim:** Gemini is built into Chrome as an opt-in side panel. The current tab is shared by default (configurable), users can explicitly share up to 10 recent open tabs across windows, dock or pop out the chat, review recent chats, and use Gemini Live while browsing.
- **Visible evidence:** Google’s help steps say “Ask Gemini” opens the panel; a new chat shares the current tab by default; `@`/Add tabs attaches up to 10 tabs; shared tabs receive a glowing underline; panel controls include pop-out/dock and Go Live. The availability page currently names Chromebook Plus, macOS, and Windows, requires Chrome sign-in, excludes Incognito, and says rollout is gradual by region/language.
- **Source:** [Use Gemini in Chrome — Computer](https://support.google.com/gemini/answer/16283624?hl=en), Google Gemini Apps Help, current help page, accessed 2026-08-27; [Gemini in Chrome availability](https://support.google.com/gemini/answer/17140089), Google Gemini Apps Help, current help page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** Older localized Chrome help snapshots still state “18 or over, US, English”; the current availability page says 13+ (or local applicable age) in supported regions. Auto browse retains stricter eligibility than basic chat. Mobile feature parity is not uniform.

**G-2 — Selection, file, screen, and voice input.**

- **Claim:** The desktop panel supports focused rectangular screen selections, local file upload, drag-and-drop images from a webpage, and full-duplex Live voice; Live can scroll/highlight content on the current page but cannot voice-navigate PDFs.
- **Visible evidence:** Google documents an Add → Select from screen flow whose captured areas are attached to the prompt; the file-upload help has a separate “In Gemini in Chrome” flow; Live supports microphone/speaker, interruptible conversation, and voice commands such as “Scroll me” and “Go to.”
- **Source:** [Share specific parts of your screen with Gemini in Chrome](https://support.google.com/gemini/answer/17077507?hl=en), Google Gemini Apps Help, current help page, accessed 2026-08-27; [Upload & analyze files in Gemini Apps](https://support.google.com/gemini/answer/14903178?hl=en-CA), Google Gemini Apps Help, current help page, accessed 2026-08-27; [Go Live with Gemini in Chrome](https://support.google.com/gemini/answer/16363185?hl=en), Google Gemini Apps Help, current help page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** The file page combines Gemini Apps and Gemini-in-Chrome instructions, so plan-specific limits may differ. Live and navigation are staged rollouts.

**G-3 — Agentic control, approval, and takeover.**

- **Claim:** Auto browse can complete multi-step web tasks in the user’s signed-in local Chrome state, review a plan before starting, request confirmation for sensitive steps, pause for manual completion/sign-in, and support stop/takeover/resume. Google also documents a remote-browser fallback for Gemini Spark tasks.
- **Visible evidence:** Google lists comparison/shopping, travel booking, reservations, forms, communications, and scheduling; the flow explicitly shows “Review the plan,” “Start Task,” “Review and confirm,” “Take over task,” “Resume,” and “Stop.” Safeguards call out confirmation for sending communications, modifying data, submitting forms, scheduling, and sensitive finance/health access; final financial transactions, terms, and account creation can require takeover.
- **Source:** [Ask Gemini in Chrome to complete tasks for you with auto browse](https://support.google.com/chrome/answer/16821166?hl=en), Google Chrome Help, current help page, accessed 2026-08-27; [Architecting Security for Agentic Capabilities in Chrome](https://blog.google/security/architecting-security-for-agentic/), Google Security Blog, 2025-12-08.
- **Confidence:** High for documented behavior; Medium for broad availability.
- **Contradictions / gaps:** Auto browse is experimental, gradual, 18+, US/English, and requires Google AI Pro or Ultra for a personal account per the current help page. The same page says it is not available in Live chats or on iPhone/iPad, while a separate Android help variant exists; mobile agent parity needs device-by-device validation.

**G-4 — Personalization and data controls.**

- **Claim:** Gemini can search synced Chrome history, remember context from past conversations, and optionally use Personal Intelligence/Connected Apps. Page content and URLs from shared tabs are processed by Gemini; website information, audio, and files can be stored in Gemini Apps Activity when Keep Activity is on, while page content is temporarily logged to the Google Account. Users can disable default tab sharing, microphone/location, and “Let Gemini browse for you,” and manage/delete activity.
- **Visible evidence:** The history help supports natural-language retrieval of previously visited pages; Google’s 2026 regional rollout post states past-conversation context and Personal Intelligence; the Privacy Hub explicitly names current/shared-tab page content and URLs and describes storage behavior.
- **Source:** [Search your Chrome history with Gemini in Chrome](https://support.google.com/gemini/answer/16716225?hl=en), Google Gemini Apps Help, current help page, accessed 2026-08-27; [Gemini in Chrome expands to users in Latin America, Africa, the Middle East and more](https://blog.google/products-and-platforms/products/chrome/chrome-expands-latin-america/), Google, 2026-06-10; [Gemini Apps Privacy Hub](https://support.google.com/gemini/answer/13594961?hl=en-Documentation), Google Gemini Apps Help, current help page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** “Browser memory,” Gemini conversation memory, Chrome history sync, and Personal Intelligence are different stores/controls; Google’s pages do not present them as a single portable browser-assistant memory.

#### Microsoft Copilot in Edge

**M-1 — Browser-native side pane and browsing context.**

- **Claim:** Copilot is built into Edge’s side pane on desktop and mobile. Depending on prompt and Context Clues settings, it can use the current webpage, title, open tabs, screenshots, and browser history to summarize webpages/videos/PDFs, compare pages, and suggest prompts.
- **Visible evidence:** Microsoft’s setup guide opens Copilot from the Edge toolbar into the sidebar and enumerates the browsing inputs; its work guide says the experience stays beside the current page on desktop or mobile.
- **Source:** [Getting started with Copilot in Microsoft Edge](https://support.microsoft.com/en-US/microsoft-copilot/getting-started-with-copilot-in-microsoft-edge), Microsoft Support, current page, accessed 2026-08-27; [Using Microsoft Copilot in Edge at work](https://support.microsoft.com/en-us/microsoft-copilot/using-microsoft-copilot-in-edge-at-work), Microsoft Support, current page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** Consumer Copilot and Microsoft 365 Copilot for work have different licensing, data protection, and preview status. “Compare information across pages” is documented, but the consumer help does not specify a fixed maximum number of tabs.

**M-2 — Voice, screen/vision, and files.**

- **Claim:** Copilot Vision in Edge is a voice-led screen/page-sharing mode that persists as the user browses supported pages; it can discuss and highlight but does not itself click, type, or scroll. Copilot chat separately supports image/file upload.
- **Visible evidence:** Microsoft says Vision can view a chosen screen, app, page, or camera feed and works in Edge, Windows, macOS, iOS, and Android subject to rollout/subscription; a separate upload help lists PDF/DOCX/XLSX/PPTX/images/text formats, up to 20 files and 50 MB each.
- **Source:** [Using Copilot Vision with Microsoft Copilot](https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-vision-with-microsoft-copilot), Microsoft Support, current page, accessed 2026-08-27; [File upload in Microsoft Copilot](https://support.microsoft.com/en-US/microsoft-copilot/file-upload-in-microsoft-copilot), Microsoft Support, current page, accessed 2026-08-27.
- **Confidence:** High for Copilot; Medium for exact Edge-sidebar upload parity because the upload article covers Microsoft Copilot broadly.
- **Contradictions / gaps:** Vision requires Microsoft 365 Personal, Family, or Premium per its current page and is advisory, not agentic. The sidebar’s selection-specific workflow was not clearly documented in the sources reviewed.

**M-3 — Page actions and control model.**

- **Claim:** Browse with Copilot (formerly Actions in Edge) works in the current tab or a new tab, uses local browser state/cookies, and can select, scroll, type, navigate, fill forms, and execute multi-step tasks. The user sees steps in real time and can interrupt or take over. Site access supports Light/Balanced/Strict permission modes and allow-once/always/cancel choices.
- **Visible evidence:** The current help page says actions run locally in Edge, marks the active task tab, and explicitly promises interrupt/takeover. The permissions page documents curated site support, site allow/block lists, and approval prompts.
- **Source:** [Browse with Copilot](https://support.microsoft.com/en-us/microsoft-copilot/browse-with-copilot), Microsoft Support, current page, accessed 2026-08-27; [Copilot Actions in Edge](https://support.microsoft.com/en-us/topic/copilot-actions-in-edge-5ed5e17e-42df-40a3-984a-20420eba86e2), Microsoft Support, current preview documentation, accessed 2026-08-27.
- **Confidence:** High for capability and control shape; Medium for rollout details.
- **Contradictions / gaps:** Naming changed from Actions to Browse with Copilot. Consumer rollout is stated as Microsoft 365 Premium in the US with more markets to follow; the work version is a separate limited, tenant-opt-in preview. Microsoft warns not to use it for banking, government IDs, medical records, or highly confidential data.

**M-4 — Memory, privacy, and retention.**

- **Claim:** Context Clues can be disabled; browsing context itself is not saved in Copilot conversation history, while prompts/responses are. Copilot memory/personalization and use of Microsoft activity are separately controllable; consumer conversation activity is retained for 18 months by default and future training use can be disabled.
- **Visible evidence:** Context Clues lists URL, title, page content/screenshots, and history and says browsing context is not retained in chat history. Copilot privacy controls expose personalization/memory, Microsoft usage data, training, and delete controls.
- **Source:** [How Context Clues work in Copilot in Edge](https://support.microsoft.com/en-US/microsoft-copilot/how-context-clues-work-copilot-edge), Microsoft Support, current page, accessed 2026-08-27; [Microsoft Copilot privacy controls](https://support.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-privacy-controls), Microsoft Support, current page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** Agent screenshots have their own retention behavior: the older Actions preview page says screenshots are stored with the conversation for up to 30 days, whereas ordinary Context Clues says browsing context is not in history. Treat action-run evidence and normal sidebar context as separate data paths.

#### Perplexity Comet

**P-1 — AI-native browser, sidecar, current-page and multi-tab UX.**

- **Claim:** Comet is a separate Chromium browser with a collapsible Assistant sidecar. It extracts visible text, headlines, and metadata from the active page on request, accepts explicit `@tab` context, summarizes multiple recent tabs, and can run multiple errands in parallel while the user continues browsing.
- **Visible evidence:** Perplexity calls Assistant a panel beside the main browser window; examples include “Summarize my last five tabs.” The quick-start guide names cross-tab intelligence, page/image understanding, one-click summaries, and Voice Mode.
- **Source:** [Assistant Panel](https://www.perplexity.ai/help-center/comet/en/articles/11734688-assistant-panel), Perplexity Comet Help Center, 2026-03-04; [Comet Quick Start Guide](https://www.perplexity.ai/comet/resources/articles/comet-quick-start-guide), Perplexity Comet Resource Hub, current page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** The sidecar page says it extracts visible page content every request, while the privacy page emphasizes minimum required context. No fixed maximum tab count is documented.

**P-2 — Selection, inline writing, voice, and files.**

- **Claim:** Selecting webpage or input-field text opens an Inline Assistant for summarize/fact-check/translate/rewrite/generate; results can be inserted into the field or sent to the sidecar. Comet also documents hands-free Voice Mode. Perplexity broadly supports documents, images, audio, video, files, and folders, but exact attachment parity inside the Comet sidecar is not explicit in the source reviewed.
- **Visible evidence:** The Inline Assistant page enumerates reading and writing actions and direct insertion; the quick-start page names Voice Mode for browsing, search, and tab management; Perplexity’s file help lists supported input types.
- **Source:** [Inline Assistant](https://www.perplexity.ai/help-center/comet/en/articles/13533742-inline-assistant), Perplexity Comet Help Center, 2026-02-19; [Comet Quick Start Guide](https://www.perplexity.ai/comet/resources/articles/comet-quick-start-guide), Perplexity, current page, accessed 2026-08-27; [File Uploads](https://www.perplexity.ai/help-center/en/articles/10354807-file-uploads), Perplexity Help Center, updated 2026-07-16.
- **Confidence:** High for selection/voice; Medium for files in sidecar.
- **Contradictions / gaps:** Inline Assistant says mobile support “may vary” and calls itself available in the Comet browser extension, despite Comet also being a full browser. This terminology should be product-tested before relying on it.

**P-3 — Browser control, parallel work, and approvals.**

- **Claim:** Comet can click, navigate, fill forms, and perform complex multi-site/multi-tab workflows. Before the first advanced agent/automation it asks Allow this time / Always allow / Don’t allow; Assistant can be paused. Enterprise adds per-domain Browser Control, Read Only, and No Access plus an option to forbid “Always Allow.”
- **Visible evidence:** The vendor changelog says the upgraded Assistant handles multi-site workflows across multiple tabs in parallel and asks for approval before doing anything in the browser. Enterprise help enumerates action and domain permission modes.
- **Source:** [Upgraded Comet Assistant, GPT-5.1 and GPT-5.1 Thinking](https://www.perplexity.ai/changelog/what-we-shipped-november-14th), Perplexity changelog, 2025-11-13; [Managing Comet Assistant permissions](https://www.perplexity.ai/help-center/en/articles/13531023-managing-comet-assistant-permissions), Perplexity Help Center, updated 2026-07-16; [Comet Assistant Privacy & Data Use](https://www.perplexity.ai/help-center/comet/en/articles/12867415-comet-assistant-privacy-data-use), Perplexity Comet Help Center, 2026-03-04.
- **Confidence:** High.
- **Contradictions / gaps:** Consumer documentation gives the first-run grant shape but does not clearly enumerate per-consequential-action confirmations or a manual takeover flow comparable to Chrome/Edge. “Pause” is visible on the product page, but resume/takeover semantics need hands-on confirmation.

**P-4 — Privacy, sync, and platforms.**

- **Claim:** By default Assistant does not upload the full history/tab list, cookies, passwords/autofill, local files, or typed website input. Required page/history/tab context can be stored up to 30 days as a temporary Perplexity thread. The browser can sync bookmarks, passwords, autofill, history, extensions, and tabs using a user-held passphrase. Comet is advertised for macOS, Windows, iOS, and Android.
- **Visible evidence:** The privacy help separates local data from request-specific uploads and provides per-site blocking/disable controls. Sync documentation says only the passphrase decrypts data and users may toggle each type.
- **Source:** [Comet Assistant Privacy & Data Use](https://www.perplexity.ai/help-center/comet/en/articles/12867415-comet-assistant-privacy-data-use), Perplexity, 2026-03-04; [Sync Between Devices](https://www.perplexity.ai/help-center/comet/en/articles/12569908-sync-between-devices), Perplexity, 2026-03-04; [Comet Browser: a Personal AI Assistant](https://www.perplexity.ai/comet), Perplexity, current product page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** Browser-data sync is not the same as Assistant conversation/memory continuity. The 30-day context statement and optional removal of the expiration timer imply users can deliberately retain threads longer.

#### Dia

**D-1 — AI-native browser, Chat panel, page/tab/history context, and Skills.**

- **Claim:** Dia is a separate browser with Chat reachable from any tab. It can use the current page, other explicitly mentioned tabs, selected text, browser history, and editable reusable Skills; tab groups can be attached wholesale as context.
- **Visible evidence:** Dia’s install FAQ explicitly lists current tab, other tabs, selected text, history, memory, and Skills. Release notes say `@`-mentioning a Tab Group attaches all tabs as a context container.
- **Source:** [Installing Dia is as easy as 1-2-3](https://www.diabrowser.com/download/thanks), Dia / The Browser Company, current page, accessed 2026-08-27; [Dia v1.14.0](https://www.diabrowser.com/changelog/1-14-0), Dia, 2026-01-14.
- **Confidence:** High.
- **Contradictions / gaps:** Dia’s current pricing page now puts AI behind Better Answers / Better Days after a trial for most new Mac users; the older install FAQ still says the free tier includes all features including everyday AI Chat. Use the pricing page for current commercial availability.

**D-2 — Voice and deterministic browser/tool actions.**

- **Claim:** Dia supports streaming voice transcription. Chat exposes receipts for tab-related tool calls—what it read, opened, and closed—and can deterministically act on tabs/URLs. It also routes requests to connected Gmail, Calendar, Slack, or Tabs tools and supports shortcuts that create new documents, spreadsheets, slides, tickets, wikis, Jira items, meetings, and more.
- **Visible evidence:** Dia 1.6.0 and 1.9.0 release notes enumerate voice transcription, tool-call bylines, tab actions, automatic tool selection, and creation shortcuts.
- **Source:** [Conversations, Context, and Chat](https://www.diabrowser.com/release-notes/1-6-0-conversations-context-chat), Dia, 2025-11-20; [Dia v1.9.0](https://www.diabrowser.com/changelog/1-9-0), Dia, 2025-12-10.
- **Confidence:** High.
- **Contradictions / gaps:** These are browser-shell/tab and connected-service actions. No current official source was found showing arbitrary live-page clicking, scrolling, form fill, checkout, or a general manual takeover/approval system. Do not classify Dia as equivalent to Chrome auto browse, Edge Browse, Comet browser control, or Neon Do without new evidence.

**D-3 — Memory, privacy, and sync.**

- **Claim:** Dia stores chat history locally. It sends only request-relevant context to model providers under zero-data-retention terms; optional product-improvement content is de-linked from the account and deleted after 30 days and can be disabled. Memory can use browsing/activity context, excludes sensitive/incognito sites, and is user-controllable. Browser sync is end-to-end encrypted with device-held keys and covers bookmarks, tabs, and profiles.
- **Visible evidence:** The 2026-08-20 release note and privacy page describe local chat and provider processing; the 2025-09 memory release documents per-profile enable/disable and deletion; the security bulletin details AES-256-GCM, SPAKE transfer, and server unreadability.
- **Source:** [Notes from the roadmap](https://www.diabrowser.com/release-notes/latest), Dia, 2026-08-20; [Dia Privacy](https://www.diabrowser.com/privacy), Dia / The Browser Company, current page, accessed 2026-08-27; [What’s New in Dia v0.45.0](https://www.diabrowser.com/changelog/0-45-0), Dia, 2025-09-07; [How Dia Sync keeps your data safe by design](https://www.diabrowser.com/security/bulletins), Dia Security Bulletin, 2026-04-29.
- **Confidence:** High.
- **Contradictions / gaps:** The privacy page says some de-identified content is used for improvement by default, while the latest release note says turning the setting off means none is sent. “Sync” covers browser state; whether AI memories/chats sync was not explicitly established in the reviewed source.

**D-4 — Platforms and current commercial constraint.**

- **Claim:** Dia is currently a macOS-first browser (macOS 14+, Apple silicon); Windows is announced for fall 2026 rather than generally available at the cut-off. Cross-device browser sync is included in the free browser tier; paid AI begins at $20/month for new eligible Mac users, with a $100/month higher-work tier.
- **Visible evidence:** The main product page states the macOS requirement, the Windows page says “coming this fall,” and the plans page lists tier features and rollout.
- **Source:** [Dia — A browser you won’t dread opening](https://www.diabrowser.com/index), Dia, current product page, accessed 2026-08-27; [Dia on Windows](https://www.diabrowser.com/windows), Dia, current page, accessed 2026-08-27; [Dia Plans](https://www.diabrowser.com/plans), Dia, current page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** Dia release notes say “Dia’s coming to Windows,” consistent with the Windows page; any Windows private beta should not be labeled GA.

#### Opera One AI / Aria

**O-1 — Product-name correction and distribution.**

- **Claim:** The current free assistant in Opera One is browser-native and account-free, but Opera announced in 2025 that “Opera One AI” replaces first-generation Aria. Older live Aria pages still describe the prior name and should be treated as capability history, not clean current naming.
- **Visible evidence:** Opera’s announcement explicitly says the new Opera One AI is rebuilt from Neon Chat Agent and is “replacing our first generation free browser AI named Aria”; no third-party extension is required. The still-live Aria product page says it is built in and available on desktop, Android, and iOS.
- **Source:** [Opera One is getting an upgraded built-in AI from Opera Neon](https://blogs.opera.com/news/2025/10/opera-one-upgraded-built-in-ai/), Opera News, 2025-10-29; [Aria browser AI](https://www.opera.com/features/aria), Opera, live legacy/current product page, accessed 2026-08-27.
- **Confidence:** High for the rename/replacement; Medium for exact feature parity under the new name.
- **Contradictions / gaps:** Opera’s site simultaneously exposes “Aria” and newer “Opera AI” pages. A final comparison should label the row “Opera One AI (Aria successor)” and date any Aria-specific claim.

**O-2 — Side panel, page/doc context, images, and voice.**

- **Claim:** The confirmed Aria UX includes sidebar, compact Command Line, and full-tab chat. Page Context reads the current webpage and text-based PDFs/Google Docs; image input supports upload and right-click “send to Aria”; current product help confirms text-to-speech. A fully conversational voice mode was introduced in Opera Developer, but stable parity is not clearly confirmed by a current source.
- **Visible evidence:** Opera’s product and feature-drop pages document moving chat between sidebar/tab, Page Context, image understanding, and TTS; the 2025 voice post explicitly labels the feature an Opera Developer drop.
- **Source:** [Aria browser AI](https://www.opera.com/features/aria), Opera, current page, accessed 2026-08-27; [Aria can now read PDFs and Docs from Command Line](https://blogs.opera.com/news/2025/04/aria-command-line-page-context-mode-read-pdf-and-docs/), Opera News, 2025-04-03; [New Image Understanding shortcut for Aria AI](https://blogs.opera.com/news/2025/02/image-understanding-shortcut-for-aria/), Opera News, 2025-02-06; [Aria conversation](https://blogs.opera.com/news/2025/03/opera-aria-conversation-ai-feature-drop/), Opera News, 2025-03-13.
- **Confidence:** High for page/docs/images/TTS; Medium for current full voice conversation.
- **Contradictions / gaps:** No evidence in these sources for explicit multi-tab content synthesis in ordinary Aria chat; “tabs” on the current Opera AI page is broader but not quantified.

**O-3 — Agentic scope is tab management, with local privacy and undo.**

- **Claim:** Stable Opera One Tab Commands can close, group, pin, and bookmark tabs from natural language. Only the command is sent to the Aria server; tab data/classification and execution stay local. The user receives a recap and can undo changes.
- **Visible evidence:** Opera’s stable announcement lists the four operations, two launch points, local processing, and keep/undo flow. It also says Tab Commands cannot be triggered from the sidebar chat.
- **Source:** [Command your tabs with AI in Opera One](https://blogs.opera.com/news/2025/03/ai-tab-commands-in-opera-one/), Opera News, 2025-03-26; [Opera now lets you chat with AI to manage your tabs](https://blogs.opera.com/news/2024/10/opera-introduces-ai-powered-tab-commands/), Opera News, 2024-10-10.
- **Confidence:** High.
- **Contradictions / gaps:** This is not evidence of arbitrary webpage control. Opera’s broader general-browser privacy page says browsing history/content/typed text are not collected as browser telemetry, but it does not fully specify prompt/page-context retention for Opera AI; do not infer zero retention for page-context chats from the Tab Commands architecture.

#### Brave Leo

**B-1 — Native sidebar/full-page assistant, multi-tab, selection, and files.**

- **Claim:** Leo is built into Brave (no extension/account required) and opens in a sidebar or full-page chat. It can use current-page content and highlighted text, `@`-mention one or multiple tabs, attach PDFs/images, analyze Google Docs/Sheets, and organize/find tabs.
- **Visible evidence:** The help center explicitly says no extra app/extension; the personalization release lists multi-tab mentions and attachments; the product page names sidebar/full-page history and tab organization.
- **Source:** [How do I use Brave Leo?](https://support.brave.com/hc/en-us/articles/20958609786637-How-do-I-use-Brave-Leo), Brave Help Center, updated 2025-03-18; [Leo personalization, model updates, and more](https://brave.com/whats-new/leo-personalization/), Brave, Brave 1.82 release page, accessed 2026-08-27; [Brave Leo AI](https://brave.com/leo/), Brave, current product page, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** Current sources confirm file/image attachments but not a dedicated rectangle/screenshot selection tool comparable to Gemini in Chrome.

**B-2 — Voice, platforms, personalization, and cross-device.**

- **Claim:** Leo is available on Windows, macOS, Linux, Android, and iOS. Android/iOS have voice input; current official material does not confirm desktop full-duplex voice. User-supplied personalization and memories remain on-device, and chat history is encrypted/local. Premium may cover five devices, but AI history/memory sync is not confirmed.
- **Visible evidence:** Brave’s product/help pages list all five platforms and iOS voice-to-text; the privacy policy and personalization page state local storage and no server retention.
- **Source:** [Brave Leo AI](https://brave.com/leo/), Brave, current page, accessed 2026-08-27; [Browser Privacy Policy](https://brave.com/privacy/browser/), Brave, updated 2026-03-13; [Leo personalization, model updates, and more](https://brave.com/whats-new/leo-personalization/), Brave, accessed 2026-08-27.
- **Confidence:** High.
- **Contradictions / gaps:** Brave’s 2025 roadmap listed cross-device sync as future work. The reviewed current pages do not establish that it shipped for conversations or memories; do not infer it from multi-device Premium entitlement.

**B-3 — Experimental AI browsing is isolated and visibly interruptible.**

- **Claim:** Leo’s agentic browsing is opt-in behind a feature flag, available for early testing in all release channels, and runs in an isolated profile rather than the user’s ordinary signed-in profile. It executes in a visible open tab, supports inspection/pause, prevents the AI from deleting session logs, and requires explicit permission when alignment checks detect a mismatch.
- **Visible evidence:** Brave’s 2026-updated announcement lists the isolation and invocation model; security details enumerate unavailable internal/non-HTTPS/unsafe pages and misalignment warnings.
- **Source:** [AI browsing now available for early testing in Brave](https://brave.com/blog/ai-browsing/), Brave, 2025-12-10, updated 2026-05-05; [Browser Privacy Policy](https://brave.com/privacy/browser/), Brave, updated 2026-03-13.
- **Confidence:** High for preview behavior; Medium for maturity/site coverage.
- **Contradictions / gaps:** Isolation is a privacy/safety strength but prevents acting in the user’s normal authenticated browsing state unless the user separately signs in within the isolated profile. The sources reviewed do not provide a stable-release date or a detailed consequential-action confirmation taxonomy.

**B-4 — Privacy differentiator.**

- **Claim:** Brave says Leo does not log IP addresses or retain prompts/responses/context on its servers, does not train on conversations, stores optional chat history locally, and uses unlinkable Premium tokens. Experimental AI browsing maintains the same no-log/no-retention commitment.
- **Visible evidence:** The browser privacy policy enumerates data fields per mode and retention as ephemeral; it separately describes feedback retention.
- **Source:** [Browser Privacy Policy](https://brave.com/privacy/browser/), Brave, updated 2026-03-13; [Verifiable Privacy and Transparency](https://brave.com/blog/browser-ai-tee/), Brave, 2025-11-20.
- **Confidence:** High.
- **Contradictions / gaps:** Voluntary feedback is a separate data path and can include the full conversation, current site, model, and subscription state, retained for one year.

#### Firefox Smart Window

**F-1 — Material first-party addition: optional assistant window, not merely a third-party chatbot iframe.**

- **Claim:** Smart Window is an optional Firefox desktop window type with a built-in assistant in the Smart Bar/sidebar. It automatically uses the current page, lets users attach one or more recent tabs via `@`, searches the web, retrieves history, and can group or close tabs.
- **Visible evidence:** Mozilla’s help center explicitly contrasts the assistant with the separately available provider-choice chatbot sidebar and documents page/tab/history use and tab commands.
- **Source:** [Get started with Smart Window](https://support.mozilla.org/en-US/kb/smart-window), Mozilla Support, updated 2026-08; [Smart Window Privacy Notice](https://www.mozilla.org/en-US/privacy/smart-window/), Mozilla, 2026-04-21.
- **Confidence:** High.
- **Contradictions / gaps:** Smart Window is early beta and distinct from Firefox’s older sidebar that embeds Claude/ChatGPT/Gemini/Mistral/Copilot. The provider-choice sidebar is distribution infrastructure, not a Mozilla assistant with browser-native context semantics.

**F-2 — Deliberately non-agentic boundary.**

- **Claim:** Smart Window can manage tabs, but Mozilla explicitly says it cannot click buttons, fill forms, purchase/book, change settings, sign in, or act independently.
- **Visible evidence:** The help page has a “What the assistant can’t do” list containing each of these actions.
- **Source:** [Get started with Smart Window](https://support.mozilla.org/en-US/kb/smart-window), Mozilla Support, updated 2026-08.
- **Confidence:** High.
- **Contradictions / gaps:** The safety page discusses action restrictions for untrusted/private content generically, but the product help is unambiguous that current user-facing Smart Window does not perform page actions.

**F-3 — Local memory, proxied models, opt-in controls, and BYOM.**

- **Claim:** Smart Window can infer interests from assistant and non-private Firefox activity, process them on Mozilla servers, then store expiring Memories locally. Queries go through a Mozilla proxy so the model provider sees Mozilla’s IP rather than the user’s; conversations are not collected for training/human review unless the user opts in. Users can inspect/delete/disable memories or use an OpenAI-compatible local/remote custom endpoint.
- **Visible evidence:** Mozilla’s privacy notice and safety help state the proxy, local memory, and opt-in data collection model; BYOM help documents Ollama/Lemonade/OpenRouter setup.
- **Source:** [Smart Window Privacy Notice](https://www.mozilla.org/en-US/privacy/smart-window/), Mozilla, 2026-04-21; [Is Smart Window safe and private](https://support.mozilla.org/en-US/kb/smart-window-safety), Mozilla Support, updated 2026-08; [Custom Models in Smart Window](https://support.mozilla.org/en-US/kb/smart-window-byom), Mozilla Support, updated 2026-08.
- **Confidence:** High.
- **Contradictions / gaps:** Browser activity outside Smart Window may contribute to Memories unless private or disabled. The reviewed source does not establish cross-device sync for chats/memories, file/screenshot input, or voice in Smart Window.

**F-4 — Availability constraint.**

- **Claim:** Smart Window is desktop-only early beta, requires a Mozilla account, and rolls out gradually beginning with US/Canada in Firefox 150 and France in Firefox 155; daily assistant limits apply.
- **Visible evidence:** The current help page states the rollout, account requirement, and midnight-ET limit reset.
- **Source:** [Get started with Smart Window](https://support.mozilla.org/en-US/kb/smart-window), Mozilla Support, updated 2026-08.
- **Confidence:** High.
- **Contradictions / gaps:** No general global availability or mobile Smart Window was evidenced.

#### Opera Neon — adjacent premium agentic benchmark

**N-1 — Task-scoped agentic browser with local logged-in execution.**

- **Claim:** Neon is a separate premium browser. Tasks are isolated mini-browser workspaces containing tabs/documents/context; Neon Do opens/closes tabs and performs live web actions for shopping, booking, research, and job applications inside the user’s actual signed-in browser session. Actions are visible in real time and can be paused or taken over.
- **Visible evidence:** Opera’s launch post directly describes Task isolation, local browser-session execution, examples, visibility, pause, and takeover.
- **Source:** [Opera Neon ships: this AI agentic browser is built to act](https://blogs.opera.com/news/2025/09/opera-neon-agentic-ai-browser-release/), Opera News, 2025-09-30.
- **Confidence:** High.
- **Contradictions / gaps:** “Local” describes browser execution/context use; Neon’s Make outputs use a European-hosted VM. The reviewed primary source does not fully specify retention, memory, voice, or cross-device behavior.

**N-2 — Public access, price, and programmable browser bridge.**

- **Claim:** Neon entered public early access at $19.90/month. Its built-in MCP server lets external AI clients list tabs, read page content, take screenshots, click, fill forms, and open tabs in the authenticated live browser, with separate read/write tool permissions.
- **Visible evidence:** Opera’s public-access announcement states price and four built-in agents; its MCP post enumerates read and write capabilities and authenticated sessions.
- **Source:** [Opera Neon becomes available in public early access](https://blogs.opera.com/news/2025/12/opera-neon-becomes-available-in-public-early-access/), Opera News, 2025-12-11; [Opera Neon now supports MCP Connector](https://blogs.opera.com/news/2026/03/opera-neon-adds-mcp-connector-to-the-browser/), Opera News, 2026-03-31.
- **Confidence:** High.
- **Contradictions / gaps:** Neon is a premium adjacent benchmark, not the free Opera One/Aria row. MCP enables an extension-like bridge for third-party agents, but it is built into Neon and does not imply that a Chrome extension is required for Neon’s own agent.

#### OpenAI distribution shift — not a current browser row

**A-1 — Atlas was retired before the cut-off; OpenAI moved browser work into ChatGPT desktop and Chrome surfaces.**

- **Claim:** ChatGPT Atlas is not a current competitor as of 2026-08-27: OpenAI scheduled it to stop working on 2026-08-09. OpenAI directs deeper browser-agent work to the ChatGPT desktop app and mentions a Chrome extension/sidebar where available.
- **Visible evidence:** The retirement help page gives the shutdown date and says the replacement direction includes multiple tabs, downloads, navigation, and account login support.
- **Source:** [Evolving Atlas into ChatGPT for browser-based agentic work](https://help.openai.com/en/articles/20001371), OpenAI Help Center, updated 2026-07.
- **Confidence:** High.
- **Contradictions / gaps:** Official help does not yet give a complete feature/permission matrix for the Chrome extension/sidebar, so it should not be compared feature-for-feature here.

**A-2 — Current adjacent host: ChatGPT desktop built-in browser.**

- **Claim:** The current ChatGPT desktop app on macOS and Windows has its own embedded browser state and supports tabs, downloads, sign-in, autofill/password management, extensions, and shared user/agent page work; cloud browser tasks can continue in the background.
- **Visible evidence:** OpenAI’s current help says the user and ChatGPT see the same page, tasks work across tabs, and the browser is launched from Chat/Work/Codex.
- **Source:** [Using the built-in browser in the ChatGPT desktop app](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app), OpenAI Help Center, updated 2026-08.
- **Confidence:** High.
- **Contradictions / gaps:** This is an adjacent app-owned browser, not a side panel over the user’s normal Chrome/Edge session. It changes the distribution comparison but is not evidence that a Cognia Chrome extension is required.

### Cross-record gaps to preserve for the final comparison

- **Screenshot semantics differ:** Gemini offers user-drawn page-region attachment; Edge Vision offers shared-screen conversation; Edge/agentic products internally capture screenshots to act; Comet/Dia/Opera/Brave do not all expose an equivalent user-facing screenshot tool in the sources reviewed.
- **“Multi-tab” is not one capability:** Google exposes an explicit 10-tab attachment cap; Comet supports named tabs and parallel errands; Dia/Brave/Firefox expose explicit `@` attachments; Edge uses open tabs context without a documented cap; Opera One’s confirmed agentic feature classifies/manages tabs locally rather than necessarily synthesizing their page bodies.
- **“Memory” is also not one capability:** local user-written preferences (Brave), inferred local memories (Dia/Firefox), browser-history retrieval (Google/Edge), connected-product Personal Intelligence (Google/Microsoft), and encrypted browser sync (Comet/Dia) should be scored separately.
- **Approval evidence is strongest where actions are broad:** Chrome documents plan review plus action-specific confirmation/takeover; Edge documents permission modes and takeover; Comet documents launch/site grants; Brave documents pause and misalignment permission; Opera One documents undo for tab actions; Dia and Firefox do not expose a comparable general page-action approval model because broad in-page control is not evidenced/currently disallowed.
- **No representative product requires a third-party extension for its own core assistant:** the dominant pattern is browser-native integration or a separate AI-native browser. Extension/sidebar bridges appear as distribution supplements (OpenAI Chrome surface), inline helpers, or external-agent bridges (Opera Neon MCP), not as a prerequisite for the product’s own browser engine.

## 附录 B：Agent bridge 与开发者执行层关键一手来源

### ChatGPT / Codex browser surfaces

- [ChatGPT Chrome extension — official Chrome Web Store listing](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg?hl=en)：side chat、跨标签上下文、后台浏览器控制、桌面 App/插件/文件系统连接，以及新站点、历史、上传下载前的确认。
- [Using the built-in browser in the ChatGPT desktop app](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)：独立本地浏览器状态、多标签、下载、登录、annotation，以及何时改用 Chrome extension。
- [Using cloud browser in ChatGPT](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt)：独立云端状态、离线继续、站点权限、关键动作确认、安全登录和 takeover。
- [Using site tools in the ChatGPT desktop app](https://help.openai.com/en/articles/20001423-using-site-tools-in-the-chatgpt-desktop-app)：WebMCP site tools、当前页面/登录态、tool activity 与敏感操作确认。
- [Evolving Atlas into ChatGPT for browser-based agentic work](https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work)：Atlas 终止及能力转向桌面 App、Chrome extension/sidebar。

### Claude in Chrome

- [Get started with Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)：侧边栏、Cowork/Claude Code 桥接、任务标签组、DOM/console/network、workflows 和 scheduled tasks。
- [Claude in Chrome permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)：Manual/Auto/Skip、站点级授权、protected/prohibited actions、权限历史与撤销。
- [Claude in Chrome admin controls](https://support.claude.com/en/articles/13065128-claude-in-chrome-admin-controls)：组织级 allowlist/blocklist 与企业控制。

### Manus Browser Operator

- [Introducing Manus Browser Operator](https://manus.im/en/blog/manus-browser-operator)：真实本地登录态、一次性授权、任务标签组、实时接管、关标签即停止、动作日志与跨设备启动。
- [Manus AI Browser Operator — Chrome Web Store](https://chromewebstore.google.com/detail/manus-ai-browser-operator/cecngibhkljoiafhjfmcgbmikfogdiko)：当前扩展分发、能力和数据披露。

### Sider / Claw

- [Sider Chat](https://sider.ai/chat)：多模型 side panel、页面/PDF/视频、选中文本、多标签与翻译。
- [Sider Claw](https://sider.ai/agents/claw)：现有登录态、跨站多标签 Agent、可见步骤、文件产出、云端计算机和跨会话记忆。
- [Introducing Browser Agent](https://sider.ai/whats-new/browser-extension/sider-v5_20_0)：侧边栏中逐步执行和随时 Stop 的早期产品路径。

### Playwright MCP Extension

- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)：accessibility snapshot、标签工具、persistent/isolated profile 与 extension mode。
- [Connecting to browsers with the Playwright Extension](https://github.com/microsoft/playwright.dev/blob/main/mcp/configuration/browser-extension.mdx)：复用现有标签、登录态、Cookie 和已安装扩展。
- [Playwright browser extension README](https://github.com/microsoft/playwright/tree/main/packages/extension)：tab picker、多 client 彩色标签组、单标签归属和状态页断开。

### Browser Use

- [Browser Use repository](https://github.com/browser-use/browser-use) 与 [releases](https://github.com/browser-use/browser-use/releases)：本地 CLI/Python、CDP、运行中 Chrome/Profile 与版本能力。
- [Cloud Agent quickstart](https://docs.browser-use.com/cloud/agent/quickstart)：云端自然语言浏览器 Agent。
- [Human in the loop](https://docs.browser-use.com/cloud/agent/human-in-the-loop) 与 [Live Preview](https://docs.browser-use.com/cloud/browser/live-preview)：交互式远程页面、人工处理敏感步骤并恢复任务。
- [The Bitter Lesson of Agent Frameworks](https://browser-use.com/posts/bitter-lesson-agent-frameworks)：BU Agent 中 CDP 与 browser-extension APIs 的互补关系。

### Browserbase / Stagehand

- [Stagehand v4](https://www.browserbase.com/blog/stagehand-v4)：随浏览器生命周期加载的内部 runtime extension、CDP session 和多 client 限制；它不是用户安装的消费级侧边栏。
- [Stagehand Agent](https://docs.stagehand.dev/v3/basics/agent)：DOM、CUA visual 和 hybrid 多步 Agent。
- [Browser Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)、[Session Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view)、[Keep Alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive)：云端持久状态、实时接管和长会话。

### Opera Neon programmable browser

- [Opera Neon ships](https://blogs.opera.com/news/2025/09/opera-neon-agentic-ai-browser-release/)：Task workspace、真实登录态内的 Neon Do、可见执行、Pause/Take over 与云端 Make。
- [Opera Neon MCP Connector](https://press.opera.com/2026/03/31/opera-neon-adds-mcp-connector/)：向第三方 Agent 暴露 live tabs、page content、screenshots、navigation 和 form actions。
- [Free MCP/CLI connection tier](https://blogs.opera.com/news/2026/08/your-ai-agents-can-use-opera-neon-free-of-charge/)：Neon 作为外部 Agent 浏览器执行层的当前分发形态。
