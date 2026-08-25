---
title: "0149 — 人不是设备，本机档案不是账户"
description: "Cognia 有三套互不认识的身份系统，却没有「人」这个实体。本 ADR 引入 User、Org 成员关系与外部身份表，把设备从授权主体降级为凭据，并定义一个服务端可读的协作面——同时本地面保持单档案、可离线。"
---

# ADR 0149 — 人不是设备，本机档案不是账户

**状态：** 已接受
**日期：** 2026-08-25
**相关：** [ADR-0054](./0054-local-multi-account-isolation)、[ADR-0091](./0091-lark-unified-identity-dual-entry)、[ADR-0059](./0059-cloud-deployment-headless-brain)、[ADR-0132](./0132-issue-tracker)、[ADR-0133](./0133-terminal-session-sharing)、[ADR-0135](./0135-diagnostic-service-completion)、[ADR-0143](./0143-device-console)、[ADR-0144](./0144-workspace-as-the-unit-of-work)

## 背景

Cognia 有三套身份系统，而它们谁也不知道另外两套的存在。

| 系统 | 权威存储 | 主体 |
| --- | --- | --- |
| 本机账户（[ADR-0054](./0054-local-multi-account-isolation)） | Dexie `cognia-account-registry` | `acct_…`——一个人、一个密码、一个独立物理数据库 |
| 设备身份（Companion） | Rust SQLite `SecurityStore` | `device_id`——一对 P-256 密钥 |
| 租户 + Logto OIDC | Rust `host_bindings`、云端 Postgres | `tnt_<uuid>` |

三者被一行表结构硬钉在一起：
`host_bindings(local_account_namespace UNIQUE, tenant_id UNIQUE)`——严格 1:1。
而 `host_identity.rs` 自己记录了残余风险：Rust 无法证明渲染端报上来的 account id
是真的，只能把命名空间钉死到第一次见到的 verifier，此后拒绝任何其他值。

### 代码里没有「人」这个实体

这不是遗漏，而是八份已接受 ADR 的共同前提（0011、0019、0042、0054、0059、0088、
0097、0132）。后果是具体且承重的：

- `types/issues/index.ts` 直说：*"`id` is optional because the local app is
  single-user."* 分配给 `human` 的 issue **没有 id**，于是
  `[assigneeKind+assigneeId]` 索引对人类毫无意义，「分配给我」退化成「分配给那个人类」。
- `NotificationRecord` 没有收件人。`StoredMessage` 没有作者——`MessageSenderKind`
  只有 `user | assistant | system`，那是角色不是人。
- 授权挂在硬件上。[ADR-0133](./0133-terminal-session-sharing) 写得很直白：
  *"The grant is device-wide, not per session. Removing the grant is the 'kick'."*
  在团队里，某人离职意味着挨台设备去撤销——而且没有任何记录说明哪台机器是谁的。
- 六个服务端组件用六套不同的认证。`services/share-server/` 最差：一个全局 bearer
  就能创建任意分享，读取完全公开，而且根本没有租户列。

### 三个已经存在的支点

缺口比看上去窄，因为有三块东西已经建好了：

1. **`cogniaUserId` 与 `logtoSubject` 在代码里是活的**，不只存在于
   [ADR-0091](./0091-lark-unified-identity-dual-entry)——`lib/connectors/principal/`、
   `src-tauri/src/companion_api/lark_entry.rs` 和 CLI 都带着它们，而且 principal
   已经可以重绑到一个非 account 的 id。今天 `lib/connectors/principal/bootstrap.ts`
   退化为 `cogniaUserId: accountId`，仅仅是因为没有 `User` 表可指。
2. **Logto Organizations 全链路已通。** `organization_id` 贯穿
   `lib/logto/client.ts` 的 PKCE 登录、令牌交换与刷新，由
   `src-tauri/src/companion_api/oidc.rs` 验签，`organization_roles` 已经并入用于
   发布访问策略的 group set。
3. **[ADR-0054](./0054-local-multi-account-isolation) 预留了这份后续**：
   *"If a later feature needs server-visible account grouping for owner tokens,
   that belongs in a follow-up ADR."* 因此不需要 supersede 任何 ADR。

产品形态已经越过了那个前提：目标是一支真人小团队，加上一名跨多台设备的操作者，
再加上从 IM 进来的外部人。这需要 Cognia 从未建过的那两层。

## 决定

### 1. 词表就此冻结

「account」目前至少指四样不同的东西。到此为止。

