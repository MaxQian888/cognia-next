---
title: "0018 — GitHub Delivery"
description: "把 AI 驱动的 PR 审阅、Issue → PR 闭环、Release 自动化收编到 cognia 可视化 Workflow 里。"
---

# ADR 0018 — GitHub Delivery

**Status:** Accepted — revised 2026-08-13.

**Current shipping boundary.** The former privileged, auto-enabled delivery
stack was removed on 2026-07-28: its dedicated Settings section,
`/github-delivery` board, direct connector, and plugin-owned privileged Git
workspace implementation do not ship. The optional frontend plugin at
`plugins/github-delivery/` does ship through the Marketplace Integration and
workflow bridges described by ADR-0026. It is discoverable but requires an
explicit user enable; it is never startup-activated. Its HTTP providers,
normalizer, actions, projections, and workflow aliases run on supported
integration hosts. Tauri is fully supported. Browser, mobile, and headless are
degraded because `runIssueLoop` uses the host-owned local Git workspace and is
therefore explicitly desktop-only. The remaining generic seams include
`lib/github/pr-observe/` and `lib/github/workspace-backend-registry.ts`.

The historical sections below describe the original delivery design. They are
decision history, not a claim that the removed privileged UI or connector stack
still ships; the optional plugin boundary above is authoritative.
**Date:** 2026-05-12
**Branch:** `feat/github-delivery`

> **编号说明.** 该 ADR 在初次落地时使用过 `0012-github-delivery.md` 的临时编号,
> 与既有的 `0012-transport-abstraction.md` 冲突。当前编号 **0018** 是规范化后的最终编号,
> 内容与原文一致(仅标题行升级)。后续引用请使用 ADR-0018。

## Context

cognia-next 已经具备四个稳定子系统 —— 可视化工作流编辑器(38 种节点,schema v22)、插件运行时
(13 个扩展点)、调度器(8 类执行器)以及 ConnectorBus(5 个平台适配器),但没有一种官方手段
来"在 GitHub 上做事"。我们的 `.github/workflows/` 下虽然有 CI 配置,客户端却无法参与到 PR 评审、
Issue 分诊或发布自动化里去 —— 哪怕针对自己正在开发的同一个仓库。

**目标:**用户在可视化 Workflow 里把 **PR 自动审阅 + Issue → PR 闭环 + Release 自动化**
组装起来,跑在 cognia 已有的原语之上。任何机器人动作都要经过策略门、写审计、并在与平台消息同源的
Inbox 里露面。

**不在本 ADR 内:**CI/CD 编排(lint / test / build / deploy 继续留在 GitHub Actions);
通用的 GitLab / Gitea 适配器;cognia 自托管的 token-exchange 服务。

## Decision

GitHub Delivery 由 **薄核心层**(`lib/github/`)+ **插件外壳**(`plugins/github-delivery/`)
组成。插件向工作流注入 13 个 `action.github.*` 节点执行器、一个 webhook 触发器、一个轮询任务、
一个写入 Inbox 的连接器适配器,以及 Settings 下的 5 个子 Tab。Rust 侧只新增一项:在现有的
webhook 接收器上加一个 `signatureMode: "github"`,让 `x-hub-signature-256` 头复用同一套校验路径。

### 架构

```
plugins/github-delivery/
├── plugin.json            — 声明 4 张 Dexie 表 + 1 个连接器
├── src/index.ts           — 插件入口,注入 runtime + 适配器
├── src/connector/         — Inbox 桥(ghEventToInbound)
├── src/adapter/           — PlatformAdapter 实现 + conversationKey 编解码
├── src/approval/          — HITL 草稿桥(draft-bridge)
├── src/drivers/           — sidecar-driver(M5 Issue→PR 用)
└── src/workflow/
    ├── runtime.ts         — GithubRuntime 单例
    ├── shared.ts          — guardedExecutor() 工厂
    ├── nodes.ts           — 13 个 action.github.* 执行器
    ├── issue-loop.ts      — Issue → PR 主流程
    └── review-pr-inline.ts — 行级 PR 评审 LLM 代理

lib/github/
├── types.ts               — GhRepoEntry / GhPolicy / GhAction / GhAuditEntry / …
├── octokit-factory.ts     — App + PAT 路由,挂 throttling / retry 插件
├── auth-app.ts            — installation token 缓存(提前 5 分钟刷新)
├── auth-pat.ts            — PAT 鉴权封装
├── webhook-verify.ts      — 常量时间 HMAC-SHA-256
├── event-normalizer.ts    — webhook + polling → NormalizedGhEvent
├── policy-gate.ts         — 6 类 action 的统一策略门
├── workspace.ts           — 基于 simple-git 的工作树(local + e2b 后端)
└── changelog.ts           — Conventional Commits → semver bump + 笔记

src-tauri/src/workflow/triggers/webhook_router.rs
└── SignatureMode { Cognia | Github } — 头部约定开关
```

