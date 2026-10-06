---
title: "0215 — 一个人、一个加密同步空间、多台可写主机"
description: "Cognia 运营一个可选的官方账号，跑在 Cloudflare Workers 上（Better Auth，标准 OIDC；自托管者可继续用 Logto）。登录后的用户拥有一个端到端加密的同步空间：每个账号一个 Durable Object，保存签名并加密的操作日志；快照和大文件由客户端加密后存入 R2；按字段用 HLC 取最后写入者；每个纪元的同步密钥分别密封给每台设备和一个恢复公钥。每台已加入的桌面、手机和浏览器都是可写副本。数据复制到所有设备；执行（连接器、定时任务、进行中的回合、凭证刷新）只在账号对象授予的租约下运行。飞书登录身份、IM 机器人凭证和飞书用户授权是三件不同的事，彼此分开。"
---

# ADR 0215 — 一个人、一个加密同步空间、多台可写主机

**状态：** 已接受（第 1 阶段“身份”已实现；第 2 阶段“密钥与设备登记”和第 3a 阶段“首批六张表的同步核心”已实现，受构建开关控制；第 3b 阶段和第 4–7 阶段尚未开始）
**日期：** 2026-10-04
**修订：** [ADR-0054](./0054-local-multi-account-isolation)（账号同步纳入范围；静态加密已存在）、[ADR-0097](./0097-cross-device-settings-contract-and-companion-reach) D5（同步表采用按字段时钟）、[ADR-0103](./0103-cross-host-session-handoff)（"单一可写副本"只约束进行中的回合，不约束数据）、[ADR-0116](./0116-host-authoritative-session-state)（权威方是租约持有者）、[ADR-0136](./0136-cross-device-placement)（主机间租约从此存在）、[ADR-0149](./0149-a-person-is-not-a-device) §6（其拒绝端到端加密的前提已过时；个人同步是端到端加密的）
**相关：** [ADR-0001](./0001-backup-schema-v3)（备份包）、[ADR-0021](./0021-webrtc-datachannel-wan-transport) 与 [ADR-0170](./0170-cognia-relay-and-connectivity-center)（配对保留）、[ADR-0027](./0027-mobile-offline-and-discovery)（未登录的配对继续用伴随同步）、[ADR-0059](./0059-cloud-deployment-headless-brain)（无头主机）、[ADR-0091](./0091-lark-unified-identity-dual-entry)（飞书主体）、[ADR-0167](./0167-the-schedule-belongs-to-the-account)（定时任务）、[ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs)（插件意图）
**线格式：** [账号同步协议 v1](../data/account-sync-protocol)
**设计与追问记录：** `docs/superpowers/specs/2026-10-04-official-account-and-e2e-sync-design.md`（本地工作笔记；以本 ADR 为准）

## 背景

Cognia 有三套互不相通的身份体系。

- **个人数据本地优先、单写者。** 本地档案（`acct_…`）在一台主机上拥有一个按档案加密的 Dexie 数据库。手机和浏览器通过拉取镜像约 370 张表中的约 50 张，写操作排队回传（ADR-0027）。没有云账号，两台桌面之间不共享任何东西，主机离线时手机只能读。
- **组织协作有真正的账号模型，但没人看得到。** ADR-0149 建好了 `usr_`/`org_`、Logto 登录和 Postgres 协作服务器，可只有主机报告 `COGNIA_DEPLOYMENT_MODE=multi-tenant` 时才出现登录门。普通安装报告 `none`，直接放行。
- **Cloudflare 边缘服务没有用户概念。** 信令按设计只认设备密钥；分享上传用全局密钥或每条分享的所有者令牌（组织授权路径已建好，但 `SHARE_GRANT_KEY` 未配置）；更新服务和状态页的管理端用静态密钥或空的 Access 配置。整个云端有五个 OIDC/JWT 校验器、三份授权格式实现。

仓库里已有多写者引擎需要的大部分零件：所有同步表都是字符串主键；有受治理的表目录和按表的删除策略；Dexie DBCore 中间件能看到每次写入；有墓碑表；有按字段的设置分类（`packages/agent-config-types/src/settings-sync.ts`）；有带版本、可轮换、可配对导出的 DEK（`lib/rag/profile-dek-store.ts`）；画布已在用 Yjs。阻碍在于：所有时钟和游标都局限于本机（`updatedAt`、按数据库计数的 `syncRevision`）；ID 由 `Date.now() + Math.random()` 生成（约 31 位）；`settings` 是单行、只有一个时间戳；`issueCounters` 顺序分配；墓碑会丢（失败被吞掉，90 天清理）；静态密文绑定了本机数据库名；BYOK 密钥放在 `settings` 行里；五份 ADR 写着"只有一个写者"。

## 决定

### 1. 官方账号，可选

Cognia 为普通用户运营账号。登录是可选的："离线继续"保留，从不登录的本地档案行为与现在完全一致。不做计费或任何商业化能力。

身份分三层，各司其职：

| 层 | ID | 职责 |
| -- | -- | ---- |
| 人 | `usr_…` | 拥有同步空间和设备目录。 |
| 设备 | `dev_…` | 持有一把 P-256 签名密钥和一把 P-256 加密密钥，与其伴随配对密钥分开。 |
| 本地档案 | `acct_…` | 继续作为本地解锁和静态加密的边界。 |

