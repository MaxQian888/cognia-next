---
title: ADR-0028 — 按会话隔离 Claude Code
description: 通过 per-`query()` env 实现 `ChatSession` 维度的 OAuth / `CLAUDE_CONFIG_DIR` / base-URL / 代理隔离(不做 WarmQuery 池 —— spike 显示 `startup()` 烤死所有 options,命中率接近零;作为单会话预热的 follow-up 推迟);五层混合执行沙盒(Cognia restricted-token Windows runner + sandbox-exec + bwrap,加 Node 24 `--permission`、Wasmtime、e2b microVM 与 `computer_use` 的 per-action 策略闸门)。
---

# ADR-0028 — 按会话隔离 Claude Code

**状态**: 提议 (2026-05-20)
**关联**: 扩展 ADR-0010（Claude 订阅 OAuth）、ADR-0020（Computer Use 完整性）、ADR-0025（统一订阅模块）、ADR-0026（插件扩展点扩展）
**作者**: Max Qian + Claude Opus 4.7

## 背景

cognia-next 的 Node sidecar (`sidecar/claude-host.mjs`) 是一个 OS 进程，承载 N 个并发的 `@anthropic-ai/claude-agent-sdk` `query()` 调用，按 `sessionId` 区分。`lib/claude/build-options.ts:resolveSendOptions` 今天已经按 `ChatSession` 隔离了相当大的面：`cwd`、`model`、`provider`、`providerCredentials`、`allowedTools`/`disallowedTools`、`mcpServers`、`additionalDirectories`、`permissionMode`、`settingSources`、`agents`、`appendHeaders`、per-call `env`（用于 `DEBUG` 与 `anthropic-beta` headers）。

但有四个轴**在 sidecar 启动时就冻结了**，今天无法中途切换：

1. `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` —— 一个 sidecar 进程一份 OAuth 身份（`src-tauri/src/claude/sidecar.rs:143-155`）。
2. `CLAUDE_CONFIG_DIR` / 磁盘上的 `~/.claude/` —— 一进程一个配置目录（CLI 子进程启动时读一次）。
3. `ANTHROPIC_BASE_URL` —— 一进程一个端点。
4. `HTTPS_PROXY` / `HTTP_PROXY` —— sidecar 启动时由 `proxy_config::current()` 设置。

此外，对高风险工具调用（`Bash` / `Edit` / `Write` / 原生 `text_editor`）**没有 OS 级执行沙盒**。`additionalDirectories` 是 SDK 层闸门，不是 OS 层。现有的 3-tier 权限闸门（`src-tauri/src/automation/permission.rs`）、HITL 同意 broker（`src-tauri/src/automation/consent.rs`）、审计日志（`src-tauri/src/automation/audit.rs`）提供策略层防御；执行层防御缺位。

ADR-0025 已经发布多账号 vault（`src-tauri/src/subscription/vault.rs` 的 `ProviderVault::accounts[]`），但今天只能有一个 "active"。用户多次要求按会话切换账号（个人 Pro + 公司 Max）。仓库内 Windows restricted-token runner（`crates/cognia-sandbox-runner`）与文档化的 `@anthropic-ai/sandbox-runtime` 包（mac/Linux）让一个可信的跨平台沙盒终于变得可行。

调研还确认了两个改变架构走向的 SDK 事实：

- **每次 `query()` 调用本身就 spawn 一个全新的 `claude-code` CLI 子进程**。Node host 只是编排器。Per-call `options.env`（显式 `{ ...process.env, ...override }` spread，自 v0.2.113 起 `env` 是 replace 而非 overlay）完全隔离子进程的环境变量。**不需要 sub-sidecar 进程池**就能按会话切换 OAuth / configdir / base-URL / proxy。
- **两个并发 CLI 子进程共享一个 `~/.claude/.credentials.json` 会在 OAuth refresh 时发生竞态**（Anthropic 已知问题 #43392、#24317、#56339）。给每个账号一个独立的 `CLAUDE_CONFIG_DIR` 目录 = 各自一份 credentials 文件 = 竞态自然消失。

