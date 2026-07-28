---
title: 源代码管理
description: 架在原生 Rust 后端之上的 VS Code 形态 Git 面板 —— 65 个 Tauri 命令与 1:1 的 TypeScript 接口面、文件系统监听、交互式变基与 sequencer，以及 AI 提交信息、diff 解释与代码评审。
---

# 源代码管理

<Status variant="stable">Stable · ADR-0038</Status>

<TLDR>
  Git 由 Rust 实现（`crates/cognia-git/`），而不是从渲染端 shell 调用出去，并以 **65 个 Tauri 命令**
  暴露，对应 `lib/git/commands.ts` 中 67 个几乎完全一致的 TypeScript 函数 ——
  这是一处罕见的前后端 1:1 映射，没有任何休眠的半边。面板（`components/source-control/` 下 51 个组件）
  是 VS Code 形态的：按 hunk 暂存、提交图、blame、stash、worktree，
  以及经 `sequencer.rs` 驱动的交互式变基。上层还有三个 AI 助手 ——
  提交信息生成、diff 解释与代码评审 —— 每个都拆成「提示词构造 + 一次生成调用」，
  因此提示词构造无需模型即可测试。
</TLDR>

<StatGrid>
  <Stat label="Rust 模块" value="25" hint="crates/cognia-git/src" />
  <Stat label="Tauri 命令" value="65" hint="crates/cognia-git/src/commands.rs" />
  <Stat label="TS 接口面" value="67" hint="lib/git/commands.ts" />
  <Stat label="UI 组件" value="51" hint="components/source-control" />
  <Stat label="AI 助手" value="3" hint="提交信息 · diff 解释 · 评审" />
</StatGrid>

设计动机见 [ADR-0038](../adr/0038-source-control-panel)。面板偏好存放在
`AppSettings.gitSettings.panel` —— 本子系统没有自己的 Dexie 表。

## Rust 层就是 Git 的全部

`crates/cognia-git/src/` 中每个文件负责 Git 的一个领域，
这正是命令面能保持扁平、而不退化成一个上帝对象的原因：

```
repo.rs        # 仓库发现 + 打开
status.rs      # 工作区状态
stage.rs       # 暂存 / 取消暂存，含按 hunk 操作
diff.rs        diff_stat.rs   # diff 与其摘要
commit.rs      history.rs     # 写入与读取历史
branch.rs      merge.rs       reset.rs      restore.rs
stash.rs       tag.rs         remote.rs     worktree.rs
blame.rs       read.rs
interactive_rebase.rs  sequencer.rs   # 变基 todo 列表 + 进行中的 sequencer 状态
watcher.rs     # 文件系统监听 → 面板刷新
exec.rs        error.rs       types.rs
commands.rs    # 65 个 Tauri 命令
```

`watcher.rs` 正是面板无需轮询的原因：后端监听仓库并推送变更事件，
TS 侧通过 `lib/git/events.ts` 消费。

## 前端模块

```
lib/git/
  commands.ts          # 对 Tauri 命令的 67 个包装
  events.ts            # watcher 事件订阅
  load.ts              # 面板数据加载
  workspace-changes.ts # 多根工作区聚合
  hunk-review.ts       # 按 hunk 的暂存决策
  commit-graph.ts  lane-palette.ts   # 提交图布局 + 泳道配色
  language-map.ts      # 路径 → 语言，用于 diff 高亮
  panel-prefs.ts       # AppSettings.gitSettings.panel
  ai-commit.ts  ai-explain.ts  ai-review.ts
```

## AI 助手首先是提示词构造器

每个助手都拆为「纯提示词构造 + 一次生成调用」，因此其中真正有内容的部分无需模型即可做单元测试。
`ai-commit.ts` 导出 `buildCommitSystemPrompt()`、`buildCommitUserPrompt()`、
`clampDiff()`（在 diff 进入模型之前按字符预算截断）与 `stripFences()`，
而 `generateCommitMessage()`（`lib/git/ai-commit.ts:102`）是唯一接触模型的函数。
`ai-explain.ts` 采用同样的形态，对应 `generateDiffExplanation()`。

## 相关文档

<Cards>
  <Card title="ADR-0038" href="../adr/0038-source-control-panel" description="源代码管理面板的决策记录" />
  <Card title="集成终端" href="./integrated-terminal" description="应用内的另一处开发者接口面" />
  <Card title="沙箱" href="./sandbox" description="Agent 驱动的仓库操作被限制的地方" />
</Cards>
