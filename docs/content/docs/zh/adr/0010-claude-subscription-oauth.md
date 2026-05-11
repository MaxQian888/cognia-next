---
title: "0010 — Claude Subscription OAuth + Usage Tracking"
description: "cognia-next gains first-class support for Claude Pro/Max OAuth login, sidecar bearer-token injection, and live 5-hour / 7-day rate-limit visibility built on the unified-* response headers."
---

# ADR 0010 — Claude Subscription OAuth + Usage Tracking

**Status:** Accepted
**Date:** 2026-05-06
**Branch:** `feat/claude-subscription-oauth`

---

## Context

Until this ADR, cognia-next's Anthropic integration was strictly **API-key based**:
the renderer wrote `apiKey` to IndexedDB, the Rust shell forwarded it as
`ANTHROPIC_API_KEY` when spawning the sidecar, and that was the entire auth
story. Pro/Max subscribers — Anthropic's most valuable individual users —
could not (a) sign in with their subscription token and (b) see how close they
were to the 5-hour rolling window or 7-day weekly cap that
[Anthropic activated on 2025-07-28](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/).

Two CCSwitch-style ecosystems already solved variants of this problem:
[Leu-s/CCSwitch](https://github.com/Leu-s/CCSwitch) parses the unified
rate-limit headers, [zach-source/ccswitch](https://github.com/zach-source/ccswitch)
manages the OS-keyring credential lifecycle, and the
[Claude Code CLI](https://code.claude.com/docs/en/authentication) defines the
canonical `claude login` OAuth flow against `claude.ai`. We borrow the
mechanisms but stay strictly **single-account** in this phase — multi-account
auto-rotation is deferred to ADR 0011.

---

## Decision

### Architecture overview

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

### OAuth flow

The Pro/Max flow and the Console (API-billing) flow share the **same public
client_id** `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
([anthropics/claude-code#39445](https://github.com/anthropics/claude-code/issues/39445);
the misconception that they differ — and the workaround in
[ben-vargas/claude-code-sdk_oauth](https://gist.github.com/ben-vargas/c7c7cbfebbb47278f45feca9cef309d1) —
is documented in the same thread).

| Param                       | Subscription (Pro / Max)                                                                                                                                      | Console (API-billing)                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Authorize URL               | `https://claude.ai/oauth/authorize`                                                                                                                           | `https://console.anthropic.com/oauth/authorize`     |
| Redirect URI                | `https://platform.claude.com/oauth/code/callback`                                                                                                             | `https://console.anthropic.com/oauth/code/callback` |
| Scopes                      | `user:profile user:inference user:sessions:claude_code`                                                                                                       | `org:create_api_key user:profile user:inference`    |
| Token endpoint (both flows) | `POST https://platform.claude.com/v1/oauth/token` (form-encoded — JSON returns 400 invalid_grant per [coqu](https://flopsstuff.github.io/coqu/claude-oauth/)) |                                                     |
| PKCE                        | S256 + `state`                                                                                                                                                | same                                                |
| `code=true`                 | forces the manual-code variant                                                                                                                                | same                                                |

The login dialog is paste-the-code (no localhost loopback), which sidesteps
port allocation, firewall prompts, and Tauri deep-link registration. The
`code_verifier` lives in the dialog's component state — no global storage,
no persistence on cancel.

### Sidecar header set (OAuth bearer mode)

When `CLAUDE_CODE_OAUTH_TOKEN` is set, the sidecar's
`@anthropic-ai/claude-agent-sdk` automatically sends:

```
authorization: Bearer <oat01-...>
anthropic-version: 2023-06-01
anthropic-beta: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20
x-app: cli
user-agent: claude-cli/...
```

Without `oauth-2025-04-20`, Anthropic returns "OAuth authentication is currently
not supported"
([#37205](https://github.com/anthropics/claude-code/issues/37205)). Without
`claude-code-20250219` + `x-app: cli`, the Sonnet/Opus 4 series 429s OAuth
callers
([NousResearch/hermes-agent#17169](https://github.com/NousResearch/hermes-agent/issues/17169)).
The official agent SDK encodes all of these for us — we don't write them
ourselves.

### Usage tracking — passive vs. active

A near-empty `POST /v1/messages` (`max_tokens: 1`, one-character user message)
**is billed** — the
[Anthropic pricing docs](https://platform.claude.com/docs/en/about-claude/pricing)
have no minimum-charge carve-out. So we pivot from the typical CCSwitch
"probe every 60 seconds" pattern to a **passive-first** design:

1. **Passive collection** (default ON, zero extra quota cost):
   `sidecar/fetch-interceptor.mjs` monkey-patches `globalThis.fetch` _before_
   the agent SDK is imported. Every response on `api.anthropic.com` triggers
   a `usage_headers` stdout event, which the renderer's `usage-collector`
   parses and persists. The user gets a fresh sample on every chat send.
2. **Active probe** (default OFF, opt-in): the user enables it explicitly in
   Settings → Subscription → Settings, with a UI line that calls out
   "~10 input + 1 output tokens per probe". The probe goes through the same
   parser + collector pipeline so both data sources share storage and UI.

The full unified-\* header set we parse — verbatim from
[anthropics/claude-code#12829](https://github.com/anthropics/claude-code/issues/12829):

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

These headers are not in Anthropic's public docs (only the legacy
`anthropic-ratelimit-{requests,tokens,…}-*` family is). We treat them as
evidence-based but unsupported — failures degrade silently to "status:
unknown" rather than crashing the collector.

### Schema (v20)

One Dexie table added in `lib/db/schema.ts` version 20:

| Table               | Key       | Indexed                                               |
| ------------------- | --------- | ----------------------------------------------------- |
| `subscriptionUsage` | `localId` | `fetchedAt`, `status`, `source`, `[source+fetchedAt]` |

Capped at 1 000 rows newest-first by `lib/anthropic-subscription/usage-collector.ts`.
A 60-second debounce per source (`passive` / `probe`) collapses streaming bursts.

### Settings (AppSettings.subscriptionSettings)

| Field               | Default | Notes                                                              |
| ------------------- | ------- | ------------------------------------------------------------------ |
| `probeEnabled`      | `false` | Active-probe master switch.                                        |
| `visibleIntervalMs` | 5 min   | Foreground cadence. Floor 60 s.                                    |
| `idleIntervalMs`    | 30 min  | Background cadence. Floor 60 s.                                    |
| `warnThresholdPct`  | 90      | Overview tab flips to "approaching limit" past this % utilization. |

### Credentials in the OS keyring

| Field    | Value                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Service  | `com.cognia.claude-subscription/v1`                                                                                                    |
| Account  | `default`                                                                                                                              |
| Backend  | macOS Keychain / Windows Credential Manager / Linux Secret Service via the `keyring` Rust crate (already a project dependency for TTS) |
| Web mode | Tauri-only — falls back to a static "desktop required" banner                                                                          |

The service name is **deliberately separate** from the Claude Code CLI's own
`Claude Code-credentials` entry. cognia-next never writes
`~/.claude/.credentials.json` — that file is owned by `claude login`, and
double-writing would race with the CLI's refresh cycle.

---

## Tradeoffs

| Tradeoff                                                          | Why we accept it                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusing the Claude Code public client_id                          | No public 3rd-party OAuth program for Anthropic. Multiple open-source community projects converge on the same UUID.                           |
| Passive collection requires at least one chat send to populate UI | Real-world quota cost is zero. Active probe is the escape hatch for users who want a baseline.                                                |
| 1 000-row cap on the usage table                                  | 1 sample per minute × 7 days = 10 080 samples; the cap drops the oldest. Plenty for the 7-day chart.                                          |
| OS keychain only (no encrypted Dexie fallback)                    | Keychain is the security baseline `claude login` itself uses. We refuse to weaken that for a web-mode fallback users can't safely run anyway. |

## What's intentionally out of scope

- Multi-account vault + auto-rotation across accounts (ADR 0011).
- Writing the OAuth credential into `~/.claude/.credentials.json` so the
  external Claude Code CLI shares it. CCSwitch already covers env-var-based
  sharing; OAuth-credential injection is an additional attack surface.
- Real Anthropic-side billing (Console API). Independent path from
  subscription OAuth.

## Verification (end-to-end)

1. Settings → Subscription → Account → "Sign in" → choose **Subscription** →
   browser opens claude.ai authorize page → paste code → dialog closes →
   Account tab shows email + plan + expiry → keychain entry appears.
2. Send a chat message. DevTools Network shows
   `Authorization: Bearer ...`, `anthropic-beta: ...,oauth-2025-04-20`,
   `x-app: cli`. **No** `x-api-key`.
3. Settings → Subscription → Overview now shows two progress bars (5h, 7d)
   with the "(authoritative)" badge on the representative-claim window.
4. Force a refresh: Account → "Refresh now" → keychain access_token rotates;
   refresh_token rotates if the server sends a new one.
5. Sign out → keychain entry disappears → Overview returns to the empty state.
6. Web mode (`pnpm dev`): Subscription section renders the "desktop required"
   banner; login CTA is disabled.
