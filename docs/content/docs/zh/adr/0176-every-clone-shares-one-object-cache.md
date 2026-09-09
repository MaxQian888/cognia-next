---
title: "0176：每一次克隆共用同一份对象缓存"
description: "裸镜像缓存、凭据策略与 git 执行器合并进一个叶子 crate，cognia-git、cognia-task-workspace 与 src-tauri 共同依赖它。缓存根目录改为进程级绝对路径，克隆预算改为真正杀死子进程而非丢弃 future，受控克隆第一次拥有了缓存。"
---

# ADR 0176：每一次克隆共用同一份对象缓存

**状态：** 已接受
**日期：** 2026-09-09
**修订：** ADR-0150（仓库供给与对象缓存）
**相关：** ADR-0067（Tier-A crate 拆分）、ADR-0026（插件工作区后端）、ADR-0132（Issue 到 PR 执行）、ADR-0144（工作区是工作的单位）

## 背景

本仓库有四处会克隆 git 仓库，而在此之前它们几乎不共享任何东西。

1. `src-tauri/src/github/workspace.rs`，Marketplace 与 Issue 到 PR 的工作区克隆。
   唯一带镜像的一处。
2. `crates/cognia-git/src/repo.rs::clone_repo_guarded`，`git_clone_guarded` 背后的
   受控克隆，插件与 agent 都在用。**完全没有缓存。**
3. `crates/cognia-task-workspace/src/mirror.rs`，它拥有镜像*算法*（URL 归一化、
   缓存路径、新鲜度、参数向量），却没有任何能真正运行它的东西。
4. `crates/cognia-plugin-runtime/src/wasm/installer.rs`，插件安装用的
   `git clone --depth=1`。刻意浅克隆，不在本文范围内。

ADR-0150 已经把镜像算法收拢到一处。真正仍在重复的是它*周围*的一切：缓存根目录、
驱动 git 的编排、以及凭据策略。这些全都住在 `src-tauri` 里。`cognia-git` 是
Tier-A 叶子 crate，够不到其中任何一样。这才是第 2 条存在的全部原因。不是疏忽，
是依赖方向。

2026-09-09 的一次审计在既有实现中找到四个缺陷，每一条都在代码中核实过，而非推断。

### 缓存根目录是相对路径

`mirror_root(base_dir)` 从*工作树基目录*推导缓存位置，而该目录的默认值
`DEFAULT_BASE_DIR` 是**相对**字符串 `"cognia-github-worktrees"`。于是生产环境的
缓存住在进程当前工作目录之下，随其漂移。与此同时垃圾回收扫的是
`mirror_root(None)`，而注入了 base 的调用方写的是 `<base>/.mirrors`，又是另一个
地方。写入方与回收方可以对缓存在哪儿各执一词，结果镜像堆在没人扫的目录里，而扫描
跑在没人写过的目录上。

### 凭据被写死成 github.com

`apply_git_auth_env` 把 `http.https://github.com/.extraheader` 写成了字面量。
GitHub Enterprise 远端只拿到隔离环境而拿不到凭据，表现为
`could not read Username for 'https://...'`，且没有任何信息指出成因。

### 克隆预算并不会让 git 停下来

`clone_repo_guarded` 用 `tokio::time::timeout(budget, exec::run(..))` 来实施预算。
`exec::run` 等待的是 `tokio::process::Command::output()`，而
`tokio::process::Command` 默认 `kill_on_drop(false)`。超时时丢弃这个 future 并不会
杀掉 git。它会让 `git clone` 继续跑，继续往超时分支随后要删除的那个目录里写。
克隆超时了，进程没有。

### 算法的归宿长不出编排

`cognia-task-workspace` 没有 tokio，也不该引入，因为它的 service 本就在
`spawn_blocking` 下被调用。于是编排既不能与算法同住，又不能住在 `src-tauri`，
否则 `cognia-git` 就够不到。它无处可去。

## 决定

### 1. 一个刻意保持同步的叶子 crate

`crates/cognia-git-mirror` 收纳镜像 plan（从 `cognia-task-workspace` 原样搬入）、
唯一的凭据策略、git 执行器，以及驱动它们的编排。
它是一个人人可依赖的叶子，沿用 `cognia-instrument` 的先例。`cognia-git`、
`cognia-task-workspace` 与 `src-tauri` 都携带它，而它谁也不携带。

它是**同步**的。`cognia-task-workspace` 不能长出 tokio 依赖，而两个异步调用方本就
各有 `spawn_blocking` 边界。同步也正是预算能做成真正的 `try_wait` 加 `kill`、而不是
丢弃 future 的前提。

`cognia-task-workspace` 以原有的 `mirror_*` 名字重新导出 plan，因此此前所有调用方
无需改动即可编译。

### 2. 根目录是进程级的绝对路径

`set_root` 只调用一次，位于 `task_workspace::install`，这是两个宿主都会经过的唯一
接缝：桌面壳在 `lib.rs` 启动时，`cognia-server` 在 `bin/cognia-server.rs`。它解析为
`<data_dir>/task-workspaces/mirrors`。

