# CC Switch 的 subagent 模型与网关实现：对照 Cognia

研究日期：2026-10-20（Asia/Shanghai）。上游：`farion1231/cc-switch`，固定提交 [`f92ff0b03964188f1cd011d9302ab8869d7a8219`](https://github.com/farion1231/cc-switch/commit/f92ff0b03964188f1cd011d9302ab8869d7a8219)，提交时间 `2026-10-19T10:26:47Z`，package version `4.0.16`。本地只读研究副本：`/tmp/cognia-ccswitch-20261020`。

本文件采用仓库现有的 dated research note 约定，独立记录外部项目快照和比较结论；不修改生产代码，也不把外部实现当作 Cognia 已具备的能力。

## 结论

CC Switch 把两个问题拆开：**Route 模式解决供应商切换、模型档位映射和故障转移；Stack 模式把供应商身份编码进模型 ID，实现请求级的模型与供应商绑定。** 它对原生 subagent 的主要集成入口是 Claude Code 的环境变量、Codex 的 `[agents]` 默认模型与模型目录，而不是自己接管子 agent 生命周期。

最值得 Cognia 借鉴的是：保留模型角色的语义、发布带供应商身份的模型目录、校验子模型是否在目录中，以及对显式供应商绑定禁止静默切换。Cognia 已有通用多模型网关原语，短板集中在外部任务 lease/config 仍把模型角色压成同一模型，以及 UI/导入配置没有贯通；不需要推翻网关重新实现。

## 1. 三种运行方式不能混为一谈

| 方式   | 客户端配置                                           | 实际选路                                 | 故障转移                                                 |
| ------ | ---------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Direct | 写目标供应商连接、凭据和模型字段                     | 客户端直接访问该供应商                   | 此处没有 CC Switch 代理链                                |
| Route  | 客户端指向本地代理；Claude 使用稳定模型别名          | 先选供应商，再按该供应商配置映射模型     | 可按供应商队列顺序切换，带 provider circuit breaker      |
| Stack  | 本地代理 + 多供应商模型目录；模型 ID 含 provider key | 从请求的模型 ID 解出唯一供应商与真实模型 | 显式绑定不转移；Stack 模式下普通模型请求也只走默认供应商 |

Route 的 `ProviderRouter` 不按子 agent 名称或角色选供应商。关闭 failover 时只取当前供应商；开启后只按队列顺序取可用供应商，熔断器 key 为 `app_type:provider_id`。Codex Official 账号不参加跨账号重试，以免复用入站账号凭据。[ProviderRouter 源码](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/provider_router.rs#L15-L135)

Stack 则先解析模型 ID，拿到 `StackTarget.provider`，将请求模型替换为真实上游名称，然后构建只含该供应商的转发列表、关闭 failover。[请求解析](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/handlers.rs#L179-L214)、[绑定转发上下文](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/handler_context.rs#L127-L188)

## 2. Claude Code：档位模型与 subagent 模型分开管理

### 2.1 明确的配置入口

供应商表单分别提供 Sonnet、Opus、Fable、Haiku 和 Subagent 模型；前四者保存为 `ANTHROPIC_DEFAULT_*_MODEL`，Subagent 保存为 `CLAUDE_CODE_SUBAGENT_MODEL`。这是显式的执行配置，不只是把几个 model ID 放进展示目录。[Claude 表单](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src/components/providers/forms/ClaudeFormFields.tsx#L615-L670)

连接、凭据、模型字段归供应商所有，切换时清旧值再写目标值；包含 `CLAUDE_CODE_SUBAGENT_MODEL` 和 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`。后者属于保留/清理的配置范围；本次未发现专门的 FORCE UI 或代理端强制改写机制，因此不能声称 CC Switch 自己实现了 Claude 原生优先级的完整覆盖。[字段所有权](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/live/floor.rs#L1-L81)

### 2.2 Route：客户端别名和上游模型双向适配

接管后，Claude Code 看到的是本地代理地址、占位凭据以及稳定的 `claude-*` 模型别名；真实模型由代理根据当前供应商配置映射。客户端投影的回落顺序是：

- Haiku：本档 → `ANTHROPIC_SMALL_FAST_MODEL` → `ANTHROPIC_MODEL`。
- Sonnet、Opus：本档 → `ANTHROPIC_MODEL` → `ANTHROPIC_SMALL_FAST_MODEL`。
- Subagent：单独写 `CLAUDE_CODE_SUBAGENT_MODEL`；识别部分 Claude 小版本时换成客户端目录认识的 ID。

这里的优先级是 **CC Switch 生成客户端配置的顺序**，并不等于对 Claude Code 内部“子角色 frontmatter / 调用参数 / 环境变量”的完整优先级证明。[客户端投影](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/live/project/claude.rs#L240-L423)

代理 `map_model` 的顺序是：识别 family（Fable、Haiku、Opus、Sonnet；Fable 未配置时降到 Opus）→ 保留匹配的显式 subagent model / 目录形态反向映射 → `ANTHROPIC_MODEL` 默认模型 → 原样。也就是说，显式子模型保留发生在 family 匹配之后、默认模型回落之前；它不是按“这是某个子角色”的元数据路由。`[1M]` 属于本地上下文能力标记，转发时剥离。[模型映射](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/model_mapper.rs#L19-L179)

### 2.3 Stack：模型 ID 绑定供应商，但默认 child 跟随主模型

Claude 的编码格式是 `ccs-claude-<provider-key>--<upstream-model>`；Codex 是 `ccs-<provider-key>/<upstream-model>`。key 一旦分配永久属于该供应商，删除后也不重用，以免旧会话的模型 ID 悄悄指向别家。[ID/key 设计](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/mode/stack.rs#L1-L124)

Claude Stack 把四档别名全部指向默认供应商的第一个 Stack 模型，并且**刻意不写 `CLAUDE_CODE_SUBAGENT_MODEL`**，让子 agent 跟随 `/model` 当前选择。`modelPicker.replaceBuiltInOptions` 发布多供应商目录，避免内置档位重复/去重吞掉真实模型行。[Stack 模型投影](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/live/project/claude.rs#L426-L461)、[模型选择器](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/mode/controller.rs#L217-L255)

因此，不能据此推导“Claude Stack 已提供每个原生子角色独立选择 provider 的 UI”。编码模型请求本身能准确路由，但默认配置采用继承；原生子角色选择能否传入任意完整编码 ID，需要对应 Claude 版本的真实验证。

## 3. Codex：直接写原生 `[agents]`，并把子模型加入目录

### 3.1 Direct / Route 的默认子模型

CC Switch 表单明确提供子代理模型和推理强度，读写：

```toml
[agents]
default_subagent_model = "model-id"
default_subagent_reasoning_effort = "low"
```

留空删除键，继承主模型。TOML helper 仅操作指定键，保留 `max_threads` 和 `[agents.reviewer]` 等其他内容；对于无法安全按行修改的 inline table，保留原文。后端把这两个键作为供应商拥有的字段随切换更新。[表单与目录外模型提示](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src/components/providers/forms/CodexFormFields.tsx#L2119-L2175)、[TOML helper](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src/utils/providerConfigUtils.ts#L1492-L1596)、[后端字段范围](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/live/floor.rs#L119-L146)

这里有一个容易忽略的陷阱：Route 经 Responses → Chat / Anthropic 转换时，若请求模型在该 provider 的 model catalog 中则保留；否则改写为该 provider 默认模型。所以“写了子模型”不自动等于“实际请求了子模型”，还必须发布到目录。UI 对此有明确提示。[Codex 模型保留/回落](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/providers/codex.rs#L462-L532)

### 3.2 Stack 的默认子模型可选择其他供应商

Stack 不使用某一张供应商卡上的子模型设置，而采用设备级 `codex_stack_subagent_model` 和 `codex_stack_subagent_reasoning_effort`。这样父模型切到别家后，child 不会被卡片原先的裸模型名悄悄送回默认供应商。模型选项来自合并目录，包含带 provider key 的 slug。[Stack 配置计划](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/services/provider/codex_direct.rs#L683-L709)、[设置语义](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/settings.rs#L470-L484)

写入之前校验：模型 slug 在合并目录中，`multi_agent_version` 不为 `disabled`；强度在该模型支持的列表中才写。模型失效则两个键都不写、继承主模型；只有强度失效则只写模型，使用模型默认强度。[校验实现](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/services/provider/codex_direct.rs#L809-L850)

合并目录保留官方条目并将额外供应商模型改成 `ccs-<key>/<model>` slug；每行保留自己的上下文和能力配置，再通过 Codex 的 `model_catalog_json` 接入。它不是把所有模型统一伪装为一个默认模型。[目录生成](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/codex_config.rs#L2544-L2648)、[目录写入](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/live/project/codex.rs#L680-L703)

### 3.3 没有发现完整的原生角色管理器

本次追踪中，CC Switch 主动管理的是 `[agents]` 的两个默认字段；`[agents.<name>]`、`config_file` 等用户角色配置保留，未发现按角色创建配置文件、逐角色 provider/account 的管理 UI。后端写入只清理自身拥有的 nested keys，表内其他设置不动。[局部配置更新](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/live/project/codex.rs#L639-L697)

因此它可以通过“child 默认模型 = 带 provider key 的模型”跨供应商，但并不是一个与 Cognia subagent 模板等价的角色编排器。

## 4. 网关的真实绑定、兼容边界和失败行为

### 4.1 绑定到 Provider 行，凭据随 Provider 获取

Stack 从编码模型拿到完整 Provider 对象，转发器调用 `adapter.extract_auth(provider)`；托管账号从 `provider.meta` 解析具体 Copilot / Codex OAuth 账号并获取其 token。这实现的是“模型 ID → Provider 行 → endpoint / credentials / account”的间接绑定。并没有独立于 Provider 行的每个 child credential 参数。[凭据获取](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/forwarder.rs#L2100-L2200)

这也是请求级选路，不是 Cognia 那样的任务 lease、子任务取消、预算或生命周期隔离机制。当前请求拿哪个 Provider，凭据就跟随哪个 Provider；不能将其描述成每个子角色已有独立任务授权或配额管理。

### 4.2 显式供应商绑定的错误不会静默降级

Stack 关闭、provider key 未知/格式错误、成员移除、供应商删除时，返回明确错误，绝不回落默认供应商。**但它并不拒绝所有未发布的 model name**：供应商身份仍有效时，Claude 上游模型若从卡片列表移除，仍把请求中的模型名原样发给同一家，由上游判断；Codex 也使用解码后的模型段。[resolver 和失败枚举](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/mode/stack.rs#L625-L727)

Stack 请求跳过 family/default model remapping，避免已经选定的模型被同一家默认模型覆盖；同时不进入 Route 的熔断、failover 状态更新路径。[保留解析模型](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/forwarder.rs#L1459-L1476)、[转换时保留模型](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/forwarder.rs#L1841-L1871)

### 4.3 Codex 跨供应商 child 的加密任务问题

CC Switch 的源码说明，新版 Codex 子 agent 工具可能通过主模型后端签发加密的 `agent_message`，另一个供应商无法解密。它在 Stack 目录中默认把 `multi_agent_version` 写成 `v1`，使用经典工具；代价是失去新版 `followup_task` 等功能，并提示 `[features] multi_agent_v2 = true` 会覆盖目录设置。这个后端行为解释来自 CC Switch 源码注释，本次未独立验证具体 Codex 版本的运行时表现。[兼容策略](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/codex_config.rs#L2629-L2648)、[默认开关与代价](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/settings.rs#L470-L476)

若已经遇到无法解密的 child 任务，rectifier 不会为了重试而剥掉必需任务，返回 `unreadable_encrypted_agent_task`，引导使用经典工具或同供应商模型。[错误处理](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/proxy/opaque_state_rectifier.rs#L12-L39)

## 5. 对照当前 Cognia

以下 Cognia 事实由本次主审源码检查确认；路径相对于仓库根目录。比较对象是当前 `dev` 工作区源码（HEAD `07eb0d44b5567f815bbdf70bcb7693f518a9a38d`，存在大量预先已有的共享未提交改动），不能把结果当作该 commit 或已部署版本的能力声明。

| 能力                | CC Switch 当前做法                                         | Cognia 当前情况 / 可复用部分                                                                                                                                     |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude 角色模型     | 明确维护 family 和 subagent env；Route 按档位映射          | `lib/ai/agent/external/config/gateway-task.ts` 外部任务把 family env 指向同一个模型；原生 SDK `agents[name].model` 已透传                                        |
| Codex 默认子模型    | 维护 `[agents].default_subagent_model`、effort；需加入目录 | `packages/agent-codex/src/manifest.ts` 原生 subagent model-selection 仍为 `unknown`；当前外部任务配置没有等价贯通                                                |
| 请求级跨供应商模型  | Stack slug 含 provider key，resolver 精确取 Provider       | `crates/cognia-gateway/src/route_planner.rs`、`route_ticket.rs` 已有多模型绑定/family alias 原语；外部任务 `task_lease.rs::task_mint_request` 才将其收敛为单模型 |
| 子模型目录一致性    | Stack 写入前检查 slug/effort/能力                          | Cognia 需要把原生子模型可选项、任务 bindings 和客户端 catalog/config 建立同一数据来源                                                                            |
| 子角色配置文件      | 保留 `[agents.<name>]`，主动管理默认字段                   | Cognia 的 Codex importer 仍需补 TOML 原生角色配置解析；不能以 CC Switch 已支持默认字段等同完整角色导入                                                           |
| CC Switch 配置互通  | 上游表单保存模型角色与连接信息                             | Cognia `lib/ccswitch/switch.ts` 切换 Claude 仅输出 key/base URL，Codex 仅写 auth.json key；导入 tier model 为目录不等于执行角色映射                              |
| 显式绑定与 failover | Stack pin 与 Route failover 分离                           | Cognia 应让任务 bindings 明确表达是否允许角色回落，并记录 requested/resolved model；不能照搬设备级全局切换进入并发任务                                           |

Cognia 的普通 SDK route ticket 可让 Rust 默认 family mappings 生效；限制单模型的是外部任务 lease/config。也不应将模型名称包含 `haiku/sonnet/opus` 的现有启发式识别，视为用户配置的跨供应商角色策略。

当前也不能通过原始自定义配置绕过这个缺口：`lib/ai/agent/external/config/gateway-task.ts::customizationEnvironment`（约 500–556 行）不接受 `CLAUDE_CODE_SUBAGENT_MODEL`，会报 `Unsupported Cognia model environment customization`；`CODEX_CUSTOM_CONFIG_KEYS`（约 265 行）未开放 `agents` 表。因此网关模式需要正式扩展配置、授权及客户端投影链路。

## 6. 建议的实现顺序

1. **先补齐配置语义。** 统一外部 agent 的主模型、family 模型、默认 child 模型、Codex reasoning effort；同一入口展示实际 provider/account，继承和显式覆盖区分清楚。扩展现有配置类型，不引入第二套模型目录。
2. **将语义传到现有网关。** 在 external task lease 上携带显式 `modelBindings` 和允许的候选 provider/account；用已有 ticket/route planner 执行。保留单模型配置兼容，但不再无条件覆盖全部角色。
3. **正确生成客户端配置。** Claude 写对应 role/subagent env；Codex 写原生 `[agents]` 字段并生成可识别的模型目录。不要把 provider 的 model catalog 当作路由授权，也不要因请求传了一个 model string 就开放任意账号。
4. **先同供应商多模型，再跨供应商。** 验证 Claude family 与显式 child model 的优先级、Codex catalog/effort、继承与删除；跨供应商 Codex 再处理加密任务兼容。经典工具策略是有能力代价的产品选择，必须可见，不宜静默强制。
5. **保持任务隔离。** CC Switch 面向设备全局客户端配置，Cognia 面向并发外部任务；借鉴其模型身份设计，但继续使用 Cognia 的任务私有配置、临时票据和账号授权边界。

这些是基于源码对照的建议，尚未实施。

## 7. 验证与证据边界

- 上游通过 GitHub API 读取 main commit，再 shallow clone；本地 `git rev-parse HEAD` 与 API SHA 一致。
- 已阅读相关生产实现及现有测试，重点包括 `model_mapper.rs` 的子模型保留/反向映射，`stack.rs` 的供应商精确解析/错误路径，`codex_direct.rs` 的目录校验，`codex_config.rs` 的经典工具目录标记，`providerConfigUtils.codex.test.ts` 的角色表保留。
- **未运行 CC Switch 测试、build 或真实 CLI 推理。** 临时 clone 没有 `node_modules`；Rust 依赖整个 Tauri crate，本次研究不安装/编译重型运行环境。测试存在是实现意图和覆盖点证据，不是本次运行成功的声明。
- Cognia 本次主审实际运行：`pnpm test --runInBand --runTestsByPath lib/ccswitch/switch.test.ts lib/claude/agents/subagents/subagents.test.ts lib/ai/agent/external/config/gateway-task.test.ts`，**3 suites、169 tests 通过**。这是当前 Cognia 边界的回归检查，不证明 CC Switch 或跨供应商推理已验收。
- 未验证真实 Claude Code / Codex 版本的模型优先级、父子并发、OAuth 多账号费用归属、限流、断线及加密任务故障。特别是 CC Switch 的版本兼容理由，须在 Cognia 采用前通过固定版本端到端测试复核。

测试证据：[Stack 解析与失败路径](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/mode/stack.rs#L1275-L1380)、[Codex 子模型校验](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/src-tauri/src/services/provider/codex_direct.rs#L1336-L1372)、[TOML 默认模型与角色表保留](https://github.com/farion1231/cc-switch/blob/f92ff0b03964188f1cd011d9302ab8869d7a8219/tests/utils/providerConfigUtils.codex.test.ts#L579-L663)。
