---
title: ADR-0028 — 按会话隔离 Claude Code
description: "Per-`ChatSession` OAuth / `CLAUDE_CONFIG_DIR` / base-URL / 代理隔离，通过per-`query()`环境（无WarmQuery池——spike显示所有选项都以`startup()`、接近零命中率烘焙;作为单次预热后续推迟），以及五层混合执行沙箱（Cognia限制令牌的Windows运行器 + 沙盒执行器 + bwrap，加上Node 24 `--permission`、Wasmtime、端对端microVM和`computer_use`的每个动作策略门禁）。"
---

# ADR-0028 — 按会话隔离 Claude Code

**状态**：提议（2026-05-20）——**部分发货**;详见下方说明

> **注 （2026-07-25）** 每会话/按角色*账号固定*的一半ADR是实时且用户可访问的，非推测：`accountIdOverride`由`lib/claude/env-resolver.ts`解决，从角色编辑器（`components/settings/characters-section.tsx`）和聊天会话设置表编辑，`components/settings/subscription/account-usage-chips.tsx`中显示为“正在使用”芯片，并有注册的`claude_env_for_account`/`claude_proxy_env_for_session` 命令支持。读者若仅凭字面理解前言，会认为这些内容根本不存在。执行沙盒部分尚未与该文档进行重新核实，因此整体状态保持提议，而非翻转为已接受。
**Supersedes**：扩展ADR-0010（Claude订阅OAuth）、ADR-0020（计算机使用完整性）、ADR-0025（统一订阅模块）、ADR-0026（插件扩展点扩展）**作者**：Max Qian + Claude Opus 4.7

## 背景

cognia-next 的节点sidecar（`sidecar/claude-host.mjs`）是一个单OS进程，可托管 N 个并发`@anthropic-ai/claude-agent-sdk` `query()`由 `sessionId` 键控的呼叫。`lib/claude/build-options.ts:resolveSendOptions`已经为每个`ChatSession`隔离出大量接口：`cwd`、`model`、`provider`、`providerCredentials`、`allowedTools` / `disallowedTools`、`mcpServers`、`additionalDirectories`、`permissionMode`、`settingSources`、`agents`、`appendHeaders`，每个呼叫的`env`（针对`DEBUG`和`anthropic-beta`的头部）。

然而，目前有四个轴线**冻结在sidecar靴*，且无法在中段变化：

1. `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` — 每个sidecar过程（`src-tauri/src/claude/sidecar.rs:143-155`）一个OAuth身份。
2. `CLAUDE_CONFIG_DIR` / 磁盘`~/.claude/`——每个进程一个配置文件目录（被生成的CLI二进制文件读取一次）。
3. `ANTHROPIC_BASE_URL`——每个进程一个端点。
4. `HTTPS_PROXY` / `HTTP_PROXY` — 由`proxy_config::current()`在出生点设定sidecar。

此外，对于高风险工具调用（`Bash` / `Edit` / `Write` / 原生`text_editor`）也没有**OS-level执行沙箱**。`additionalDirectories`是SDK-level 门禁，而非OS。现有的三层权限门禁（`src-tauri/src/automation/permission.rs`）、HITL同意代理（`src-tauri/src/automation/consent.rs`）和审计日志（`src-tauri/src/automation/audit.rs`）提供了策略层防御;执行层防御缺失。

ADR-0025已经发布了多账户保险库（`src-tauri/src/subscription/vault.rs` `ProviderVault::accounts[]`）;目前一次只有一个账户是“活跃”的。用户多次请求按会话切换账户（个人Pro + 公司Max）。树内的Windows限制令牌运行器（`crates/cognia-sandbox-runner`）和文档中的`@anthropic-ai/sandbox-runtime`包（mac/Linux）使得一个可信的跨平台沙盒终于变得可行。

一次研究还证实了两个重塑建筑的SDK-level事实：

- **每个`query()`已经生成一个新的`claude-code` CLI子进程。**节点主机只是一个编排器。每次调用`options.env`（明确有`{ ...process.env, ...override }`分布，因为v0.2.113 `env`是替换而非覆盖层）完全隔离子进程的环境。**不需要子sidecar进程池**即可在每个会话中变化OAuth/配置-dir / base-URL/代理。
- **两个并发的CLI子进程共享一个`~/.claude/.credentials.json`，将在OAuth刷新时进行竞赛**（开放Anthropic期#43392、#24317、#56339）。每个账户`CLAUDE_CONFIG_DIR`目录通过为每个账户分配自己的凭证文件来消除竞争。

