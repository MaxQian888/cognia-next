---
title: 统一订阅
description: 横跨 Anthropic、Codex 与 OpenCode 的同一套账号模型 —— keyring 支撑的 provider vault、宁取真实用量窗口也不取额度计的有序 limits 源注册表、九个余额适配器，以及加密导出信封。
---

# 统一订阅

<Status variant="stable">Stable · ADR-0025 · vault schema v4</Status>

<TLDR>
  三个订阅提供方 —— Anthropic、Codex、OpenCode —— 共用同一套账号模型、同一种 vault 格式、同一个额度接口面。
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
  <Stat label="提供方" value="3" hint="anthropic · codex · opencode" />
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
但采用了一个更简单、只装三个 provider vault 的信封
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
