---
title: 统一订阅
description: 横跨 Anthropic、Codex、OpenCode 与 CommandCode 的同一套账号模型 —— keyring 支撑的 provider vault、宁取真实用量窗口也不取额度计的有序 limits 源注册表、九个余额适配器，以及加密导出信封。
---

# 统一订阅

<Status variant="stable">Stable · ADR-0025 · vault schema v4</Status>

<TLDR>
  内置及动态注册的订阅提供方（包括 Anthropic、Codex、OpenCode、CommandCode）共用同一套账号模型、同一种 vault 格式、同一个额度接口面。
  真正有意思的是 **limits 源注册表**（`lib/subscription/limits/registry.ts`）：
  这是一个扁平的**有序**列表，带窗口的源排在通用余额源**之前**，
  因此 runner 会优先采用真实的用量窗口，只有在没有窗口适用时才回退到额度计。
  聚合层（`limits/aggregate.ts`）查询所有已配置账号，并把当前激活账号置顶返回 ——
  TUI 的 `/limits` 面板与桌面端多提供方视图消费的都是它。
  所有接缝都是注入式的，因此同一份代码能在测试中离线运行，
  也能在 CLI 中配合基于 Node `fetch` 的 `authedGet` 运行。
</TLDR>

<StatGrid>
  <Stat label="源文件" value="129" hint="lib/subscription —— 含测试" />
  <Stat label="提供方" value="4" hint="anthropic · codex · opencode · commandcode" />
  <Stat label="余额适配器" value="9" hint="deepinfra · deepseek · moonshot · novita · openrouter · ppio · siliconflow · 302 · _shared" />
  <Stat label="内置 limits 源" value="4" hint="anthropic · codex · volcengine · balance" />
  <Stat label="Tauri 命令" value="17" hint="src-tauri/src/subscription/commands.rs" />
  <Stat label="Vault KDF" value="600k" hint="PBKDF2-SHA256 + AES-GCM-256" />
</StatGrid>

设计动机见 [ADR-0025](../adr/0025-unified-subscription-module)。
Codex 相关扩展见 [ADR-0048](../adr/0048-codex-support-expansion)。

## 顺序本身就是设计

「额度」可能指两种完全不同的东西：滚动的用量窗口（Anthropic、Codex），
或者信用余额（多数 OpenAI 兼容的转售方）。在真实窗口存在时却展示额度计，属于信息降级 ——
所以注册表把这个偏好编码进了**列表顺序**：带窗口的源在前，通用余额源在最后。
runner 遍历返回的候选列表，在第一个能产出快照的源处停止。

插件贡献的源会叠加在内置源之前，经
`lib/plugin/registries/limits-source-registry.ts` 解析。
注册表本身是纯的：一个列表加一个解析器，返回**所有**匹配的源而不是挑一个 ——
这样回退决策就留在 runner 里，可被测试。

## 通过面板或插件添加服务

所有添加入口共用 `core/provider-registry.ts` 和同一个账号表单。对于兼容 OpenAI Chat
Completions 或 Anthropic Messages 的服务，在账号中心选择添加自定义服务，填写名称、API
端点、协议、模型 ID 和 API Key 即可。名称、端点和模型保存在现有自定义提供商配置中，密钥
仅进入当前本地账号的加密订阅 vault。

插件可声明 `subscription-provider` capability 和 `subscriptionProviders[]`，TypeScript SDK
提供 `defineSubscriptionProvider`。宿主自动生成 `pluginId:providerId` 标识，注册模型目录，
并复用添加账号、端点预设、默认账号、凭据解析和加密备份流程。停用插件会移除其配置入口和
模型注册，已保存账号仍可查看和删除。加密备份同时保存面板创建的服务定义，不会自动启用插件。

声明式接入支持 API Key 以及上述两种标准协议。OAuth、自动刷新、CLI 凭据发现、厂商特殊协议
和实时额度查询仍需专门的宿主适配器或独立额度扩展，不会根据服务名称猜测认证流程或额度 API。

## CommandCode API 订阅