## 决策

### 每查询环境注入（方法B）

`ChatSession`获得可选`accountId`（UUIDv7指`ProviderVault::accounts[]`）;`Character`获得`accountIdOverride`;`AppSettings`获得`defaultAccountId`。`resolveSendOptions`获得`session → character → settings → ActiveAccountState`（现今的主动指针仍为最后回退）。

`src-tauri/src/subscription/active.rs`获得一条**只读**的`env_for_account(provider, account_id) → Vec<(String,String)>`路径，不接触活动指针。它会输出一个OAuth-mode-appropriate环境（`CLAUDE_CODE_OAUTH_TOKEN` xor `ANTHROPIC_API_KEY`）、加上`CLAUDE_CONFIG_DIR = <app_data>/cognia/claude-configs/<accountId>/`（首次调用时确保创建）、账户记录中的`ANTHROPIC_BASE_URL`，以及来自 `proxy_config::current()` 的每个会话代理。

`lib/claude/build-options.ts`通过两个新Tauri 命令（`claude_env_for_account`、`claude_proxy_env_for_session`）解析该元组，并在`debugMode`分支前合并为`opts.env`。`sidecar/dispatch/anthropic.mjs:117`已经正确地做到`baseEnv = { ...process.env, ...(sendOptions.env ?? {}) }`——评论经过加固，提醒未来读者注意v0.2.113替换语义。

考虑过子sidecar池并已拒绝：SDK-level subprocess-per-`query()`已经为每个会话提供了一个隔离的CLI进程。在上面运行自己的节点子sidecar是冗余的，且每个会话内存成本增加了三倍。

### 冷启动成本——已接受，无池

SDK暴露了一个`startup()` API（自v0.2.111起），返回一个`WarmQuery`以摊销CLI子进程的~12秒冷启动。context7对v0.2.111+的激增解决了计划标记为应急的问题：**每个`Options`字段——包括`cwd`、`model`、`mcpServers`、`agents`、`allowedTools`、`additionalDirectories`、`permissionMode`、`canUseTool`、`resume`、`forkSession`——都在`startup()`该时烘焙**，`WarmQuery`实例只能执行一次`.query()`调用，之后被丢弃。在Cognia中，`additionalDirectories`（由`@`-references驱动）、`appendSystemPrompt`（由目标注入/工作流程快照驱动）以及其他几个字段每条消息都会变化，所以元组键温池的命中率几乎为零。复杂度并不值得它应付。

**决策**：池被丢弃。每个`query()`支付~12秒冷启动;sidecar在成本中处理流输入，因此用户每_send_看到一次旋转器，而非每回合。`sidecar/dispatch/anthropic.mjs`中的流输入流保持不变。未来的优化可以在`session_ended`后预热每会话`WarmQuery`，并在下一条消息中交换，_if_选项未变——作为后续跟踪而非V1范围。

`env`语义是：自v0.2.111起，子进程`options.env`**覆盖层**（覆盖层**`process.env`子进程（在上一次研究阶段，v0.2.113时曾短暂替换-非覆盖;当前公开文档覆盖层）。无论如何，`sidecar/dispatch/anthropic.mjs:117`的显式`baseEnv = { ...process.env, ...(sendOptions.env ?? {}) }`在两种制度下均正确且保持。

### 五层混合执行沙盒

T1–T5涵盖正交威胁接口;并非所有场次都涵盖所有等级。

#### T1 — OS-native沙盒，适用于`Bash` / `Edit` / `Write` / `text_editor`

`src-tauri/src/sandbox/mod.rs`中`SandboxedExec`的一项新 Rust 特征暴露了`run(SandboxCommand, SandboxPolicy)`。各平台`cfg(target_os = …)`后端：

- **Windows**：`crates/cognia-sandbox-runner`以`cognia-sandbox-runner.exe`形式发布。运行者在应用自身令牌的受限子集下启动目标，降低完整性，将进程树分配给作业对象，并通过JSON返回捕获的stdout/stderr。它不需要升华、独立OS账户，或预设的文件系统/权限/进程约束设置标记。遗留`target_user` 载荷字段仅保留用于JSON兼容性，运行者忽略;`cognia-sandbox-setup.exe`预留给未来的可选per-SID防火墙后续。
- **macOS**：直接Rust呼叫`sandbox-exec -f <profile.sb> -- <argv>`，`src-tauri/src/sandbox/macos/profiles/`中SBPL模板。备选方案B文档，苹果移除`sandbox-exec`当天——迁移到应用沙盒+XPC服务。
- **Linux**：捆绑静态`bwrap`二进制文件Tauri资源;`--unshare-all` + 可选`--share-net` + read/write绑定 + `--die-with-parent` + 基于 Flatpak 的 seccomp 配置文件。