在同一台设备上，一个人最多绑定一个本地档案，一个本地档案也最多绑定一个人（沿用现有 `userBindings` 规则）。要区分工作和个人，就用两个账号。

### 2. 身份服务跑在 Workers 上，只讲 OIDC

- 官方签发方是 **Better Auth on Workers + D1**（`id.cognia.cn`），启用 OAuth 2.1 Provider 和 JWT 插件，显式配置 JWKS 轮换，使用 Workers 付费套餐。其 `sub` 就是 `usr_` ID。
- Cognia 各端都是公开的 PKCE 客户端。原生回调使用 RFC 8252 的私有 URI `cn.cognia.app:/auth/callback`（桌面、手机）：反向域名形式的 scheme，不带 authority，因为 Better Auth 拒绝 `cognia://…` 回调（见下文 spike）。回环地址（CLI）和 SPA 路由（网页）不变。回调跟随签发方类型：Logto 签发方继续使用 `cognia://logto/callback`，自托管的应用无需任何修改；其它签发方使用 `cn.cognia.app:/auth/callback`。桌面、iOS 和 Android 同时注册两个 scheme；`pnpm logto:seed` 在 Logto 原生应用上同时登记两个回调，以后切换时无需改控制台。
- **客户端不绑定签发方。** `lib/identity/deployment-discovery.ts` 内置官方签发方作为默认值，不再等主机宣告多租户模式。自托管可以覆盖为任意 OIDC 签发方；自托管 Logto 仍是参考实现，开发时用它证明客户端不绑定签发方。宿主的 `/api/auth/config` 公布 `oidc.issuerKind`（`logto` 或 `oidc`，版本 4，取自 `COGNIA_OIDC_ISSUER_KIND`），缺省视为 Logto。只对 Logto 签发方发送 Logto 专有参数（为拿到刷新令牌而加的 `prompt=consent`、`direct_sign_in`、组织 scope、`organization_id`）；Better Auth 收到 `prompt=consent` 时，即使是第一方客户端也会跳到授权确认页。
- Rust 校验器统一到 `cognia-tenant-auth::oidc`；伴随网关自己的 JWKS 缓存和诊断服务器的静态 PEM 改为调用它。Workers 使用一个 TypeScript 移植版，用 `crates/cognia-tenant-auth/fixtures/grant-wire-vector.json` 校验一致性。
- 第三方登录：飞书/Lark 走 `genericOAuth`（授权 `accounts.feishu.cn/open-apis/authen/v1/authorize`，令牌 **v2** `open.feishu.cn/open-apis/authen/v2/oauth/token`，用户信息从 `data` 中取出），以 `(feishu|lark, tenant_key, union_id)` 为键，绝不用 `open_id`；GitHub 和 Google 用内置实现；Apple 每次登录签一个 ES256 客户端密钥并修复 `form_post` 的 Cookie 问题；微信用 `unionid`。邮箱可选；提供方不返回邮箱时使用一个不可路由的占位地址，且永远不标记为已验证。登录只申请最小权限。
- **签发方不保存第三方令牌。** 第三方登录只用来一次性证明 `(provider, tenant, subject)`；否则 Better Auth 会把第三方的访问令牌和刷新令牌明文存进 D1，所以用 `databaseHooks.account` 的 before 钩子在每次写入前丢弃它们。飞书用户授权是另一项由客户端持有的授权（§9）。
- **签发方以声明的形式公布此人关联的第三方身份**，客户端不依赖协作服务器就能关联 `lark:<tenant_key>:<union_id>`（目前这一步由协作服务器读取 Logto 管理 API 完成）。
- 客户端和资源的管理接口关闭：`clientPrivileges` 和 `resourcePrivileges` 拒绝普通用户；Cognia 客户端和同步 API 资源由配置写入（`resourceSeedMode: "overwrite"`），客户端与资源显式关联。
- 否决：OpenAuth（停滞、只有 OAuth、没有 `id_token`）、`@cloudflare/workers-oauth-provider`（不透明令牌，Rust 校验器无法验证）、Auth.js 和 Lucia（不是签发方，或已弃用）、以 Logto 作为官方签发方（需要 Postgres 和 Redis，跑不了 Workers）。

### 3. 密钥离开设备时一定是密封的

- 每个纪元有一把随机 256 位**同步密钥** `SK_e`。服务器只保存它的 HPKE 信封：每台活跃设备一份，外加一份给**恢复公钥**。
- **恢复密钥**是 128 位随机数，用分组的 Crockford Base32 显示。它确定性地派生一个 P-256 密钥对，只上传公钥一半，所以任何设备不需要知道恢复密钥就能把新纪元密封给恢复公钥。
- 每个新纪元包裹上一个纪元的密钥，因此当前密钥能打开全部历史。
- **轮换时机**：吊销设备、重新生成恢复密钥、使用恢复密钥，以及用户手动触发。被吊销的设备即使服务器被攻破也读不到新纪元；它已经缓存的数据收不回来，界面会明确说明。
- 第一台设备必须先生成恢复密钥并通过确认（重新输入其中 4 个位置，或下载恢复工具包）才能开始上传。重新生成会让旧密钥立即作废。
- **丢失所有设备且丢失恢复密钥，数据就丢失了。** 加入流程会直白地告知。
- 登录从不派生密钥，OIDC 只负责传输层认证。
- 在本地，密钥链作为本地档案主密钥下的一个保险库机密保存。由于静态密文绑定本机数据库名，同步时先在本地解密，再用 `SK_e` 重新加密；静态密文从不外发。
- 这是对设计稿中"单一账号主密钥"的细化：把每个纪元直接密封给各设备和恢复公钥，可以做到真正的吊销，而且轮换时从不需要恢复密钥。
- 选 P-256 而不是 Curve25519：仓库在 WebCrypto 和 Rust 里已经用 P-256 做 ECDSA 和 ECDH，而较旧的 Android WebView 对 X25519 的支持不确定。

