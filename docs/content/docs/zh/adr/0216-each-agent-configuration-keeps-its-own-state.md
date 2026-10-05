---
title: "0216 — 每个外部 Agent 配置各自保存状态"
description: "同一外部运行时的多个配置过去共用它的主目录、登录、全局当前订阅账号，而且重启后都拿不到自己的钥匙串密钥。现在配置带有 stateIsolation（缺省为 shared，已有配置保留原有登录；每个新建配置和每个副本默认 isolated）。独立的配置以每配置一个状态根启动，派生后端把它映射到运行时的主目录变量并在沙箱中隔离。进入管理器的每条路径都经过同一个启动准备器，解析配置自己的密钥、状态根和绑定账号。复制改为对话框，会话上限与审批列表得到执行，插件获得带读取与管理权限的 ctx.externalAgents。"
---

# ADR 0216 — 每个外部 Agent 配置各自保存状态

**状态：** 已接受（已实现）
**日期：** 2026-10-05
**修订：** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)（管理器准备每次启动）、[ADR-0119](./0119-pi-native-rpc-integration)（Pi 遵循配置的审批列表）
**相关：** [ADR-0025](./0025-unified-subscription-module)（订阅账号）、[ADR-0145](./0145-python-plugin-runtime-alignment)（Python 贡献）、[ADR-0182](./0182-a-project-names-the-image-it-runs-in)（沙箱放置）、[ADR-0199](./0199-an-agent-variant-follows-its-base)（Cognia 自身 Agent 的变体，是另一种机制）

## 背景

外部 Agent 页面允许为同一运行时保存多个配置：只读的 Codex 与可写工作区的 Codex 并存，或者同一个 CLI 用两个账号。2026-10-05 的审计发现这些配置实际上并不隔离：

- **重启后的密钥。** 钥匙串密钥只有经过 `ExternalAgentLifecycleService.register()` 才会进入启动。启动时的重新注册、`lifecycle.connect` 和“连接”按钮传的都是去掉密钥的存储配置，所以重启后每个配置都在没有自己凭证的情况下运行。
- **共用主目录。** 同一运行时的所有配置都使用运行时的状态目录（`~/.codex`、`~/.claude*`、`~/.qwen`、`~/.pi` 等）：同一个登录、同一份配置文件、同一个 MCP 列表、同一份会话历史，刷新令牌还会相互竞争。手动设置 `CODEX_HOME` 会被沙箱的可写根抵消。
- **共用账号。** Codex 环境注入总是使用全局当前的订阅账号。
- **一个 Python 适配器对象**服务插件适配器的所有配置。
- **跨配置的会话。** 导入会话的原生恢复会选中该运行时的任意一个配置。
- **主机端配置**启动时不解析密钥，会删除内联密钥，并接受指向其他配置的凭证引用。
- **复制**会带上状态目录环境变量、固定的 OpenCode 端口和明文服务器密码，自动连接副本，不记录来源，生成“(copy) (copy)”，并丢掉会话上限。
- **预设绑定**会优先选中恰好已连接的那个副本；本地与主机记录配对时退回到按名称匹配。
- **登出**会让所有共用该 CLI 账号的兄弟配置一起登出，却不提示。
- **声明了却未生效：** `autoApprovePatterns`、`requireApprovalFor` 和 `maxConcurrentSessions` 被保存却从不执行。
- **没有插件 API** 可以读取或管理配置。

## 决定

### 配置字段

`ExternalAgentConfig`（`types/agent/external-agent.ts`）新增：

| 字段 | 含义 |
| --- | --- |
| `stateIsolation?: "shared" \| "isolated"` | 缺省即 `shared`：此前保存的配置保持原有行为和登录。创建规范化与复制构建默认 `isolated`。 |
| `subscriptionAccountId?: string \| null` | Codex 系列。以该账号而不是当前账号启动。更新时传 `null` 清除。 |
| `duplicatedFromAgentId?: string` | 来源，仅由复制写入。来源仍存在时界面会显示。 |
| `maxConcurrentSessions?: number` | 缺省为不限。可设置，更新时传 `null` 清除。 |
| `sessionIdleTimeout?: number` | 可设置，更新时传 `null` 清除。 |

### 状态根

`protocol/external-agent-security-policy.json` 新增 `agentStateIsolation.rules`：按运行时说明要设置哪些主目录变量（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`QWEN_HOME` 等）、有哪些共享根、禁止读取哪些。支持：codex、claude、qwen、pi、kimi、cline、qoder、copilot、opencode。没有规则的运行时（gemini、goose、devin、kiro、droid、cursor、aider、dsh）无法隔离：在其上设为独立的配置会以 `state_isolation_unsupported` 被阻止，界面对它只提供共享状态。

TypeScript 侧（`lib/ai/agent/external/lifecycle/launch-preparation.ts`）设置 `COGNIA_AGENT_STATE_KEY=<configId>`，并移除规则所拥有的环境变量。每个派生后端——Rust `crates/cognia-external-agent/src/state_isolation.rs` 与 CLI 的 `cli/src/runtime/external/state-isolation.ts`——校验键（`^[A-Za-z0-9_-]{1,128}$`），根据宿主环境解析 `<data_dir>/cognia/external-agents/<key>`，以 `0700` 创建，把规则的变量映射进去，从子进程环境中移除该键；在沙箱中使该根可写，把共享根移出可写集合并禁止读取。在 Linux 上，若状态根位于被遮蔽的密钥存储之下，启动器会重新打开它（`crates/cognia-exec-sandbox/src/launcher.rs`）。删除配置会删除它的根（`external_agent_state_root_remove`）；检查器显示路径和大小（`external_agent_state_root_info`）。

