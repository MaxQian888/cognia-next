---
title: "0181 — 用户暂存的，就是模型读到的"
description: "选中的文字、工具结果、之前发过的输入、成段的多条消息，都走 ADR-0157 建好的同一条暂存路径进入对话。应用自己附加的上下文放进一个带标记的信封，转录能把它原样取出；生成的回答以「来源的摘录」暂存；多条消息合成一个引用块；手机拿到同样的操作；配对设备向主机要它没同步到的历史。"
---

# ADR 0181 — 用户暂存的，就是模型读到的

**Status:** Accepted
**Date:** 2026-09-15
**Related:** [ADR-0157](./0157-references-and-result-reuse)（本文所依托的注册表与暂存路径）、[ADR-0093](./0093-selection-toolbar-content-hugging-window)（系统级划词工具栏，会话内胶囊沿用了它的动作与语言列表）、[ADR-0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version)（两条新命令遵循的命令语法）

## 背景

[ADR-0157](./0157-references-and-result-reuse) 让所有 `@` 命名空间共用一份注册表和
一条暂存路径。2026-09-14 对「把东西带进对话」的各种方式做了一次审计——选中的文字、
工具结果、之前的输入、一次多条消息、以及对上述任意一项的总结——结论是：路径本身没问题，
路径周围几乎处处漏。

**暂存的上下文并不总能送达。** 首页输入框只有在会话已经存在时才构建引用块，于是第一条
消息之前暂存的引用块会在发送前被清空。发出去的那段引用块又被原样写进了用户消息文本，
而且没有任何地方会把它剥掉：气泡、编辑、引用、搜索、即时标题，乃至 `@msg:` 自己，都把
`Referenced context: …` 当作用户亲手敲的字。网页搜索结果和审查回执也是这样拼在前面的
（`User question:`）。回复引用行在 sidecar 路径上能到达模型，但独立 BYOK 引擎是从已保存
的消息重建历史的，那一行永远到不了。

**在对话里选中文字什么也做不了。** 系统级划词工具栏
（[ADR-0093](./0093-selection-toolbar-content-hugging-window)）作用于其他应用。在转录里
选中的一段话，除了复制别无他用。

**没有办法同时处理多条消息。** 引用、总结、存为记忆都只能一条一条来。

**手机上一样都没有。** 长按会弹出操作面板，同时还会选中手指下的一个词，系统复制菜单
压在面板上面。

**配对设备只在碎片里搜索。** 伴侣同步只拉取每个会话最近的一段。`@msg:`、`@prompt:`
和 `^` 搜的是设备自己的索引，所以人们想引用的那段较早的历史大多不在，从别处挑中的记录
也暂存不了。

总结另有两个毛病：没有配置 BYOK key 时，分支对话框会一声不响地退回到结构化摘要；这条
路径上也没有任何东西经过 PII 闸门。

## 决定

### 1. 应用附加的上下文装进一个带标记的信封

应用在用户这一轮前面附加的所有内容——审查回执、引用块、网页结果——都放进文本开头的
同一个信封：`<cognia_context_NONCE>` … `</cognia_context_NONCE>`
（`lib/chat/prompt-preamble.ts`）。nonce 每一轮随机生成，所以被引用的文档里恰好出现
闭合标签，也提前结束不了这个块。

信封**保留在持久化文本里**。独立引擎从已保存的消息重建历史，如果只把这个块挪进元数据，
第一轮之后的每一个 BYOK 轮次都会丢掉上下文。取而代之的是：所有读取用户文本的地方都会
剥掉它（`stripPromptPreamble*`），包括气泡、编辑、引用、复制、搜索投影、即时标题、
`@msg:`、`@prompt:`、记忆回填、导出、房间和小地图等。`metadata.promptPreamble` 只记录
信封里装了什么（分区类型和引用标题，从不含正文），气泡把它渲染成一张折叠的
「附带 N 个引用」卡片。

无论会话是否已存在，输入框都会构建信封；引用记录随这一轮一起走
（`ComposerTurnMetadata`），而不是放在按会话划分的 store 槽位里，所以从首页输入框发送
也能保住引用块。同一条记录暂存两次，会原地替换先前那个引用块
（`contextSelectionIdentity`）。回复引用行根据 `metadata.replyTo` 重建，放在每一条发给
模型的消息前面（`withReplyContextLines`），独立引擎读的正是这些消息。

