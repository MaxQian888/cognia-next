---
title: "0010 — Claude 订阅 OAuth + 用量追踪"
description: "cognia-next 获得对 Claude Pro/Max OAuth 登录、sidecar bearer-token 注入，以及基于 unified-* 响应头实时展示 5 小时 / 7 天速率限制的一级支持。"
---

# ADR 0010 — Claude 订阅 OAuth + 用量追踪

**状态：** 已接受
**日期：** 2026-05-06
**分支：** `feat/claude-subscription-oauth`

---

## 背景

在本 ADR 之前，cognia-next 与 Anthropic 的集成完全是**基于 API key** 的：
renderer 把 `apiKey` 写入 IndexedDB，Rust shell 在启动 sidecar 时将其作为
`ANTHROPIC_API_KEY` 转发，这就是全部的鉴权方案。Pro/Max 订阅用户——Anthropic
最具价值的个人用户——既无法 (a) 用其订阅 token 登录，也无法 (b) 看到自己距离
[Anthropic 于 2025-07-28 启用](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/)
的 5 小时滚动窗口或 7 天周上限还有多近。

已有两个 CCSwitch 风格的生态各自解决了该问题的变体：
[Leu-s/CCSwitch](https://github.com/Leu-s/CCSwitch) 解析统一速率限制响应头，
[zach-source/ccswitch](https://github.com/zach-source/ccswitch)
管理操作系统钥匙串的凭据生命周期，而
[Claude Code CLI](https://code.claude.com/docs/en/authentication) 定义了针对
`claude.ai` 的标准 `claude login` OAuth 流程。我们借用这些机制，但本阶段严格保持
**单账户**——多账户自动轮换推迟到 ADR 0011。

---

## 决策

### 架构总览

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

### OAuth 流程

Pro/Max 流程与 Console（API 计费）流程共用**同一个公开 client_id**
`9d1c250a-e61b-44d9-88ed-5944d1962f5e`
（[anthropics/claude-code#39445](https://github.com/anthropics/claude-code/issues/39445)；
认为二者不同的误解——以及
[ben-vargas/claude-code-sdk_oauth](https://gist.github.com/ben-vargas/c7c7cbfebbb47278f45feca9cef309d1)
中的绕过办法——都记录在同一个 thread 中）。

| 参数                        | 订阅（Pro / Max）                                                                                                                                            | Console（API 计费）                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Authorize URL               | `https://claude.ai/oauth/authorize`                                                                                                                           | `https://console.anthropic.com/oauth/authorize`     |
| Redirect URI                | `https://platform.claude.com/oauth/code/callback`                                                                                                             | `https://console.anthropic.com/oauth/code/callback` |
| Scopes                      | `user:profile user:inference user:sessions:claude_code`                                                                                                       | `org:create_api_key user:profile user:inference`    |
| Token endpoint（两种流程）  | `POST https://platform.claude.com/v1/oauth/token`（form-encoded——JSON 会按 [coqu](https://flopsstuff.github.io/coqu/claude-oauth/) 返回 400 invalid_grant） |                                                     |
| PKCE                        | S256 + `state`                                                                                                                                                | 同上                                                |
| `code=true`                 | 强制走手动输入 code 的变体                                                                                                                                    | 同上                                                |

登录对话框采用粘贴 code 的方式（无 localhost 回环），从而绕开端口分配、防火墙弹窗
以及 Tauri deep-link 注册。`code_verifier` 存活于对话框组件的 state 中——无全局
存储，取消时不留持久化。

### Sidecar 请求头集合（OAuth bearer 模式）

当设置了 `CLAUDE_CODE_OAUTH_TOKEN` 时，sidecar 的
`@anthropic-ai/claude-agent-sdk` 会自动发送：

```
authorization: Bearer <oat01-...>
anthropic-version: 2023-06-01
anthropic-beta: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20
x-app: cli
user-agent: claude-cli/...
```

缺少 `oauth-2025-04-20` 时，Anthropic 会返回 "OAuth authentication is currently
not supported"
（[#37205](https://github.com/anthropics/claude-code/issues/37205)）。缺少
`claude-code-20250219` + `x-app: cli` 时，Sonnet/Opus 4 系列会对 OAuth 调用方
返回 429
（[NousResearch/hermes-agent#17169](https://github.com/NousResearch/hermes-agent/issues/17169)）。
官方 agent SDK 已为我们编码了所有这些头——我们不必自己编写。

### 用量追踪——被动 vs. 主动

一次近乎空载的 `POST /v1/messages`（`max_tokens: 1`、单字符的用户消息）
**也会计费**——
[Anthropic 定价文档](https://platform.claude.com/docs/en/about-claude/pricing)
并无最低收费豁免。因此我们从典型的 CCSwitch「每 60 秒探测一次」模式转向
**被动优先**的设计：

1. **被动采集**（默认开启，零额外配额成本）：
   `sidecar/fetch-interceptor.mjs` 在 agent SDK 被 import _之前_ 对
   `globalThis.fetch` 打猴子补丁。`api.anthropic.com` 上的每个响应都会触发一个
   `usage_headers` stdout 事件，renderer 的 `usage-collector` 解析并持久化它。
   用户每次发送聊天都会获得一份新样本。
2. **主动探测**（默认关闭，需显式开启）：用户在
   设置 → 订阅 → 设置 中显式启用，UI 文案明确指出
   "每次探测约消耗 10 输入 + 1 输出 token"。探测走与被动采集相同的
   parser + collector 流水线，因此两个数据源共享存储与 UI。

我们解析的完整 unified-\* 响应头集合——逐字摘自
[anthropics/claude-code#12829](https://github.com/anthropics/claude-code/issues/12829)：

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

这些响应头不在 Anthropic 的公开文档中（仅旧的
`anthropic-ratelimit-{requests,tokens,…}-*` 系列有）。我们将其视为有据可依但
不受官方支持——失败时静默降级为 "status: unknown"，而非让采集器崩溃。

### Schema（v20）

在 `lib/db/schema.ts` 第 20 版中新增一张 Dexie 表：

| 表                  | Key       | 索引                                                  |
| ------------------- | --------- | ----------------------------------------------------- |
| `subscriptionUsage` | `localId` | `fetchedAt`、`status`、`source`、`[source+fetchedAt]` |

由 `lib/anthropic-subscription/usage-collector.ts` 按最新优先封顶 1 000 行。
每个数据源（`passive` / `probe`）有 60 秒去抖，折叠流式爆发。

### 设置（AppSettings.subscriptionSettings）

| 字段                | 默认值  | 说明                                                       |
| ------------------- | ------- | ---------------------------------------------------------- |
| `probeEnabled`      | `false` | 主动探测总开关。                                           |
| `visibleIntervalMs` | 5 分钟  | 前台节奏。下限 60 秒。                                     |
| `idleIntervalMs`    | 30 分钟 | 后台节奏。下限 60 秒。                                     |
| `warnThresholdPct`  | 90      | 利用率超过该百分比时，概览页切换为「接近上限」。           |

### 操作系统钥匙串中的凭据

| 字段     | 值                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Service  | `com.cognia.claude-subscription/v1`                                                                                                    |
| Account  | `default`                                                                                                                              |
| 后端     | macOS Keychain / Windows Credential Manager / Linux Secret Service，经由 `keyring` Rust crate（已是项目的 TTS 依赖）                   |
| Web 模式 | 仅 Tauri——降级为静态的「需桌面端」横幅                                                                                                |

该 service 名称**刻意独立**于 Claude Code CLI 自身的
`Claude Code-credentials` 条目。cognia-next 从不写入
`~/.claude/.credentials.json`——该文件归 `claude login` 所有，双重写入会与 CLI
的刷新周期竞争。

---

## 取舍

| 取舍                                                             | 我们为何接受                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 复用 Claude Code 的公开 client_id                                | Anthropic 没有公开的第三方 OAuth 计划。多个开源社区项目都汇聚到了同一个 UUID。                                                                |
| 被动采集需至少一次聊天发送才能填充 UI                            | 现实中的配额成本为零。主动探测是给想要基线的用户的逃生口。                                                                                    |
| 用量表 1 000 行上限                                              | 每分钟 1 样本 × 7 天 = 10 080 样本；上限会丢弃最旧的。对 7 天图表绰绰有余。                                                                   |
| 仅用操作系统钥匙串（无加密的 Dexie 回退）                        | 钥匙串正是 `claude login` 本身所用的安全基线。我们拒绝为一个用户本就无法安全运行的 web 模式回退而削弱它。                                     |

## 刻意排除在范围之外的内容

- 多账户保险库 + 跨账户自动轮换（ADR 0011）。
- 把 OAuth 凭据写入 `~/.claude/.credentials.json` 以便外部 Claude Code CLI 共享。
  CCSwitch 已覆盖基于环境变量的共享；注入 OAuth 凭据是额外的攻击面。
- 真正的 Anthropic 侧计费（Console API）。与订阅 OAuth 是相互独立的路径。

## 验证（端到端）

1. 设置 → 订阅 → 账户 → "登录" → 选择 **订阅** →
   浏览器打开 claude.ai 授权页 → 粘贴 code → 对话框关闭 →
   账户页显示邮箱 + 套餐 + 到期时间 → 钥匙串条目出现。
2. 发送一条聊天消息。DevTools Network 显示
   `Authorization: Bearer ...`、`anthropic-beta: ...,oauth-2025-04-20`、
   `x-app: cli`。**没有** `x-api-key`。
3. 设置 → 订阅 → 概览 此时显示两条进度条（5h、7d），
   并在代表性窗口上带有 "(authoritative)" 徽章。
4. 强制刷新：账户 → "立即刷新" → 钥匙串 access_token 轮换；
   若服务器下发了新的 refresh_token，则其也轮换。
5. 登出 → 钥匙串条目消失 → 概览回到空状态。
6. Web 模式（`pnpm dev`）：订阅区块渲染「需桌面端」横幅；登录按钮禁用。
