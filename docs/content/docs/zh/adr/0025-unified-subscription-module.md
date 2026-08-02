---
title: "0025 — 统一订阅模块（Claude + Codex + OpenCode）"
description: "一个Rust模块 + 一个TS模块 + 一个设置UI标签，涵盖人类学PKCE、OpenAI设备代码和OpenCode发现/Zen粘贴键流程。新增多账户保险库、第三方端点预设和加密导入/导出功能。在存储和多账户方面取代了 ADR 0010;Anthropic专用的使用跟踪流程自0010年起仍为规范。"
---

# 0025 — 统一订阅模块（Claude + Codex + OpenCode）

> 平衡和配额预测通过[ADR-0104——提供商诊断控制plane](/docs/en/adr/0104-provider-diagnostics-control-plane)扩展。

**状态：** 已接受 **日期：** 2026-05-18 **分支：** `feat/subscription-unification` **部分替代:** [ADR 0010 — Claude 订阅 OAuth + 使用Tracking](/docs/en/adr/0010-claude-subscription-oauth)（存储布局 + 单账户假设）

---

## 背景

到ADR-0010年，代码库拥有一个自包含的`anthropic_subscription`模块，Rust + `lib/anthropic-subscription/` in TS，用于Claude Pro/Max PKCE流。后续项目以`codex_subscription`+`lib/codex-subscription/`获得设备代码OAuth ChatGPT/Codex发现`~/.codex/auth.json`。

两个子系统相互映照对方的_intent_——在OS 密钥环中保持OAuth 凭证;让渲染器和sidecar消耗它——但在OAuth流形态、命令命名（`claude_sub_*`与`codex_sub_*`）、凭证模式字段名称以及JSON blob携带哪些字段上有所不同。

这带来了三个具体问题：

1. **OpenCode 无法干净利落地添加。** OpenCode 是一个多 提供商 客户端，其`~/.local/share/opencode/auth.json`包含 75+ 个子条目提供商以及 OpenCode-Zen 自己的订阅路径。如果将其作为第三个兄弟目录添加，命名规范会三倍。

2. **多账户被屏蔽了。**两个模块都在密钥环层硬编码了`account = "default"`。Anthropic的 mod.rs 对延期提出了异议。CC-Switch（社区对该细分市场的事实解决方案）设定了“每提供商 N个账户，带热切换”的表层。

3. **共享不变量存在两次。** 密钥环服务名称版本控制、凭证模式迁移、sidecar布线、取用拦截器对等性、测试门控——全部重复。碰到其中一个总会让另一个开始腐烂。

该ADR将三个子系统整合为一个Rust模块（`src-tauri/src/subscription/`）+一个TS模块（`lib/subscription/`）+一个设置UI标签页（`components/settings/subscription/`）。

## 决策

### 1. 一个特征背后有三提供商

```
src-tauri/src/subscription/
  trait.rs          // SubscriptionProvider — sync, pure-data
  vault.rs          // ProviderVault (per-provider keyring blob)
  active.rs         // ActiveAccountState — Tauri state, in-mem cache
  preset.rs         // ProviderPreset (Anthropic + Codex only)
  migration.rs      // v1 → v2 migration (idempotent)
  commands.rs       // 10 shared CRUD commands + active + preset
  anthropic/        // PKCE save-hook (PKCE flow lives in TS)
  codex/            // device-code OAuth + discovery (ported verbatim)
  opencode/         // discovery (whitelist) + paste-Zen-key
```

`SubscriptionProvider`是有意为纯数据的：

```rust
pub trait SubscriptionProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn validate(&self, c: &ProviderCredential) -> Result<(), String>;
    fn default_label(&self, c: &ProviderCredential) -> Option<String>;
    fn env_for_sidecar(
        &self,
        a: &Account,
        preset: Option<&ProviderPreset>,
    ) -> Vec<(String, String)>;
    fn requires_sidecar_restart_on_active_switch(&self) -> bool { false }
    fn supports_preset(&self) -> bool { true }
}
```

I/O存在于特征之外：密钥环在`vault.rs`，HTTP在每个提供商的`oauth.rs`中，文件系统发现在`discovery.rs`。该特性易于单元测试，且通过第四个提供商易于扩展。

### 2. 多账户的逐提供商 密钥环金库

```
service = "com.cognia.subscription/v2"
account = "anthropic" | "codex" | "opencode"
payload = JSON-encoded ProviderVault { schemaVersion: 2,
                                       accounts: [Account],
                                       activeAccountId,
                                       preset }
```

