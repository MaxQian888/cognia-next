---
title: "0164：模板、小队与命令可携带、可迭代"
description: "小队记得自己来自哪个模板，会话模板成为一等的可携带产物，插件可以迭代自己拥有的模板与命令，分享在既有平台上分成三层（链接、签名包、受信发布者）。"
---

# ADR 0164：模板、小队与命令可携带、可迭代

**Status:** Accepted  
**Date:** 2026-09-02  
**Builds on:** [ADR-0100](./0100-unified-template-platform), [ADR-0140](./0140-squad-as-an-executor), [ADR-0037](./0037-public-share-links), [ADR-0155](./0155-plugins-reach-the-host-through-one-door), [ADR-0027](./0027-mobile-sync-orchestrator)

## 背景

对模板平台、小队界面、会话模板、插件 API 与分享管线的审计发现：ADR-0100 宣称的生命周期大部分已经接线，剩下的缺口形状一致，一种能力存在于某个界面，却在用户真正会去找它的那个界面上缺席。

- 设置页的模板库直接通过 store 创建小队，小队没有 `TemplateInstanceRecord`，永远无法从来源模板更新或脱离。另存为模板只镜像成草稿，任何包都带不走草稿。
- 会话模板是唯一没有任何离机途径的创作资源。不进备份、不同步、没有文件格式、目录里看不见。手机上的 `/` 菜单永远看不到桌面保存的模板。
- 插件只能创建一次草稿并注册不可变的发布版，不能保存、发布、派生、废弃或导出任何东西，而 `ctx.team.saveAsTemplate` 却用更弱的权限、不经确认就能到达 `saveDraft`。插件只能在清单里声明斜杠命令，自定义 `.md` 命令躲在裸的 `isTauri()` 后面，只有桌面能用。
- 分享链接只能把角色、技能、角色团队或工作流模板带进一个只读页面。所有导出的包都没有签名，因为没有任何地方生成签名，模板的 `verified-publisher` 层级不可达。
- 手机有一份完整的模板目录，却没有任何入口链到它，另有三个路由的主体在移动壳包装器下塌成一条空白。

## 决定

1. **从模板创建的小队保留血统。** 模板库的「使用」走平台的 preflight 与 instantiate，小队因此获得实例记录，小队详情面板渲染 Studio 用的同一张实例卡片（只加标题与摘要，不派生副本），更新与脱离在设置页里就能做。另存为模板可以顺手发布一个版本，模板面板显示平台状态，并在每一行用户模板旁提供发布、导出包、派生、导入包与分享。

2. **会话模板是仅目录域，也是可携带文件。** 写入方仍是 `lib/db/chat-templates.ts`，目录只做投影，并通过订阅在每次写入后重新投影，因为模板是在输入框里保存的，离展示它的界面只有一次按键。可携带形式就是仓库读取器已经解析的那种 frontmatter markdown。导出不降权，由读取器对「作者不是你选的」文件收回能力。该表加入伴侣同步（带墓碑）、备份与按域传输，内容等级为 `encrypted-content`。

3. **插件迭代自己拥有的东西。** `ctx.templates` 新增 `saveDraft`、`publish`、`fork`、`deprecate`、`deleteDraft`、`exportPackage`、`importPackage`，全部位于 `templates:library:write`、与 `createDraft` 相同的确认代理，以及基于 `provenance.pluginId` 的所有权检查之后。provenance 在内容哈希之外，盖章不会改变包校验的任何内容。`ctx.team.saveAsTemplate` 同时要求两个权限。`ctx.commands` 在运行期注册斜杠命令，命名空间与清单路径一致，跨插件先到先得，并在 `commands:read`、`commands:write` 之后读写自定义 `.md` 命令。`onCommand` 先派发给拥有者插件。桌面扫描器像 CLI 一样读取 `.cognia/commands`。项目范围的命令走配对浏览器或手机已有的工作区文件传输，全局范围仍只在宿主可用并如实说明。

4. **分享在既有管线上分三层。** 两种分享类型：`template-definition` 携带已发布版本，对端可校验哈希，分享者的本地 provenance 被中性化；`chat-template` 携带正文、参数与启动配置，出站与入站各降权一次。在应用内，查看器提供「加入我的库」，走解析信任并盖章 provenance 的同一条包导入路径。发布者身份是宿主中立密钥环里的 Ed25519 密钥，指纹算法与插件安装器一致，因此模板发布者与插件发布者在信任账本里是同一行。有密钥后导出默认签名，导入可以信任签名者，包也可以在出站防护之后从 URL 导入。

5. **手机能找到它本来就有的东西。** `/templates` 加入首页快捷操作、「我的」列表与「发现」标签前缀。`/templates`、`/discover`、`/agent-runs` 成为全视口路由，覆盖测试只对自己撑高的主体接受豁免。`/me/chat-templates` 用带 `mobile` 属性的设置区块复用同一个编辑器。

## 后果

- Studio 的作用域控制、启动期实例工作区回填、受控标签页与由 URL 驱动的选择，关闭了 `lib/templates/service.ts` 里最后几个无人调用的方法。休眠测试仍钉住三个有意保持惰性的角落。
- 小队模板首次发布是 0.1.0，因为 `service.publish` 拒绝与 `getPublishSuggestion` 不一致的版本号。改它是平台决定，不是小队决定。
- 伴侣同步写入的会话模板绕过了表的写入器，所以同步处理器自己宣布应用了的行，输入框订阅它。没应用任何行的拉取保持沉默。
- 分享查看器用「原生壳，或页面 origin 不等于分享端点」判断自己是否在应用内，失败即关闭，绝不只看 `isTauri()`，因为浏览器在这里是一等的壳。
- `ctx.commands` 暴露给前端与混合插件。Python 插件还需要宿主请求路由器里的一条路由，暂缓。
- 有意暂缓：868 个叶子的 `agentTeamsWorkspace` 命名空间拆分、`/issues` 与小队共用一块看板、`verified-fresh-agent`、面向 Agent 的模板与小队 sidecar 工具、备份分享链接的 PII 门。

## 修订

- **ADR-0100**：目录新增第七个仅目录域 `chatTemplate`，插件接缝从只能创建扩大为自有生命周期。
- **ADR-0140**：store 里已死的工作区 UI 状态簇被移除。`activeTeamId`、`displayMode`、`workspaceTab` 因 persist 仍携带而保留，在类型上标注惰性并由测试钉住。
- **ADR-0037**：两种新分享类型，以及查看器上第一个应用内导入动作。
- **ADR-0155**：新增能力模块 `commands` 与两个权限。