### 2. 在对话里选中一段话会弹出胶囊

消息列表内的一次 `selectionchange`——鼠标、键盘、触摸都一样——会在选区旁弹出一个小胶囊，
包含 **引用**、**开旁支追问**、**总结**、**解释** 和 **翻译**。选区至少三个字符；如果
含有汉字、假名或谚文，两个字符即可，因为两个字就是一个词。

**引用** 暂存一个普通的 `message` 实体，附带 `excerpt`（`derivation: "quote"`）。
**开旁支追问** 会打开工作台旁支，并把这段话以引用形式放进旁支输入框。三个生成类动作
以流式写入内联结果面板，回答可以复制，也可以引用。

### 3. 生成的回答是来源的摘录，而不是新文本

总结、解释或翻译同样暂存为 `message` 实体，设置 `excerpt.derivation`，并在
`excerpt.quote` 里保存原始选区。提示词块会说明这段文字是应用根据用户所选内容生成的，
并列出对应的消息，模型因此不会把译文当成用户原话，也不会把应用写的总结当成引文。

新鲜度对照的是来源，不是回答：只要原引文还出现在消息里，暂存的摘录就是**最新**；
不再出现就是**已改动**；消息不在了就是**已消失**。重跑一遍模型来判断，要花掉一轮调用，
而且根本回答不了这个问题。

生成时，有用户自己配置的模型就用它，没有就用 headless-turn 客户端
（`buildAgentBackedLlmClient`）。一次处理不下的材料会分段总结再合并
（`lib/ai/generation/summarize-material.ts`，每段 24 000 字符）。任何调用之前，每一段都
先经过 `hasNoLeakingPii`。完全没有模型时，面板会直接说明，不会悄悄退回到摘要。

### 4. `@prompt:` 就是用户自己的话

它和 `@msg:` 分成两个命名空间，因为人们拿旧输入做的事都围绕那些字本身：引用，或者再发
一次。只有当 `resolveMessageSpeaker` 在一条 `user` 消息背后找不到别人时，这一行才算数——
IM 连接器和共享会话会把别人的消息也存成这个角色。正文是去掉信封后的输入文字。候选项带有
`insertText`，所以 ⌥↵（或者行上的插入按钮）会把这些字放回草稿，不暂存任何东西。

### 5. 多条消息是一个模式、一个引用块

「多选消息」（消息操作，或行首复选框）把列表切换到多选模式。点击勾选；Shift 扩展范围；
⌘A 全选；Esc、退出按钮、取消勾选最后一条、Android 返回键都会退出。只有挂载了这个模式的
列表才提供它（`TranscriptSelectionHostContext`），所以用同一个消息组件渲染的只读转录
永远不会出现这个操作。

悬浮栏提供 **引用**、**总结**、**复制** 和 **存为记忆**。引用会按转录顺序构建**一个**
合并引用块，去掉重复项，每条成员单独截断；引用块列出成员，任何一条都可以单独移除。
只剩一条可读消息时，它退化为普通的消息引用，与用 `@msg:` 挑选完全一致。总结把消息作为
独立片段交出去，所以分段总落在两条消息之间，除非单条消息本身就超过一段。存为记忆只写
**一条**记忆，每段都标上说话人；来自第三方的段落会让这份草稿以 `external_agent` 归档，
记忆层会把它视为不可信内容。

### 6. 手机拿到同样的操作

长按面板新增 **多选消息**（进入同一个模式）和 **选择文本**：后者在一个面板里打开这条
消息，文字可以自由选择，下方是引用、总结、解释和翻译。什么都没选时，这些操作作用于整条
消息。长按区域不再选中文字。手机上没有旁支：旁支开在桌面端工作台的停靠栏里，手机外壳
没有这个停靠栏。

桌面胶囊和手机面板走同一个 hook（`useMessageSelectionActions`），所以无论在哪一端引用
一段话，得到的都是同一个引用块。

### 7. 配对设备向主机要历史

伴侣设备通过 desktop-write 桥上的两条只读命令，把 `@msg:`、`@prompt:` 和 `^` 路由到
主机。主机用自己输入框运行的同一套本地读取来回答（`localHistoryReference`）：

- `session_reference_search` —— 某一类记录针对一个查询的候选项，附带输入框所在的
  工作区和会话。
