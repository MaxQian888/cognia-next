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

**Batch 2 期间的更正——代价认错了地方。** 本 ADR 原本把障碍记为 `rust-version`
分歧（`services/diagnostic-server` 是 `1.82`，workspace 是 `1.89.0`）。这是个幻影：
它的 `Dockerfile` 用 `rust:1.95-bookworm` 构建，仓库也把 `channel` 钉在 `1.95`，
所以那个 `rust-version` 只是一条没有任何东西真正据以编译的下限。

真正的障碍是**镜像构建上下文**。`.github/workflows/images.yml` 用
`context: services/diagnostic-server` 构建该服务，因此 `path = "../../crates/…"`
依赖在 `cargo test` 下能解析，进了 Docker 就失败——那里根本没有上一级目录。
为了一次重构去改部署流水线的构建上下文是更差的交易，所以 `cognia-tenant-auth`
是一个 diagnostic-server 并不消费的 workspace crate——见路线图 Batch 2 行。

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
| **2** | ✅ `crates/cognia-tenant-auth` | **不是**合并——见下方说明。交付身份内核（`usr_`/`org_` id、两条角色阶梯、`resolve_workspace_access`）、RLS 会话变量契约，以及挂在 `grants` feature 后的 HMAC grant 面。今天已被 `src-tauri` 消费：它现在会校验自己落库的 id。 |

**Batch 2 的发现——那两个文件毫无共享。** 本路线图曾写 `cognia-tenant-auth`
将"由 `services/diagnostic-server/src/auth.rs` 与
`crates/cognia-ops-controller/src/auth.rs` 合并"。这两个文件没有共享任何一个类型、
函数或常量。它们是针对两种威胁模型的两套不同认证设计：diagnostic-server 用
**静态 RSA PEM** 验 OIDC（只有 RS256、`tenant_id: Uuid`、四级角色枚举），
ops-controller 则跑**带 TTL 缓存的 JWKS discovery**、支持九种算法
（`tenant_id: String`、自由形式 scope 集合）。两者还分别依赖不兼容的
`jsonwebtoken` 大版本（9 与 11）。

所以 OIDC 验签面在两个服务里各自留在原地，共享 crate 拥有的是它上面那一层：
一个已验证的 token **意味着什么**。那也正是本 ADR 真正新增的一层——两个既有文件
里都没有 `User`。
| **3** | ✅ `crates/cognia-collab-server` + Issues 上协作面 | 服务端：RLS 隔离的 Postgres、两步鉴权链，以及 `POST /v1/orgs/{org}/grants`——唯一的入口。客户端：`types/issues/collab.ts`（actor 收窄）、`lib/collab/`（带 grant 缓存的客户端 + 拉取）、Dexie v195 `collabIssues`，以及看板的第五个联邦源。 |

**Batch 3 的补充说明。** 三件本 ADR 没有预见的事：

1. **`IssueActor.id` 是有条件必填，不是无条件。** §10 写的是"一旦 Issues 进入协作面"，
   这个条件是承重的：没人登录过的机器根本没有 `usr_`，而决定 4 要求它离线可用。
   所以本地类型保留 `id?`，收窄发生在**边界**——`resolveCollabActor` 选择拒绝，
   而不是凭空造一个 id。ADR-0132 失去的是它的理由（"本地应用是单用户"），不是它的形状。
2. **协作面需要一个签发 grant 的端点。** 只验不签的服务，没有任何东西能通过认证。
   该端点在**目标 org 自己的 RLS 作用域内**校验路径里声明的 org，从而不需要为了
   "这个 token 属于哪个 org" 去开一条绕过行级安全的特权通道。
3. **§7 的共享 crate 在这里才找到真正的理由。** Batch 2 证明既有两个服务没有共享代码；
   是第三个服务让共享 JWKS 验签变得正确，`cognia_tenant_auth::oidc` 现在拥有它。
| **4a** | ✅ `devices.user_id` 记账 | `security_store.rs`（列、迁移、入册继承已绑定的人、登录认领无主设备）、`lib/devices/`、控制台的"归属"行。**没有任何判定路径读它**，由两个测试钉住。 |
| **4b** | ✅ grant 判定改道 | `has_capability` join `host_bindings`，拒绝归属他人的设备；`lib/devices/grant-capabilities.ts` 镜像该谓词，让控制台能说清原因；新增 `suspended` 授权状态与提示条。作为**独立 release** 发出——见下。 |

**为什么把 4a 与 4b 分开编号。** §5 写的是"两个 release，绝不合一"，而路线图那一行
把这件事藏进了一句话里。风险是具体的：`capability_grants` 被 `rpc.rs`、`ws_terminal.rs`
与 `remote_execution.rs` 每请求读取，而升级前就存在的每一台设备的 `user_id` 都是 NULL。
一个既引入该列又开始据其判定的 release，会拿新规则去评估一支尚未完成归属的设备群——
那是锁死，不是迁移。4a 存在的意义，就是让这一列先有一个 release 去填。