T1拦截路径：一个新的树内插件`plugins/cognia-sandboxed-tools/`注册四个MCP工具（`sandbox_bash` / `sandbox_edit` / `sandbox_write` / `sandbox_text_editor`）。当会话启用沙盒时，`resolveSendOptions`会将内置SDK添加到`disallowedTools`，过滤`anthropicTools`投影中的原生`text_editor`，附加简短的系统提示说明，并通过`opts.pluginTools` 接口四个沙箱对应工具。现有的`plugin_tool_exec` IPC桥（`sidecar/builtin-tools/plugin-tools.mjs`）将调用传递给渲染器，渲染器再向`sandbox_exec` Tauri 命令发送。SDK保持不变。

考虑的替代方案是通过SDK的 `executable` hook 包裹整个 CLI 子进程——已拒绝：它强制所有工具通过沙箱（只读工具有点大材小用），破坏标准MCP IPC，并阻止每个工具的策略。Per-`canUseTool`-style拦截保留了SDK的授权/环境/MCP布线，让我们对 Bash 施加比对编辑更严格的策略。

#### T2 — Node 24 `--permission` 用于插件JS执行器

新`lib/plugin/launcher/launchPluginJs.ts`重新执行节点目标插件JS条目，视其条目`node --permission --allow-fs-read=<…> --allow-fs-write=<…>`源自插件的清单 `PluginPermission[]` 和具体`fileScope`。空或缺失的具体作用域会省略对应的标志（默认为拒绝），通配符值则被过滤，而非节点`*`授予的输出。节点24不暴露有范围的网络主机授权，且`--allow-child-process`为全有或全无，而非可执行范围，因此`networkAccess.allowedDomains`和`shellCommands` 默认拒绝，并带有主机代理错误，而非被扩展为无效或宽广的节点标志。`PluginLoader`将此作为正常`PluginDefinition` activate/deactivate路径暴露，因此`PluginManager.loadPlugin()`通过现有生命周期到达该路径，并在deactivate/unload时终止生成进程。

威胁模型说明：Node的权限模型仅限制插件进入进程。原生子进程没有实质等效的继承，因此类似shell的工作必须通过T1支持的主机工具或显式未来代理路由。如果插件需要网络访问，必须使用能够强制声明的主机允许列表的经纪主机API;Node 24执行器从不将“全部”扩展到Node `*`，也不会发出广泛的子进程权限。

#### T3 — Wasmtime + WASI for plugin WASM

新`lib/plugin/core/wasm-runtime.ts`通过`@bytecodealliance/jco`（或`wasmtime`节点绑定）运行WASM插件;主机导入仅限于通过`lib/plugin/security/wasm-grant.ts`授予的预开。预开授权账本是持久的Dexie状态（`wasmGrantLedger`，模式v88），旧的localStorage镜像仅用作迁移回退。插件更新时，清单预开与账本对账：移除的路径被拒绝并警告，新声明的路径在审核前不会被授予。运行时还会在每次调用前重新验证已加载的预开集，因此加载后撤销授权无需等待重新加载即可生效。

#### T4 — e2b Firecracker microVM作为选择加入的等级

`Character.computerUseSettings.sandboxTier?: "os" | "microvm"`。`microvm`时，`sandbox_*`工具实现会路由到现有的`plugins/e2b-sandbox/`工作区后端，而不是T1。e2b没有变化;只有一个路由分支。

#### T5 — `computer_use`的每个行动策略 门禁

`computer_use`无法进行进程沙盒（其全部目的是驱动主机的运行）UI）。新`src-tauri/src/automation/policy.rs`在现有的四层防御基础上增加了第五层防御（三层权限、HITL同意、审计日志、`Character.computerUseSettings.allowedToolIds`）：按`target_app_name?`、`target_window_title_regex?`、`target_url_regex?`、`forbidden_screen_regions?`为关键的每个动作策略。在获得同意后立即评估`permission.rs:PerCall`。