### 插件 Dexie 表(4 张)

github-delivery 是 M0 "Plugin Dexie Tables" 平台特性的第一个用户。声明如下:

| 逻辑名       | 实际存储                     | 用途                               |
| ------------ | ---------------------------- | ---------------------------------- |
| `repos`      | `github-delivery:repos`      | 每仓配置(App/PAT、push 目标、策略) |
| `workOrders` | `github-delivery:workOrders` | Issue → PR 闭环的状态机            |
| `events`     | `github-delivery:events`     | webhook + polling 投递去重         |
| `audit`      | `github-delivery:audit`      | 每一次策略决定(允许 + 拒绝)        |

### 凭据(D5/D6)

按仓选择两种凭据模式:

- **GitHub App**(推荐)。5K 次/小时,按 installation 隔离,每个 installation 有独立审计。
  App 由用户自己创建;cognia 不托管共享 App,也不持有其私钥。
- **Personal Access Token**(快速上手)。配置更简单,绑定到具体的人。适合个人仓库和试运行。

两者都通过插件的 secrets API 存放(桌面端走 OS keyring、Web 端走加密 blob)。App installation
token 由 `@octokit/auth-app` 铸造,按 `(appId, installationId)` 缓存,**提前 5 分钟刷新**,
让调用方永远看不到 401。

### 触发器(D2)

- **Webhook(默认)。** `trigger.github.webhook` 在 Rust axum 接收器上注册路径。校验逻辑读取
  `x-hub-signature-256`(签名模式 = `github`)。用户粘贴公开 URL;一键 cloudflared 在 M4 上线。
- **Webhook only (superseded 2026-07-16).** The unintegrated polling prototype was removed;
  inbound events now use the Rust webhook receiver exclusively.

两路最终都吐出同一个 `NormalizedGhEvent`,下游只面对一种形状。

### 策略门(D8)

任何机器人产生的写操作都要走 `checkPolicy(action, ctx)`。默认值(可在仓库级或工作流节点级覆盖):

- `requireGreenCi: true` —— CI 不为 `success` 不允许 merge。
- `requireHumanApproval: true` —— merge + 非草稿 release 必须人审批。
- `maxDailyMerges: 5` —— 机器人每 UTC 日 merge 不得超过此上限。
- `branchProtection: ["^main$", "^master$", "^release/"]` —— 这些分支永远不能直推。
- `allowedAuthors: { kind: "collaborators" }` —— 只对仓库 collaborator 的 PR/Issue 动手。
- `quietHours?` —— 复用 `lib/connectors/outbound-runner` 的安静时段工具函数。

每一个决定(允许 + 拒绝)都会写进命名空间下的 `audit` 表,附带完整的 `GhAction` 判别式
和 `runId` / `stepId` 上下文。

### 工作流节点分类(13)

每个 `action.github.*` 执行器都是一个被 `guardedExecutor`(策略 + 审计)包起来的 Octokit 调用。