## 决策

### Per-query env 注入（方案 B）

`ChatSession` 新增可选 `accountId`（UUIDv7，引用 `ProviderVault::accounts[]`）；`Character` 新增 `accountIdOverride`；`AppSettings` 新增 `defaultAccountId`。`resolveSendOptions` 按 `session → character → settings → ActiveAccountState` 的链 fallthrough（今天的 active 指针仍是最终兜底）。

`src-tauri/src/subscription/active.rs` 新增**只读**的 `env_for_account(provider, account_id) → Vec<(String,String)>` 路径，不动 active 指针。它输出与 OAuth mode 匹配的 env（`CLAUDE_CODE_OAUTH_TOKEN` 与 `ANTHROPIC_API_KEY` 互斥）+ `CLAUDE_CONFIG_DIR = <app_data>/cognia/claude-configs/<accountId>/`（首次调用时 ensure-create）+ 账号记录里的 `ANTHROPIC_BASE_URL` + 由 `proxy_config::current()` 推导的会话级代理。

`lib/claude/build-options.ts` 通过两个新 Tauri 命令（`claude_env_for_account`、`claude_proxy_env_for_session`）拿到这个元组，在 `debugMode` 分支之前并入 `opts.env`。`sidecar/dispatch/anthropic.mjs:117` 现有的 `baseEnv = { ...process.env, ...(sendOptions.env ?? {}) }` 已经正确 —— 注释加强提醒后人 v0.2.13 的 replace 语义。

sub-sidecar 池被考虑后**否决**：SDK 层 subprocess-per-`query()` 已经给每个会话独立的 CLI 进程，我们再叠一层 Node sub-sidecar 是冗余的，per-session 内存成本会翻三倍。

### 冷启动代价 —— 接受，不做池

SDK 自 v0.2.111 起暴露 `startup()` API,返回一个 `WarmQuery` 用于摊销 CLI 子进程约 12 秒的冷启动。Plan 中作为 contingency 标注的这个问题,由 context7 spike 对着 v0.2.111+ 的版本确认了结论:**`Options` 的每一个字段 —— 包括 `cwd`、`model`、`mcpServers`、`agents`、`allowedTools`、`additionalDirectories`、`permissionMode`、`canUseTool`、`resume`、`forkSession` —— 都在 `startup()` 时被烤死**,且一个 `WarmQuery` 实例只能服务恰好一次 `.query()` 调用就废了。在 cognia 里,`additionalDirectories`(由 `@`-引用驱动)、`appendSystemPrompt`(由 goal 注入 / 工作流 snapshot 驱动)、以及其他若干字段在每条消息间都会变,按 tuple-key 池化的命中率接近零。复杂度配不上收益。

**决策**: 删掉池。每次 `query()` 付约 12 秒冷启;sidecar 的 streaming-input 机制会让用户在一个 _send_ 内只看到一次 spinner,而不是会话内每一轮都看到。`sidecar/dispatch/anthropic.mjs` 的 streaming 流程不变。一个未来的优化是:在 `session_ended` 后立即按会话当前 options 起一个 `startup()`,下条消息如果 options 没变就用它 —— 作为 follow-up 跟踪,V1 不做。

`env` 语义: 自 v0.2.111 起,`options.env` 对子进程**覆盖**(overlay)`process.env`(此前研究读到 v0.2.113 一度改为 replace-not-overlay;当前公开文档记录的是 overlay)。无论哪种,`sidecar/dispatch/anthropic.mjs:117` 显式的 `baseEnv = { ...process.env, ...(sendOptions.env ?? {}) }` 在两种语义下都正确,保留。

### 五层混合执行沙盒

T1–T5 覆盖正交的威胁面，并非每个会话都会触发全部 5 层。