### 4. 新设备靠批准或恢复加入

- 新设备上传自己的公钥。每台已登录设备收到通知，显示设备信息和 6 位校验码；用户确认两边一致后批准，批准方把当前密钥密封给新设备。请求 15 分钟后过期。通知复用设备控制台（`components/devices/`）和通知系统。
- 手边没有其他设备时，输入恢复密钥；使用恢复密钥会轮换纪元，并提示重新生成恢复密钥。
- 设备登记表是一条以固定的创世设备为根的签名链，服务器无法塞入设备。
- **本来就有本地数据的设备**先预览差异，做一次 ADR-0001 备份，然后选择合并（默认）或丢弃本地数据。内置种子数据不会重复：只同步用户在其上的改动。

### 5. 每个账号一个 Durable Object

- 账号对象保存设备登记表、密封的纪元信封、操作日志、快照清单、租约和计数器。使用 WebSocket 休眠；失败时退回长轮询。
- 对每个操作，它只做这些事：认证设备会话；用登记表校验签名（被吊销的设备不读内容直接拒绝）；按 `(deviceId, deviceSeq)` 去重；分配无间断的 `serverSeq`；通知在线设备。每次推送的一批只存一行。
- 操作只带一个粗粒度的明文类别（内容、设置、密钥、CRDT、只追加）；表名、行 ID、字段名和值都在填充过的密文里。
- 快照由持有压缩租约的设备生成，加密分块后存入 R2，之后账号对象删除旧的操作批次。
- 大文件由客户端加密，用带密钥的哈希做内容寻址，存入 R2。
- 自托管用 `workerd` 运行同一套 Worker，Durable Object 存储放在本地磁盘，大文件用 S3 兼容存储，打包进 `deploy/compose`。服务端不写第二套实现。

### 6. 每台已加入的设备都是可写副本，合并在客户端完成

- 记录表按字段合并，按 `(HLC, deviceId)` 取最后写入者。HLC 生成时拒绝超前本机时钟 5 分钟以上。
- 删除是一个带自身时钟的字段。只有所有活跃设备都确认越过之后才回收墓碑；90 天未出现的设备从快照重新开始。
- 消息只追加，编辑生成新版本。
- 富文本和画布把 Yjs 更新作为不透明的加密操作传输。
- 模式演进只做加法。客户端遇到更新模式的操作时只存不应用，保留不认识的字段并原样回写，并提示用户升级。服务器强制最低客户端版本。
- 变更捕获是一个 DBCore 中间件，在同一个 IndexedDB 事务里写一条待发送记录，与 `createEncryptedContentMiddleware`、`createMessageSyncRevisionMiddleware` 并列。应用远端操作时不再重复捕获。
- **登录后的手机是完整副本**：所有主机都离线时也能读写，大文件按需下载（可选仅 Wi-Fi）。**纯网页**在第 6 阶段成为完整副本，密钥只放在内存或不可导出的 WebCrypto 密钥里，每次打开靠批准或恢复密钥解锁。
- 二维码配对和伴随拉取同步保留，用于远程控制和从不登录的用户。

### 7. 按类别决定同步什么

表目录在 `none` 和 `companion-readonly` 之外新增 `DataSyncMode` 值 `account-e2e`，由一个门禁固定每张表的类别。所有类别默认开启，可以按类别关闭；任意一条密钥都可以标记为"仅本机"。

| 类别 | 示例 | 规则 |
| ---- | ---- | ---- |
| 内容 | 会话、消息、角色、技能、记忆、工作流、模板、计划、目标、议题、机器人 | 操作日志，按字段合并；消息只追加 |
| 设置 | 单行的 `settings` | 拆成每个键一行；每个键按 `settings-sync.ts` 分为共享、仅本机或仅桌面 |
| 密钥 | 模型 API Key、机器人应用密钥、OAuth 令牌集 | 独立类别；BYOK 密钥先移出明文的 `settings` 行；会轮换的凭证只在租约下刷新 |
| 执行 | 连接器运行时、定时任务、进行中的智能体回合、终端、沙箱 | 配置同步；运行需要租约（§8） |
| 仅本机 | 窗口状态、本地路径、stdio MCP 命令、向量索引 | 从不同步；向量索引在每台设备上重建 |
| 大文件 | 附件、产物、图片 | 加密、内容寻址的 R2 对象 |
| 插件 | 安装 | 同步意图（`setPluginIntent`），每台设备各自调和 |

新 ID 使用 UUIDv7 或基于 CSPRNG 的 nanoid。议题编号由账号对象里的计数器分配（计数器只是元数据，不影响端到端加密）。

### 8. 数据复制到所有设备，执行只在一处

