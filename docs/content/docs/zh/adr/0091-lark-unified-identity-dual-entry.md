---
title: "0091 — Lark 统一身份与双入口界面"
description: "服务器授权的飞书主注册表，具备失败闭合多账户隔离、统一回调授权保护、带一次性入口令牌的网页SSO，以及对照的聊天标签页/菜单/快捷键入口接口。"
---

# 0091 — Lark 统一身份与双入口界面

- **状态：** 已接受
- **日期：** 2026-07-24
- **建立在：** ADR-0009、ADR-0025、ADR-0036、ADR-0059、ADR-0089
- **计划记录：** `docs/plans/2026-07-24-lark-im-dual-entry-completion.md`
- **运行手册：** `docs/runbooks/lark-entry-surfaces.md`

## 背景

Lark连接器很好地覆盖了机器人执行方向（消息、附件、主题、持久的入站作业、CardKit运行控制、机器人菜单、聊天内斜线命令），但没有服务器端身份模型：任何到达本地账户下执行的适配器的`open_id`，高权限的卡片回调（`wf_approve`、`wf_fanout_*`、`tool_approve`、`skill_invoke`）不带演员授权，唯一网络深度链接（`/inbox/c?key=`）暴露了原始对话密钥—— 可猜测、永久、未经认证。“用户从飞书内部打开Cognia”的方向（聊天标签、群组菜单、消息快捷方式`+`菜单）并不存在。

## 决策

### 1. 非书主登记处（默认拒绝）

Dexie v125 增加了 `feishuTenants`（`&[tenantKey+appId]` → cogniaAccountId）、`feishuPrincipals`（`&[tenantKey+appId+openId]` → cogniaAccountId + cogniaUserId，状态 active/disabled/unlinked）和 `feishuPrincipalBindRequests`。入站总线解决适配器查找与覆盖查找之间的每个Lark事件（步骤2.5）：`resolved`事件将`accountId`/`principalId`印在持久作业、会话状态和运行发起者上;`unbound`发件人被`history_only` hashed-open_id审计和每天一次双语绑定码回复;`disabled`、`tenant_disabled`和`cross_account`静静地停着。映射到另一个Cognia账户的租户NEVER在该活跃账户下执行——没有对`HEADLESS_LOCAL_ACCOUNT_ID` 回退，且明确已拒绝每事件更换账户。注册处受`larkPrincipalRegistry`（默认关闭）限制;关闭旗帜后，遗留行为字节完全相同。

### 2. 统一回拨授权

每次回调短路前都会运行一个守卫（`lib/connectors/callback-authorization.ts`）：适配器匹配→到期→消耗一次（`wf_approve`、`wf_cancel`、`wf_fanout_*`、`tool_approve`、`skill_invoke`）→对话匹配（聊天级别;仅当双方携带一个线程时）→主体检查→ allowedActions → actorScope（发起者/操作员/对话/任何人，带有每种遗留备份）→运行控制对话绑定。装订师`actorScope`/`allowedActions`;`consumedAt`修复了陈旧的重新点击，重新授予会话绕过。`larkStrictCallbackAuthorization`默认是**强制执行**。审计在每个适配器上仍然可迁移，但它不是静止状态：在审计模式下，`consume`永远不会铸造，因此永远不会写入`consumedAt`，过时的重新点击仍可重新授予会话绕过——守卫存在的缺口。审计现在也会增加`cognia_lark_callback_auth_would_deny_total`，因此“静音后扩大”程序采用了聚合，而不仅仅是单个审计行。每个终端否定理性都会用双语解释回答点击器;之前只有`actor_forbidden`有，剩下的十个机器人和坏掉的机器人几乎没什么区别。

### 3. 网络SSO及授权参赛链接

配套的API（无头 axum、`/integrations/lark/*`、预授权费率限制）拥有公共接口。SSO：服务器端状态+PKCE登录→ Lark OAuth代码交换，Rust →8小时`lark_web` HS256会话JWT通过URL片段传递并在`sessionStorage`中进行。外部链接绝不携带原始会话密钥：个人链接包裹一个300秒的一次性`lark_entry`令牌（jti LRU），其解析强制进行身份匹配;聊天层接口（聊天标签页/组菜单）包裹了一个长期存在的纯完整性`lark_surface`描述符，其解析需要SSO加上一次实时聊天成员检查，由事件总线意图桥（`connectors://lark-intent` + `lark_result_complete` RPC + 轮询端点）的 Brain 回答。`/lark/entry`呈现终端结果。Dexie v126 增加了条目上下文/聊天接口/消息导入/网页会话账本。