| 术语 | id 前缀 | 今天叫什么 |
| --- | --- | --- |
| `User` | `usr_` | 不存在（`cogniaUserId` 是它的一半） |
| `Org` | `org_` | `tnt_<uuid>`，等同于一个 Logto organization |
| `Workspace` | 沿用 `projectId` | 不变（[ADR-0144](./0144-workspace-as-the-unit-of-work)） |
| `LocalProfile` | 沿用 `acct_` | 现称「local account」——id 不动，只改名称与文档 |
| `ProviderAccount` | — | `lib/subscription` 里的 `accountId`（Anthropic/Codex 登录） |
| `Device` | `dev_` | `device_id` |
| `ExternalIdentity` | — | `feishuPrincipals` 行，以及 `logtoSubject` |

仓库里已有先例：`lib/subscription/core/transport.ts` 在同一个文件里就已经区分了
`localAccountId` 与 `accountId`。这个拆分在最难的地方做过一次，只是没有推广开。
本 ADR 负责推广它。

后续由门禁强制（见 Batch 0）。存量出现处**在触碰时**改名，不做一次性大扫除——
这棵工作树是与其他会话共享的。

### 2. 五层，而 Cognia 缺的是中间两层

1. **Credential（凭据）**——证明持有。密码 verifier、设备密钥对、OAuth 令牌。
   ✅ 已有，且本来就是多个。
2. **User / Principal（人）**——有稳定 id 的人。❌ **缺失，本 ADR 新建。**
3. **Org / Tenant（归属与审计边界）**——⚠️ 以 `tnt_…` 存在，但与 LocalProfile 1:1 钉死。
4. **Membership + Role（成员与角色）**——`user × org → role`。❌ **缺失**；今天角色挂在设备上。
5. **Session / Token（短期派生凭据）**——✅ 已有且质量很高：带重放缓存的 DPoP、
   5 分钟访问令牌、一次性 socket ticket、一次性 admin lease、按租户的 KMS 信封密钥、
   Postgres RLS。

问题从来不是密码学，而是缺了两个名词——于是设备被迫顶上来充当授权主体。

### 3. User 是主体，外部身份挂在它下面

`User` 是稳定主体。Logto 作为 IdP——**自托管**、单实例——但 `logtoSubject`
只是外部标识，**永远不做外键**。每一个外部身份，包括 IM principal，都变成
`ExternalIdentity` 表里指向某个 `User` 的一行，即 Auth0 与 Logto 都称为
`identities[]` 的那种形状。

决定性的性质在这里：**同一个人今天从飞书进来、明天从 Web 登录，是同一个 `User`。**
另一条路——让 principal 继续当主体——会产生两条永远无法合并的记录。

已经为飞书 principal 建好的 fail-closed 解析
（[ADR-0091](./0091-lark-unified-identity-dual-entry)）原样保留：未绑定的发送者
仍然被搁置，跨账户绝不会在当前账户下执行。改变的只是绑定的目标——从 LocalProfile
id 变成 `User` id。

### 4. 成员关系分两层，Linear 式，并允许 Guest

成员同时挂在 Org 与 Workspace **两层**：

- Workspace 成员**独立招募**——身在 Org 并不意味着能看见每一个 Workspace。
- Org admin **可以穿透**进入任意 Workspace，用于离职交接、审计与合规。不提供
  「连本 Org 的 admin 都看不见」这种隐私级别。
- **Workspace Guest**：一个 `User` 可以只持有 Workspace 成员资格而不属于任何 Org。
  这正是从 IM 进来的人和外部协作者的落点，也是拒绝 Notion 式「Org 角色自动下放」
  的原因——那种模型只会过度授权。

由于权限判定要走两层，必须有一个 effective-permission 解析器。它复用
`lib/workspace/capability-overlay.ts` 的结构——那里已经在做「多层叠加求有效值」——
再配一个投影缓存。这不是新模式。

### 5. 设备归属于人，分两步

设备不再是授权主体，而成为由某个 `User` 持有的凭据。授权按
`device → user → membership → capability` 解析，device 级 override 保留——
但只能用来**收窄**，绝不能放宽。

这件事**刻意分两步**落地：

1. `devices` 增加 `user_id`。纯记账，不改动任何判定路径。仅此一步就能回答
   「这台机器是谁的」——这个问题今天无法回答。
2. 再把 grant 判定改道经过 membership。

`capability_grants` 位于请求热路径上——`rpc.rs` 与 `ws_terminal.rs` 直接读它——
所以把两步压缩成一次发布是不可接受的。

### 6. 协作面：服务端权威、服务端可读