- 账号对象发放租约 `{resource, holder, generation, expiresAt}`：TTL 30 秒，每 10 秒续约，世代号单调递增，并随每次对外操作一起携带，过期的持有者会被隔离。资源名只以带密钥的哈希形式到达服务器。
- 需要租约的资源：每个连接器实例、每个定时任务、每个进行中的会话回合、压缩任务，以及每个会轮换的凭证的刷新。
- 放在哪台设备由客户端决定：租约过期后，设备按排位依次重试（无头服务器，然后最近活跃的桌面，然后其他桌面），资源也可以固定到某台设备。依赖本机环境的资源（stdio MCP、本地路径工作区、电脑操作）默认固定在创建它的设备上。进行中的智能体回合从不自动转移，只能走 ADR-0103 的显式交接。
- 手机和浏览器从不获取执行租约。
- 连不上账号对象的主机在租约本应过期时停止所持资源，从不自行授予租约。
- 这同时堵上了一个与同步无关、今天就存在的漏洞：没有任何机制阻止两台配置了同一个飞书应用的主机同时连上它。

### 9. 飞书登录、IM 机器人和用户授权是三件事

| | 是什么 | 凭证 | 归属 |
| - | ------ | ---- | ---- |
| 登录身份 | 你是谁 | `union_id` + `tenant_key` | 人 |
| IM 机器人 | 渠道 | 机器人应用的 `app_id` / `app_secret` | 连接器配置，密钥类别 |
| 用户授权 | 读文档、以你的身份发消息 | `user_access_token` + 一次性轮换的 `refresh_token` | 某一个飞书应用，密钥类别 |

- 飞书用户令牌只对签发它的应用有效；`union_id` 只在同一开发者的应用之间一致。
- **机器人由用户自带。** 用户自己的应用跑在用户自己的主机上，消息内容不经过 Cognia 服务器。登录永远不能提供机器人凭证。
- **登录身份经过一次确认后用来识别机器人的发信人。** 身份平面里的 `lark:<tenant_key>:<union_id>` 来自 IdP 和协作服务器，而本 ADR 不信任它们来决定谁能接触智能体，所以它只把绑定请求标注为“与你的登录一致”。本人以自己的身份审批一次；此后同一个 `union_id` 给本人在该租户下的其他机器人发消息时自动准入，前提是传输无法用静态令牌伪造；档案退出登录时这种准入随之结束（见 ADR-0091 的实现更新）。
- **用户授权是一次单独的同意**，预填当前登录账号，申请 `offline_access` 和所需 API 权限。令牌由客户端持有，作为密钥同步；只在该凭证的刷新租约下刷新，新令牌集立即写入。
- Logto 内置的飞书连接器会丢弃供应商令牌，并以 `open_id` 为键；本设计不依赖它。
- 登录应用目前是飞书自建应用，只有其所在租户能用。正式上线前需要飞书 ISV 资质和商店应用；申请与开发并行进行。

### 10. 退出登录、吊销、注销、配额

- **退出登录**保留本地数据和未发送的待同步队列；只有同一个人再次登录时才续上同步。在该本地档案上以另一个人登录会被拒绝，并提示新建档案。另有独立的"从本设备移除账号数据"操作，二次确认后自我吊销并删除档案。
- **吊销设备**会拒绝它的请求、关闭它的连接并轮换纪元。它下次联系服务器时锁定档案，删除密钥和密钥类别数据；加密的本地内容保留，只有输入本地密码才能读，且不再同步。可选的"同时擦除本地数据"勾选框会直接删除档案。
- **注销账号**有 7 天冷静期，期间可撤销；注销前提示先做备份。到期后删除账号对象、其 R2 前缀和身份记录，各设备把数据保留为普通本地档案。
- **配额**（防滥用，可调）：操作日志加快照软上限 2 GB，大文件软上限 10 GB。超过软上限后停止上传大文件，文本继续同步；超过软上限的 125% 后只接受删除。客户端显示用量并提供清理入口。

### 11. 本 ADR 不涉及

- **协作平面不变。** 唯一承诺是官方签发方遵循标准 OIDC，协作服务器以后可通过 `COLLAB_OIDC_ISSUER` 接入。Better Auth 的组织插件保持关闭，不能出现两个组织数据源。`host_bindings.tenant_id` 保留 UNIQUE 约束。
- 分享、状态页和诊断服务的云端认证统一是同系列的后续工作（见"后果"）。

## 被修订的决定

| ADR | 原来 | 现在 |
| --- | ---- | ---- |
| 0054 | 没有静态加密；云身份和账号同步不在范围内 | 静态加密已存在；账号同步就是本 ADR |
| 0097 D5 | 认为单用户不需要按字段时间戳，予以否决 | `account-e2e` 表采用按字段 HLC，因为有多台主机在写 |
| 0103 | 永不允许两份可写副本 | 只约束进行中的会话回合（租约）；数据有多份可写副本 |
| 0116 | 活跃主机是进行中会话的唯一权威，带 30 秒租约 | 权威是账号对象中的租约持有者；租约和世代号移到账号对象 |
| 0136 | 有意不做主机间权威协商 | 账号对象中的租约；确定性幂等保留为第二道防线 |
| 0149 §6 | 因本地数据库没有静态加密，否决组端到端加密 | 该前提已过时；个人同步端到端加密；组织平面仍为服务器可读 |

