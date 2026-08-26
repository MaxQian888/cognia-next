---
title: "0151 — 栈作为一等公民"
description: "一条依赖式 PR 链早就存在于 Agent Team 内部：应用里没有任何写入面、层次靠行的时间戳推断且从不与 git 核对、restack 用的是合并而不是变基。本 ADR 把引擎抽出来，让 git 成为记录，并把它接到本就该有它的五个调用方上。"
---

# ADR 0151 — 栈作为一等公民

**状态：** 已接受
**日期：** 2026-08-26
**相关：** [ADR-0022](./0022-agent-team-runtime-hardening)、[ADR-0038](./0038-source-control-panel)、[ADR-0045](./0045-unified-plan-execution-hub)、[ADR-0132](./0132-issue-tracker)、[ADR-0150](./0150-repository-supply-and-object-cache)

## 背景

栈是一条分支链，每一层基于它下面那一层，作为一条 PR 链发出去，于是每次评审只看到它自己的改动。
这里本来就有一条——`delivery-graph.ts` 有拓扑排序、链式 base 分支、跨仓依赖和自底向上合并——
而它既不可达，又有一部分是假的：

- `githubDeliveryPolicy` 有三处读、**零处写**。应用里没有任何地方能把它打开。
- 层次从 `agentTeamChildRuns.createdAt` 推断，**从不与 git 核对**。一个「栈」可以是三条互不相干
  的分支，而把它发布出去会产出彼此 diff 里静悄悄包含对方工作的 PR。
- restack 用的是 GitHub 的 `update-branch`，那是**合并**。合并不会把一层移到它的父层之上，它只是
  记录了父层发生过。栈在纸面上活着，它的 diff 却不再彼此独立。
- `git_rebase` 与 `--force-with-lease` 两个原语都存在，而这条路径一个都没调用。
- 栈状态按 `runId` 归属，于是 run 结束它就不存在了。

与此同时 GitHub 在 2026-07-30 公开预览了原生 stacked pull requests：服务端 stack 对象、级联
rebase、连续区段合并、合并后自动重指、合并队列的栈感知，以及**按「PR 直接指向 stack base」评估**
的分支保护。

## 决策

**git 是记录。** 一层的父指针存在仓库自己的配置里，键为 `branch.<name>.cognia-parent`。而不是
存在旁边的数据库里：分支是 git 的，另一台机器上的克隆读到的是同一份配置，而一张与 `git log`
不一致的表比没有表更糟。上层一律把自己的存储当作可重建的投影。

**父指针是一个「声称」，而这个声称会被核对。** `merge-base --is-ancestor` 决定一层是否真的包含
它的父层，核对失败即拒绝发布，并返回一个可执行的修复动作而不是一个布尔值。

**restack 是 `git replay --onto --contained`。** 它计算出新提交并打印 ref 更新，全程不碰任何
工作树，于是一次 restack 不会扰动本应用按任务切出的那些 worktree。`replay` 缺席时降级为在临时
工作树里跑 `rebase --onto`，且 git 二进制的能力是运行期探测的，而不是从版本号推断的。

**不用 `rebase --update-refs`。** 它会拒绝更新在另一个 worktree 里被检出的分支——而这恰恰是这里
最要紧的情形，并且它是静默跳过的。

**强推同时带 `--force-with-lease` 与 `--force-if-includes`。** 只有前者时，租约比对的是
remote-tracking ref，而后台的 `git fetch` 已经把它更新过了；后者额外要求本地分支包含 tracking
ref 所指的内容。它是探测出来的，缺席时会明确报出而不是藏起来。

**什么都不会丢。** restack 移动的每条分支，其此前的 tip 会先写入
`refs/cognia/stack-history/<branch>/<毫秒>`，于是一次不想要的 restack 距离撤销只有一条
`update-ref`，且旧提交保持可达。

**本地栈是真相；可用时向 forge 的原生栈注册。** 注册换来的是 forge 自己的栈界面、合并队列的栈
感知，以及按 stack base 评估的分支保护。forge 没有这种对象时，base 分支链承载全部形状、不承载
任何界面——这也正是它此前的状态。

**只有 fork 写权限时诚实拒绝，而不是降级。** PR 的 base 必须存在于目标仓库，而最底层之上的每一层
其 base 都是一条只存在于 fork 里的分支。GitHub 原生栈、ghstack、ejoffe/spr 和 spacedentist/spr
全都不支持。检测到并说出来，胜过产出一个落不了地的栈。

## 调用方

引擎与宿主无关（`lib/stack/`、`crates/cognia-git/src/stack.rs`），带一个 forge 适配器接缝，
五个调用方用它：

- **源代码管理** —— 一个 Stacks 面板：列出、校验、restack、记录或清除父指针、新建一层分支、
  发布整条 PR 链、自底向上合入，以及用 restack 保留下来的旧顶点撤销一次 restack。forge 那一半
  是按需的——不按「发布」或「合入」就不会有任何请求发到 GitHub；而 restack 只在这个栈已经有
  PR（否则那些 PR 会显示已经不存在的提交）时才强推。
