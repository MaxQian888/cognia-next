---
title: "0010 — Claude 订阅 OAuth + 用量追踪"
description: "Cognia-NEXT 获得了一流的Claude Pro/Max OAuth登录支持、sidecar持有令牌注入以及基于统一响应首部的实时5小时/7天速率限制可视化。"
---

# ADR 0010 — Claude 订阅 OAuth + 用量追踪

**状态：** 已接受 — 存储和多账户部分 **已被[ADR 0025](/docs/en/adr/0025-unified-subscription-module)**取代。使用跟踪流水线（`parser.ts`、`usage-collector.ts`、`usage-probe.ts`、`subscriptionUsage` Dexie表）**保持规范**，是唯一有意被排除在统一模块之外的人类专用位。**日期：** 2026-05-06（2026-05-18修订，与ADR 0025同时）**分支：** `feat/claude-subscription-oauth`

---

## 背景

直到本ADR，cognia-next 的 Anthropic 集成严格基于**API-key：渲染器写入`apiKey`给IndexedDB，Rust壳在生成sidecar时将其转发为`ANTHROPIC_API_KEY`，这就是整个认证故事。Pro/Max 订阅者——Anthropic 最有价值的个人用户——无法（a）用订阅令牌登录，（b）查看他们距离 [Anthropic 于 2025-07-28](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/) 激活的 5 小时滚动窗口或 7 天每周上限有多近。

