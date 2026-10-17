---
title: 源代码管理
description: 基于原生 Rust 后端的 VS Code 形态 Git 面板：65 个 Tauri 命令与 1:1 的 TypeScript 接口、文件系统监听、交互式变基与 sequencer，以及 AI 提交信息、diff 解释与代码评审。
---

# 源代码管理

<Status variant="stable">Stable · ADR-0038</Status>

<TLDR>
  Git 由 Rust 实现（`crates/cognia-git/`），而不是从渲染端 shell 调用出去，并以 **65 个 Tauri 命令**
  暴露，对应 `lib/git/commands.ts` 中 67 个几乎完全一致的 TypeScript 函数 ——
  前后端按 1:1 映射，两端的接口均已接入运行路径。面板（`components/source-control/` 下 51 个组件）
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

设计动机见 [ADR-0038](../adr/0038-source-control-panel)。面板偏好存放在 `AppSettings.gitSettings.panel` —— 本子系统没有自己的 Dexie 表。

## Rust 层就是 Git 的全部

`crates/cognia-git/src/` 中每个文件负责 Git 的一个领域，这种划分使命令接口保持扁平，避免由单个对象承担所有职责：

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

`watcher.rs` 正是面板无需轮询的原因：后端监听仓库并推送变更事件，TS 侧通过 `lib/git/events.ts` 消费。

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

每个助手都拆为「纯提示词构造 + 一次生成调用」，因此其中真正有内容的部分无需模型即可做单元测试。`ai-commit.ts` 导出 `buildCommitSystemPrompt()`、`buildCommitUserPrompt()`、`clampDiff()`（在 diff 进入模型之前按字符预算截断）与 `stripFences()`，而 `generateCommitMessage()`（`lib/git/ai-commit.ts:102`）是唯一接触模型的函数。`ai-explain.ts` 采用同样的形态，对应 `generateDiffExplanation()`。

## Best-of-N 比较与发布

使用 `/best-of-n 2 <prompt>`（也支持 3、4）或仅作用于下一次发送的 composer
chip。共用开始对话框展示已提交基线、不会携带未提交修改的提示，以及可编辑的
新结果分支；已有分支必须显式选择，流程永不 push。`/best-of-n status`、
`cancel`、`pick <candidate>` 操作当前会话最新运行。assistant card 打开
比较 dock，展示进度、agent/model、文件、检查、时长、摘要和成本，未知成本
保持未知。diff 和 changeset 详情只读。

人工选择可提前停止其他尝试，无修改结果不可发布。发布是独立操作：在记录的
head 上创建新 checkout 检查、记录用户审批，再以 stop-on-conflict 仅集成
所选 changeset。Host 守卫也阻止通用 SCM 发布落选者。落选工作区/会话归档
失败可独立重试，不影响发布成功。`bestOfNRuns` 为可重建 Host 投影，透过
Companion sync 提供只读镜像。原生确认期间持续续租，不阻塞候选进展；业务状态
变化需要重新确认。预算耗尽不会覆盖后续显式取消，取消后仍可归档。
参见 [ADR-0230](../adr/0230-best-of-n-attempts-share-a-frozen-base)。

## 相关文档

<Cards>
  <Card title="ADR-0038" href="../adr/0038-source-control-panel" description="源代码管理面板的决策记录" />
  <Card title="集成终端" href="./integrated-terminal" description="应用内的另一处开发者接口面" />
  <Card title="沙箱" href="./sandbox" description="Agent 驱动的仓库操作被限制的地方" />
</Cards>