`Account` 携带 **UUIDv7** ID（单调 + 唯一无协调）、可选的用户标签，以及带有 v1 模式字段布局的标签联集 凭证：

```rust
#[serde(tag = "provider", rename_all = "kebab-case")]
pub enum ProviderCredential {
    Anthropic(AnthropicCredentialData),        // mirrors v1 SubscriptionCredential
    Codex(CodexCredentialData),                // mirrors v1 CodexCredential
    OpencodeDiscovered(OpencodeDiscoveredData),// pointer record from auth.json
    OpencodeZen(OpencodeZenData),              // paste-key flow
}
```

### 3. 迁移 v1 → v2

每次应用启动时，`subscription_init` 会寻找 v1 密钥环 条目（`com.cognia.claude-subscription/v1` + `default` 及 codex 等价物），将每个条目打包成一个`Account { id: uuidv7(), label: Some("Default"), ... }`，写入 v2 的 vault 并`active_account_id = Some(id)`，并且 **保留 v1 条目保持原有** 90天的回滚窗口。幂零通过访问令牌比较来强制执行：在已迁移的配置文件上重运行时，返回`AlreadyMigrated`且不重复。

一次性反应组件（`SubscriptionInitializer`）发射`subscription_init`，然后发出一个由`localStorage["subscription.migrationToastShown"]`键控的索纳吐司，使使用者只看到一次。

### 4. OpenCode积分 — **发现 + paste-Zen-key**

OpenCode 与 Anthropic / Codex 根本不同：它是一个**多 提供商 客户端**，其自身`auth.json`可能保留 75+ 上游提供商的凭证，以及 OpenCode-Zen 管理订阅的 OAuth-style 条目。

我们选择了**两条轨道的集成**：

- **发现（仅读）。** `opencode_oauth_discover`解析`~/.local/share/opencode/auth.json`，仅接口白名单子提供商——`anthropic`、`openai`、`opencode-zen`。其他一切都被过滤掉;Cognia目前还不知道怎么吞噬它们。Rust方负责执行白名单;TS方重新采用了防御纵深防御。

- **Paste-Zen-key（write）。** opencode.ai 的OAuth端点截至目前尚未公开文档。这一轮没有通过逆向工程发布脆弱集成，而是通过**paste-API-key对话**让Zen订阅持续存在：用户在`opencode.ai/auth`登录，复制密钥，然后粘贴到Cognia。我们以`ProviderCredential::OpencodeZen`方式存储，并可选地URL。

完整的Zen OAuth是有意的**延迟**，直到端点在上游被文档化;粘贴密钥路径是第一阶段桥。

### 5. 提供商预设（仅限拟人 + Codex）

`ProviderPreset { id, label, baseUrl, extraHeaders? }`按每个提供商覆盖上游基URL——AWS Humanropic的Bedrock，Codex的Azure OpenAI / OpenAI-compatible中继。OpenCode拒绝预设（它已经在`auth.json`中管理自己的多提供商端点;第二个重定向层只会让用户困惑）。

### 6. 加密的导出/导入

`lib/subscription/core/encrypted-package.ts`发布一个自定义包络（`cogniabak-subscription-v1`），使用与`lib/data/` Dexie宽备份相同的原语——AES-GCM 256 + PBKDF2-SHA256，迭代60万次。信封内含明文清单（提供商列表+账户计数+ISO时间戳）和一个加密正体，保存完整的每个提供商保险库。用户用`Export…`在机器间备份，用`Import…`恢复。错误的密码短语接口一个不同的`SubscriptionPassphraseError`，因此UI可以显示“错误密码短语”，而不是通用的解密错误。

### 7. 每节 提供商 有源指针 + sidecar 布线

`ActiveAccountState` 是一个Tauri管理的内存缓存。每个提供商它存储活跃账户ID + 已解析的环境变量（`SubscriptionProvider::env_for_sidecar`）。缓存由`subscription_set_active`填充;读者（sidecar生成器、外部代理环境构建器）通过`subscription_get_active`消耗它。

**仅限人类的副作用**：`subscription_set_active("anthropic", id)`从已解决的环境中提取`CLAUDE_CODE_OAUTH_TOKEN`，推入现有`ApiKeyState::set_oauth_bearer`，并召唤`kill_sidecar`，使下一个`claude_send`与新携带者一起生成。`sidecar.rs:143-155`合同（从生成时读取`ApiKeyState`）与之前**字节完全相同**——只是上游的触发条件变了。