## 非目标

- 计费、套餐或付费存储。
- 通过 Cognia 云中转 IM 流量的官方机器人。
- 服务器端合并、搜索，或任何需要明文的服务器功能。
- 把官方账号接入组织。
- 在丢失所有设备和恢复密钥后找回数据。

## 后果

- 用户获得跨桌面、手机和网页的统一账号；所有主机都离线时手机依然可用；两台桌面都可写；定时任务和机器人只运行一次。
- Cognia 从此运营面向用户的基础设施：一个带 D1 的身份 Worker，以及一个带 R2 的账号 Durable Object，使用 Workers 付费套餐。按约 1 万活跃用户估算每月 150–200 美元，主要是 DO 和 R2 存储；批量写入让行写入次数保持在套餐包含额度内。
- 第一张表开始同步之前的前置条件：CSPRNG ID、按键拆分的设置行、BYOK 密钥移出 `settings`、议题计数器移到账号对象、待发送中间件，以及表目录的 `account-e2e` 类别和对应门禁。
- 本次设计中发现、可独立修复的缺陷（第 1–5 项和第 9 项已于 2026-10-04 修复，见 [ADR-0091](./0091-lark-unified-identity-dual-entry) 的实现更新）：
  1. 飞书连接器从不记录 `union_id`（`lib/connectors/adapters/lark/parse.ts` 中的 `LarkSenderId` 只有 `open_id`/`user_id`，创建主体时也不传 `unionId`），所以登录关联和 IM 主体永远对不上。
  2. 入站主体解析从不读取 `externalIdentities`（`lib/connectors/.../resolve.ts`）。
  3. 飞书主体上的 `logtoSubject` 文档说登录时会填写，实际从未写入。
  4. `skills/built-in/lark/auth-bridge.ts` 读取 `settings.appId`，但 `appId` 只存在密钥存储里。
  5. ADR-0091 说 `larkPrincipalRegistry` 默认关闭；`lib/connectors/feature-flags.ts` 实际默认开启。
  6. 网页和 Capacitor 上的 keyring 密钥放在 `localStorage` 里，存在那里的令牌只是被混淆而非受保护；Capacitor 应改用安全存储。（Capacitor 部分已于 2026-10-05 修复：`lib/keyring` 在手机上改用 Keychain / Keystore，并迁移旧条目；浏览器在第 6 阶段之前仍用原回退方式。）
  7. ADR-0010 的复审已指出 Claude 订阅 OAuth 的问题，但添加账号对话框里仍可进入。
  8. 诊断服务器的匿名授权用同一请求中提供的公钥做校验，租户是否存在的检查需要确认。
  9. `crates/cognia-collab-server/src/logto_management.rs` 中的 `identities_from_user` 读取 `details.unionId`/`details.tenantKey`，但 Logto 的飞书连接器把 `union_id` 和 `tenant_key` 存在 `details.rawData` 下，且 `userId` 用的是 `open_id`；于是关联写入的是不带租户的 open id，登录永远对不上此人的飞书主体。
- 后续的云端认证统一：分享的创建和所有者操作接受人的令牌，并配置 `SHARE_GRANT_KEY`；状态页管理端补齐 Access 配置；信令保持只认设备密钥，已登录设备用设备目录代替二维码配对。

## 风险

- **中国大陆可达性。** Cloudflare 标准网络在大陆没有节点；`*.workers.dev` 基本不可用，自定义域名可用但延迟较高。接受此风险：同步在后台进行、能容忍延迟，服务使用 `*.cognia.cn` 自定义域名，WebSocket 失败退回长轮询。登录跳转对延迟最敏感，自托管是兜底方案。
- **飞书覆盖范围。** 在商店应用上线之前，只有登录应用所在的租户能用飞书登录。
- **未经验证的假设**，各自在对应阶段之前做 spike：`workerd` 能在本地磁盘上运行基于 SQLite 的 Durable Object，以支撑自托管；HPKE over P-256 在支持的最旧 Android WebView 的 WebCrypto 上性能可接受。（身份相关的假设已验证，见下文。）
- **丢失恢复密钥无法挽回。** 只能靠强制确认和设备批准来缓解。

## 身份 spike（2026-10-04）

在第 1 阶段之前，用 `services/identity-server/` 中的原型（better-auth 1.7.7、wrangler 4.141、本地 D1，结果见其 README）验证了身份相关的假设：

- Better Auth on Workers + D1 在 `<issuer>/.well-known/openid-configuration` 提供 OIDC 发现。带上 `resource=https://sync.cognia.cn` 时，它签发 ES256 的 `at+jwt` 访问令牌：带 `kid`，`aud` 是包含同步 API 的数组，`sub` 是由 `advanced.database.generateId` 生成的 `usr_` ID。打包体积 3.0 MiB，gzip 后 510 KiB。
- 生产使用的校验器 `cognia-tenant-auth::oidc::OidcAuthenticator` 接受该令牌，`UserId` 校验主体格式通过；错误的受众、错误的签发方和被篡改的载荷都会被拒绝。
- 飞书登录在浏览器中端到端跑通：经 `genericOAuth`，并自定义 v2 令牌交换；账号以 `<tenant_key>:<union_id>` 为键。
- 应用现有的 PKCE 客户端（`lib/logto/client.ts`）在不发送 `prompt=consent` 的前提下，能对 Better Auth 完成登录、带轮换的刷新、吊销，并把吊销后的刷新正确归类为 `invalid_grant`。
- 本 ADR 据此修改的内容：原生回调 scheme、Logto 专有参数、丢弃第三方令牌、签发方公布身份声明、关闭客户端管理接口（均在 §2）。spike 还发现了下面的第 9 项缺陷。