| 节点                              | Octokit endpoint                        | 策略 action |
| --------------------------------- | --------------------------------------- | ----------- |
| `action.github.openPr`            | `POST /pulls`                           | `push`      |
| `action.github.closePr`           | `PATCH /pulls/{n}` state=closed         | `close`     |
| `action.github.mergePr`           | `PUT /pulls/{n}/merge`                  | `merge`     |
| `action.github.reviewPr`          | `POST /pulls/{n}/reviews`               | `comment`   |
| `action.github.reviewPrInline`    | `POST /pulls/{n}/reviews` + inline 评论 | `comment`   |
| `action.github.commentPr`         | `POST /issues/{n}/comments`             | `comment`   |
| `action.github.commentIssue`      | `POST /issues/{n}/comments`             | `comment`   |
| `action.github.labelIssue`        | `POST + DELETE /issues/{n}/labels`      | `label`     |
| `action.github.closeIssue`        | `PATCH /issues/{n}` state=closed        | `close`     |
| `action.github.createRelease`     | `POST /releases`                        | `release`   |
| `action.github.generateChangelog` | `GET /compare/{base...HEAD}`            | n/a(只读)   |
| `action.github.pushTag`           | `POST /git/refs`                        | `push`      |
| `action.github.runIssueLoop`      | clone → AI → push → openPr              | `push`      |

`runIssueLoop` 依赖 M5 的 Claude Code 子进程集成,M0..M4 期间会抛出一个友好的
"M5 pending" 错误。

### 内置模板(8)

`lib/workflow/definition/seed-github.ts` 出厂带 8 个可 fork 的模板:

1. **[GitHub] PR auto-review** — webhook → AI review → 提交评审
2. **[GitHub] PR inline AI review** — webhook → 行级 LLM 评审
3. **[GitHub] Issue smart triage** — webhook → AI 分类 → 打标签
4. **[GitHub] Issue → PR loop** — Issue 标签触发 → runIssueLoop
5. **[GitHub] Release: Conventional Commits** — cron → changelog → 草稿 release
6. **[GitHub] Release: continuous** — PR 合并 → 打 tag → release
7. **[GitHub] Release: manual** — 手动点击 → release
8. **[GitHub] CI failure diagnosis** — check_run 失败 → AI → 评论到 PR

### UI 入口

- **Settings → GitHub Delivery** — 5 个子 Tab(Repos / Credentials / Policies / Audit / Usage),
  URL 反映为 `?section=github-delivery&ghTab=...`。
- **独立页面 `/github-delivery`** — 基于 `workOrders` 表的 6 列看板。
- **Inbox**(M4 之后)—— 带 PR/Issue 上下文的事件(review_requested / assigned)出现为
  `InboundMessage`。

### Rust 侧改动(最小)

`src-tauri/src/workflow/triggers/webhook_router.rs`:

- 在每个 `WebhookEntry` 上新增 `SignatureMode` 枚举(`Cognia` | `Github`)。
- `verify_hmac_signature` 改为读 `mode.header_name()`:`cognia → x-signature-256`,
  `github → x-hub-signature-256`。
- `workflow_register_trigger` IPC 在 `kind == "trigger.github.webhook"` 时隐式选择
  `Github`;若入参显式带 `signatureMode` 字段则继续优先采用,留出前向兼容空间。

## Consequences

**正面**

- 用户自持 App 私钥,cognia 不分发共享 App、也不开 token-exchange 服务。
- 每个动作都经过策略门 + 审计,正则保护的分支 + 每日 merge 上限作为对 AI 失控的纵深防御。
- 8 个模板全部由已注册的 executor 组合而来,开箱即 fork。
- Rust 端的签名模式改动是非破坏性的 —— 现有 `trigger.webhook` 继续走 `x-signature-256`。

**负面**

- 两条凭据通路意味着两套上手流程。Credentials Tab 默认引导用户走 App,但 PAT 仍然保留。
- Web 模式无法跑 webhook 接收器(没有 Rust)。Repos Tab 上有徽标,Settings 也提示"仅桌面"。

**中性**

- 在插件命名空间下新增 4 张 Dexie 表。按 M0 的保留规则,卸载插件时数据默认保留,除非用户
  在 Settings → Plugins 中显式选择"Delete data"。

## M5 / M6 / M7 增量(2026-05-13)

`~/.claude/plans/github-github-majestic-sloth.md` 中记录的方案分三个增量收尾了剩余缺口:

### M5 — Issue → PR 核心闭环(已关闭)

- `IssueLoopDriver` 接上真实实现。`plugins/github-delivery/src/drivers/sidecar-driver.ts`
  (~80 行)向 cognia 现有的 Claude sidecar(`lib/claude/ipc.ts:sendPrompt`)送一条 prompt,
  `cwd` 指向克隆出来的 worktree,sidecar 自带的 cognia-tools MCP server(file / git / shell
  / process / environment)在线上跑。Agent 最终的 assistant 文本从 `system-prompt.ts` 里的
  `<SUMMARY>…</SUMMARY>` 块抽出,作为 PR 主体。