#### T1 —— Bash / Edit / Write / text_editor 的 OS 原生沙盒

新建 Rust trait `SandboxedExec`（`src-tauri/src/sandbox/mod.rs`），暴露 `run(SandboxCommand, SandboxPolicy)`。按 `cfg(target_os = …)` 分发的后端：

- **Windows**: 随包发布 `crates/cognia-sandbox-runner` 产物 `cognia-sandbox-runner.exe`。runner 用当前应用 token 的受限子集启动目标、降低完整性级别、把进程树放入 Job Object，并通过 JSON 返回捕获到的 stdout/stderr。文件系统 / 权限 / 进程约束不需要提权、独立 OS 账号或预先创建的 setup marker。旧的 `target_user` payload 字段仅为 JSON 兼容保留，runner 会忽略它；`cognia-sandbox-setup.exe` 只保留给未来可选的 per-SID Firewall 后续。
- **macOS**: Rust 直接调 `sandbox-exec -f <profile.sb> -- <argv>`，SBPL 模板放在 `src-tauri/src/sandbox/macos/profiles/`。模块注释里写明 Plan B：Apple 真正移除 `sandbox-exec` 之时迁移到 App Sandbox + XPC service。
- **Linux**: 在 Tauri 资源里 bundle 静态 `bwrap` 二进制；`--unshare-all` + 可选 `--share-net` + 读写 bind + `--die-with-parent` + 基于 Flatpak 默认的 seccomp profile。

T1 拦截路径：新建 in-tree 插件 `plugins/cognia-sandboxed-tools/`，注册 4 个 MCP 工具（`sandbox_bash` / `sandbox_edit` / `sandbox_write` / `sandbox_text_editor`）。会话开启沙盒时，`resolveSendOptions` 将 SDK 内建工具加入 `disallowedTools`、过滤 `anthropicTools` 投影中的原生 `text_editor`、追加一段简短 system-prompt 引导、并通过 `opts.pluginTools` 暴露 4 个沙盒等价物。现有 `plugin_tool_exec` IPC（`sidecar/builtin-tools/plugin-tools.mjs`）把调用送到渲染端，由它派发到 `sandbox_exec` Tauri 命令。SDK 完全不动。

考虑过的另一方案 —— 通过 SDK `executable` 钩子包裹整个 CLI 子进程 —— 被否决：会强制所有工具都走沙盒（对只读工具是过度）、破坏 MCP stdio IPC、无法做 per-tool 策略。per-`canUseTool` 风格拦截保留了 SDK 的认证 / env / MCP 路线，同时让 Bash 比 Edit 走更严格策略成为可能。

#### T2 —— 纯 JS 插件执行器走 Node 24 `--permission`

新建 `lib/plugin/launcher/launchPluginJs.ts`，把 Node-target 插件 JS 入口 re-exec 成 `node --permission --allow-fs-read=<…> --allow-fs-write=<…>`；标志位由插件 manifest 的 `PluginPermission[]` 与具体 `fileScope` 推导。缺失或为空的具体 scope 会省略对应 flag（默认拒绝），通配值会被过滤，不会变成 Node 的 `*` grant。Node 24 没有按 host 收窄的网络授权 flag，`--allow-child-process` 也是全开/全关而非按可执行名收窄，因此 `networkAccess.allowedDomains` 与 `shellCommands` 会以 host-broker 错误 fail closed，不会被扩成无效或过宽的 Node flag。`PluginLoader` 将它暴露为普通 `PluginDefinition` 的 activate/deactivate 路径，因此 `PluginManager.loadPlugin()` 会通过现有生命周期真正触达它，并在 deactivate/unload 时杀掉子进程。

威胁模型备注：Node permission model 只约束插件入口进程。原生子进程没有等价继承边界，因此 shell 类工作必须走 T1 支撑的 host tools 或未来显式 broker。如果插件需要网络访问，必须使用能强制声明 host allowlist 的宿主 broker API；Node 24 执行器绝不把 "all" 扩展成 Node `*`，也绝不发放宽泛的 child-process 权限。