## 实现（第 1 阶段）

第 1 阶段交付身份部分：官方账号、在各端登录它、以及注销它。尚无同步。

**签发方**是 `services/identity-server/`，名为 `cognia-identity` 的 Worker，部署在 `id.cognia.cn`（staging 为 `id-staging.cognia.cn`）。

- 它只通过“方法 + 路径”白名单提供 OIDC，客户端与资源管理全部关闭。
- 迁移脚本预置两个公共 PKCE 客户端：
  - `cognia-app`：用于桌面、手机和 CLI，回调为 `cn.cognia.app:/auth/callback` 与回环地址；
  - `cognia-web`：URI 来自 `WEB_ORIGINS`。
- 登录方式为飞书（自建应用）、GitHub、Google、Apple。提供方令牌一律丢弃；只有当双方提供方都验证了同一邮箱时才合并账号。
- ID 令牌和 UserInfo 中的 `cognia_identities` 列出此人关联的登录方式。
- CORS 只开放给 Web 源。`/api/account/deletion` 实现 §10 的冷静期，由每小时的 cron 清除到期账号。
- 运维指南见其 README，故障处理见 `docs/runbooks/identity-worker.md`。

**此人的 id。** 只有官方签发方的 subject（当它是合法的 `usr_` id 时）才直接作为此人的 id；其他所有签发方（Logto 与任何自托管 OIDC 签发方）的 subject 都与签发方一起做哈希派生。部署自称的类型从不决定这一点，因此任何网关都无法签发一个等于他人官方 id 的 subject。渲染层（`lib/identity/sign-in.ts`）与桌面宿主（`crates/cognia-companion-security/src/official_identity.rs`）读取同一组向量（`fixtures/identity-id-vectors.json`）。

**桌面的信任锚。**

- headless 宿主只信任其环境变量中的签发方。
- 桌面信任用户选定的部署，再加上编译进构建的官方签发方（构建时的 `COGNIA_OFFICIAL_ISSUER`；仅 debug 构建可从运行环境读取）。
- 若选定的部署就是官方签发方，则按官方锚处理。

令牌中未经验证的 `iss` 只用于在这些锚之间选择。

**客户端。**

- 发现逻辑在原本返回 `none` 的地方返回 `official`（`lib/identity/official-deployment.ts`）。唯一的例外是 headless 宿主和对单个网关的探测。
- 云端闸门对每个配置文件（新旧皆然）只展示一次官方登录页；“登录”与“继续离线”都会永久记住（`official-sign-in-prompt.ts`）。此后由“设置 → 账号”请求闸门展示登录页，无需重新加载。
- 登录会绑定配置文件，并关联签发方列出的身份（`personal-sign-in.ts`）。没有组织。
- “设置 → 账号”显示此人及其关联的登录方式，并可申请或撤销注销。申请注销需要以同一身份重新登录一次。
- CLI 的 `logto login` 默认登录官方账号（支持 `--provider` 和 `COGNIA_ID_ISSUER`）。
- 自托管 Web 镜像以 `NEXT_PUBLIC_COGNIA_OFFICIAL_ACCOUNT=0` 构建。

**第 1 阶段遗留问题。**

- 在应用市场版应用就绪前，只有自建飞书应用所在租户能登录。
- Google 和 Apple 身份已列出，但本地身份词汇表中尚无对应项。

## 实现（第 2 阶段）

第 2 阶段交付密钥与设备登记：设备密钥、同步恢复密钥、用六位代码批准新设备、用恢复密钥恢复、撤销与 纪元轮换。不同步任何数据。线上格式见[协议](../data/account-sync-protocol)第 2–5 节。其中第 4、5 节取代了初稿：

- 设备列表是只追加、带签名的哈希链；
- 每个 纪元密钥都在其中有承诺；
- 恢复密钥既能解密也能签名；
- 批准代码采用先承诺后揭示。

**共享规则。** `packages/sync-protocol` 没有依赖，只用 WebCrypto。它的 `validateAppend`、`foldRegistry` 和回滚固定点，就是 Worker 强制执行、每个客户端重新检查的规则。`fixtures/v1.json` 中冻结的向量固定了线上格式。它们在 Node 中运行，也通过 Worker 的测试在 workerd 中运行。

**服务端**是 `services/sync-server/`，Worker 名为 `cognia-sync`，域名 `sync.cognia.cn`（预发布 `sync-staging.cognia.cn`）。每个空间一个 SQLite Durable Object，以 `spaceId` 命名。

- 它接受身份 Worker 签发的同步访问令牌，通过 `IDENTITY` 服务绑定读取 JWKS。
- 每个设备操作都检查设备证明，被撤销的设备在读取任何内容之前就被拒绝。
- 它强制要求完整的信封集合、原子的恢复批次，以及批准请求的状态、转录和批准者。
- `SyncAdmin.purgeSpace` 删除一个空间。身份 Worker 清除账号时通过 `SYNC_ADMIN` 绑定调用它：预发布环境已绑定，生产环境在 `cognia-sync` 部署后绑定。
- 运维指南见其 README，事故处理见 `docs/runbooks/sync-worker.md`。

