---
title: ADR-0119 — Pi 原生 RPC 接入
description: "新增内建 `pi-rpc` 协议，直接驱动 `pi --mode rpc` 取代社区 ACP 桥，且不削弱外部智能体的强制沙箱。"
---

# ADR-0119 — Pi 原生 RPC 接入

**状态**：已接受（2026-08-14）

## 背景

Pi 此前只能经社区 ACP 桥 `npx -y pi-acp` 接入（`lib/ai/agent/external/ecosystem-adapters.ts`）。该桥把 Pi 的原生 RPC 投影到更小的 ACP 词汇表上，thinking level、steering 与 follow-up 队列、compaction 生命周期、带分叉的会话树以及 usage 明细因此全部丢失或被压平。该桥还是执行路径上的第三方代码，不在 Cognia 的认证范围内。

Pi 本身提供了一等的本地协议：`pi --mode rpc` 在 stdio 上讲一套 JSONL 命令/事件流。它**不是** JSON-RPC——帧是 `{type, id, …}` 命令对象，应答为 `{"type":"response", "command", "success", …}`——因此 `json-rpc-peer.ts` 无法复用，只能仿照。

该协议有四条性质是通过在本机实跑 Pi 0.84.1 确认的，而非从文档推断，因为每一条都会让朴素实现出错：

1. **响应不是先进先出。** `abort` 的应答晚于其后才发出的 `get_state` 的应答。关联只能依据 `id`。
2. **入站畸形帧不会终止 Pi。** 它回 `{"type":"response","command":"parse","success":false}` 且**不带 `id`**；假定每个响应都带 id 的关联层会永久泄漏一个 pending request。
3. **`set_thinking_level` 接受非法输入。** 它返回 `success: true`，静默降级为 `off`，并先发出 `thinking_level_changed`。校验必须在 Cognia 侧依据 `get_available_thinking_levels` 完成，而该结果按模型而异。
4. **`--no-extensions` 并不构成隔离。** `~/.agents/skills/` 下的 skills 与 Pi 内置的 inline extension 仍会加载。

另外，Node 的 `readline`——即 `cli/src/runtime/external/node-backend.ts` 用来给所有外部智能体 stdout 分帧的实现——会在 U+2028 与 U+2029 处断行。`JSON.stringify` 不转义这两个字符，因此正文含 U+2028 的单个合法 Pi 帧会被切成若干无法解析的片段。Rust host（`BufReader::lines()`）是字节导向的，不受影响。

## 决策

新增内建 `ExternalAgentProtocol` `pi-rpc`，并在 `ExternalAgentManager.registerDefaultAdapters()` 中注册 `PiRpcAdapter`。不新增 execution rail，不新增 Dexie schema version，路径上不出现任何 ACP。

**分帧。** adapter 自持严格 LF codec：只按 `\n` 字节分帧，删除尾部单个 `\r`，绝不把 U+2028/U+2029 或孤立 `\r` 当作分隔符。它容忍半帧与单 chunk 多帧，并施加 16 MiB 单帧、32 MiB 缓冲上限，越界即报 `protocol_frame_invalid`。为向它提供未分帧的字节，`node-backend.ts` 增加按需启用的 raw chunk 转发模式，仅供 `pi-rpc` 使用；ACP、Codex、OpenCode 保持既有 `readline` 路径不变。它们同样暴露于该 U+2028 缺陷，但属既存问题，不在本 ADR 范围内。

**会话。** 每个 Cognia session 独占一个 Pi 进程，绝不通过 `switch_session` 共享。Cognia 生成 session UUID 并传入 `--session-id`，Pi 将其视为"使用该精确 id，不存在则创建"——因此恢复就是再次传入同一 flag，持久化的 link 只保存该 UUID、cwd 与 Pi 版本。任何跨设备负载中都不出现 session 文件的绝对路径。分叉使用 `--fork`。每 host 上限 4 个进程，超限回收最近最少使用的空闲进程，否则返回 `resource_limit`。