- **Agent Team** —— `githubDeliveryPolicy` 的设置开关（默认关）、一个不再把「当前检出的
  分支」当作主干的主干读取，以及发布前的祖先关系校验。
- **工作流** —— 内置 `action.stack.{list,parent,validate,restack,push}`。forge 投递仍属插件
  （ADR-0018/0026）；为了够到它而把 GitHub 凭据放进内置节点集，是错误的取舍。
- **Issue** —— 运行一个关联了 GitHub 的 issue 时，可以把它的 PR 叠加在另一个 issue 的分支上，
  并把父指针记录到本地检出里，于是这条链在面板里是一个栈，而不是三条互不相干的分支。
- **CLI** —— `/stack` 直接调 `git`，写同一个配置键；`/pr` 以记录的父层作为 PR 的 base。

## 后果

**两种创作模型收敛到同一条分支链上——其中一种是惰性的。** 分支即层把父指针放在 git config 里，
所有产出走的都是它。commit-per-PR 会用提交时写入的 `Cognia-Change-Id` trailer 标识一个变更
（不安装任何 git hook）；它被声明出来，是因为它的合并规则确实不同，而对着一个类型不知道的模型
去写规则正是这条规则被忘掉的方式——但没有任何路径创作它。这份惰性在三个轴上都做了标注：类型、
面板，以及 `model.test.ts` 里那个先断言自己扫了多少文件、再报告零调用方的扫描。

**Agent Team 的投递图刻意不是 `lib/stack`。** 两者看着像，其实不是一回事：`Stack` 是单仓库的
一条链，git 是真相、restack 是修法；而投递图是多个仓库加跨仓依赖、把节点状态持久化以便半途中断
的合并能续跑、一道审批闸，以及一个把失败层交回给 agent 的补救循环。把它折进 `mergeStack` 会把
这四样全部丢掉，所以能共享的共享——排序规则、base 链、祖先校验——其余保持原样。

**一串分支在 git 说话之前不算一个栈。** Agent Team 的层次来自按 `createdAt` 排序的
`agentTeamChildRuns`，那只说明谁先完成，与祖先关系无关：两个并行从主干拉出去的 agent 产出的
正是这样一份列表。`assertPublishableStack` 先写下每层意图中的父指针（这同时让这次运行的成果
出现在 Stacks 面板里），再去问 git，并在任何一个 PR 被创建之前就指名拒绝。

**合并对三种合并方式是同一条序列。** 一层合并之后，剩下的部分被 restack 到主干上——这会丢掉被
这次合并吸收掉的提交——然后 push，然后 retarget，顺序就是这个。不需要时它是免费的，需要时它是
正确的。

**返回路由判定的节点必须声明 output handle。** 工作流编排器会跳过「路由键与判定不匹配」的每一条
出边，而一条随手画的边路由键是 `"default"`。于是一个做判定却不声明 handle 的节点，会在图看起来
完全正确的情况下跳过它下游的一切。两个做判定的栈节点都声明了自己的 handle，并有测试钉住。

## 考虑的替代方案

**栈的 Dexie 投影。** 原计划要做，实现过程中被否决：栈的全部内容——有哪些分支、什么顺序、基于
哪个主干——都能从走父指针得出，而 PR 号必须每次向 forge 重新查，因为缓存下来的 PR 号会比「这个
PR 被关掉」活得更久。一张没人读的表只会带来与 `git branch -d`、重命名、别人的 push 之间的不一致。

**ghstack 的合成 base**（`gh/<user>/<n>/{base,head}`）。它无法注册原生栈，且落地必须直推默认
分支、绕过分支保护——上游自 2021 年起未关的投诉。

**自建合并队列。** 它需要常驻服务，而本应用的静态导出托不住（生产环境没有 `app/api/`），而且
原生队列现在已经栈感知。

**非 GitHub 的 forge。** 只建了适配器接缝，并用一个测试里的第二实现证明这个接缝真的可插拔，
而不是声称它可插拔。

## 被实现推翻的前提

- **`git replay` 的默认行为在 git 2.54 翻转了**，从打印 ref 更新变成直接写，而 `--contained`
  随后会移动没人点名的分支。包装层在支持时传 `--ref-action=print`，**并且**无论如何都快照并
  还原 `refs/heads`——因为需要这道保险的那个版本，恰恰是不接受这个 flag 的版本。
- **两个 restack 引擎都会盖上新的 committer 时间**，所以对一个已经对齐的栈做 restack 会把每层
  重写成新 SHA。现在先查祖先关系，已对齐的栈原样不动。
- **rebase 降级路径必须用「移动之前」的父层 tip。** 用已经移动过的父层当 upstream，会把它的提交
  重放第二遍。
- **不在 companion 清单里的命令在界面上是永久禁用的**，即便在它直接可达的桌面端也一样——
  descriptor 的判定发生在「无 client target 即本机」这条分支**之前**。既有审计只查
  descriptor→handler，所以补了一条反方向的通用守卫；它当场就找出两个既有缺口。
