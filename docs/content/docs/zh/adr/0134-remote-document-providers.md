---
title: "0134 — 云端文档提供方"
description: "在聊天输入框引用飞书与 Google Workspace 文档，既不新造一条附件通路，也不污染 IM 连接器契约。"
---

# ADR 0134 — 云端文档提供方

**状态：** 已接受
**日期：** 2026-08-19

## 背景

输入框的 `@` 此前只能引用本地工作区文件：`searchWorkspace` 走 Tauri 根目录，
选中后把 `@relPath` 写进文本、把绝对路径推进 `chatStore.referencedPaths`，
`resolveSendOptions` 再声明父目录，交给 Agent 的 Read 工具按需读取。这条链路
每一步都假定被引用物有本地路径。

而用户真正要引用的大部分文档没有路径——它们在飞书云文档和 Google Workspace
里，此前唯一的办法是打开、全选、粘贴。

四块拼图里有两块已经存在，只是聊天侧够不到：`lib/twin/ingest/lark-doc-fetcher.ts`
用连接器凭证为数字分身读取飞书 docx / wiki / 旧版文档；`lib/skills/built-in/lark/`
提供 40 个基于 lark-cli 的技能。Google 侧则完全空白：`ALL_PLATFORM_KINDS` 连名字
都没预留，仓库里唯一的 Google OAuth 属于 Drive **备份**目的地。

## 决策

### 与 Platform Connectors 平级，而非扩展它

ADR-0009 明确把 `PlatformAdapter` 限定在 IM 会话语义上——`send`、`edit`、表情
回应、群管理、A2UI 能力矩阵。给它加 `searchDocuments()` 会迫使 Google 被建模成
一个没有消息能力的连接器，`send` 与 `health` 全是空实现。因此
`lib/docs-providers/` 是一个平级注册表：模块级 Map，id 与提及前缀重复都抛错，
内置项在 `./index` 模块加载时注册。

飞书 provider 仍然**复用**连接器实例的凭证，因为用户的飞书账号本来就在那里。
借用胜过再造一个需要单独授权、单独吊销的连接。

### 选中即抓取，按附件送达

选中的文档立即抓取，合成为 `File` 后汇入既有的附件通路
（`prepareComposerAttachments` → `staged-attachment-store` →
`lib/chat/attachments/dispatch.ts`）。

这是让整个特性保持小体量的关键决策：脱敏门、芯片上的 token 计数、
`INLINE_TOKEN_CEILING` 超长确认、附件预览的「模型视图」、草稿恢复，全部继承
而非重建。另一条路——只留引用、由 Agent 事后取——需要为每个 provider 造工具，
而飞书唯一的工具路径依赖用户自行安装 `lark-cli`。

正文先经 `wrapUntrustedContent` 包裹：第三方文档是外部数据，不是指令。

### 截断永远可见

一个多维表格可以装几十万条记录。`limits.ts` 里每一条上限都同时置
`RemoteDocContent.truncated` **并**在正文里写入标记。静默比拒绝更糟——模型会
拿着缺了尾巴的文档自信作答。

同样的理由，Google 表格走 `spreadsheets.values.batchGet` 而非 Drive 的 CSV
导出，后者会静默地只返回第一个工作表。

两个 provider 都跳过隐藏工作表：它们对用户是隐藏的，喂给模型等于展示得比打开
链接更多。

### Google 需要回环重定向，这正是本特性桌面专属的原因

Google 把设备码流限定在固定作用域清单上——`email`、`openid`、`profile`、
`drive.appdata`、`drive.file` 以及 YouTube 系。本特性需要的读取作用域一个都不
在其中，所以 Drive 备份目的地用的那条流，物理上读不到用户已有的文档。

于是只剩 installed-app 流，而桌面客户端唯一被允许的重定向是回环地址。连接器
axum 服务是本应用唯一的回环 HTTP 宿主，因此新增
`/oauth/docs/{provider}/callback`，与飞书中继完全同构地弹跳到
`cognia://docs-provider/oauth/<provider>`。新增 `connectors_ensure_server` 而
不是放宽 `connectors_start_server`：后者在服务已运行时报错是因为它是启动路径，
二次启动属于生命周期缺陷；OAuth 流要的是地址，不是状态迁移。

飞书桌面专属的原因不同但同样具体：`open.feishu.cn` 不返回 CORS 头，只有 Rust
的 `connectors_http_request` 桥能触达。

两个原因都是物理限制而非政策。`DocsProvider.hosts` 记录它，面板与设置卡在其他
壳上渲染本地化说明，并由测试钉死注册表在 web / 移动 / headless 上返回空。

### Google 文档连接与 Google 备份连接相互独立

共用 keyring 键会把两者耦合：重连其一会破坏另一方的身份；而放宽备份连接的
`drive.file` 作用域，等于给一个「只能写自己文件夹」的集成发放整盘 Drive 读权限。
两者在 `docs-providers` 命名空间下各自独立，也可以是不同的 Google 账号。

### 飞书搜索必须使用用户身份

`POST /open-apis/suite/docs-api/search/object` 只接受 `user_access_token`。
共享 harness 默认会回落到租户（机器人）令牌，在这里只会产生误导性的权限错误，
因此 `withLarkAuthedApi` 增加了 `requireUserIdentity`，搜索改为直接以
`notAuthorized` 快速失败。

provider 没有搜索能力不算错误：面板会提供粘贴链接，对于手上有链接的用户这是
完整答案。

### 一份飞书鉴权 harness

「解析最佳飞书身份、静默刷新、回落机器人」此前只在 `lark-doc-fetcher.ts` 里实现
过一次。与其为电子表格和多维表格复制一份，不如把它抽到
`lib/connectors/adapters/lark/authed-api.ts` 并改写 fetcher 使用它；fetcher 现有
的 41 个测试钉死了行为未发生位移。

## 影响

- 不引入 Dexie 版本。凭证在 keyring，抓取到的正文是临时附件。
- `@lark:` 覆盖文档、知识库节点、电子表格与多维表格；`@gdoc:` 覆盖 Docs 与
  Sheets。幻灯片与思维笔记被排除，因为两个平台都没有可用的文本读取接口——面板
  不应提供一个必然在抓取时失败的选项。
- `parseLarkDocUrl` 继续拒绝表格与多维表格；provider 使用的是更宽的
  `parseLarkResourceUrl`，因此数字分身管线字节级不变。