**版本策略。** `0.84.1` 为认证版本。更低版本以 `runtime_version_unsupported` 拒绝。更高版本放行但标记为未认证并打点，使 Pi 升级降级为一条警告而非一次中断。

**沙箱。** 无例外。Pi 与其他所有外部智能体一样运行在强制的 `cognia-external-agent-launcher` 之下；launcher 缺失或平台非 macOS/Linux 时，会话以 `sandbox_unavailable` 被拒。ADR-0077 的"从不回退到无沙箱进程"原样重申，规划期间考虑过的三条逃生通道（桌面一次性确认、CLI flag、headless 环境变量）全部否决——Pi 不应成为侵蚀该不变量的先例。

**扩展与权限。** 第一方 Cognia extension 以原始 TypeScript 分发（Pi 直接加载 `.ts`，无构建步骤），并在构建期做 SHA-256 pin。隔离的含义是 `--no-extensions --no-skills --no-prompt-templates --no-approve`；`AGENTS.md`/`CLAUDE.md` 上下文文件刻意仍然加载，因为它们是数据而非可执行代码。由于 Pi 即使在隔离下仍保留自身内置 inline extension，extension 的 `session_start` 握手断言的是**预期的扩展集合**，而非断言集合为空。5 秒内未完成握手或哈希不符，会话以 `extension_handshake_failed` fail closed。

extension 经 `pi.on("tool_call")` 拦截每一次 Pi 原生工具调用，把五种 canonical 权限模式映射到 Pi 的 `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash`。`plan` 与 `dontAsk` 另在启动时固定 Pi 自身的 `--tools` 允许名单，使限制性模式拥有进程级底线，而不仅依赖拦截。

**工具投影。** extension 复用既有 tool host，不新增通道：从自身环境读取 `COGNIA_TOOLHOST_{SOCKET,TOKEN,SERVER}`，并与 broker 讲既定的 `hello` / `authorize` / `exec` 协议。规划期提出的 session 级控制文件被废弃——相对于既有的环境变量 + `0600` unix socket，它冗余且严格更差。

## 影响

- tool-host token 现在会进入 Pi 进程环境，模型的 `bash` 工具可以读到它；而今天该 token 只到达受信的 bridge。接受这一点的理由是：权限权威是 broker 的 `authorize()` 而非持有 token——每次调用都会重新核对工具可见性、工作区 confinement、`needsApproval` 与审批 gate，因此泄漏 token 并不能带来沙箱进程本就无法经同 uid socket 触达的能力。此处记录它，是因为这确实是纵深防御的一次收窄，而不是无关紧要。
- Windows 以及任何缺少可用沙箱 launcher 的主机无法本地运行 Pi，需经配对桌面或 headless host 接入，与其他外部智能体一致。
- 隔离会在 Cognia 发起的会话中停用用户自己的 Pi 扩展栈。这正是目的：`pi-permission-system` 等社区权限引擎同样 hook `tool_call`，两套引擎拦截同一次调用会产生重复确认与不可预测的阻断。
- Cognia 从不读取 Pi 的凭证。认证诊断只调用 `pi auth check --provider <id> --json --no-refresh`；`--credentials`、`print-api-key`、`print-bearer-token` 一律禁用。
- `pi-acp` 作为独立的 experimental 兼容 preset 保留。迁移是显式且可回滚的，原地更新配置以保住 team、scheduler 与 runtime 对 agent id 的引用，且不假定 ACP session id 能映射到 Pi session。**（2026-08-27 撤销 —— 该桥与其迁移已移除，见修订记录。）**

## 修订记录

### 2026-08-18 —— Pi 的配置面与扩展包系统

原 ADR 只覆盖 Pi 的**运行时**。端到端复查这套集成后，缺口的形状很清楚：Pi 既是本仓库运行时集成最深的 vendor，同时也是配置面最空的一个 —— settings、slash command、subagent、skill、MCP、memory 六类导入全无；`VendorRoots` 里没有条目（于是 `PI_CODING_AGENT_DIR` 被忽略、会话路径被硬编码）；迁移向导里没有 Pi；而且**全仓库没有任何代码触及 Pi 的 npm packages**。