#### T3 —— 纯 WASM 插件走 Wasmtime + WASI

新建 `lib/plugin/core/wasm-runtime.ts`，通过 `@bytecodealliance/jco`（或 `wasmtime` 的 Node binding）跑 WASM 插件；host import 限定在 `lib/plugin/security/wasm-grant.ts` 授权过的 preopens。preopen grant 账本迁入持久 Dexie 表（`wasmGrantLedger`，schema v88），旧 localStorage 镜像只作为迁移 fallback。插件更新时，manifest preopens 会与账本对账：manifest 删除的路径带 warning 拒绝，新声明路径在用户复核前不会自动授权。runtime 每次 call 前还会重新验证加载时的 preopen 集合，因此加载后撤销 grant 也会立即生效。

#### T4 —— e2b Firecracker microVM 作为 opt-in 强隔离层

`Character.computerUseSettings.sandboxTier?: "os" | "microvm"`。值为 `microvm` 时，`sandbox_*` 工具实现路由到现有 `plugins/e2b-sandbox/` 的 workspace backend 而不是 T1。e2b 端零改动，仅新增一个路由分支。

#### T5 —— `computer_use` 的 per-action 策略闸门

`computer_use` 本质不可进程沙盒化（它就是要驱动宿主桌面）。新建 `src-tauri/src/automation/policy.rs`，在现有四件套（3-tier 权限、HITL 同意、审计、`Character.computerUseSettings.allowedToolIds`）之上叠加第五件：per-action 策略，键位 `target_app_name?` / `target_window_title_regex?` / `target_url_regex?` / `forbidden_screen_regions?`，在 `permission.rs:PerCall` 同意通过后立即评估。

### 严格模式（无逃生门）

T1 后端不可用时（Windows runner 缺失、`bwrap` 缺失、runner 退出非零），工具调用**严格 deny**。Settings 里**没有**关闭沙盒的开关，也**没有** `COGNIA_SANDBOX_BYPASS` 环境变量后门。Settings → Sandbox 显示红色 "Setup required" 徽章和 "Retry setup" 按钮。这是刻意取舍：bypass 选项是社会工程的攻击面（"助手叫我关掉沙盒"），任何审计日志都补偿不了它。

### Resume bug（#16103）缓解

SDK `--resume` 忽略 `CLAUDE_CONFIG_DIR`，只在默认 `~/.claude/projects/` 下找。当 `session.accountId` 已设 **且** sidecar 重启过（自上次 `sidecar_exited` 起未收到 `sdk_session_id` 事件），`resolveSendOptions` 跳过 `opts.resumeSessionId`，把 Dexie 中最近 N 轮作为前缀拼到 prompt 里，由新建的 `lib/claude/replay.ts:buildReplayPrompt(messages, currentMessage, budget)` 处理。默认账号会话（无 `accountId`）保持今天的 resume 行为不变。

### OAuth 令牌轮换回写

每账号独立的 `CLAUDE_CONFIG_DIR` 目录消除了跨进程 `.credentials.json` 竞态，但 CLI 子进程内的 refresh 写的是磁盘，不会自动回到我们的 keyring vault。新建 `src-tauri/src/subscription/anthropic/credential.rs::watch_configdir_credentials(account_id, path)`，用 `notify` crate 监听 `<configdir>/.credentials.json`；`mtime` 变化时 parse 文件、把轮换后的 `refresh_token` 写回 vault 对应账号记录。watcher 生命周期：该账号有第一个 session 打开时启、最后一个关闭时停。

### 审计与可观测

