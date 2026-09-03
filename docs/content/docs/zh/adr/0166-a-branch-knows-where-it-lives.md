---
title: "0166 - 分支知道自己住在哪"
description: "分支与工作树在数据层从未关联，于是分支选择器会对本应用自己创建的工作树所占用的分支照样给出 checkout。关联落在 Rust 层，三个结构性面从溢出菜单收进一个导航栏，面板改为测量自己的窗格而不是窗口。"
---

# ADR 0166 - 分支知道自己住在哪

**状态：** 已接受
**日期：** 2026-09-03
**相关：** [ADR-0038](./0038-source-control-panel)、[ADR-0111](./0111-managed-workspace-registry-and-bundle)、[ADR-0129](./0129-unified-global-search)、[ADR-0144](./0144-workspace-as-the-unit-of-work)、[ADR-0151](./0151-stacks-as-first-class)

## 背景

源代码管理读起来像三个恰好共用一条路由的独立功能。反馈是分支与工作树彼此割裂、面板存在逻辑漏洞、窄屏没有答案。三者同源。

**分支与工作树从未关联。** `GitBranch` 只带
`{name, isCurrent, isRemote, upstream, ahead, behind}`，不知道分支被检出在哪。`GitWorktree`
知道自己的分支，但 store 只存 branches / stashes / conflicts，`lib/git/load.ts`
根本不调用 `gitWorktreeList`。没有关联可用，每一行就只能画同一个 checkout 按钮，然后让 git 去决定。

git 的决定是拒绝：一个已被第二个工作树检出的分支无法再检出。而这些工作树正是本应用自己为隔离运行创建的，分支名形如
`agent/<run>/<teammate>/<task>`（ADR-0111）。于是面板在提供一个它本可以预知会失败的操作，对象是它自己造出来的工作树。同一处缺失的关联还让
`checkout origin/x` 进入游离 HEAD 而不是建立跟踪分支，让删除出现在 git 会拒绝的地方，并且把早已在手的
`ahead`、`behind`、`upstream` 与栈父指针一个都没渲染。

**最结构性的东西最难够到。** 工作树与栈藏在同步工具栏溢出菜单的两层之下，各自弹出一个盖住 diff 的抽屉。分支列表住在挂于头部 chip 的
288px 浮层里。而 fetch 与 pull 这种一键习惯却占着一级按钮。与此同时，`/workspace` 把整个
`SourceControlPanel` 又挂了第二遍。

**没有一处在测量正确的东西。** 面板用 `useMediaQuery("(max-width: 959.98px)")`
分叉布局，问的是窗口，答的却是窗格。嵌在工作区标签页里时，1000px 的窗口会得到一个根本放不下的左右分栏。另外，每个右侧抽屉都从
`components/ui/sheet.tsx` 继承 `sm:max-w-sm`，而 `cn()` 是 tailwind-merge，`w-*` 与
`max-w-*` 属于不同冲突组，所以只写 `w-[40rem]` 的调用方根本删不掉这个上限。blame 与 compare-refs
一直在桌面端以 384px 渲染，和标签列表一样宽，而在另一端又会撑破 375px 的视口。

## 决定

### D1. 分支与工作树的关联落在 Rust 层

`GitBranch` 增加 `checked_out_in` 与 `checkout_locked`，由纯函数 `annotate_placements`
在工作树列表上填充。`git_branches` 本来就是 `async`，因此它先在 `spawn_blocking`
上跑同步的 libgit2 遍历，再做工作树读取。

备选方案是在 store 里做客户端 join。之所以否决：面板不是唯一的消费方，CLI、agent-team
的隔离层与配对 companion 都读这条命令，把 join 放在渲染端等于让它们各自重写一遍或者干脆没有。

工作树读取用 `unwrap_or_default` 而非 `?`。一个不支持 `worktree list --porcelain -z`
的老 git 该付出的代价是失去这条标注，而不是整个面板赖以存在的分支列表。空列表退化为「位置未知」，这恰好就是加这个字段之前的行为。

### D2. 位置决定操作，并且行会说明

`lib/git/branch-placement.ts` 是唯一裁决：`here`、`otherWorktree`、`free`、`remoteOnly`。选择器与
⌘K provider 都读它，所以两者不可能对一行的含义产生分歧。