- `lib/workflow/runtime/long-step-runner.ts` 是新加的帮助器,把任意长跑步骤包成 checkpoint
  感知的执行。每次拉新事件落到 `workflowRunEvents`;进程崩溃后重入,`runLongStep` 自动检测
  最近一次 checkpoint 并经 `onResume` 回放状态,使多分钟级的 Claude 跑能渡劫。Orchestrator
  原本的 `resume-controller` 重入路径不变 —— runner 自己处理 resume 检测。
- `lib/runtime/approval-bus.ts` 把 agent-team 的 plan-approval 发布订阅抽成了一个泛型、按
  scope 索引的原语。`lib/ai/agent/plan-approval-bus.ts` 现在是一个 100% API 兼容的薄再导出。

### M6 — HITL 审批 + PR 行级评审(已关闭)

- 当 `policy-gate` 因 `requireHumanApproval` 拒绝时,decision 上挂 `needsApproval: true`。
  `plugins/github-delivery/src/workflow/shared.ts` 里的 `guardedExecutor` 把这种 decision
  路由进 `plugins/github-delivery/src/approval/draft-bridge.ts`,后者向既有的 `connectorDrafts`
  表写一行,然后用 Dexie 轮询阻塞等待。用户在 Inbox 的 `<DraftEditor/>` 上点 Approve / Reject
  / Edit body,工作流步骤带着用户改过的正文继续往下走。重启安全 —— 草稿留在 Dexie 里,bridge
  会复用既有的 pending 行,不会重复开。
- `plugins/github-delivery/src/workflow/review-pr-inline.ts` 替换了"PR auto-review"的快通道。
  LLM 不再吐一条大评论,而是输出结构化 JSON `{ body, comments: [{ path, line, side, body }] }`,
  执行器以 Octokit 的 review API 提交带行级注释的评审。注册为 `action.github.reviewPrInline`;
  模板 1 的快版本和新模板 `wf_builtin_gh_pr_inline_review` 并存。

### M7 — 出站连接器 + E2B 后端 + cloudflared 依赖(已关闭)

- `plugins/github-delivery/src/adapter/github-adapter.ts` 实现了 `PlatformAdapter` 并通过
  插件 connectors bridge 注册(`plugin.json:connectors[]` + `createGithubAdapterForBridge`
  导出)。`action.connector.send` 和 Inbox 的 Composer 现在可以借助跟其他连接器一样的出站队列
  (quiet-hours、circuit-breaker、idempotency)往 PR / Issue 评论。
- `plugins/github-delivery/src/adapter/conversation-key.ts` 为 `gh:owner/repo/<kind>-<n>`
  共享编解码器,inbox-bridge 与出站适配器在路由键上保持一致。
- `plugins/e2b-sandbox/src/workspace-backend.ts` 实现 `E2BBackend`,在该插件 activate 时通过
  `ctx.workspace.registerBackend({ id: "e2b" })` 注册（旧 `setE2BBackend()` shim 已于 2026-08-18 移除）。默认沙盒工厂动态 `import('@e2b/sdk')`;若 SDK 未安装,在克隆点显示
  安装提示而不是在插件激活点崩溃。
- `@tauri-apps/plugin-shell` 加入 `package.json`,Rust crate 加入 `Cargo.toml`,plugin init
  加到 `src-tauri/src/lib.rs`,`tauri.conf.json` 的 shell scope 里给 `cloudflared` 留了一条
  allow rule。`lib/github/cloudflared-tauri.ts` 的动态 import 现在可以正常解析。

## 留待的开放问题

- Usage Tab 里的 30 日图表(M4 仅占位)。
- 实时 GitHub API 配额历史(每隔一段时间快照 `GET /rate_limit`)。

## References

- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [GitHub Apps 概览](https://docs.github.com/en/apps/overview)
- [验证 webhook 投递签名](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [`@octokit/auth-app` README](https://github.com/octokit/auth-app.js)
- ADR-0011 — Workflows subsystem(可视化工作流编辑器 + 运行时)
- M0 plan — Plugin Dexie Tables 平台特性