网关任务和机器人隔离的启动保留各自的隔离，不再叠加第二个根。

### 统一的启动准备器

`ExternalAgentManager.addAgent` 在做任何事之前，让每个配置经过同一个准备器：按 `credentialRefs` 解析钥匙串密钥（现在包括 `serverPassword` 槽位），应用状态根；对绑定的 Codex 账号读取该账号的环境（`subscription_get_account_env`），过期则刷新，但不把它设为当前账号。因此进入管理器的每条路径都以配置自己的凭证启动。准备失败会拒绝注册。

### 运行时中的实例

- **会话上限。** 超过 `maxConcurrentSessions` 打开会话时，先关闭最久未活动的空闲会话；若所有会话都在执行中，则以 `session_limit_reached` 拒绝。
- **审批列表**按 `allowedTools` 语法，对请求的标题、工具名和类型匹配并执行：ACP 客户端、Codex app-server 客户端（计划模式仍然拒绝）、Pi（静态覆盖加动态批准），以及管理器事件流中的 OpenCode 与插件适配器。“询问”优先于跳过权限模式。
- **预设绑定**按启用、创建时间、id 排序。本地配置与主机记录按名称配对，仅在名称两侧唯一且主机记录没有来源信息时发生。
- **导入会话恢复**排除独立配置（其历史不属于运行时），当多个共享配置都符合时让用户选择。
- **Python 适配器。** 贡献信封新增第五个元素：实例 id。以类声明的贡献按配置各有一个实例；`__release__` 释放它。

### 复制

`externalAgentDuplicateInput` 复制设置、会话上限和绑定账号，记录来源，默认 `isolated`，保持源的启用状态但从不连接副本，并去掉隔离规则拥有的环境变量、`metadata.port` 与 `metadata.serverPassword`。密钥被复制到副本自己的钥匙串槽位，删除任一方都不会破坏另一方。名称唯一（“X (copy)”、“X (copy 2)”……）。桌面端与手机端都先在对话框中询问名称、状态和启用开关。主机通过 `external_agent_config_duplicate` 提供同样的能力。

### 主机端配置

主机端配置把密钥保存在以自身 id 命名的钥匙串槽位，启动时只用自己的引用，拒绝外来引用，接受 `null` 清除上限，删除时清理槽位和状态根。

### 管理界面

桌面设置的侧栏可按状态或按运行时分组，显示每个配置的区别（状态、权限、模型、账号、目录、参数、沙箱、会话上限、审批），窄窗格下以列表→详情推入。检查器可直接编辑名称、描述和启用状态，并有“此配置”一节：状态选择、目录、会话上限、兄弟配置及共享内容。编辑器在桌面为对话框、在手机为抽屉，等待保存完成，失败时保持打开。移动端 `/me/external-agents` 为每个主机配置提供详情页。聊天侧的管理器会提示登出将影响共享状态的配置，并链接到设置。

### 插件 API

`ctx.externalAgents`（TypeScript 与 Python，桌面端）：

- `agent:external:read`：`list`、`get`、`getReadiness`、`listPresets`、`listRuntimes`、`getSettings`、`listDelegationRules`、`onChange`（Python：`onExternalAgentConfigChange` 钩子）。
- `agent:external:manage`（危险）：`create`、`createFromPreset`、`update`、`duplicate`、`remove`、`setEnabled`、`connect`、`disconnect`、委派规则写入与 `updateSettings`。

投影从不包含密钥、环境变量、请求头或钥匙串引用。带内联凭证的输入会被拒绝；凭证和非沙箱授权只能在宿主界面中完成。写入经过生命周期服务，并记录 `metadata.createdByPluginId`。

`runExternalAgent` 在总开关关闭、目标被禁用或未就绪时拒绝，把请求的权限模式限制在配置的默认值以内（预设的临时实例使用全局默认值），并在运行结束后移除临时实例。指向外部 Agent 的 `dispatchSubagent` 还需要 `agent:dispatch-external`。

## 后果

- 独立配置启动时未登录其运行时；复制对话框、编辑器和检查器会在更改前说明这一点。
- 已有配置在用户把它切换为独立状态之前不会有任何变化。
- 运行时只需在策略文件中添加规则即可支持隔离；`scripts/gates/check-agent-capabilities.mjs` 保持规则表与两个派生后端同步。
- 提升安全策略版本会使非沙箱授权失效，因此本次没有提升版本。

## 验证

- `lib/ai/agent/external/lifecycle/launch-preparation.test.ts`、`lib/ai/agent/external/manager.instances.test.ts`、`lib/ai/agent/external/lifecycle/service.test.ts`、`lib/ai/agent/external/config/{duplicate-config,instance-family,agent-binding,env-builder,host-config-service}.test.ts`
- `crates/cognia-external-agent/src/state_isolation.rs`（文件内测试）、`cli/src/runtime/external/state-isolation.test.ts`
- `lib/plugin/api/external-agents-api.test.ts`、`lib/plugin/messaging/external-agent-config-hook-source.test.ts`、`plugin-sdk/python/tests/test_contributions.py`
- `components/settings/agent/*.test.tsx`、`components/mobile/external-agents/*.test.tsx`