- `session_reference_snapshot` —— 按 id 取记录：总是返回指纹，按需返回正文。一个含
  十二条消息的引用块，过期检查只需往返一次。

路由依据的是主机配置档（`mobile-companion` 或 `cloud-companion`），而不是
`!isTauri()`：独立浏览器自己的数据库就是它的历史，headless brain 本身就是主机。主机
答不上来时，搜索退回到设备上的副本，选择器会说明列表不完整。正文只有在副本里有这条
记录时才退回，因为「这里没有」不等于「已删除」。指纹永远不退回：副本算出的摘要不是
主机的摘要，所以这次检查失败，引用块保持原状。

## 与计划的偏差

- 两条命令原计划叫 `chat_reference_search` 和 `chat_reference_snapshot`。契约生成器按
  名称前缀把每条命令归入一个主机类别，而 `chat_` 不属于任何类别，所以最终是新资源
  `session.reference` 下的 `session_reference_*`。
- `@prompt:` 是在远程方案写好之后才上线的；它读的是同一份历史，所以和 `@msg:`、`^`
  一起路由到主机。
- 多选悬浮栏多了一个计划里没有的 **复制**。

## 影响

- 持久化的用户文本不再等于输入的文字。任何新增的消息文本读取方都必须经过
  `stripPromptPreamble*` 或 `extractText`，否则信封会再次出现在用户面前。
- 来源的改动即使无关紧要，暂存的摘录也可能变成**已改动**（重新排版不算改动，换了措辞
  就算）。这正是「这还是当初说的话吗」的诚实答案。
- 契约里多了两条伴侣命令。早于它们的主机会拒绝调用，设备把它当作普通失败处理：
  列表不完整，并如实说明。
- 手机的选择文本面板显示的是用户消息里输入的文字。某个渲染成文字但并非用户输入的部分
  （比如视频的描述块，等它合入之后）需要像编辑和引用那样在这里排除。

## 考虑过的替代方案

**把引用块从文本里完全移到元数据。** 否决：独立引擎从已保存的消息重建历史，第一轮之后
的每个 BYOK 轮次都会丢失上下文。

**重跑动作来检查生成摘录是否过期。** 否决：每次检查都要一次模型调用，而且新回答与旧
回答不同，并不能说明来源变了没有。

**把全部历史同步到配对设备。** 否决：只同步最近一段是有意为之的下载上限，而引用恰恰是
「问一次主机」胜过「处处存一份」的场景。

**每条选中的消息一个引用块。** 否决：一个意图十二个引用块，移除「这次选择」要点十二下。

## 实现

正确性：`71398c31d`、`c3c449512` —— `lib/chat/prompt-preamble.ts`、
`components/chat/message-parts/prompt-preamble-card.tsx`、
`lib/chat/turn-metadata.ts`、`lib/chat/mentions/{selection-citations,selection-identity}.ts`、
`lib/chat/reply-to.ts`、`lib/ai/generation/summarize-material.ts`、
`lib/chat/search/indexer.ts`。

胶囊与 `@prompt:`：`9eca81ea6`、`a768baf79` ——
`components/chat/message-selection-toolbar.tsx`、
`components/chat/message-selection-result-panel.tsx`、
`lib/chat/selection/{selection-text,message-excerpt,run-selection-action}.ts`、
`hooks/chat/use-selection-action-run.ts`、`lib/chat/mentions/prompt-reference.ts`。

多条消息：`bd8e831a8` —— `hooks/chat/use-transcript-selection.ts`、
`components/chat/transcript-selection-bar.tsx`、
`lib/chat/selection/{message-set-reference,transcript-selection}.ts`、
`lib/chat/save-message-as-memory.ts`。

手机：`ae86c7814` —— `components/mobile/chat/{message-action-sheet,message-text-selection-sheet}.tsx`、
`hooks/chat/use-message-selection-actions.ts`、
`components/chat/floating-action-bar.tsx`、`hooks/ui/use-back-dismiss.ts`。

配对设备：`80ac1665f` —— `lib/chat/mentions/{host-references,host-reference-rpc}.ts`、
`lib/chat/mentions/entity-sources.ts`、`lib/companion/desktop-write-source.ts`、
`protocol/companion-commands.json`、`src-tauri/src/companion_api/rpc/data_sync.rs`。

验收时未验证：真实模型的流式回答（开发环境没有模型）、Capacitor 外壳里的手机流程、
以及对真实配对主机的引用搜索。