对于Codex/OpenCode没有 sidecar;外部代理环境构建器在Codex / OpenCode CLI子进程的生成时读取激活环境。

### 8. 人类使用追踪保持仅限人类使用

`sidecar/fetch-interceptor.mjs`中的取用拦截器、`lib/subscription/anthropic/parser.ts`中的解析器、Dexie `subscriptionUsage`表、主动探测循环、可视化调度器——这些都没有被抽象进特征中。OpenAI不Claude发出统一速率限制的头部，OpenCode是下游代理;泛化是一种虚构的对称。ADR 0010仍然是使用跟踪管道的规范参考;ADR 0025 仅取代了其**存储+多账户**部分。

## 三重能力矩阵提供商

| 能力 | 人为 | Codex | OpenCode |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| 登录流程 | PKCE（粘贴代码） | 设备代码 | 发现 + 粘贴键（Zen / Go） |
| 客户端ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e`（Claude Code） | `app_EMoamEEZ73f0CkXaXp7hrann`（抄本-CLI） | n/a（粘贴键） |
| 唯一事实来源启动 | v2 vault，然后 v1 迁移一次 | v2 vault，然后 v1 迁移一次 | 仅限V2 Vault（无V1） |
| 多账号 | 是的 | 是的 | 是的 |
| 激活账户触发sidecar重启 | 是的 | 没有（环境建造者下一个刷新点会接手） | 不 |
| 提供商预设 | 是的（基岩，自定义代理） | 是的（Azure，OpenAI-compatible） | 是的（网关relays/mirrors） |
| 使用跟踪 | 是的（被动+选择加入探针） | 没有（没有统一的头部） | 不 |

## 2026-06-07 修订 — OpenCode Go，聊天布线，预设对等性，云同步

验证了一次实时开放代码安装 + Zen 网关：

1. **真实auth.json密钥。** opencode CLI 以 `"opencode"`（Zen）和 `"opencode-go"`（Go 固定费率计划）格式存储其管理计划，并带有形状`{"type":"api","key":"sk-…"}`——原本假设的 `"opencode-zen"` 拼写从未出现（保留在白名单中以便向下兼容）。发现白名单现已`anthropic / openai / opencode / opencode-go / opencode-zen`，分类器识别`type:"api"`/裸`key`字段，Windows路径探测器在每个平台上使用`~/.local/share/opencode/auth.json`（XDG-style;`%LOCALAPPDATA%`错了）用一个LOCALAPPDATA 回退。
2. **去计划凭证。** `OpencodeZenData`获得了可选`plan: "zen" | "go"`（加法——vault `SCHEMA_VERSION` stay 3;缺席=zen）。`opencode_save_zen_key` 取一个可选的`plan`参数;`env_for_sidecar`总是会发出`OPENCODE_BASE_URL`（预设>账户覆盖计划默认>：Zen `https://opencode.ai/zen/v1`，Go `https://opencode.ai/zen/go/v1`）。
3. **聊天提供商。** 两个内置聊天提供商 `opencode`/`opencode-go`（OpenAI-compatible，通过`/models`+`/chat/completions`实时验证）。当设置→ 提供商没有API键时，`resolveSendOptions`会通过`lib/subscription/opencode/chat-bridge.ts`退回到订阅金库（先是活跃账户，然后是匹配套餐中最近使用过的账户;bound/default预设基础URL获胜）。
4. **预设对等性。** `supports_preset()`现在对OpenCode成立;预设模型relays/mirrors置于托管网关前，并输出 `OPENCODE_BASE_URL` / `OPENCODE_MODEL` / `OPENCODE_CUSTOM_HEADER_*`。我们至今从未回信给OpenCode自己的auth.json。
5. **云同步。** 之前延迟的保险库云同步作为WebDAV流水线与数据备份并行发布：加密`cogniabak-subscription-v1`信封`cognia-subscription-<ts>.cogniabak.json`+`latest-subscription`指针，自有密码短语（会话+选择加入密钥环），自有切换（`webdavSync.subscriptionSyncEnabled`），传输层脏标记自动上传，预览还原。参见`lib/subscription/sync/`。
| 发现外部CLI认证 | n/a（无Claude Code CLI auth.json） | `~/.codex/auth.json` + codex-cli 密钥环 | `~/.local/share/opencode/auth.json` |

## 2026-06-11 修正案 — 计费成熟期（插件余额适配器、聊天命令、非驻地同步）

