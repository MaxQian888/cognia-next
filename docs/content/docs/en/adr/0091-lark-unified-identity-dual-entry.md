---
title: "0091 — Lark Unified Identity and Dual-Entry Surfaces"
description: "Server-authoritative Feishu principal registry with fail-closed multi-account isolation, a unified callback-authorization guard, web SSO with single-use entry tokens, and reconciled Chat Tab / menu / shortcut entry surfaces."
---

# ADR 0091 — Lark Unified Identity and Dual-Entry Surfaces

- **Status:** Accepted
- **Date:** 2026-07-24
- **Builds on:** ADR-0009, ADR-0025, ADR-0036, ADR-0059, ADR-0089
- **Plan record:** `docs/plans/2026-07-24-lark-im-dual-entry-completion.md`
- **Runbook:** `docs/runbooks/lark-entry-surfaces.md`

## Context

The Lark connector covered the bot-execution direction well (messages, attachments, topics,
durable inbound jobs, CardKit run controls, bot menus, in-chat slash commands) but had no
server-side identity model: any `open_id` reaching an adapter executed under the local account,
high-privilege card callbacks (`wf_approve`, `wf_fanout_*`, `tool_approve`, `skill_invoke`)
carried no actor authorization, and the only web deep link (`/inbox/c?key=`) exposed raw
conversation keys — guessable, permanent, unauthenticated. The "user opens Cognia from inside
Feishu" direction (Chat Tab, group menu, message shortcut, `+` menu) did not exist.

## Decision

### 1. Feishu principal registry (fail-closed)

Dexie v125 adds `feishuTenants` (`&[tenantKey+appId]` → cogniaAccountId), `feishuPrincipals`
(`&[tenantKey+appId+openId]` → cogniaAccountId + cogniaUserId, status active/disabled/unlinked)
and `feishuPrincipalBindRequests`. The inbound bus resolves every Lark event between adapter
lookup and override lookup (Step 2.5): `resolved` events stamp `accountId`/`principalId` onto the
durable job, conversation state, and run initiators; `unbound` senders are parked `history_only`
with a hashed-open_id audit and a once-per-day bilingual bind-code reply; `disabled`,
`tenant_disabled`, and `cross_account` are parked silently. A tenant mapped to a different
Cognia account NEVER executes under the active one — there is no fallback to
`HEADLESS_LOCAL_ACCOUNT_ID`, and per-event account switching is explicitly rejected. The
registry is gated by `larkPrincipalRegistry` (default off); with the flag off the legacy
behavior is byte-identical.

### 2. Unified callback authorization

One guard (`lib/connectors/callback-authorization.ts`) runs before every callback short-circuit:
adapter match → expiry → consume-once (`wf_approve`, `wf_cancel`, `wf_fanout_*`, `tool_approve`,
`skill_invoke`) → conversation match (chat-level; thread only when both sides carry one) →
principal check → allowedActions → actorScope (initiator / operators / conversation / anyone,
with per-kind legacy fallbacks) → run-control conversation binding. Binding writers stamp
`actorScope`/`allowedActions`; `consumedAt` fixes stale re-clicks re-granting session bypasses.
`larkStrictCallbackAuthorization` defaults to **audit** (checks run, would-deny decisions audit
as `callback.authorization_would_deny`, nothing blocks); the enforce flip is a runbook step
taken when the audit stream is quiet.

### 3. Web SSO and authorized entry links

The companion API (headless axum, `/integrations/lark/*`, pre-auth rate-limited) owns the
public surface. SSO: server-side state+PKCE login → Lark OAuth code exchange in Rust → an 8 h
`lark_web` HS256 session JWT delivered via URL fragment and held in `sessionStorage`. External
links never carry raw conversation keys: personal links wrap a 300 s single-use `lark_entry`
token (jti LRU) whose resolve enforces identity match; chat-level surfaces (Chat Tab / group
menu) wrap a long-lived integrity-only `lark_surface` descriptor whose resolve requires SSO plus
a live chat-membership check answered by the brain over the event-bus intent bridge
(`connectors://lark-intent` + `lark_result_complete` RPC + poll endpoint). `/lark/entry` renders
the terminal outcomes. Dexie v126 adds the entry-context / chat-surface / message-import /
web-session ledgers.

### 4. Entry surfaces

- **Chat Tab / group menu**: reconcilers pinned against the official `chat_tabs` and
  `menu_tree` APIs keep one "Cognia" entry per chat pointing at the surface URL; desired state
  and exponential backoff live in `larkChatSurfaces`; triggers are adapter start, bot-added
  events, settings resync, and urlVersion bumps. Links only — never direct execution.
- **Bot menus**: clicks classify into mapped / link / unknown. Unknown `event_key`s answer with
  a fixed bilingual notice plus a `menu.unknown_key` audit and never become model prompts
  (previously they did). Reserved `cognia.*` built-ins resolve behind adapter-configured rows.
- **Slash commands**: Feishu's open platform has **no** bot slash-command event — "/name" text
  arrives as `im.message.receive_v1` and the existing command dispatcher already owns it
  (verified against the official bot-capability docs). The control-command spec registry
  (`nativeExposed` batch: /new /status /help /sessions /switch) drives the console menu
  manifest instead of a fictional event branch.
- **Message shortcut / `+` menu**: `/lark/shortcut` exchanges the Lark trigger code for the
  selection via the H5 JSSDK (signature minted by the session-authed `jssdk/config` endpoint),
  submits ONLY ids, and the brain re-verifies flag + principal + membership + per-message
  `chat_id` before writing one delimited imported block into a fresh platform-bound session
  (`sourceHash` idempotency). The `+` menu binds a new session `/new`-style. Client-supplied
  data is always a request, never trusted.

### 5. Observability and rollout

Ten `cognia_lark_*` counters in the companion exposition (SSO, entry resolves, principal
unbound, callback denies, chat-tab failures, imports); the brain mirrors bumps through the
allowlisted fire-and-forget `lark_metrics_record` RPC. Security events additionally write
durable audits (`principal.*`, `callback.*`, `entry.*`, `menu.unknown_key`, `chat_tab.*`,
`shortcut.*`, `plus.create`, `sso.session_seen`) carrying hashes, never message content. All
surfaces are flag-gated per adapter (settings card) with env/global fallbacks defaulting off;
the gray order, admin-console checklist, client verification matrix, alert thresholds, and
rollback (including the enforce flip) live in the runbook.

## Consequences

- Multi-tenant Feishu traffic is account-isolated with a fail-closed default; operators must
  bind principals (or leave the registry flag off) before strangers can execute anything.
- Card callbacks acquire real actor authorization with an audit-first rollout that cannot
  regress existing flows until enforce is chosen.
- Every externally published URL is authorized at resolve time; leaked links expire, are
  single-use, or demand SSO + membership.
- The companion API grows a public Lark surface that must ride the existing HS256 secret,
  rate limits, and deny lists; rotation invalidates outstanding sessions by design.
- Real-tenant operations (console configuration, Chat Tab publish, client verification, gray
  release) are deliberately runbook steps, not code — they cannot be executed from CI.