`host_bindings.tenant_id` 在 4a 期间保留 `UNIQUE`。放宽它列在 §9，但目前没有任何东西
需要它；而正是这个约束让"这个租户属于哪个人"成为单行查询——入册中的设备就是这样得知
自己归属谁的。它应该在两个 profile 真正共享同一个 Org 租户时再放宽，不是更早。
**Batch 4b 补记。** 在宿主上，「membership」到底指什么。

本 ADR 写的规则是 `device -> user -> membership -> capability`。但宿主没有成员表，
也不该长出一张：成员关系归协作服务器所有，本地镜像要么在过期时**放行**（是个洞），
要么在过期时**收紧**（每次网络抖动都变成锁死）。宿主真正拥有的是 `host_bindings`，
它记录了一个租户归属的那一个人。

所以宿主只强制它能证明的那一段——设备的人必须是这台宿主为之服务的人——而形状仍然是
本 ADR 描述的那个交集：那个人的上界对已绑定的人是「全部」、对其他人是「空」，再由设备
自己的 `capability_grants` 从上界往下收。将来真有成员镜像落地时，只是上界变细，规则
不动。

具体挡住了什么：A 登出、B 在同一台机器上登录，而 A 那台仍然配对着的手机继续在 B 的
宿主上跑 agent。在此之前它可以。

**两个 NULL 依然放行**，这就是全部的安全论证。没人登录的宿主不按归属做任何判定；
未归属的设备——也就是 4a 之前存在的每一台——不被当作陌生人的设备。任何一边改成拒绝
都会造成两阶段拆分本来要避免的全设备锁死，所以两者各有一个测试钉住。

这个谓词现在存在两份：热路径上的 SQL，和控制台里的 TypeScript——后者只是为了解释
一个它画成关闭的开关。两边各有一个测试去读对方的源码，因为**会漂移的镜像比没有镜像
更糟**：它会把宿主已经拒绝了好几周的授权继续画成生效。

`suspended` 是一个新状态，而不是复用 `denied`。没有任何东西被撤销，设备回到它所属的
人手上就会恢复，不需要重新授权；显示成「未授权」会诱导用户去重新授予一个本来就已经
授予了的权限。

| **5** | ✅ `ExternalIdentity` 收编 IM principal | `lib/identity/external-person.ts`（按外部 subject 找人或建人）、`lib/connectors/principal/person.ts`（Lark 三种 id 的强弱排序）、`bootstrap.ts` 与 `approveFeishuBind` 不再退化到 `accountId`、Dexie v196 的 `subject` 索引、principals 卡片的「人 + 身份」徽章。**Guest 可推导、可渲染，但没有生产者**——见下。 |
**Batch 5 补记。** 三件本 ADR 没有预料到的事：

1. **Guest 在这一批里落不了地，只交推导那一半才是诚实的。** Guest 的定义是「持有
   Workspace 成员身份、但不在 Org 里」的 `User`。而生产环境里没有任何代码会写
   `workspaceMemberships`：这些行归协作服务器所有，客户端至今没有可配置的端点去拉
   ——`pullCollabIssues` 本身也还没有生产调用方。所以 Batch 5 交付的是推导
   （`personStandingFrom`、`resolvePersonStanding`）与渲染它的界面，`guest` 这个取值
   在 Batch 7 给协作面配上配置与成员拉取之前一直不可达。
   `lib/db/workspace-membership-producers.test.ts` 把这件事钉住：它扫描代码树寻找写
   入方，一旦出现就失败——这样这句话不会烂成一条过期注释。

2. **先从 IM 来的人和先从 Web 来的人是两个 `User`，合并是运维决定。** 登录侧的 id
   由 `(issuer, sub)` 推导，从 Lark `open_id` 铸出来的人无法复现它。只有在证据存在的
   那个方向上会自动收敛：带 `logtoSubject` 的 principal 会解析到那个已经用它登录过的
   人。反方向则由运维把 principal 重绑到真正的 `usr_…`，而重绑现在会同时改指外部身份
   行。没有任何自动路径会合并两个人——那等于把一个人的消息记到另一个人头上。

3. **`cogniaUserId` 不能只是「填对」，还必须校验。** 这个字段长期默认为
   LocalProfile id，以至于 `acct_…` 放在里面到今天仍然「看起来是对的」，而
   `cognia lark rebind --user bob` 一直被接受。现在运维通道（`user_invalid`）与写入
   底层都会拒绝。本批之前写下的行保留其 `acct_…` 值；principals 卡片回落显示裸 id，
   而不是一个什么也没说的词——与设备控制台归属行是同一个判断。

