# Claude Cowork 与 ChatGPT Work 能力对比

> 调研日期：2026-07-22  
> 访问日期：本文所有网页均于 2026-07-22 访问。  
> 范围：只比较 Claude Cowork 与 OpenAI ChatGPT Work 的用户可见能力、执行架构、安全与权限、Skills/Plugins/Connectors/MCP、本地文件/浏览器/终端、后台与并行工作、规划/验证、会话与制品。  
> 证据原则：只使用 Anthropic 和 OpenAI 官方产品页、帮助中心、文档、发布说明及官方规范链接；不使用媒体、社区帖子或第三方评测。本文是能力层研究，不涉及 Cognia 的实现或方案建议。

## 1. 术语与比较边界

OpenAI 的官方产品名是 **ChatGPT Work** 或 **Work mode**，不是“Codex Work mode”。OpenAI 说明 Work mode 把 Codex 背后的技术带入 ChatGPT，面向研究、分析、文档、表格、演示、报告和 Sites；**Codex 仍是独立的软件开发视图**，拥有独立历史，侧重 repository、terminal 和 developer tools。本文将用户所说的“Codex Work mode”规范为 **ChatGPT Work（基于 Codex 技术）**；只在 Work 的桌面执行边界直接复用 Codex runtime 时引用 Codex 文档。[ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275) [Get started with Work mode](https://learn.chatgpt.com/docs/get-started-with-work) [Work mode admin FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq)

Claude Cowork 同样不是 Claude Code 的改名版本。Anthropic 将它定义为把 Claude Code 的 agentic architecture 用于非编程知识工作的体验，不要求用户操作 terminal；Claude Code 仍是开发者产品。[Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [Claude Cowork product page](https://www.anthropic.com/product/claude-cowork)

两边都处于快速迭代期。Cowork 的 remote sessions 在 web/mobile 仍为 beta；ChatGPT Work 于 2026-07-09 发布并仍在分批 rollout。本文描述的是调研日公开能力，不把 beta/preview 行为当作长期稳定契约。[Claude Cowork surfaces](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile) [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)

## 2. 结论摘要

两者已经收敛为同一产品类别：用户描述结果，agent 自行规划、多步执行、调用文件和外部系统，用户可在执行中观察、纠偏和批准关键动作，最后得到可审阅的制品。核心差异不在“能否生成文档”，而在执行拓扑、并行模型、浏览器边界、扩展包结构和制品持久化方式。

1. **执行拓扑不同。** Cowork 当前 remote-by-default：agent loop 与 code/shell 在 Anthropic 的每会话临时 sandbox 中运行，本地文件和浏览器经在线 Claude Desktop 代理访问；旧有 desktop deployments 仍可本地运行，并把 code execution 放进专用 Linux VM。Work 的 web/mobile 工作在 cloud；desktop local chat 则在用户机器上通过 OS-enforced sandbox 运行命令。OpenAI 官方明确提醒，不同 Work 任务、scheduled task、desktop chat 和 Codex cloud 可能具有不同 execution environment，不能用一套权限假设覆盖全部表面。[Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview) [Work mode admin FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq) [OpenAI sandbox](https://learn.chatgpt.com/docs/sandboxing)
2. **Cowork 公开承诺内置多 agent 编排，Work 公开承诺多 chat 并行。** Cowork 会拆分 subtasks，并可协调多个 sub-agents 同时工作。OpenAI 对 Work 的公开建议是把独立任务放进不同 chats 并行运行；调研日官方 Work 文档没有承诺单个 Work chat 自动生成并协调 sub-agent team。Codex 本身有多 thread/worktree 和 subagent 能力，但不能据此自动推导 Work chat 具有相同 UI/契约。[Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [OpenAI long-running work](https://learn.chatgpt.com/docs/long-running-work) [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
3. **两者都把低风险自治与高风险批准分开，但机制不同。** Cowork 提供 Manual、Auto、Skip 三种模式；永久删除文件始终需要显式批准。Work desktop 把 sandbox boundary 与 reviewer 分离：Ask for approval、Approve for me/Auto-review、Full access；Auto-review 由独立 reviewer agent 评估越界请求，但不扩张原 sandbox。Full access 明确提高数据丢失、泄漏和意外行为风险。[Cowork getting started](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [OpenAI permissions](https://learn.chatgpt.com/docs/permission-modes) [OpenAI auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
4. **浏览器策略不同。** Cowork 优先 connector，其次 Claude in Chrome，再次 direct computer use；direct computer use 对 desktop apps 没有 sandbox，只用 per-app approval、blocklist、截图理解和 action review 控制风险。Work 同时提供 remote cloud browser（当前只处理无需登录/支付的 public pages）和 desktop built-in browser（可共享页面、支持登录、autofill、password management、多 tab、downloads、annotations），也可借助 Chrome extension 使用现有 profile。[Cowork computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork) [ChatGPT cloud browser](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) [ChatGPT built-in browser](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)
5. **扩展体系概念相近、包装单元不同。** Claude plugin 可把 skills、connectors、sub-agents 组合在一起，hooks/sub-agents 只在 Cowork 运行。OpenAI plugin 可包含 skills、apps 和 app templates；apps 承担外部数据和 actions，保留 source-system permission、workspace action controls 与 approvals。两边都支持 MCP，但 remote MCP 流量主要从各自 cloud 发起；本地/私网 MCP 的可达方式不同。[Claude plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude) [OpenAI plugins](https://help.openai.com/en/articles/20001256) [Claude remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) [OpenAI MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)
6. **Cowork 的特色持久制品是 Live artifacts；Work 的特色是通用文件预览/annotation 与 Sites。** Cowork Live artifact 是可版本回退、按打开时刷新 connector/local-file 数据的 persistent interactive HTML dashboard，当前 desktop-only。Work 在 desktop 可并排预览并 annotation 文档、slides、spreadsheets、PDF 和网页；Work 还可创建、预览和发布 ChatGPT Sites。[Cowork live artifacts](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork) [OpenAI work with files](https://learn.chatgpt.com/docs/artifacts-viewer) [ChatGPT Sites](https://developers.openai.com/codex/sites)

## 3. 能力矩阵

| 维度                  | Claude Cowork                                                                                                                                    | ChatGPT Work（基于 Codex 技术）                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主要定位              | 非技术知识工作的 outcome-to-deliverable agent；同一任务可跨文件、connectors、web 与 apps                                                         | ChatGPT 中面向较长、多步、可交付成果的 Work mode；Codex 仍是独立开发视图                                                                                            |
| 表面                  | Desktop、web、mobile；remote sessions 在 web/mobile 为 beta；desktop 功能最完整                                                                  | Web、mobile、desktop；cloud Work 跨端同步，local desktop chats 留在本机                                                                                             |
| 典型产物              | Formatted docs、Excel formulas、PowerPoint、research、organized files、charts、Live artifacts                                                    | Documents、spreadsheets、presentations、PDF、reports、analysis、workflows、Sites                                                                                    |
| 规划与 steering       | 自动创建 plan、拆 subtasks、显示 progress/approach；执行中可跨端纠偏                                                                             | Work 显示 progress，可回答问题、改方向、批准动作；desktop 支持 `/plan`、`/goal`、pause/resume/edit goal 与 side chat                                                |
| 内部并行              | 官方明确：单任务可协调多个 parallel sub-agents/workstreams                                                                                       | 官方明确：独立 chats 可并行；未公开承诺单 Work chat 自动编排 sub-agent team                                                                                         |
| 后台持续              | Remote session 关闭 laptop 后继续；scheduled tasks 无需 device online                                                                            | Cloud Work/browser 可后台继续；web schedules cloud 执行；需要 local files 的 desktop schedule 要求电脑与 app 在线                                                   |
| 本地文件              | 只访问用户连接的 folders；remote session 通过 desktop bridge；支持 read-only、read-write、read-write-no-delete mount policy；永久删除另行批准    | Desktop 打开 local folder/project 并授权；默认 workspace-write，越界需批准；web/mobile 不能直接访问本机文件                                                         |
| Shell / code          | 无需 terminal UI；remote sandbox 或本地 Linux VM 内运行 code/shell；activity 对用户可见                                                          | Work desktop 可在 sandbox 内运行 local commands；spawned tools（如 git/package managers/test runners）继承 sandbox；Codex 另有显式 integrated terminal/developer UI |
| Browser               | Connector → Claude in Chrome → direct computer use；后者可点按 desktop apps                                                                      | Cloud browser 处理 public, no-login/no-payment tasks；desktop built-in browser 支持登录、多 tab、download、annotations，另可用 Chrome profile                       |
| 权限模式              | Manual / Auto safety screening / Skip；高敏动作仍可强制 human approval                                                                           | Ask for approval / Approve for me（separate reviewer agent）/ Full access；sandbox 与 approvals 分离                                                                |
| Skills                | Instructions/scripts/resources 的可复用 workflow；可个人、组织或 plugin 提供                                                                     | Reusable instructions/examples/code；遵循 Agent Skills open standard；可创建、上传、分享及 workspace 管理                                                           |
| Plugins               | Bundle skills + connectors + sub-agents；hooks/sub-agents 仅 Cowork；支持 marketplace、Git repo、自定义上传                                      | Bundle skills + apps + app templates；Plugin Directory 是发现入口；plugin 与 app permission 分开管理                                                                |
| Connectors / MCP      | Connector 继承 source permission；remote MCP 从 Anthropic cloud 连接；local MCP 仅 desktop/local execution 路径，admin 可禁用                    | Apps 支持 search/sync/actions/UI；custom apps 基于 MCP；远端 MCP，私网可经 Secure MCP Tunnel；RBAC/action control/confirmation 分层                                 |
| Session / project     | Remote session/files 随 Claude account 跨端；Projects 带 files/context/instructions/memory；task deletion 即时移出历史、后端 30 天内删除         | Cloud Work chats 跨 web/mobile/desktop；local chats 不同步；Projects 聚合 chats/files/instructions；Chat/Work recents 合并，Codex history 分离                      |
| 制品生命周期          | 文件可 preview/download；Markdown 可 selection-based in-place edit；Live artifacts 持久、自动刷新、有 version history/restore                    | Desktop 文件与网站可 side-by-side preview + annotation；web 可下载并迭代；Sites 是独立可托管/分享的持久制品                                                         |
| Enterprise visibility | OTel 可记录 prompts、tool/MCP calls、file access 等；当前不进入 Compliance API/audit/data export；VM/remote sandbox 不可被 endpoint EDR 直接观察 | Compliance Logs 覆盖 prompts/responses，但不记录 files/actions/tool calls；Codex local 另可 opt-in OTel；workspace analytics/Compliance API 分工                    |

矩阵证据来自：[Cowork getting started](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)、[Cowork surfaces](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)、[Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)、[Cowork plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)、[ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275)、[Work getting started](https://learn.chatgpt.com/docs/get-started-with-work)、[OpenAI permissions](https://learn.chatgpt.com/docs/permission-modes)、[OpenAI long-running work](https://learn.chatgpt.com/docs/long-running-work)、[OpenAI file viewer](https://learn.chatgpt.com/docs/artifacts-viewer)、[OpenAI scheduled tasks](https://learn.chatgpt.com/docs/automations) 和 [Work admin FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq)。

## 4. 用户工作流、规划与验证

### 4.1 Claude Cowork

Cowork 的公开执行流程是：分析 request → 创建 plan → 必要时拆成 subtasks → 在 isolated environment 运行 code/shell → 适合时协调 parallel workstreams → 返回可 preview/download 的成果。用户先 review approach 再放行；执行时可看 progress indicators 和 surfaced approach，也能从另一 surface 回答问题或中途 steering。[Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)

它的“验证”承诺主要是 **可见过程、可审阅产物和安全动作筛查**，而不是通用的 deterministic test gate。Anthropic 的安全指南反而建议用户观察 task-level 异常模式，而不要假定自己能逐条验证所有 shell commands；scheduled tasks 应从低风险工作开始，并定期 review 每次 run 的结果。[Use Cowork safely](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely)

### 4.2 ChatGPT Work

Work 的入口同样以 outcome、sources、constraints 和 review criteria 为中心。用户可持续查看进度、回答问题、调整方向和批准重要动作。Desktop 的 `/goal` 把 goal 同时当作 first prompt 与 completion criteria，progress row 支持 pause、resume、edit、clear；若 outcome 尚不清楚，可先 `/plan` 让 ChatGPT 访谈、提取 constraints，再形成可衡量的 goal。官方模板要求 goal 明确写出 outcome、constraints 和 verification（tests、measurements 或 review criteria）。[Get started with Work mode](https://learn.chatgpt.com/docs/get-started-with-work) [Long-running work](https://learn.chatgpt.com/docs/long-running-work)

Work 的 review surface 比“下载最终文件”更细：desktop 可在 chat 侧边预览 documents、presentations、spreadsheets、PDF 与 websites，并把 annotation 作为局部修改上下文；sidebar 可展示 plan、sources、generated files 和 chat summary。官方建议要求 agent 报告保存路径和实际执行的 checks，再由用户检查 preview。[Work with files](https://learn.chatgpt.com/docs/artifacts-viewer)

因此在公开产品契约上，Work 对“definition of done + verification criteria”的表达更显式；Cowork 对“自动 decomposition + sub-agent coordination”的表达更显式。两者都要求 human review，不应把生成成功等同于事实正确或业务动作安全。

## 5. 执行环境、文件、浏览器与终端

### 5.1 Cowork 的 remote/local 双架构

Cowork 当前 remote session 为默认路径：每个 session 获得独立的临时 Anthropic-managed sandbox，session 结束即销毁，不与其他 sessions 或 organizations 分享状态，并与 Anthropic corporate/research/model-training environment 分离。Sandbox 默认不能访问 private/internal、link-local、cloud-metadata 或 Anthropic internal addresses；egress 经过 sandbox 无法绕过的 proxy；只持有数小时内过期的 session-scoped tokens，connector authorization tokens 不进入 sandbox。[Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)

Remote session 若需本地文件或 browser，会通过 Anthropic-brokered connection 请求 Claude Desktop；只有 user-connected folders 可访问，每次 local tool call 都重新检查 permission，desktop offline 时无法触达设备。要特别注意：这种方式打开的本地文件会在 Anthropic server 上处理，并非始终留在 device 内。[Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)

对于仍使用 local execution 的既有 desktop deployment，agent loop 在 host 上原生运行，负责 conversation、folder-limited I/O、web fetch 和 local plugin MCP；code/shell 在专用 Linux VM 内运行，由 Apple Virtualization.framework 或 Windows Hyper-V 隔离，并施加 network egress、syscall 和 per-session user 约束。这种 VM 隔离也意味着 host EDR 看不到 VM 内部行为；remote sandbox 同样不在 endpoint 上。[Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview) [How Anthropic contains Claude](https://www.anthropic.com/engineering/how-we-contain-claude)

### 5.2 Work 的 cloud/local 分界

Work web/mobile 在 cloud 执行，cloud chats 跨 web、mobile、desktop 同步；desktop local chat 可以打开本地 folder/project，本地文件和 outputs 默认留在机器上，除非用户明确移动或分享。Codex view 则保持独立 history，并可从 mobile Remote tab 连接支持的 desktop tasks。[ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275)

Desktop local chat 运行 command 时使用 OS-enforced sandbox：macOS 用 Seatbelt，Windows/PowerShell 用 native Windows sandbox，Linux/WSL2 使用 Linux sandbox/bubblewrap 路径。Sandbox 约束 file writes 与 network，`git`、package managers、test runners 等 spawned commands 继承同样边界；approval flow 只负责决定谁能批准越界，而不是替代技术隔离。[OpenAI sandbox](https://learn.chatgpt.com/docs/sandboxing) [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)

默认 `workspace-write` 边界允许读写当前 workspace、执行 routine local commands，network 默认关闭；访问 workspace 外文件或 network 时需要 escalation。Full access 可写任意文件并联网执行 command，不再逐次批准，官方明确把它标为显著增大 data loss、leak 与 unexpected behavior 风险的模式。[OpenAI permissions](https://learn.chatgpt.com/docs/permission-modes)

### 5.3 Browser 与 direct computer use

Cowork 选择最精确的工具：有 connector 先用 connector，再用 Claude in Chrome，最后才用 direct screen interaction。Computer use 是 Pro/Max 的 research preview；它能截图、click、type、打开 files 和 dev tools，但 **agent 与 desktop application 之间没有 sandbox**。控制来自 per-app permission、blocked apps、prompt-injection scan 和用户随时 stop。电脑必须 awake、Claude Desktop 必须 open；Anthropic 不建议把它用于 banking、healthcare、government 等 sensitive apps。[Let Claude use your computer in Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)

Work 有两套浏览器能力：cloud browser 可在后台操作 supported public sites、填写 supported fields 并结合 connected apps，但当前不接受 credentials、不登录、不使用 password manager，也不完成 payments；遇到 CAPTCHA/sign-in/blocked automation 会停止。Desktop built-in browser 与用户共享页面，支持登录、autofill、password management、extensions、multi-tab、downloads 和 annotations；也可转用 Chrome extension 复用已有 profile/session。两者的登录与风险边界不能混为一谈。[Using cloud browser in ChatGPT](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) [Using the built-in browser](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)

## 6. 权限、安全与企业治理

### 6.1 Cowork

Cowork 的 folder access 可表达为 read-only、read-write、read-write-no-delete；permanent deletion 无论何种 mode 都需要显式确认。Manual 对 gated actions 询问用户；Auto 对 actions 做安全判断，识别疑似 data exfiltration/prompt injection 时 block 或寻找更安全路径；Skip 不询问也不自动审查。但 Auto 仍不会自动批准新增 local folder、文件删除、创建 schedule 等敏感能力。[Cowork getting started](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [How Anthropic contains Claude](https://www.anthropic.com/engineering/how-we-contain-claude)

Isolation 只限制 code execution 的 blast radius，不会缩小用户已经授予 connectors、files、browser 的权限。网络 egress policy 也不覆盖 web fetch/search、MCP 或 Claude in Chrome，这些需独立管控。Anthropic 公开披露过仅靠 destination allowlist 仍可能被 prompt injection 借合法 API domain 外传数据，因此把 allowlisted domain 视作 capability grant，而非简单“安全域名”。[Use Cowork safely](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely) [How Anthropic contains Claude](https://www.anthropic.com/engineering/how-we-contain-claude)

Team/Enterprise 可通过 MDM 禁用 local MCP servers 与 desktop extensions，并对 remote sessions、egress、persistent allow、trusted device/recent sign-in 设约束。OTel 可输出 prompts、tool/MCP invocations、file access、approvals、skills/plugins 等 activity；但调研日 Cowork activity 不进入 Anthropic Compliance API、audit logs 或 data exports。[Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview) [Monitor Cowork with OpenTelemetry](https://support.claude.com/en/articles/14477985-monitor-claude-cowork-activity-with-opentelemetry)

### 6.2 Work

Work 在 workspace 层继承 identity、roles、RBAC、source-system permissions、plugin/app policy 与 action controls。启用 plugin/app 不会扩大用户在 source system 原本可访问的 files、repositories、channels、records 或 actions。高影响 action 应组合 narrow credentials、read/write/action scope、approvals 和 human review；不同 execution surface 的网络与 sandbox policy 分开治理。[Work mode admin FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq) [Admin controls for plugins and apps](https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-in-apps-connectors-enterprise-edu-and-business)

Desktop 的 Ask for approval 把人作为越界 reviewer；Approve for me/Auto-review 把相同 escalation 交给 separate reviewer agent。Reviewer 可审批 shell escalation、blocked network、workspace 外 edit、需要 approval 的 MCP/app action 与新 website/domain，但不扩大 writable roots、network 或 sandbox。Computer Use 的 app-level prompt 仍直接交给用户。[OpenAI auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)

Enterprise observability 需区分数据面：Compliance Logs Platform 提供 Work 的 user prompts 与 agent responses，但当前不跟踪 files、actions 或 tool calls，平台保留 30 天，长期留存需持续 export。Workspace analytics 负责 adoption/credit usage；Codex local client 可另行 opt in OTel 事件。这与 Cowork 的“详细 OTel、无 Compliance API”形成不同取舍。[Work mode admin FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq)

## 7. Skills、Plugins、Connectors 与 MCP

### 7.1 Claude

Claude skill 是按需加载的 instructions、scripts 与 resources；它规定“如何完成一类工作”，MCP/connector 则提供外部 tools 和 data。Claude plugin 把 skills、connectors、sub-agents 打包成 role/workflow capability；skills 可用于 chat 与 Cowork，而 hooks 和 sub-agents 只在 Cowork 执行。用户可用 Anthropic marketplace、organization marketplace、Git repository 或 custom plugin file 安装，并可让 Cowork 对 plugin 做定制。[What are Skills?](https://support.claude.com/en/articles/12512176-what-are-skills) [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)

Claude connector 继承 individual 在 source service 的权限，可 read data 或 execute actions。Custom remote MCP 从 Anthropic cloud 发起连接，因此 server 必须可从 Anthropic IP ranges 访问；Team/Enterprise 由 owner 先加入组织，成员再各自认证。Local MCP 是不同机制，使用 local network/host permissions；plugin 内的 local MCP 与 ordinary local program 权限相同，必须把安装来源当成软件供应链风险。[Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities) [Claude remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)

### 7.2 OpenAI

OpenAI skill 是 reusable instructions、examples、code 与 structured steps，可自动触发；ChatGPT skills 遵循 Agent Skills open standard，可 create/upload/install/share，并由 workspace permissions 控制创建、上传、发布与安装。Personal Skills 的 desktop 与 web/mobile 安装当前不会自动同步；Codex 内的 skill governance 可能独立。[Skills in ChatGPT](https://help.openai.com/en/articles/20001066) [Agent Skills specification](https://agentskills.io/)

OpenAI plugin 是 capability container，可包括 skills、apps 与 app templates。Apps 提供 search/sync/actions/interactive UI，plugin installation 与 app access 是两个独立控制；app 仍继承 RBAC、read/write action control、confirmation、sync/domain/source boundaries 和 source-system authorization。[Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256) [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)

Custom app 可由 MCP 驱动。Full MCP write/modify 当前为 Business、Enterprise、Edu beta；高风险 write action 可能需要确认或被 block。ChatGPT 直接连接 remote MCP，私网/on-prem/developer-machine server 可通过 Secure MCP Tunnel 接入，而无需暴露到 public internet。Admin 首次批准后使用 tool/input 的 frozen snapshot，后续 incompatible schema change 需重新 review/publish。[Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 8. 后台、并行、Scheduled Tasks 与跨设备

Cowork remote session 会随 account 保存并跨 desktop/web/mobile 接续；关闭 laptop 后 cloud work 继续，但依赖 local file/browser/computer/local MCP 的步骤只有 desktop app 在线时才能执行。Complex task 可在单 session 内协调 parallel sub-agents。Scheduled task 是独立 remote Cowork session，可定期或 on-demand 运行并使用 account/cloud files、connectors、skills、plugins，不要求 device online，但不能绑定 computer-local folder。[Cowork surfaces](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile) [Cowork scheduled tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)

ChatGPT Work cloud chats 同样跨 web/mobile/desktop 同步并支持后台执行；cloud browser 离开 conversation 后仍可继续，直到需要确认或遇到 sign-in。官方建议独立工作用不同 chats 并行，且不要让两个 chats 同时写同一 connected source。Scheduled tasks 可从 Chat/Work 创建；web schedule 可用 uploaded context、connected tools、skills、plugins，但不能直接访问 local folder。Desktop schedule 若使用 local project，则必须 computer on、app running；Git repo 可选择 project directory 或 isolated worktree。[ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275) [Cloud browser](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) [Long-running work](https://learn.chatgpt.com/docs/long-running-work) [Scheduled tasks](https://learn.chatgpt.com/docs/automations)

## 9. 会话、Projects、Memory 与制品生命周期

Cowork remote sessions 与 files 保存到 Claude account，可在任意 surface review/steer/resume；删除 task 会立即从 history 消失，并在 30 天内从 backend storage 删除。Projects 把 related tasks 放入带 files、links、instructions 和 memory 的持久 scoped workspace；local-folder-linked project 只支持 desktop Cowork。Cowork 还提供 global/folder instructions。[Cowork getting started](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [Cowork surfaces](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)

Cowork 的一般文件可 preview/download，Markdown 支持 selection-based “Edit with Claude”。Live artifacts 则是独立于原 task 的 persistent interactive HTML page，保存在 Artifacts view，打开时可从 approved connectors/local files 刷新数据，每次 update 留下 version history 并可 restore。当前 Live artifacts 为 desktop-only；Team/Enterprise 可组织内分享，viewer 使用自己的 connector permissions。[Cowork live artifacts](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork)

ChatGPT 的 cloud Work chats 在 web/mobile/desktop 同步，local desktop chats 留在机器上；Chat 与 Work 一起出现在 Recents，可 sort/filter/pin，Codex history 保持分离。Projects 聚合 related chats、files 和 instructions，并可把 project context 直接带入新的 Work chat。[ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275)

Work 的 generated documents、presentations、spreadsheets、PDF 在 desktop 可并排 preview 与 annotation，在 web 可在 chat 中 review/download/refine。Sites 则形成独立的 hosted artifact lifecycle：private preview、refinement、saved version、deployment 和 sharing；这比普通 file attachment 更接近可持续交付的应用制品。[Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) [Codex Sites developer guide](https://developers.openai.com/codex/sites)

## 10. 公开能力差异中应保留的“不等价”

| 容易被误判为等价的概念                           | 应保留的差异                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Cowork remote session vs Work desktop local chat | 前者主要在 Anthropic cloud sandbox 中运行并经 desktop bridge 访问本机；后者在用户机器的 OS sandbox 内执行 command                        |
| Cowork computer use vs isolated code execution   | Computer use 对 desktop apps 没有 sandbox；VM/cloud sandbox 只隔离 code/shell，不能替代 app permissions                                  |
| Work cloud browser vs built-in browser           | Cloud browser 当前不登录、不支付；built-in browser 有独立 browser state，可登录并使用 autofill/password management                       |
| Cowork sub-agents vs Work parallel chats         | Cowork 官方承诺单任务自动 sub-agent coordination；Work 官方承诺用户把独立任务放入不同 chats，并未公开承诺同一能力                        |
| Claude plugin vs OpenAI plugin                   | Claude bundle 可包含 sub-agents/hooks；OpenAI bundle 是 skills/apps/app templates，外部 action 由 app permission 管理                    |
| MCP support                                      | 两边都支持 MCP，但 cloud origin、local/private connectivity、admin approval 与 tool snapshot 行为不同                                    |
| Live artifact vs Site                            | Live artifact 是 desktop Cowork 中可刷新/版本回退的 interactive dashboard；Site 是 Work/Codex 创建并托管、部署、分享的网站或轻量应用     |
| “Auto” permission                                | Cowork Auto 对 action 做 safety screening；OpenAI Auto-review 用独立 reviewer agent 审批 sandbox-boundary escalation；两者都不是无限权限 |
| Compliance visibility                            | Cowork 当前 OTel 更细但不进 Compliance API；Work Compliance Logs 覆盖 prompts/responses，但不覆盖 files/actions/tool calls               |

## 11. 官方证据索引

以下链接均于 **2026-07-22** 访问。

### Anthropic

- [Claude Cowork product page](https://www.anthropic.com/product/claude-cowork)
- [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- [Use Claude Cowork on web, desktop, and mobile](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)
- [Claude Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)
- [Use Claude Cowork safely](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely)
- [Let Claude use your computer in Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude)
- [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)
- [What are Skills?](https://support.claude.com/en/articles/12512176-what-are-skills)
- [Use connectors to extend Claude's capabilities](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)
- [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Schedule recurring tasks in Claude Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- [Use live artifacts in Claude Cowork](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork)
- [Monitor Claude Cowork activity with OpenTelemetry](https://support.claude.com/en/articles/14477985-monitor-claude-cowork-activity-with-opentelemetry)
- [Claude release notes](https://support.claude.com/en/articles/12138966-release-notes)

### OpenAI

- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275)
- [Get started with Work mode](https://learn.chatgpt.com/docs/get-started-with-work)
- [Work mode admin FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq)
- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [ChatGPT is now a partner for your most ambitious work](https://openai.com/index/chatgpt-for-your-most-ambitious-work/)
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work)
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer)
- [Permissions](https://learn.chatgpt.com/docs/permission-modes)
- [Sandbox](https://learn.chatgpt.com/docs/sandboxing)
- [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Using cloud browser in ChatGPT](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt)
- [Using the built-in browser in the ChatGPT desktop app](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)
- [Skills in ChatGPT](https://help.openai.com/en/articles/20001066)
- [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256)
- [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Codex Sites developer guide](https://developers.openai.com/codex/sites)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)

### Open specifications referenced by official product docs

- [Agent Skills specification](https://agentskills.io/)