`root()` 的兜底是系统临时目录下的路径，绝不是相对路径。缓存悄悄跟着工作目录跑正是
第一个缺陷的成因，这个错误不值得留出第二次犯的余地。

`base_dir` 参数在 `github/workspace.rs::mirror_root` 中作为**仅供测试的接缝**保留，
并且"缺省"现在就保持缺省，不再折叠进 `DEFAULT_BASE_DIR`。

### 3. 由一个请求对象携带预算

`MirrorRequest` 命名了缓存根、远端、可选凭据、额外 refspec 与挂钟预算。用结构体而不
是第八个位置参数，因为八个位置参数的调用点，正是凭据与 refspec 被互换而编译器毫无
察觉的地方。

预算会抵达镜像发起的每一次 git 调用。一个可能活得比它所服务的请求还久的缓存不是
缓存，是挂起，而让缓存未命中可被承受的那条网络回退路径将永远没机会运行。

### 4. 缓存未命中永远不是错误

镜像路径上的每一次失败都返回"走网络"而不是向上抛：损坏的镜像、拉不动的远端、上次
fetch 之后才在上游创建的分支。每一条的代价是一次慢克隆。一个能让运行失败的缓存，
比没有缓存更糟。

### 5. 受控克隆拿到缓存，但仅限 depth 0

`clone_repo_guarded` 会先试镜像再走网络，但**仅在无 blob 的默认路径上**。传了
`depth` 的调用方要的是*小*克隆，并随之拿到 `--single-branch`。而镜像派生是完整提交
历史，用缓存服务那个请求等于悄悄交回比所要求的更大的东西，而报出来的会是体积后置
条件，不是缓存。在 `depth == 0` 时，镜像的 `--filter=blob:none` 派生与
`guarded_clone_args` 本来做的事完全一致。

这条路径上永不传递凭据。护栏在此之前就已拒绝任何携带凭据的 URL。

### 6. `origin` 是被指名的，不是被假定的

`DerivedOrigin::RealRemote` 把派生检出的 origin 重新指向真实远端，
`DerivedOrigin::Mirror` 则让它留在镜像上。两个调用方想要的恰好相反。为推送而存在的
工作区不能拿本机目录当 `origin`，而受管的源检出从不推送，保留镜像正是让工作树层能在
不接触任何凭据的情况下对私有仓库执行 `git fetch origin` 的原因。搞反了是一个只会在
agent 干完活之后才暴露的缺陷，所以它是一个有名字的参数，而不是一个默认值。

### 7. 网络克隆会杀掉自己起的进程

`exec::run_within` 自己 spawn 子进程、持有句柄，并以 `kill` 加 `wait` 结束预算。调用方
删除半成品目标目录时，删的已经是没人在写的目录。stderr 由独立任务抽干，因为克隆很
啰嗦，而没人读的管道会让 git 阻塞在写上而不是继续推进。`kill_on_drop(true)` 兜住预算
兜不住的情形：整个 future 被取消的调用方或正在关闭的运行时丢弃。

`exec::run` 保留 `classify_failure`，所以源代码管理面板的错误信息没有变化。

## 后果

- 一个仓库就是一份镜像，由工作区克隆与受控克隆共享，桌面端与无头服务器一视同仁。
  同一个仓库的第二次克隆，不会再为第一次已经取回的对象走网络。
- 镜像按年龄回收（30 天未触碰），走 task-workspace 的维护排期，扫的就是每个写入方
  克隆进去的那个根目录。
- GitHub Enterprise 远端现在会拿到按自身 origin 键控的凭据。
- 旧的相对缓存会在维护循环的第一趟里被删除，每进程一次。不迁移：那些镜像本就可以
  重新拉取，而它们所在的路径取决于进程当时的工作目录，所以在别处启动的进程直接什么
  也找不到。只取 `.mirrors`，旁边的工作树是有人还在用的活工作区。删除失败只记日志
  并丢弃，因为缓存清扫绝不能让一次克隆失败。
- 插件安装器的 `--depth=1` 克隆仍然走网络。它刻意是浅的，镜像派生不是它要的东西。
- 工作区克隆的*网络回退*仍然没有挂钟预算。这是未改动的既有行为，不在本文范围内。
  只有它前面的镜像路径是有界的。

## 实现

| 关注点 | 位于 |
| --- | --- |
| Plan（URL、路径、新鲜度、argv） | `crates/cognia-git-mirror/src/plan.rs` |
| 凭据策略 | `crates/cognia-git-mirror/src/credential.rs` |
| 带预算的 git 执行器 | `crates/cognia-git-mirror/src/runner.rs` |
| 编排、根目录、GC | `crates/cognia-git-mirror/src/lib.rs` |
| 启动：缓存根 | `src-tauri/src/task_workspace.rs::install` |
| GC 排期 | `src-tauri/src/task_workspace.rs::reclaim_stale_mirrors` |
| 工作区克隆适配器 | `src-tauri/src/github/workspace.rs` |
| 受控克隆 | `crates/cognia-git/src/repo.rs::clone_from_mirror` |
| 会杀进程的超时 | `crates/cognia-git/src/exec.rs::run_within` |