### 严格模式（无旁通）

当T1后端不可用（Windows运行器缺失、缺`bwrap`、运行程序退出非零）时，工具调用**严格拒绝**。没有设置开关来禁用沙箱，也没有`COGNIA_SANDBOX_BYPASS`环境后门。沙箱→设置接口红色“需要设置”徽章和一个“重试设置”按钮。选择是有意为之：绕过选项会创建一个社会工程目标（“助手告诉我关闭沙盒”），任何审计痕迹都无法抵消。

### 恢复漏洞（#16103）缓解

SDK的`--resume`忽略`CLAUDE_CONFIG_DIR`（只在默认`~/.claude/projects/`下查看）。当sidecar重启（自上次`sidecar_exited`以来无`sdk_session_id`事件）AND `session.accountId`设置时，`resolveSendOptions`跳过`opts.resumeSessionId`，并在新`lib/claude/replay.ts:buildReplayPrompt(messages, currentMessage, budget)`构建的Dexie来源回放前缀前置。默认账户会话（无`accountId`）完全保持当前简历的行为。

### OAuth刷新写回

每个账户`CLAUDE_CONFIG_DIR`目录消除了`.credentials.json`的跨进程竞速，但CLI的子进程刷新是写入磁盘，而非写回密钥环保险库。新`src-tauri/src/subscription/anthropic/credential.rs::watch_configdir_credentials(account_id, path)`使用`notify` crate监控`<configdir>/.credentials.json`;更改`mtime`时解析文件，并将旋转后的`refresh_token`写回vault账户记录。watcher生命周期：该账户从第一个会话开始;最后一次关闭时停止。

### 审计 + 可观测性

`automation/audit.rs` 获得了`Surface::Sandbox`变体。每个沙箱调用（允许/拒绝/错误）都会被记录;`resume_replayed`事件也会被记录。现有的 5000 封 VecDeque + Dexie `automationAuditLog` 镜像负责携带这些事件。现有的诊断标签页（`components/settings/sections/diagnostics-section.tsx`，可观测组）扩展了可折叠的沙盒事件日志卡和sidecar重启计数器——没有新标签页。

### UI 接口

- **沙盒→设置**（新标签页）：健康卡含后端+版本/运行者可用性，“重试设置”/“运行健康探针”按钮，默认层级选择器（OS/microVM——严格模式下不“关闭”），每个工具的网络策略编辑器，T5每个应用的策略编辑器。
- **订阅→设置**（扩展）：每个账户“被X字符/Y会话使用中”芯片，“设置为默认”操作，删除引用确认。
- **诊断→设置**（扩展）：沙箱事件日志 + sidecar重启计数器折叠。
- **角色编辑器**（扩展）：账户选择器 + `sandboxTier`覆盖。
- **聊天会话头**：账户徽章（用户只有一个账户时隐藏）+ 切换器→吐司“下一条消息将使用账号 X”。
- **Composer**：盾牌指示器（绿色/黄色/红色用填充/虚线/划线）——颜色与形状搭配，以保证色盲安全。
- **首次运行向导**：平台检测→后端/运行者健康检查→修复指导。

所有新弦都落在`i18n/messages/en.json`和`i18n/messages/zh-CN.json`（≈120–150调）之间。`pnpm lint:i18n:baseline`在有意更换后运行。

### 执行层硬化（T1后续）

对已发货T1后端的全链审计揭示了并关闭了一系列逃逸/撤离漏洞。这些现已成为T1合同的一部分：