`automation/audit.rs` 新增 `Surface::Sandbox` variant。每次沙盒调用（Allow / Deny / Error）写一条;`resume_replayed` 也写一条。现有 5000 上限的 VecDeque + Dexie `automationAuditLog` 镜像照常承载。现有 Diagnostics tab（`components/settings/sections/diagnostics-section.tsx`,observability 分组）扩展两张 collapsible 卡片:沙盒事件流、sidecar 重启计数 —— 不新建 tab。

### UI 界面

- **Settings → Sandbox**（新 tab）：健康卡片显示后端 + 版本 / runner 可用性，"Retry setup" / "Run health probe" 按钮，默认 tier 单选（OS / microVM —— 严格模式下没有 "Off"），per-tool 网络策略编辑器，T5 per-app 策略编辑器。
- **Settings → Subscription**（扩展）：每个账号显示 "在 X 角色 / Y 会话使用中" chips、"设为默认" 操作、删除前列出引用方确认。
- **Settings → Diagnostics**(扩展):沙盒事件流 + sidecar 重启计数两张 collapsible。
- **Character 编辑器**（扩展）：账号选择器 + `sandboxTier` override。
- **Chat session header**：账号 badge（单账号用户隐藏）+ 切换器 → toast "下一条消息将使用账号 X"。
- **Composer**：盾牌指示器（filled / dashed / crossed 对应 绿 / 黄 / 红）—— 颜色配合形状以保证色盲友好。
- **首次使用向导**：平台检测 → 后端 / runner 健康检查 → 缺失时给出修复指引。

所有新增字符串同时落到 `i18n/messages/en.json` 与 `i18n/messages/zh-CN.json`（约 120–150 个 key）。预期变化由 `pnpm lint:i18n:baseline` 重写 baseline。

### 执行层加固（T1 后续）

对已上线的 T1 后端做全链路审计后，发现并修复了一组逃逸 / 外泄缺口，现已纳入 T1 契约：