本次修订关闭可关闭的那一半，并把其余部分写成显式非目标，而不是留作看起来像疏漏的空白。

#### 有一条约束被收窄，而非撤销

「影响」一节写道：

> Cognia 从不读取 Pi 的凭证。认证诊断只调用 `pi auth check --provider <id> --json --no-refresh`；`--credentials`、`print-api-key`、`print-bearer-token` 一律禁用。

这句话逐字仍然成立，因此上文保留原文而不改写。真正变化的是：Cognia 现在会**读写** `<pi agent dir>/settings.json` —— 这个文件此前从未打开过。边界由「不打开该文件」移动为：

- **键白名单。** `lib/pi-packages/settings-io.ts` 只解析 `packages`，其余键一律不到达调用方：解析对象的其他部分被直接丢弃，不返回、不记日志、不进遥测、不进 support report。
- **优先让 Pi 自己写。** 变更优先 shell 调用 `pi install` / `pi remove` / `pi update --extension`；只有 `pi` 不在 PATH 时才直接编辑 `settings.json`。
- **绝不覆盖无法解析的文件。** 若 `settings.json` 存在但解析失败，则拒绝写入，与 `lib/claude/sync.ts` 中的守卫同源。
- **`auth.json` 与 `models-store.json` 仍然从不打开。** Pi 把凭证放在单独的 mode-600 文件中，完全不在范围内。

`ENV_PREFIX_ALLOWLIST` 中依然没有 `PI_` 前缀。这在原 ADR 中就是刻意为之，现在依然是 —— 它不是需要纠正的疏漏。

#### 现已纳入范围

settings / prompt template / subagent / skill / memory 导入；`VendorRoots.piAgentDir` 与 `piSessionDir`（尊重 `PI_CODING_AGENT_DIR`）；迁移向导中的 Pi，配一份诚实的 per-artifact 支持矩阵；经由第 14 个 adapter `pi-mcp-adapter` 的 MCP（用它自己的 id，因为 Pi 核心不带任何 MCP，那个文件属于第三方包）；以及 `/plugins` → Agent 扩展包 下的包管理器。

#### 显式非目标

1. **生命周期 hooks 保持 `sidecarOnly`。** 这不是 Pi 的限制 —— 所有外部后端一致如此。只为 Pi 改动会让 Pi 在一处「一致性即设计」的地方成为例外。
2. **rate limits 与 MCP logs 保持 `sidecarOnly` / `agentOwned`。** 同上。
3. **不支持 per-session `mcpServers`。** Pi 的 RPC 协议没有该参数 —— `mcpServers` 在其整个发行物中零命中。上文记录的 `COGNIA_TOOLHOST_*` 环境通道即是既定权衡；要关闭它需要上游改协议，而不是在这里改。
4. **Windows 上不支持本地运行 Pi。** 这是强制沙箱的后果，上文已记录。Windows 现在可以**配置** Pi —— 读取其设置、为另一台机器管理其扩展包 —— 但依然无法在本地运行它。
5. **不做包注册中心集成。** pi.dev/packages 是 npm 关键字画廊，没有 JSON API；npm 本身只能给出版本与下载量，永远给不出重叠组、上下文开销或维护信号 —— 而这些才是目录条目有价值的地方。因此目录在仓库内人工整理并带日期，散文走 i18n，使两个 locale 都可被校验。

#### 已知限制

Cognia 无法读取 Pi 各扩展包自己的配置文件，因此重叠检测只能依据人工整理的目录。具体地：`pi-permission-modes` 自带 Plan 模式，但推荐配置会把 `plan` 从它的 `cycleOrder` 中移除，让独立的 plan 包接管规划。因此目录中没有为它列出 `plan` —— 而若用户在那里重新启用 `plan`，将得不到任何重叠告警。