1. **可插拔平衡适配器。** 平衡适配器注册表不再是一个封闭阵列。新增的`balance-adapter`插件功能（`types/plugin/plugin-balance-adapter.ts`、`lib/plugin/registries/balance-adapter-registry.ts`、通过`OVERLAY_REGISTRY_CAPABILITIES`有线连接）允许插件通过`manifest.balanceAdapters[]`贡献`PluginBalanceAdapterDef`。`findBalanceAdapter`现在会在内置适配器之前**查看覆盖注册表，这样插件可以扩展或覆盖捆绑的设备。参考实现：`plugins/agent-team-examples/src/demo-balance-adapter.ts`。
2. **聊天端计费命令。** 聊天订阅数据新增内置斜杠命令 接口：`/usage`（Anthropic 5小时/7天配额窗口，重复使用`summarizeCurrentWindow`）、`/balance`（通过`latestBalanceSnapshot`获取最新的账户快照）、`/models`（通过`syncModelsDevCatalog`目录同步）和`/login`（在订阅→打开设置）。请看`lib/slash-commands/actions/billing.ts`。
3. **非驻留同步接口。** 始终挂载的 models.dev 和订阅WebDAV同步卡会合并成共享的紧凑`SyncStatusStrip`（`components/settings/_shared/`）：一个小同步按钮和一条空闲时消失的瞬态状态线;订阅控制权转移到一个默认收缩的面板后面。

## 渲染器端的 IPC 接口

> **2026-07-25修订。** 以下列表中有两点内容被删减。
>
> 1. **计数是28，不是20。** v3预设*库*命令（`subscription_list_presets`、`subscription_save_preset`、`subscription_delete_preset`、`subscription_set_default_preset`）、通用`subscription_authed_get`、`subscription_volcengine_usage`和ADR-0028环境解析器（`claude_env_for_account`、`claude_proxy_env_for_session`）都在本节写完后发布。2. **实现已移动。** 根据ADR-0067，vault/active-pointer/preset / 每个提供商发现 + OAuth 逻辑现存于`crates/cognia-subscription/`中;`src-tauri/src/subscription/`是薄薄的再出口外墙，加上Volcengine SigV4使用用命令。本ADR中其他引用的路径应与crate对照阅读。

`src-tauri/src/lib.rs`共登记命令 20人：

共享（10人）：`subscription_init`，`subscription_list_accounts`，`subscription_get_account`，`subscription_save_account`，`subscription_delete_account`，`subscription_rename_account`，`subscription_set_active`，`subscription_get_active`，`subscription_get_preset`，`subscription_set_preset`。

人类特有（1）：`anthropic_oauth_save_pkce_result`（PKCE流在TS中运行;此hook仅持续于结果中）。

Codex具体（5）：`codex_oauth_discover`、`codex_oauth_request_device_code`、`codex_oauth_poll_device_code`、`codex_oauth_refresh`、`codex_oauth_revoke`。

OpenCode-specific（2）：`opencode_oauth_discover`，`opencode_save_zen_key`。

加密导出/导入仅在rendererr端支持（`lib/subscription/core/encrypted-package.ts`）——用户点击导出时，密钥已经处于渲染器状态，因此仅仅通过Rust路由写入JSON会增加复杂性，却没有安全收益。

## 后果

**获胜**

- 三个提供商共享一个IPC 接口、一个设置标签页和一个 凭证 schema（模各变体载荷字段）。
- 多账户+标签+一键切换，作为一个功能，没有每个提供商重复。
- 加密export/import意味着新机器只需两次点击即可启动（导入→输入密码短语）。
- 该特征足够小，可以在几百行内添加第四个提供商。

**权衡取舍**

- OpenCode-Zen集成如今是粘贴键;完整 OAuth 在上游文档端点等待。
- 自动发现`~/.codex/auth.json`不再是运行时 回退——用户通过“重用”流程明确采纳发现凭证。计划的未结问题#3确认了这种权衡（账户标签显示发现，UX成本较低）。
- 伴随API RPC桥从`claude_sub_*`/`codex_sub_*`名称切换到统一`subscription_*` 接口;旧名称的移动客户端会收到`unknown_command` 404，需要协调更新。

**超出范围（稍后降落）**

- Vault 的云同步（Dropbox / OneDrive / WebDAV à la CC-Switch）。
- 本地代理自动故障切换（设置→ 提供商目前通过互操作处理CCSwitch）。
- Zen opencode.ai OAuth全程（等待上游）。