- **可写根目录下限 + 上限。** 模型完全控制 `sandbox_*` 调用里的 `writable` / `target` 路径。`sandbox::run_confined` 现强制一条始终生效的**下限**：cwd / writable / 写目标若是或位于系统目录（`/etc`、`/usr`、`/bin`… 或 `C:\Windows` / `Program Files` / `ProgramData`）或 cognia 自身的应用数据目录（OAuth 配置 / keyring / 向量库）之下，则在任何 spawn 前以 `InvalidPolicy` 拒绝。其上，`SandboxResourcePolicy.writableRoots` 是可配置的每会话**上限**：`cognia-sandboxed-tools` 把模型给出的每个可写 / 目标路径收窄到这些根目录内（文件工具的目标若在外则抛错）。下限刻意放行 OS 临时目录与用户主目录（Python scratch 用临时目录；Computer Use 默认主目录）。
- **两级受保护路径。** `sandbox::protected` 把豁免清单分为机密凭据库（`.ssh`、`.gnupg`、`.aws`、`.git-credentials`、`.netrc`、`.npmrc`、`.docker/config.json`、`.config/gh`、`.kube/config`、`.pgpass`、云 CLI 令牌缓存，以及 cognia 自身应用数据目录）与写保护控制文件（`.git`、shell rc）。机密库**读写皆禁**——且即便不存在也禁（创建 `~/.ssh/authorized_keys` 永远是恶意的）——并覆盖可写**与**可读根目录（读取即外泄威胁）。写保护文件按存在性门控（禁止改写已有仓库的 hooks / rc，但全新 `git init` 仍可用）。指向任何受保护片段的单文件写目标（`is_protected_anywhere`）在上游即被拒绝——文件工具没有可供按根重绑定的可写根。
- **过滤代理 SSRF 防护。** 宿主侧白名单代理（`net_proxy`）对每个 CONNECT 目标只解析一次，拒绝任何非公网目标（环回 / 链路本地含 `169.254.169.254` / RFC1918 / ULA / CGNAT / IPv4-mapped），再连接到锁定地址——在既有的解析器/解析差分防护之上，关闭 DNS rebinding + IP 字面量 SSRF 类。
- **危险 env 清洗。** 除 `LD_*` / `DYLD_*` / `NODE_OPTIONS` 外，黑名单现追加 `GCONV_PATH`（glibc iconv 模块注入，等同 `LD_PRELOAD`）、`GIT_CONFIG_*` 族（任意 git-config / alias / pager 注入）、`HOSTALIASES` / `NLSPATH` / `RESOLV_HOST_CONF` 解析重定向，以及针对 Windows PowerShell shell 的 `PSModulePath` / `PSExecutionPolicyPreference`（`$PSModulePath` 会从其列出的任意目录自动导入 `.psm1` 模块，是 Windows 上等同 `LD_LIBRARY_PATH` 的注入面；`$PROFILE` 则由以 `-NoProfile` 启动 PowerShell 单独屏蔽）。
- **seccomp 新挂载 API 族。** Linux 过滤器额外拒绝 `open_tree` / `move_mount` / `fsopen` / `fsconfig` / `fsmount` / `mount_setattr`——传统 `mount` deny 看不见的后 `mount(2)` 接口。`clone3` 刻意放行（glibc 线程创建依赖它）。
- **超时杀进程树。** 墙钟看门狗现杀掉整个沙盒进程树（旧文档承诺了代码从未实现的 SIGTERM→SIGKILL 宽限）；Windows 新增宿主侧 `kill_on_drop` 看门狗，超时余量大于 runner 自身期限，避免挂死的 runner 拖垮宿主。
- **交互式 launcher 对齐。** 交互式启动路径——集成终端的 PTY 与 Python 插件宿主——经 `sandbox::launcher` 渲染自己的 `bwrap` / `sandbox-exec` 前缀（无法像 `run_confined` 那样捕获 stdout）。它现在与一次性后端的机密处理对齐：可写**与**可读根下的 SECRET 凭据库（含用户 `$HOME` 与 cognia 自己的凭据库）在 Linux 上被空只读源遮蔽、在 macOS 的 SBPL 配置中被拒绝 READ。此前 launcher 仅把它们重绑为只读但**可读**，且从不扫描可读根，导致沙盒终端可 `cat ~/.ssh/id_rsa` / `~/.aws/credentials`。该路径上调用方提供的 env 现也经同一危险变量清洗，使 `LD_PRELOAD` / `NODE_OPTIONS` / `GIT_SSH_COMMAND` 无法向沙盒 shell 注入代码。

## 非目标

- **sub-sidecar 池 / per-tuple OS 进程**。已确认与 SDK 层 subprocess-per-`query()` 重复。
- **per-tool-call 沙盒启动**。会话内的多次工具调用复用 per-call CLI 子进程;一个会话对应一个沙盒身份,每次工具调用按 per-tool 策略评估。
- **macOS App Sandbox + XPC 迁移**。等 Apple 给 `sandbox-exec` 设定移除时间表后启动；现在推迟。
- **移动端 / Capacitor 覆盖**。Claude Code 不在移动端跑；瘦客户端（ADR-0014 / ADR-0015）超出范围。多租户 per-session 隔离的天然归宿是 V2 headless 服务器。
- **Vercel Sandbox**。仅云上可用，桌面应用默认不可行。
- **AppContainer / Hyperlight / `firejail` / `nsjail`**。已评估并否决（AppContainer 形状不对，OpenAI 已撞墙；Hyperlight 跑不了 shell；后两者与 `bwrap` 功能重复）。
- **删除现有单账号 active 指针**。它仍是 `accountId` 解析链的最终兜底，所以现存安装行为完全不变。

## 影响