| **6** | ✅ `share-server` 补租户与身份；`ops-controller` 补 RLS | 控制器：`0002_tenant_isolation.sql`（12 张表全部 ENABLE + FORCE），每条语句都跑在 `tenant_scope` 事务里。分享：`org_id`/`creator_user_id` 两列、Rust 服务与 Worker 双侧的 grant 校验、以及仅接受 grant 的 `/v1/orgs/{org}/shares` 面。 |
| **7a** | ✅ 协作面变得可达，Guest 落地 | `lib/collab/connection.ts`（服务器在哪）、`lib/collab/refresh.ts`（唯一的那次拉取，由 `lib/issues/boot.ts` 触发）、`GET /v1/orgs/{org}/memberships/me`、`pullCollabMemberships`，以及「协作服务器」设置卡片。 |
| **7b** | ⏳ Plans 与 Runs 上协作面 | 沿用 Issues 那一刀的形状——服务端表、端点与镜像。 |

**Batch 7a 补记。** 缺的一直是同一样东西，缺了三次。

Batch 3、5、6 各自造出了这个面的一块能用的东西，也各自以同一个发现收尾：**没人调用它**。
`pullCollabIssues` 没有生产调用方、`workspaceMemberships` 没有写入方、share 服务的
org 路由没有客户端。三者都在等同一个缺失的事实——**服务器在哪**。
`lib/collab/connection.ts` 与它的设置卡片就是这个事实，补上之后其余部分**不需改动**
就活了。

**Guest 落地了。** `GET …/memberships/me` 只报原始事实——有 org 角色就报、以及每个
workspace 成员身份连同角色——`pullCollabMemberships` 把它们写进投影。持有 workspace
成员身份而不在 org 里的人现在读作 `guest`，也就是 §4 描述、而此前无人能处于的那个形状。
服务端**刻意不下结论**：`personStandingFrom` 是这条规则的唯一实现，两边各算一次就是
两条要同步的规则。

三个值得记住的细节：

1. **「没有」就是「没有」。** 成员拉取会删除服务器不再报告的 org 成员身份，并丢掉它
   不再列出的 workspace。留下过期的行，正是会让一个已被移出 org、但仍留在某个
   workspace 的人**永远读作 org 成员**——而这恰恰是 guest 存在的那个场景。
2. **替换的作用域是「这个人」，不是「这个 org」。** 投影里可能有这次拉取从未被告知过的
   行，把整个 org 清空是在删除事实，而不是刷新它。
3. **先拉成员、再拉事项**，而且启动时的拉取是静默的。协作服务器不可达绝不能挡住看板启动
   ——本地的行才是最要紧的，而它们根本不需要网络。

`lib/db/workspace-membership-producers.test.ts` 从 Batch 5 存活了下来，并被反转：
它当时断言「没有写入方」，现在断言「恰好有一个」。恰好一个，是因为 §6 让服务器成为权威
——第二个写入方就是关于「谁属于哪里」的第二种意见，而本地那份会在最后运行时胜出。

**Batch 6 补记。** 四件值得记录的事。

1. **控制器的隔离一直就是那句 `WHERE tenant_id = $1`，而这正是问题所在。** 每张表都有
   这一列、每条查询都在过滤它，所以 ~30 条语句里漏掉任何一处，就会把别的租户的服务器、
   日志和操作端出去——挡在它和生产之间的只有 code review。`FORCE` 和 `ENABLE` 一样
   关键：控制器以表的 owner 身份连接，而 owner 对「仅 ENABLE」的策略是豁免的，那样这份
   迁移就只是做戏。

2. **有三条语句无法被 scope，它们被点名，而不是被容忍。** 消费入册令牌与鉴定 agent 都是
   **凭据查找**——租户是查询的**输出**而不是输入；租约清扫按定义就是跨租户的。它们走一个
   显式的 `app.cross_tenant` 出口，并且有测试钉住「恰好三个调用方」。
   `heartbeat_operation` 与 `transition_operation` **没有**走这个出口——agent 网关本来
   就握着该 agent 已鉴定的租户，所以它们改成多收一个参数。

3. **grant 校验器现在存在三份，这不是失误。** `.github/workflows/images.yml` 用各自的
   目录作为 Docker build context 构建这两个服务，所以 `path = "../../crates/…"` 依赖在
   `cargo test` 下能解析、进了镜像就失败——§7 已经为 `services/diagnostic-server` 记录过
   同样的约束；Worker 还是 TypeScript。于是格式在 `cognia-share-core`、Worker、以及拥有
   它的 `cognia-tenant-auth` 里各存一份，三者共同校验一个**冻结的线格式向量**（放在拥有
   者旁边）。没人钉住的重复代码一定会漂移，而这种漂移只会在生产暴露，且只表现为
   「分享突然不能用了」。

4. **应用端目前还给不出 grant，我也没有为此造一条假装可用的路径。**
   `lib/share/client.ts` 发的是配置好的上传密钥；要拿到 grant 需要一个已配置的协作面端点
   ——这正是 Batch 5 在 `pullCollabIssues` 上发现缺失的同一件事。服务端这一半是完整的，
   在 Batch 7 给协作面配上配置面之前处于待用状态——这也是为什么旧密钥继续可用、
   而租户化之前的分享被原样保留而不是用猜测回填。