### 2026-08-27 —— 移除 `pi-acp` 桥，并补上可诊断的凭证

两项后续，其中一项撤销了本 ADR 原先做出的一个决定。

#### 已撤销：「`pi-acp` 作为独立的 experimental 兼容 preset 保留」

上文「影响」一节把社区桥与原生适配器并列保留，并提供显式、可回滚的迁移。该决定现予撤销。`pi-acp`
runtime、它的 `pi` preset、它的 ecosystem surface、它的 `npx` 允许名单条目、它的能力精化，以及那套原地迁移
（`lib/ai/agent/external/pi-migration.ts` 及其设置卡片）全部删除。

这座桥已经换不来任何可度量的东西：

- 它需要与原生适配器**完全相同**的强制沙箱和**完全相同**的 macOS/Linux 平台集合，因此从来不是
  Windows 逃生口，也不是免沙箱通道；
- 它内部桥到 `pi --mode rpc`，也就是 Cognia 现在直接讲的协议，所以它严格地只是通往同一处的更长路径，
  且在执行路径上多塞了一个第三方进程；
- 它唯一的功能差异是覆盖 Pi 0.80.4–0.84.0 —— 而本 ADR **本来就**在原生路径上以
  `runtime_version_unsupported` 拒绝这个区间。用一个未钉版本的第三方进程，去支持产品自己声明不支持的
  版本区间，这是不一致，不是特性。

移除它同时把 `unpinnedLaunchWaivers` 从四条缩到三条。`pi-acp` 经 `npx -y pi-acp` 启动，每次启动都从网络
重新解析该包。目录声明这份清单只能缩小、且条目只能通过钉住 distribution 来移除 —— 这里改为移除 runtime
本身，以更直接的方式满足同一不变量。另外三条 waiver（`codex-acp`、`gemini-cli`、`qwen-code`）刻意不动：
与 Pi 不同，那三个 agent 没有第一方替代，它们的 waiver 是承重的。

「钉住 `pi-acp`」这条路被考虑过并否决。那会让 Cognia 事实上成为一个第三方桥的发行方 —— 拥有它的
frozen lock、传递依赖树与 CVE 响应 —— 并且会拿我们本就想删掉的那个 runtime，去首次在生产中启用整套
托管发行路径（lock 校验、provider 安装、回滚）。目录里从来没有任何一个 runtime 带过 `distributions` 条目。

安全策略不再把 `pi-acp` 列入允许名单，因此仍指向它的手工配置会在启动时被拒绝，而不是静默地跑起一座
未钉版本的桥。

#### 已补上：本 ADR 规定过却从未实现的凭证诊断

「影响」一节写明认证诊断只调用 `pi auth check --provider <id> --json --no-refresh`。这条约束被写下来后
从未实现 —— 未认证的 Pi 只会表现为第一次提示词失败，而不是一条诊断。现在
`lib/ai/agent/external/pi-auth.ts` 与 agent 设置面板上的「Pi 凭证」卡片实现了它，且是对照 Pi 0.84.1 自带的
`dist/cli/auth-check.d.ts` 实测确认，而非推断：

- CLI 的 **exit code 不能主导分类**：`1` 在正常路径上是 `not_ready`，但同时也表示「参数解析失败」；
  `2` 既覆盖真正的 `invalid` 判定，也覆盖用法错误。只有 stdout 上可解析的 JSON 才是权威；
- **错误路径不认 `--json`** —— 参数与用法错误把散文写到 stderr，stdout 完全为空，因此没有判定的探针
  归为 `unreadable`，绝不归为「未认证」；
- `--no-refresh` 是承重的而非装饰：它让 Pi 以 `ReadOnlyAuthStorage` 打开凭证库，这才是「Cognia 的诊断
  不可能刷新、轮换或过期用户自己的凭证」这一保证的来源。

`print-api-key`、`print-bearer-token` 与 `--credentials` 仍然禁用，且现在是在 argv 构造处被拒绝，而不再
只靠约定。