**范围（第一刀）**：Issues、Workspace 元数据、Plans 与 Runs。它们已经有稳定 id
与事件流（`issueEvents`、`agentPlanEvents`、`operation_events`），而且
`IssueActor` 已经有 `human | agent | team` 的骨架——只差一个 id。会话与消息属于
**第二刀**，不在本次范围内。

**一致性**：协作面以服务端为权威，客户端保留只读缓存。本地核心功能保持完全离线可用；
协作功能需要在线。这是**有意为之的两套一致性模型**，不做统一尝试。

**加密**：协作面**服务端可读**，由按租户的 KMS 信封密钥加 Postgres 行级安全保护——
这正是 `services/diagnostic-server/` 已经验证过的设计，包括通过 `shred_tenant_keys`
实现的密码学擦除。群组端到端加密（每次成员变动都要做 MLS 级别的密钥重分发）被拒绝：
它会摧毁服务端搜索、通知与聚合能力，而且并不自洽——
[ADR-0054](./0054-local-multi-account-isolation) 已经写明本地 Dexie 数据库本身就
没有静态加密。

[ADR-0037](./0037-public-share-links) 的零知识分享链接原样保留，作为**独立能力**。
「给陌生人发一个链接」和「与队友协作」是两个不同的问题，不予合并。

### 7. 服务安置，以及一个共享 auth crate

`crates/cognia-ops-controller` 与 `services/diagnostic-server` 各自独立实现了
grant 签发、RBAC 阶梯与租户作用域——**写了两遍**，而且是全仓质量最高的两处安全代码，
彼此却互不知情。37 个 crate 里没有一个是关于 auth 的。

- 新建 `crates/cognia-collab-server`——协作面。**不**并入
  `cognia-ops-controller`：后者的 scope 词表（`servers:read`、`servers:operate`、
  `servers:admin`）讲的是操作机器，塞进团队语义会永久污染它。
- 新建 `crates/cognia-tenant-auth`——grant 的签发与校验、RBAC 阶梯，以及
  `set_config('app.tenant_id', …)` 的 RLS 夹具，供三方共用。

**已认领的代价**：`services/diagnostic-server` 是独立 Cargo 工程，自带 lockfile，
`rust-version = "1.82"`，而 workspace 是 `1.89.0`。共享 crate 要么把它拉进 workspace，
要么接受跨工程 path 依赖。这笔账现在就认，不假装它不存在。

### 8. 认证做选择性收敛，而非一律统一

| 组件 | 处置 |
| --- | --- |
| `cognia-collab-server`（新） | 照抄 diagnostic-server 模型：OIDC → 短期 HMAC grant → RBAC 阶梯 → RLS。不发明新东西。 |
| `services/share-server/` | **必须**补上租户列与真实身份。一个全局 bearer 加完全公开的读取，意味着任何一次泄露都是全量泄露。 |
| `crates/cognia-ops-controller` | 补 Postgres RLS。所有表已经带 `tenant_id`，今天的隔离完全依赖应用代码不写错。 |
| `services/signaling-server/` | **刻意不动。** `room_id = SHA256(含双方公钥的描述符)` 意味着中继什么都看不见，两个用户也不可能落进同一个房间。在这里加身份反而**降低**隐私。这是设计性质，不是缺口。 |
| `src-tauri/src/companion_api/` | 除第 5 节外本 ADR 不改动。DPoP、socket ticket 与 capability grant 保留。 |
| `services/workspace-runtime/` | 不动。一个 pod 一个 bearer，靠 pod 隔离，够用。 |

### 9. LocalProfile 保留，首次登录时绑定

`acct_…` 与 `cognia-account-<id>` 数据库原地不动，继续承担本地加密/解锁边界的角色。
首次登录时，一个 LocalProfile 绑定到一个 `User`，`host_bindings` 从二元组放宽为
`(localProfile, user, org)`。

两条理由。[ADR-0054](./0054-local-multi-account-isolation) 已经立了先例——
*"The legacy source database is not deleted during migration. It remains a
rollback source."* 而且这是唯一能让「离线时我仍然是我」成立的迁移路径：
LocalProfile 可以独立解锁，`User` 只是叠在它之上的远端绑定。

`host_bindings` 上的 `UNIQUE` 约束必须放宽，`host_identity.rs` 里
「第一次见到谁就钉死谁」的信任模型也必须重写。

### 10. 那八份 single-user ADR 怎么处理

没有一份被整体 supersede。每一处 single-user 陈述逐条定性：