CommandCode 的 GOAT、Pro、Max、Team 和 Provider 套餐使用
[Settings → API Keys](https://commandcode.ai/settings/keys) 中的 API Key 接入。
Go 套餐仅支持 CLI，无法使用此集成。账户中心、订阅设置、首次引导和聊天/角色账户选择器
共用添加密钥对话框及端点预设绑定。密钥保存在加密订阅 vault 中；选择、编辑、激活、删除、
加密导入导出及同步沿用统一账户生命周期。

官方端点为 `https://api.commandcode.ai/provider/v1`。Claude 模型调用 Anthropic Messages
（`/messages`），其他模型调用 OpenAI Chat Completions（`/chat/completions`）；
聊天、上下文压缩、功能模型调用和本地 Gateway 均按模型选择协议。
绑定预设优先于账户端点，可传递 `x-cmd-zdr: 1` 等自定义请求头，内部 `x-cognia-*` 请求头会被排除。

模型发现使用公开的 `/models` 接口。连接测试会发起一次最小的认证生成请求，可能消耗少量套餐额度；
仅获取公开模型列表无法验证密钥有效性。官方未公开额度查询 API，界面引导用户前往
CommandCode Studio 查看用量，不显示虚构余额。目前不提供 OAuth 或 CLI 凭据发现。

以上行为于 2026-09-11 对照[官方 Provider API 文档](https://commandcode.ai/docs/provider)核验。

## 代码位置

```
lib/subscription/
  core/
    transport.ts           # authedGet + 账号访问 —— 注入接缝
    encrypted-package.ts   # 加密导出 / 导入信封
    vault-snapshot.ts  migration.ts  account-expiry.ts
    subscription-events.ts # 变更事件总线
    now-ticker.ts  uuidv7.ts  hooks.ts
  anthropic/   oauth · discovery · refresh · scheduler · parser
               usage-analytics · overview-windows · sidecar-sync
  codex/       oauth · discovery · refresh · scheduler · usage-probe · chat-bridge
  opencode/    discovery · chat-bridge
  commandcode/ chat-bridge
  limits/
    registry.ts  runner.ts  aggregate.ts     # 解析 → 运行 → 聚合
    coalesce.ts  coalesce-record.ts  meters.ts  policy.ts
    sources/     anthropic · codex · volcengine · balance
    descriptor/  catalog · engine · path        # 声明式源描述符
    custom/      presets · runner · store       # 用户自定义源
  balance/
    registry.ts  runner.ts  store.ts  adapters/  # 9 个 OpenAI 兼容提供方
  sync/        subscription-sync · change-tracker · passphrase-cache

src-tauri/src/subscription/
  mod.rs         # 对 cognia-subscription crate 的门面（ADR-0067 Tier B）
  commands.rs    # 17 个命令的 IPC 面 —— 拥有 sidecar 重启接缝
  volcengine.rs

components/settings/subscription/
```

vault、provider 与发现逻辑位于 `cognia-subscription` crate；`mod.rs` 将其再导出，
使既有的 `crate::subscription::…` 调用点保持不变，
而命令面留在 app 侧，因为它拥有 sidecar 重启接缝与 `ApiKeyState`。

## 账号中心与凭据边界

### 订阅与中转行为（2026-09-11）

账号中心、首次引导、快速登录和 Anthropic 提供方复用入口使用同一组账号弹窗。Cognia 管理的
Anthropic、Codex、OpenCode 账号可以在添加时选择已有端点预设，也可以之后修改绑定；外部
OpenCode 发现记录仍然只读。Anthropic 订阅和 Console 登录使用 OAuth；第三方 API 和 Coding
Plan 密钥应在已有的提供方配置中添加，不能伪装成 OAuth 凭据。

账号绑定的预设优先，否则额度查询读取 vault 真正的默认预设，不能任取预设库的第一项。
额度快照使用 vault 的 `provider` 和 `accountId` 作为存储标识，通过 `sourceId` 保留真实额度或
余额适配器来源。单个账号失败不会丢弃其他账号的结果，也不会阻止独立自定义来源的查询。
自定义来源使用跨页面挂载唯一的 ID，编辑时保留所有额度窗口和请求头。

Codex 和 OpenCode 聊天桥接会传递预设请求头，并排除内部 `x-cognia-*` 配置。Codex 始终以所选
ChatGPT 凭据的身份为准。OpenCode 聊天和压缩摘要请求标明 Cognia 客户端，并通过
`x-opencode-session` 传递相同的会话 ID，遵循
[OpenCode Go 客户端要求](https://opencode.ai/docs/go/#where-can-i-use-it)。Go 面向编程代理流量；
此集成不表示无限制通用 API 使用或已获得提供方认证。端点与请求头配置依据
[Codex 配置参考](https://developers.openai.com/codex/config-reference/)和
[OpenCode 提供方文档](https://opencode.ai/docs/providers/)。

当前 Companion 命令清单将订阅 vault 命令定义为 `client.local` / `internal`。Web 和移动端显示
桌面管理说明，不通过通用 RPC 获取 vault 密钥。远程脱敏提供方诊断属于 ADR-0104 的独立能力。
提供方文档核对日期为 2026-09-11；离线测试不代表真实额度接口已验证可用。

设置 → 订阅 → 账号是唯一的账号 CRUD 界面。Claude、Codex、OpenCode 的 provider 页面只保留
各自的用量、探测和路由设置，不再重复账号修改控件。「当前激活」表示把一个凭据投影到当前
provider 运行时；「新会话默认」只是解析新会话时的 fallback，不会激活账号，也不会改写正在
运行的工具。

列表与详情面板只消费无法序列化 access token、refresh token、ID token 或 API key 的
`AccountSummary` / `AccountDetail`。设置界面的修改都走限定范围的操作：重命名、偏好设置、
凭据替换、带身份校验的 Codex 重新认证，以及本地移除。含 secret 的完整账号解析只留在运行时
consumer 和用户明确触发的加密备份/导出流程中。

Vault schema v4 新增非 secret 的 Codex 身份信息与生命周期状态。Codex 刷新由 host 管理，
按账号 single-flight，原子持久化轮换后的 access/refresh/ID token，并与移除操作共用生命周期锁。
定向重新认证只有在 workspace 与 subject 都匹配时才允许覆盖原账号；缺少可验证 fingerprint 的
legacy 账号会 fail closed，必须另存为新账号。终止型刷新错误会持久化为 `reauth_required`；瞬时
网络错误保持可重试，不会让账号失效。

<Callout type="warn">
  「停用」只清除 Cognia 的 active 投影。「从 Cognia 移除」只删除本地 vault 条目并迁移 Cognia
  内部引用。两者都不会撤销上游 token、登出外部 CLI、编辑 CCSwitch，或改动外部凭据文件/
  keychain。OpenCode 等外部凭据只以只读形式展示，除非用户明确创建 Cognia 管理的副本。
</Callout>

v3 → v4 是纯 payload 迁移：只会从传入 vault payload 中已经存在的 ID token 推导可选 fingerprint，
不会执行 host discovery、keychain 查询、配置文件读取或网络请求。

## 导出用的是备份那套加密原语

`core/encrypted-package.ts` 复用了 `lib/data/` 中全库 Dexie 备份的同一套加密 ——
PBKDF2-SHA256 迭代 600,000 次加 AES-GCM-256 ——
但采用了一个更简单、保存动态 provider vault 的信封
（`SUBSCRIPTION_PACKAGE_VERSION = "subscription-v1"`）。
更小的载荷让备份文件在工具中保持可读，也让「里面装了哪些 vault」一目了然。

<Callout type="warn">
  写入必须经过 settings store，不能直接写 Dexie。绕过它会让内存中的 store 变陈旧 ——
  这是一个真实发生过的 bug，已在 ccswitch 路径上修复过一次。
</Callout>

## 相关文档

<Cards>
  <Card title="ADR-0025" href="../adr/0025-unified-subscription-module" description="统一订阅的决策记录" />
  <Card title="ADR-0048" href="../adr/0048-codex-support-expansion" description="Codex 支持扩展" />
  <Card title="Provider 体系" href="../chat/provider-system" description="已配置账号如何变成可用模型" />
  <Card title="备份与数据" href="../data/backup-and-data" description="导出信封复用的备份原语" />
</Cards>