- **可写根底线+天花板。** 模型完全控制`sandbox_*`调用中的`writable`/`target`路径。`sandbox::run_confined`现在强制执行始终在线的FLOOR：一个cwd/可写/写目标，位于系统目录（`/etc`、`/usr`、`/bin`、...或`C:\Windows`/`Program Files`/`ProgramData`）或Guia自身的应用数据目录（OAuth配置/密钥环/向量存储）下，在任何生成前都会被拒绝`InvalidPolicy`。此外，`SandboxResourcePolicy.writableRoots` 是一个可配置的每次会话CEILING：`cognia-sandboxed-tools` 会将模型提供的可写/目标路径缩小到这些根节点（当目标在外部时文件工具会抛出）。OS 临时 Dir 和用户的 home 是故意允许在 floor 的（Python Scratch 使用 temp;计算机使用默认为 home）。
- **两层保护路径。** `sandbox::protected`将切割列表分为SECRET 凭证存储（`.ssh`、`.gnupg`、`.aws`、`.git-credentials`、`.netrc`、`.npmrc`、`.docker/config.json`、`.config/gh`、`.kube/config`、`.pgpass`、cloud-CLI令牌缓存以及Cognia自有的应用数据目录）和WRITE-PROTECTED控制文件（`.git`、shell rc）。SECRET存储不仅被拒绝写入，也READ被拒绝——即使不存在也会被阻挡（创建`~/.ssh/authorized_keys`总是敌对的）——无论是可写根AND还是可读根（读取是泄露威胁）。WRITE-PROTECTED文件存在门禁（现有仓库的hook / rc 重写被拒绝，但新`git init`仍然可行）。单个文件写目标指向任何受保护段（`is_protected_anywhere`）时，上游被拒绝——文件工具没有可写的根节点，用于每个根的重新拒绝。
- **Filtering-proxy SSRF guard。** 主机端允许列表代理（`net_proxy`）只解析每个CONNECT目标一次，拒绝任何非公开目的地（环回/链路本地，包含`169.254.169.254`/RFC1918/ULA/CGNAT/IPv4-mapped），然后连接到固定地址——关闭DNS-rebinding+IP-literal SSRF类，覆盖在现有parser/resolver-differential守卫之上。
- **Dangerous-env scrub.** 除了 `LD_*` / `DYLD_*` / `NODE_OPTIONS` 之外，拒绝者现在会丢弃 `GCONV_PATH`（glibc iconv 模块注入——`LD_PRELOAD` 的等价物）、`GIT_CONFIG_*` 家族（任意的 git-config / 别名 / 分页器注入）、`HOSTALIASES` / `NLSPATH` / `RESOLV_HOST_CONF` 解析器的重定向，以及——对于 Windows PowerShell shell ——`PSModulePath` / `PSExecutionPolicyPreference`（`$PSModulePath` 自动从任意列出的目录导入`.psm1`模块，这是 Windows 的对应`LD_LIBRARY_PATH`;`$PROFILE`通过生成PowerShell与`-NoProfile`）单独中和。
- **seccomp new-mount-API 家族。** Linux 过滤器还会拒绝 `open_tree` / `move_mount` / `fsopen` / `fsconfig` / `fsmount` / `mount_setattr`——post-`mount(2)` API这些本可以嫁接遗留`mount`拒绝的文件系统，但遗留机构从未看到。`clone3` 是故意允许的（glibc 线程创建依赖于此）。
- **超时会杀死树。** 墙上时钟看门狗会关闭整个沙箱进程树（文档之前过度承诺SIGTERM-then-SIGKILL没有代码实现的宽容）;Windows 获得了一个主机端的`kill_on_drop`看门狗，且比运行者自己的截止时间有余距，因此挂机运行者无法楔入主机。
- **交互式启动器对等性。** 交互式启动路径——集成终端的 PTY 和 Python 插件主机——通过 `sandbox::launcher` 渲染自己的 `bwrap` / `sandbox-exec` 前缀（它无法像 `run_confined` 那样捕获标准）。它现在镜像了一次性后端的秘密处理方式：在可写且可读根节点下的 SECRET 存储（包括用户的 `$HOME` 和 cognia 自己的 凭证 存储）在 Linux 上被空的只读源遮挡，macOS SBPL配置文件中被拒绝READ。之前启动器将它们重新装定为只读但可读，且从未扫描可读根节点，因此沙箱终端可以`cat ~/.ssh/id_rsa` / `~/.aws/credentials`。这条路径上的调用者提供的环境也经过相同的危险环境清除程序，因此`LD_PRELOAD` / `NODE_OPTIONS` / `GIT_SSH_COMMAND` 无法向沙箱壳注入代码。

## 非目标

- **子sidecar池 / OS-process-per-tuple。** 根据SDK subprocess-per-`query()`被验证为冗余。
- **每个工具调用沙箱启动。** 会话中的工具调用重复使用每个调用CLI子进程;每个会话一个逻辑沙箱身份，根据每个工具策略评估每个工具调用。
- **macOS 应用沙盒 + XPC迁移。** 作为苹果设定`sandbox-exec`移除日期时的备选方案;推迟。
- **移动/Capacitor覆盖。** Claude Code 不在移动端运行;瘦客户端（ADR-0014、ADR-0015）是超出范围。V2 无头服务器是服务器层多租户每会话隔离的自然归宿。
- **Vercel 沙盒。** 仅云端;作为桌面应用默认不现实。
- **AppContainer / 超轻型 / `firejail` / `nsjail`。** 已评估并已拒绝（每条OpenAI形状AppContainer错，超轻型不能运行炮弹，后两个对`bwrap`来说是多余的）。
- **移除现有的单账户活跃指针。** 它仍然是`accountId`解析链中的最后一个回退，因此现有安装保持当前行为。