已有两个CCSwitch-style生态系统解决了该问题的变体：[Leu-s/CCSwitch](https://github.com/Leu-s/CCSwitch)解析统一速率限制头，[zach-source/ccswitch](https://github.com/zach-source/ccswitch)管理OS-keyring 凭证生命周期，[Claude Code CLI](https://code.claude.com/docs/en/authentication)定义针对`claude.ai`的规范`claude login` OAuth流。我们借用了机制，但在此阶段严格保持**单账户**——多账户自动轮换推迟到ADR 0011。

---

## 决策

### 架构概述

```
┌──────── Frontend (React) ─────────────────────────────────────────┐
│                                                                    │
│  components/settings/subscription/                                 │
│   ├─ subscription-section.tsx     Tabs shell (?subTab=)            │
│   ├─ tabs/{overview,account,                                       │
│   │       usage,settings}-tab.tsx                                  │
│   └─ login-dialog.tsx             paste-the-code OAuth flow        │
│                                                                    │
│  lib/anthropic-subscription/                                       │
│   ├─ constants.ts        endpoints + client_id + required headers  │
│   ├─ oauth.ts            buildAuthorizeUrl / exchange / refresh    │
│   ├─ credential-store.ts Tauri-only keyring façade                 │
│   ├─ sidecar-sync.ts     pushes the bearer to Rust                 │
│   ├─ parser.ts           unified-* header → UsageSnapshot          │
│   ├─ usage-collector.ts  drains sidecar events → Dexie             │
│   ├─ usage-probe.ts      optional active probe                     │
│   ├─ scheduler.ts        visibility-aware probe loop               │
│   └─ hooks.ts            React hooks (credential / usage / signOut)│
│                                                                    │
│  components/providers/subscription-usage-provider.tsx              │
│   └─ Mounted in app/layout.tsx — drives the passive collector      │
│                                                                    │
│  sidecar/                                                          │
│   ├─ fetch-interceptor.mjs   patches globalThis.fetch — emits      │
│   │                          `usage_headers` for every             │
│   │                          api.anthropic.com response            │
│   └─ claude-host.mjs (top)   imports the interceptor BEFORE the    │
│                              Claude agent SDK                      │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌──────── Tauri Rust ───────────────────────────────────────────────┐
│                                                                    │
│  src-tauri/src/anthropic_subscription/                             │
│   ├─ credential.rs    OS keyring (com.cognia.claude-subscription/v1)│
│   └─ commands.rs      claude_sub_save_token / load / clear         │
│                                                                    │
│  src-tauri/src/api_key.rs                                          │
│   └─ adds `oauth_bearer` field. spawn() prefers OAuth over API key │
│      and injects `CLAUDE_CODE_OAUTH_TOKEN` env so the official     │
│      claude-agent-sdk picks it up natively.                        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### OAuth流

Pro/Max 流和 Console（API-billing）流共享**相同的公共client_id** `9d1c250a-e61b-44d9-88ed-5944d1962f5e`（[anthropics/claude-code#39445](https://github.com/anthropics/claude-code/issues/39445);关于它们不同的误解——以及 [ben-vargas/claude-code-sdk_oauth](https://gist.github.com/ben-vargas/c7c7cbfebbb47278f45feca9cef309d1) 中的变通方法——在同一个讨论串中都有文档）。

| 参数 | 订阅（Pro / Max） | 控制台（API-billing） |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 授权URL | `https://claude.ai/oauth/authorize` | `https://console.anthropic.com/oauth/authorize` |
| 重定向URI | `https://platform.claude.com/oauth/code/callback` | `https://console.anthropic.com/oauth/code/callback` |
| 瞄准镜 | `user:profile user:inference user:sessions:claude_code` | `org:create_api_key user:profile user:inference` |
| 令牌端点（两个流程） | `POST https://platform.claude.com/v1/oauth/token`（表单编码——JSON返回每个[coqu](https://flopsstuff.github.io/coqu/claude-oauth/)]返回400个invalid_grant） |  |
| PKCE | S256 + `state` | 我也是 |
| `code=true` | 强制采用手动代码变体 | 我也是 |

登录对话框是粘贴代码（无本地主机环回），绕过端口分配、防火墙提示和Tauri深度链接注册。`code_verifier`处于对话框的组件状态——无全局存储，取消时无持久化。

### sidecar 头部集（OAuth承载模式）

当`CLAUDE_CODE_OAUTH_TOKEN`设置好时，sidecar的`@anthropic-ai/claude-agent-sdk`会自动发送：

```
authorization: Bearer <oat01-...>
anthropic-version: 2023-06-01
anthropic-beta: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20
x-app: cli
user-agent: claude-cli/...
```

如果没有`oauth-2025-04-20`，Anthropic会回复“OAuth认证目前不支持”（[#37205](https://github.com/anthropics/claude-code/issues/37205)）。没有`claude-code-20250219`+`x-app: cli`，Sonnet/Opus 4系列429 OAuth来电者（[NousResearch/hermes-agent#17169](https://github.com/NousResearch/hermes-agent/issues/17169)）。官方代理SDK为我们编码所有这些信息——我们自己不写。

### 使用跟踪——被动与主动

一个几乎空的`POST /v1/messages`（`max_tokens: 1`，一个字符的用户消息）**被计费**——[Anthropic定价docs](https://platform.claude.com/docs/en/about-claude/pricing)没有最低收费的划分。因此，我们从典型的CCSwitch“每60秒探测一次”模式转向**被动优先**设计：

1. **被动收集**（默认ON，零额外配额成本）：导入代理SDK `globalThis.fetch` _before_ `sidecar/fetch-interceptor.mjs`猴子补丁。`api.anthropic.com`上的每个响应都会触发`usage_headers` stdout事件，渲染器`usage-collector`解析并持续执行。用户每次发送聊天都会获得一个新的样本。
2. **主动探针**（默认OFF，选择加入）：用户在设置→订阅→设置中明确启用，UI行显示“~10个输入 + 每个探针1个输出令牌”。探针经过同一个解析器+收集器流水线，因此两个数据源共享存储和存储和UI。

完整的统一\*头部集我们解析——逐字解析自[anthropics/claude-code#12829](https://github.com/anthropics/claude-code/issues/12829)：

```
anthropic-ratelimit-unified-status                allowed | allowed_warning | rate_limited
anthropic-ratelimit-unified-representative-claim  five_hour | seven_day
anthropic-ratelimit-unified-5h-utilization        0.0–1.0
anthropic-ratelimit-unified-5h-reset              unix-seconds
anthropic-ratelimit-unified-5h-status             allowed | …
anthropic-ratelimit-unified-7d-utilization        0.0–1.0
anthropic-ratelimit-unified-7d-reset              unix-seconds
anthropic-ratelimit-unified-7d-status             allowed | …
anthropic-ratelimit-unified-fallback-percentage   0.0–1.0
anthropic-ratelimit-unified-overage-disabled-reason text
```

这些头项不在Anthropic的公开文档中（只有`anthropic-ratelimit-{requests,tokens,…}-*`家族的遗产文件有）。我们把它们当作有证据支持但没有支持——失败会默默降级为“状态：未知”，而不是让收集器崩溃。

### Schema （v20）

`lib/db/schema.ts`版本20中新增的一个Dexie表：

| 表格 | 说明 | 已索引 |
| ------------------- | --------- | ----------------------------------------------------- |
| `subscriptionUsage` | `localId` | `fetchedAt`，`status`，`source`，`[source+fetchedAt]` |

`lib/anthropic-subscription/usage-collector.ts` 时，排数上限为 1,000 行，最新至先。每个源的 60 秒去反弹（`passive` / `probe`）会使流速突发崩溃。

### 设定（AppSettings.subscriptionSettings）

| 场地 | 默认 | 注释 |
| ------------------- | ------- | ------------------------------------------------------------------ |
| `probeEnabled` | `false` | 主动探针主开关。 |
| `visibleIntervalMs` | 5分钟 | 前景节奏。楼层60多。 |
| `idleIntervalMs` | 30分钟 | 背景节奏。楼层60多。 |
| `warnThresholdPct` | 90 | 概览标签页翻到“接近限制”，超过了这个百分比利用率。 |

### 凭证在OS 密钥环

| 场地 | 价值 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 服役经历 | `com.cognia.claude-subscription/v1` |
| 账号 | `default` |
| 后端 | macOS Keychain / Windows 凭证 Manager / Linux Secret Service，通过`keyring` Rust crate（TTS 已经是一个项目依赖） |
| 网页模式 | 仅Tauri — 会退回到静态的“需要桌面”横幅 |

服务名称被**故意分开**，与Claude Code CLI自身的`Claude Code-credentials`条目分开。Cognia-Next从不写入`~/.claude/.credentials.json`——该文件属于`claude login`，重复写入会与CLI刷新周期竞速。

---

## 权衡取舍

| 权衡 | 我们为什么接受它 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 重复利用Claude Code公共client_id | Anthropic 没有公开的第三方 OAuth 程序。多个开源社区项目汇聚在同一UUID上。 |
| 被动收集至少需要发送一次聊天来填充UI | 现实世界配额成本为零。主动探针是想要基线用户的好选兜底机制。 |
| 使用表上的1000行上限 | 每分钟1个样本×7天 = 10,080个样本;上限是最早的样本。7天图表的样本量充足。 |
| OS仅有钥匙扣（无加密的Dexie 回退） | 钥匙扣是`claude login`自身所使用的安全基线。我们拒绝削弱这一点，因为网络模式是回退用户根本无法安全运行。 |

## 什么是故意的超出范围

- 多账户保险库+账户间自动轮换（ADR 0011）。
- 将OAuth 凭证写入`~/.claude/.credentials.json`，使外部Claude Code CLI共享。CCSwitch已经涵盖了基于环境变量的共享;OAuth-credential注入是额外的攻击接口。
- Real Anthropic 端的计费（主机API）。独立路径，不依赖订阅OAuth。

## 端到端验证

1. 设置 → 订阅 → 账户 → “登录”→选择**订阅** →浏览器打开 claude.ai 授权页面 →粘贴码→对话框关闭 →账户标签显示邮件 + 套餐 + 过期→钥匙串条文显示。
2. 发送聊天消息。DevTools网络显示`Authorization: Bearer ...`、`anthropic-beta: ...,oauth-2025-04-20`、`x-app: cli`。**不** `x-api-key`。
3. →订阅概览设置→现在代表申领窗口显示两个进度条（5小时，7天），带有“（权威）”徽章。
4. 强制刷新：账户→“立即刷新”→钥匙扣access_token轮换;如果服务器发送新钥匙串，refresh_token会轮换。
5. 登出→钥匙链条目消失→概览恢复为空状态。
6. 网页模式（`pnpm dev`）：订阅部分显示“桌面需要”横幅;登录CTA被禁用。