| ADR | 陈述 | 处置 |
| --- | --- | --- |
| 0011 工作流 | "Multi-user collaboration / CRDT — single-user desktop app" | **收窄**——对本地面成立；工作流协作不在第一刀内。 |
| 0019 /goal | "multi-model, single-user desktop product" | **仍然成立**——/goal 是本地的。 |
| 0042 通知中心 | 拒绝了 multicast 与租户作用域 | **收窄**——通知保持本地；协作通知属于第二刀的问题。 |
| 0054 本地隔离 | 非目标："Cloud identity, account sync, or remote login" | **仅该行被取代**，取代者正是它第 68 行预告的这份后续。选项 A（一个档案一个库）与对选项 B（每张表加 `userId`）的拒绝**都继续有效**。 |
| 0059 云端部署 | "local-first… the desktop is the server"；T3 多租户被推迟 | **收窄**——local-first 对本地面仍然成立；本 ADR 就是那个被推迟的层级到来了。 |
| 0088 Pro IDE | "on a single-user desktop, a process running as the user…" | **仍然成立**——该安全立场讲的是本机。 |
| 0097 跨设备设置 | 指出对「单个用户」而言冲突罕见 | **收窄**——设置仍然按 LocalProfile 存放。 |
| 0132 Issue 追踪器 | `IssueActor.id` 因「本地是单用户」而可选 | **该点被取代**。Issues 进入协作面后，`id` 变为必填。 |

## 非目标

明确排除，且不得从上文任何段落反推：

- 面向公众的自助注册。目标是一支已知的团队，不是开放产品。
- 计费、授权或订阅服务器。今天一个都不存在（`LICENSE_NAME = null`），本 ADR
  也不创建。`lib/subscription/` 仍然是本地凭据保险箱，不是 billing。
- 协作面的群组端到端加密（见第 6 节）。
- 给约 700 张本地 Dexie 表加 `userId`。
  [ADR-0054](./0054-local-multi-account-isolation) 拒绝过，该拒绝继续有效。
- 共享会话与消息。那是第二刀，需要它自己的 ADR：`StoredMessage` 没有作者字段，
  且附件字节不跨宿主传输。
- 改动 `services/signaling-server/`。

## 后果

- 对于从不登录的用户，本地面与今天完全一致。`AccountGate`、密码 verifier
  与按档案分库都不受影响。
- 「分配给我」成为真的。`[assigneeKind+assigneeId]` 从装饰性索引变成可用索引。
- 离职交接变成对「人」的操作，而不是满世界找硬件。
- 产品中从此并存两套一致性模型，用户会感知到：离线时协作数据不可用或陈旧。
  这一点被接受、在界面上明说，并且**不得**用乐观本地写入去掩盖。
- `host_identity.rs` 失去「第一个 verifier 胜出」这条捷径，需要一个真正的信任模型。
  这是整条路线图上风险最高的一处改动。
- 三个服务将共用 `cognia-tenant-auth`，因此它里面的一个 bug 就是三处 bug。
  在迁移任何调用方之前，它必须先有自己的测试套件。

## 路线图

批次按风险排序，而非按可见价值。Batch 0 不交付任何功能。

| 批次 | 内容 | 关键文件 |
| --- | --- | --- |
| **0** | 冻结词表；加 lint 门禁。零功能变更。 | `scripts/gates/check-identity-vocabulary.mjs`（仿 `check-workspace-attribution.mjs`）——拒绝新代码中裸用 `accountId` |
| **1** | `User` / `Org` / `Membership` 模型；Logto 登录；LocalProfile↔User 首登绑定 | `lib/logto/*`（org 支持已具备）、`stores/account/account-store.ts`、`src-tauri/src/companion_api/host_identity.rs` |
| **2** | 抽出 `crates/cognia-tenant-auth` | 由 `services/diagnostic-server/src/auth.rs` 与 `crates/cognia-ops-controller/src/auth.rs` 合并；先解决 lockfile 与 `rust-version` 分歧 |
| **3** | `crates/cognia-collab-server` 骨架；Issues 上协作面；`IssueActor.id` 变必填 | 新 crate、`types/issues/index.ts`、`lib/db/issues.ts` |
| **4** | `devices.user_id` 记账，然后改道 grant 判定 | `security_store.rs`、`device_grants.rs`、`lib/devices/grant-capabilities.ts`——两次发布，绝不合并 |
| **5** | `ExternalIdentity` 收编 IM principal；Guest 落地 | `lib/connectors/principal/*`——`bootstrap.ts` 不再退化到 `accountId` |
| **6** | `share-server` 补租户与身份；`ops-controller` 补 RLS | `services/share-server/{src,worker}`、`crates/cognia-ops-controller/migrations/` |
| **7** | Workspace、Plans 与 Runs 上协作面 | 承接 Batch 3 |