- **多账号聊天**变成会话级决策，不再是全局开关。
- **OAuth refresh 竞态**对装有 ≥2 账号的安装彻底消失（各自一份 `.credentials.json`）。
- **per-`query()` env** 让每轮多付一次 Tauri IPC（env 解析约 1 ms）。
- **冷启动代价**每次 `query()` 约 12 秒在 V1 是被接受的(见上文"冷启动代价 —— 接受,不做池")。预热作为文档化的后续跟进。
- **Windows 安装**多随包发布一个 runner 二进制。restricted-token runner 不需要提权弹窗或独立 OS 账号；可选的 kernel-enforced per-SID Firewall 仍是后续。
- **包体积**：Linux 因 bundle `bwrap` 多约 1.5 MB；macOS 用 OS 自带 `sandbox-exec` 不增；Windows 多两个约 500 KB exe。
- **严格模式**意味着 Windows 安装缺失 `cognia-sandbox-runner.exe` 时无法发 Bash / Edit / Write 工具调用，直到修复或重装应用。这是刻意的。
- **resume 冷恢复**对 per-account 会话被降级（用 Dexie 重放代替 SDK resume）—— sidecar 重启后第一轮稍多 input token 消耗，无功能差距。
- **vendor Windows runner crate** 让我们要按季度复审 restricted-token / low-integrity / Job Object 代码，以及值得移植的上游沙盒安全修复。
- **向后兼容**：`accountId` 可选；没设的 session / character / settings 行为与今天完全一致。

## 验证

| 套件                                       | 命令                                    | 跑在哪                                                             |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------ |
| 前端 Jest                                  | `pnpm test:coverage`                    | ubuntu-latest                                                      |
| Sidecar `node --test`                      | `pnpm sidecar:test`                     | ubuntu-latest                                                      |
| Rust 单元（sandbox + active + watcher）    | `cargo test`                            | ubuntu / macos / windows                                           |
| Rust 集成（真实 `bwrap` / `sandbox-exec`） | `cargo test --test sandbox_integration` | ubuntu-latest + macos-14；Windows runner crate 走独立单元测试 |
| Lint + i18n 对齐                           | `pnpm lint && pnpm lint:i18n`           | ubuntu-latest                                                      |
| E2E Playwright（多账号 + 沙盒派发）        | `pnpm test:e2e`，用 MockSDK             | ubuntu-latest                                                      |
| 插件 slots 审计                            | `pnpm audit:slots`                      | ubuntu-latest                                                      |

覆盖率门槛 ≥90%（CLAUDE.md 要求），由现有 Jest config + 新 Rust 模块的 `cargo-tarpaulin` 强制。

手工验收(每个 release 跑一次):完整 Windows 安装 / runner 缺失修复 / 多账号 `mitmproxy` / OAuth 竞态 / resume 重放清单见实施计划 `~/.claude/plans/plan-distributed-wren.md`。

## 后续跟进

1. macOS `sandbox-exec` 弃用时间表 —— Apple 真给日期后，启动 App Sandbox + XPC 迁移（当前 SBPL profile 与 App Sandbox temporary-exception entitlements 一一对应）。
2. 季度复审 `crates/cognia-sandbox-runner` 以及任何值得移植的上游 Windows sandboxing 工作。
3. 单会话 WarmQuery 预热优化 —— 在 `session_ended` 后立即按会话当前 options 起 `startup()`,下条消息若 options 未变就直接用它。V1 推迟;spike 证明跨会话池化不可行,但 stable-options 会话内的单实例预热仍是干净的胜利。
4. Anthropic `--resume` 忽略 `CLAUDE_CONFIG_DIR`（#16103）—— 跟踪上游修复；landed 后 per-account 会话的 Dexie 重放路径可以退役。
5. V2 headless 服务器的多租户 per-session 隔离（ADR-0014 后续）—— headless API 稳定后把 trait / env 注入层端口过去。
6. T2 / T3 / T4 / T5 的遥测 —— 五层都上线后，看 Diagnostics 审计日志里各 tier 的使用比例，判断 T4（e2b）的 opt-in 比例是否值得它的 bundle 成本。