**客户端。**

- `lib/account-sync/crypto`：HPKE 用 `@hpke/core`，恢复密钥的 RFC 9180 `DeriveKeyPair` 用 `@noble/curves`。
- `lib/account-sync/enrollment`：各个流程。
- `lib/account-sync/vault-store.ts`：密钥存放在配置文件的密钥存储中，按配置文件和空间隔离。在重启后无法保留时拒绝写入。

设备只信任已验证列表承诺过的 纪元密钥。只有列表中存在针对自身的有效签名撤销条目时，才删除自己的密钥。比已固定列表更短或不同的列表属于完整性错误，不删除任何内容。同一空间的变更在多个标签页之间串行执行。子系统说明见[账号同步设备登记](../subsystems/account-sync-enrollment)。

**界面。**

- *设置 → 账号 → 同步设备*提供设置、加入、恢复和设备列表，并标注“暂不同步数据”（第 3a 阶段改为“预览”）。
- 应用根部的宿主在应用可见时每 20 秒轮询一次。它通过仅限本机的通知（通知中心、toast、系统通知）提示等待中的设备，点击后打开批准对话框。设备控制台显示同样的提示。

**由构建开关保持休眠。** 只有 `NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC` 打开时才启用：预发布构建会设置它，`next dev` 默认打开。

- 开关关闭时，不挂载、不轮询、不连接同步服务。
- 账号概览会注明此版本未提供该功能。
- 两者都有测试固定。

**第 2 阶段遗留问题。**

- 无界面宿主还不能登记：它们还没有配置文件保险库（已在第 3a 阶段解决：它们在自己的终端里登记）。
- 加入时合并设备已有的本地数据（协议第 5.4 节）随首批同步表一起实现（已在第 3a 阶段解决）。
- 服务端向不同设备展示不同列表的情况，通过比较列表指纹来发现，但无法阻止（协议第 4.2 节）。
- Android 和 iOS 外壳上的 WebView 加密验证，以及预发布环境的端到端测试，尚待完成。

## 实现（第 3a 阶段）

第 3a 阶段交付首批六张表的同步核心：会话、消息、角色、技能、记忆，以及按键拆分的设置。内容包括操作日志、实时更新、变更捕获、逐字段合并、模式版本差异处理，以及带着本地数据加入。桌面、浏览器和无界面主机都参与。快照、压缩、大文件和过期设备重启属于第 3b 阶段。线上格式见[协议](../data/account-sync-protocol) §5.4、§6、§7 和 §9，相对初稿有以下细化。

- **没有会话令牌。** §6 的挑战与令牌步骤被去掉：第 2 阶段的设备证明已经认证每个请求。WebSocket 使用凭该证明获取的一次性票据（32 字节，60 秒），因为浏览器无法给 WebSocket 设置请求头。
- **每个字段带着自己的时钟**（`f: {name: [value, hlc]}`）。待发送队列只记录哪些字段变了，操作在推送时由当前值构造。这样流式生成的回复会合并成一个操作，同时不丢失逐字段的先后顺序。
- **删除是带“存活”规则的行级墓碑。** 删除后又被编辑的行会保留，持有它的设备会整行重发。`isDeleted` 不是字段。
- **消息逐字段合并，而不是只追加。** 应用在流式生成时以及在图片工作台中会原地修改消息。`append` 和 `crdt` 继续保留。
- **推送应答说明存了什么**（`{deviceSeq, firstSeq, lastSeq}`）。客户端只结清已存储的尾部，所以应答丢失后的重发不会丢失操作。
- **服务器也在 WebSocket 上通知登记表变化**，已连接的设备会立刻看到等待中的加入请求。

**共享规则。** `packages/sync-protocol` 新增：

- `hlc.ts`：48 位毫秒、16 位计数器加设备 id，编码后字符串顺序即时钟顺序。发送端单调递增，远端时钟最多采纳到当前时间 + 5 分钟。
- `padding.ts`（PADMÉ）。
- `ops.ts`：规范的 AAD 与签名字节、`op` 子密钥、载荷校验。
- `merge.ts`：纯函数的逐字段后写者胜，含墓碑。

冻结向量在 `fixtures/v1-ops.json` 中。

**服务端**把每次推送存为一行 SQLite，分配一段连续的服务器序号，并强制以下规则：

- 每台设备的序号连续：重发的前缀只确认，有间断则返回 `409 seq_gap`；
- 操作必须在当前纪元下（`409 epoch_stale`），且每个签名都有效；
- 每次推送最多 256 个操作、1 MiB，操作日志达到 2.5 GB 后只读。

拉取最多等待 25 秒的新操作。可休眠的 WebSocket 负责通知新操作和登记表追加，被吊销设备的连接以代码 4403 关闭。`SyncAdmin.purgeSpace` 会连同空间的其他存储一起删除操作日志。

**客户端**是 `lib/account-sync/data/`。它不依赖框架，应用和无界面主机的 brain 共用它。