## 后果

- **多账户聊天**变成了每次会话的决策，而非全局模式切换。
- **OAuth刷新竞赛**在≥两个账号安装时消失（每个账号都有自己的`.credentials.json`）。
- **Per-`query()` 环境** 管道意味着每匝为环境分辨率支付一趟往返Tauri IPC（~1毫秒）。
- **每次`query()`呼叫的冷启动成本**为12秒，在V1中已接受（参见上文“冷启动成本 — 已接受，无池”）。预热是有文档的后续检查。
- **Windows 安装** 附带一个额外的运行器二进制文件。限制令牌运行器无需升高提示或单独OS账户;可选的内核强制per-SID防火墙工作仍需后续处理。
- **捆绑包大小**：捆绑`bwrap`为Linux构建增加了~1.5 MB;macOS使用OS-provided `sandbox-exec`;Windows自带两个~500 KB exe。
- **严格模式**意味着缺少Windows安装`cognia-sandbox-runner.exe`在修复或重新安装应用之前无法发送Bash/编辑/写入工具调用。这是设计使然。
- **恢复冷恢复**在每个账户会话中降级（从Dexie回放而非SDK恢复）——sidecar重启后第一回合输入标记成本略高，但无功能缺口。
- **提供Windows运行程序crate**意味着我们必须季度审查受限令牌/低完整性/作业对象代码，以及任何值得移植的上游沙箱修复。
- **向下兼容**：`accountId`为可选;没有此功能的会话/角色/设置表现与现今完全相同。

## 验证

| 组曲 | 命令 | 其中 |
| ------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| 前端玩笑 | `pnpm test:coverage` | Ubuntu-最新 |
| sidecar `node --test` | `pnpm sidecar:test` | Ubuntu-最新 |
| Rust单位（沙盒+主动+watcher） | `cargo test` | Ubuntu / macOS / Windows |
| Rust积分（实`bwrap` / `sandbox-exec`） | `cargo test --test sandbox_integration` | Ubuntu 最新 + macOS-14;Windows 运行crate有独立的单元测试 |
| Lint + i18n 对等性 | `pnpm lint && pnpm lint:i18n` | Ubuntu-最新 |
| E2E Playwright（多账户+沙盒派遣） | `pnpm test:e2e` MockSDK | Ubuntu-最新 |
| 插件槽审计 | `pnpm audit:slots` | Ubuntu-最新 |

覆盖门槛≥每CLAUDE.md 90%，由现有的Jest config + `cargo-tarpaulin`强制执行，适用于新Rust模块。

手动接受（按版本）：详见实施计划 `~/.claude/plans/plan-distributed-wren.md` — 完整 Windows 安装 / 缺失跑者修复 / 多账号`mitmproxy` / 竞速OAuth / 恢复回放清单。

## 开放后续

1. macOS `sandbox-exec`弃用时间线——当苹果设定日期时，安排应用沙盒+XPC迁移（当前SBPL配置文件一对一地移植到应用沙盒临时例外权限）。
2. 季度回顾`crates/cognia-sandbox-runner`及任何值得移植的上游Windows沙箱工作。
3. 每场WarmQuery预热优化——`session_ended`后立即启动`startup({sessionOptions})`，当选项未变时下一条消息交换。推迟于V1;峰值显示池式共享在各场次不可行，但稳定期权会话的单场预热依然是干净利落的胜利。
4. Anthropic `--resume`忽略`CLAUDE_CONFIG_DIR`（#16103）——跟踪上游修复;一旦确定，Dexie重放路径可以退役用于每个账户会话。
5. V2 无头服务器多租户每会话隔离（ADR-0014后续）——当无头 API稳定后，对特征/环境注入层进行端口。
6. T2 / T3 / T4 / T5遥测——五级发货后，在诊断审计日志中测量层级组合，以判断T4（e2b）选择加入率是否值得其捆绑成本。