主操作随之而定：free 分支是 checkout，被别的工作树占用的是**打开那个工作树**，remote-only 的是
`checkout -b x origin/x`。删除只在 git 会接受的地方出现。

位置从 `isCurrent` 读取，绝不用 `rootDir` 与工作树路径做比较。跨 companion 时这是两套坐标系：面板的
root 是不透明的 `git-workspace:<id>` 目标，而工作树路径是工作区相对路径；即便在本机，两者在符号链接下也会不一致。

### D3. 两种 git 拒绝变成问题而不是死路

`BranchCheckedOutElsewhere` 与 `BranchNotFullyMerged` 加入 `GitError`，在
`classify_failure` 中排在冲突分支之上，因为两条 stderr 都不含 "conflict" 一词。`useGitActions`
不再对调用方会转成下一步的 kind 弹 toast，于是一个对话框和一条 toast 不会再把同一次失败报告两遍。

**已知边界：** `companion_api/rpc/source_control` 用 `RpcError::internal(e.to_string())`
把每一种 git 失败压平，所以 `kind` 无法穿过配对传输，这些路径在那里退回 toast。此处只记录，不修。

### D4. 一个导航栏，源代码管理离开工作区标签页

仓库、工作树、分支、栈属于同一份层级清单，这也是 VS Code、Fork、Sublime Merge
的共同做法：它们是你**在其间移动**的东西，而不是你**做**的事。面板新增 Browse 视图容纳三者，复用
`WorkspaceEnvironmentList`、`BranchPicker` 与抽出的 `StackList`，而不是长出任何一个的第二份副本。区块只在展开时读取，因为这一列的寿命长过旁边 diff 的每一次渲染。

`/workspace?tab=source-control` 下线。它把 `FeaturePageHeader` 塞进了
`FeaturePageShell`，并且把一个单仓库面板绑在了一个以工作区为工作单元（ADR-0144）、可以拥有多个根的页面上。标签条保留一个外链，旧深链做重定向：撤掉一个面却不留下入口，正是一个功能变得不可达的方式。`?tab=environments`
原样保留，仍是同一份清单的工作区视角。

### D5. 面板测量自己的窗格，紧凑档测量屏幕

`SOURCE_CONTROL_DENSE_WIDTH`（960）是**窗格**宽度，经 `useElementWidth`
读取，决定面板如何排布自己。`useCompactLayout`（768px 或原生壳）是**屏幕**问题，决定挂哪个 body。两档都保留，各自命名，把区别写下来。

`0` 表示「尚未测量」，按宽处理。当作窄会让每次挂载都先堆叠一帧再弹回并排，在最宽的屏幕上就是一次可见的闪烁。

### D6. 每个右侧抽屉都是 `w-full sm:max-w-*`

绝不写裸宽度，因为基础的 `sm:max-w-sm` 会存活下来。由一个解析 `<SheetContent>`
标签的门禁钉住，并先断言标签数量下限，这样一次什么都没匹配到的扫描不会空转通过。

### D7. ⌘K 能找到分支与工作树，且从不检出

两个 provider 同步读 store，`cache: false`。提交与栈刻意不索引：provider
每次击键都会跑，`git log` 搜索是时间线过滤器的职责，而栈没有人会去打的名字。行导航到
`/source-control?root=`，因为从一次模糊匹配触发工作树切换是命令面板能产生的最坏结果。

## 后果

`git_worktree_list` 一直在每个 companion 上返回 `contract_output_violation`，因为它的响应
schema 在 `additionalProperties: false` 下只声明了 Rust 序列化的八个字段中的四个。修它是读取工作树的前提，而它本身就是一个与本次工作无关的线上 bug。

fs watcher 从不匹配 `.git/worktrees/`，所以 `worktree add --detach`、`lock`、`unlock`、`prune`
都不发刷新。在没有任何东西渲染工作树时这尚可容忍，一旦分支开始携带占用它的工作树就不再可以。

给 `GitBranch` 加字段会移动 `HEADLESS_CATALOG_HASH`，而桥接握手会比对它。这是本分支上任何契约变更的常规代价，不构成把关联留在渲染端的理由。