- **策略。** `tables.ts` 把每种同步行的每个字段归为 `sync` 或 `local`，并按行类型做类型约束。内置角色和技能、属于项目的记忆、向量索引、设备相关信息，以及对尚未同步的表的引用都留在本地。设置只同步 `shared` 键。
- **捕获。** `capture-middleware.ts` 是位于内容加密之上的第 3 层 Dexie 中间件，在写入自身的事务里把变化的字段及其时钟记入 `accountSyncOutbox` 和 `syncFieldClocks`。它由 `accountSyncState` 中的一行启用，应用远端操作的事务不受它影响。
- **推送、来源校验与应用。** `pusher.ts` 负责构造、加密、签名和推送。`op-origin.ts` 对照已验证的登记表重新检查每个拉取到的操作的签名者。`applier.ts` 在一个事务中合并并写入字段、时钟和游标，把来自更新模式版本或未知纪元的操作暂存到 `accountSyncInbox`。
- **加入。** `join.ts` 在任一方为空时自动播种，否则先做加密的 ADR-0001 备份，再询问合并还是替换。
- **引擎。** `engine.ts` 每个数据库持有一个 Web Lock。它运行一条带防抖的推送通道，以及一条走 WebSocket、必要时退回长轮询的拉取通道。它只在档案自己的数据库上运行，从不在伴侣镜像上运行。

数据库模式为 v236。两客户端和三客户端的收敛测试（`sync.integration.test.ts`）让真实客户端对接扩展后的模拟服务器。

**界面。** 账号页面的同步区域显示状态行和按类别的开关（内容、共享设置），还显示暂存与过大提示，以及**立即同步**。合并或替换对话框会列出每张表的数量。区域标注为**预览**，不再是“暂不同步数据”。

**无界面主机**在自己的终端里登记。它们不使用计划最初提出的伴侣 RPC，那种方式会让浏览器标签页去操纵另一台主机的密钥。

- `cognia-agent account-sync status|setup|join|recover|approve|deny|devices|revoke|rotate|recovery-key|data` 封装同一套登记流程。
- 主机用 `cognia-agent logto login` 登录，只认官方签发方的会话。
- 密钥以 0600 文件存放在 `~/.cognia/account-sync/` 下，与 brain 共用。
- 主机登记后，brain 的 `account-sync` 运行时启动引擎。它采用通过 `account-sync data --merge|--replace` 给出的合并或替换答案，并先做备份。
- 连接到无界面主机的标签页会显示这条命令。
- 子系统说明见[账号同步数据](../subsystems/account-sync-data)。

**由构建开关保持休眠。** 一切都受 `NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC` 控制，无界面主机上是 `COGNIA_ACCOUNT_SYNC`。关闭时，不启用、不捕获、不连接任何东西，CLI 命令拒绝执行，brain 不启动引擎。测试固定了这些行为。

**第 3a 阶段遗留问题。**

- 没有快照和压缩（3b）：新设备要重放整个日志，日志会一直增长到 3b。达到只读上限后删除也会被拒绝，因为服务器无法区分删除操作。
- 操作还不携带签名者的登记表头部（协议 §4.2），所以分裂视图仍只能靠指纹发现。
- 引用附件或图片的消息，在其他设备上会显示为不可用，直到大文件同步上线（第 6 阶段）。
- 预发布环境的端到端测试、`cognia-sync` 的生产部署，以及手机外壳上的 WebView 验证，尚待完成。

## 路线图

1. **身份。** Better Auth Worker 和 D1；飞书（自建应用）、GitHub、Google、Apple；带官方默认值、不绑定签发方的客户端；档案与人的绑定；修复上面的飞书缺陷。
2. **密钥与加入**（已实现，受构建开关控制）。设备密钥、恢复密钥及确认、6 位校验码批准、恢复、吊销、纪元轮换。
3. **同步核心。** 账号对象、操作日志、HLC、待发送中间件、快照、模式版本差异处理、ID 与计数器。首批表：会话、消息、角色、技能、记忆、设置（拆分后）。**3a**（已实现，受构建开关控制）：操作日志、实时更新、捕获、合并、模式版本差异、加入、无界面主机。**3b**：快照、压缩、过期设备重启、ID 与计数器。
4. **执行租约。** 连接器、定时任务、进行中的回合；对 0103、0116、0136 的修订在此生效。
5. **密钥与飞书用户授权。** 密钥类别、刷新租约、BYOK 密钥移出 `settings`。
6. **其余表和大文件**，手机成为完整副本，纯网页成为完整副本。
7. **云端认证统一**，以及切换到商店应用。

## 验证

- `packages/sync-protocol/fixtures/` 中的协议向量（规范编码、签名、HPKE 密封、填充、HLC 合并）在客户端和 Worker 中都能通过。
- 合并性质：两个副本以任意顺序应用同一批操作后结果一致（对随机操作交错做性质测试，覆盖删除、时钟偏差和更新模式的操作）。
- 吊销：吊销设备后，新纪元永远不会为它生成信封，它的请求一律被拒绝。
- 租约：配置了同一连接器的两台主机永远不会同时运行它；失去账号对象联系的持有者在过期时停止。
- 不绑定签发方的客户端无需改代码即可分别登录本地 Logto 和 Better Auth Worker。
- 每个阶段都按仓库规则附带同目录测试、en/zh-CN 文案和 changeset。