### 4. 入口接口

- **聊天标签页/群菜单**：调解者被钉在官方`chat_tabs`，`menu_tree` APIs每个聊天中保留一条指向接口 URL的“Cognia”条目;Desired State 和指数式后退在 `larkChatSurfaces` 现场。需要状态行在适配器启动和设置重新同步时`GET /im/v1/chats` SEEDED——如果没有这个，只有实时`bot.added`事件才会创建，所以启用该标志对机器人已经在的聊天没有任何影响。`chat_mode`决定资格，所以P2P聊天不会因为拒绝参加的队伍菜单API而进入群菜单。15分钟的扫荡会推动回撤（之前没有回放，因此失败的接口会失败直到重启）;许可和仅限组别的拒绝将停放为`blocked`，而非每小时无限重试;关闭接口旗帜则是撤回已发布的tab/menu，而不是留下活着的URL。仅链接——绝不直接执行。
- **机器人菜单**：点击分类为映射/链接/未知。未知`event_key`s答案，固定双语通知加上`menu.unknown_key`审核，且从未成为示范提示（之前是）。保留的`cognia.*`内置组件解析在适配器配置的行后面。
- **Slash 命令**：Feishu的开放平台没有**机器人slash-命令事件——“/name”文本作为`im.message.receive_v1`到达，且现有命令调度员已拥有该事件（已与官方机器人能力文档核实）。control-命令 spec registry（`nativeExposed`批次：/new /status /help /sessions /switch）驱动控制台菜单的列表，而不是虚构的事件分支。
- **消息快捷方式 / `+`菜单**：`/lark/shortcut`通过H5 JSSDK交换Lark触发码（由会话认证的`jssdk/config`端点铸造签名），提交ONLY ID，Brain在写入一个分隔的导入块到新的平台绑定会话（`sourceHash`幂等性）前，重新验证标志 + 主体 + 成员 + 每条消息`chat_id`。`+`菜单绑定了一个新的会话`/new`-style。客户端提供的数据始终是请求，绝非可信。

### 5. 可观测性与推广

伴随展示中的16个`cognia_lark_*`计数器（SSO、条目解析、主金未绑定、回调拒绝AND想拒绝、聊天标签和组菜单失败作为独立系列、导入、`+`-menu创建和拒绝、入站速率限制行程）;Brain镜子会穿过允许列出的触发后不等待 `lark_metrics_record` RPC。入站速率限制桶`${tenant}|${user}:${channel}`有选择加入`perTenantPerMin`上限——每个用户和每个频道的桶只限一人和一个房间，且都不限制工作区。安全团队还会编写持久审计（`principal.*`、`callback.*`、`entry.*`、`menu.unknown_key`、`chat_tab.*`、`shortcut.*`、`plus.create`、`sso.session_seen`），这些审计带有哈希值，而非消息内容。所有接口都按适配器（设置卡）进行标志门控，且env/global的备选默认开启;灰序、管理员控制台检查表、客户端验证矩阵、警报阈值和回滚（包括强制翻转）都存在运行手册中。

## 后果

- 多租户的非书流量是账户隔离的，采用默认拒绝默认状态。现有工作区之所以能继续工作，是因为注册表会从它已经通信过的身份中做种;真正新发件人会收到一个绑定码，操作员可以从设置卡或CLI中批准。
- 卡片回拨默认被授权：来自既非请求者也非配置操作员的点击会被拒绝，且在所有平台上均被拒绝，而不仅仅是Lark。`operators`最终是可配置的——字段有三个读者且没有写入者，因此请求者未知时`approvalActorScope`范围永久为空。
- 每个外部发布的URL均在解析时间获得授权;泄露链接会过期、一次性使用，或要求SSO+会员资格。
- 伴随者API建立了一个公共Lark 接口，必须利用现有的HS256秘密、速率限制和拒绝名单;轮换设计使未完成的会议无效。
- 真实租户操作（控制台配置、聊天标签发布、客户端验证）是故意的运行手册步骤，而非代码——无法从CI执行。机器人菜单列表是生成（`cognia-agent lark menu-manifest`）而非转录的，因此控制台列表不会从命令注册表中漂移。
- `/integrations/lark/*`仅在无头服务存在时挂载，因此SSO、入口解析、快捷方式导入和JSSDK签名仅无头。桌面安装保留了机器人菜单、回调和命令调度。这是因为接口需要公共的HTTPS回调URL，而桌面机器没有这个功能。
