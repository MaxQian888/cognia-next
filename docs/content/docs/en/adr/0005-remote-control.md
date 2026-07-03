---
title: ADR-0005 — Remote Control Subsystem
description: Complete the half-finished webhook + event-trigger story with a local 127.0.0.1 axum HTTP listener, HMAC-signed outbound deliveries, and a dedicated Settings section.
---

# Remote Control Subsystem

| Status   | Accepted · **Activated 2026-06-03**                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Date     | 2026-05-03                                                                                                             |
| Replaces | The half-finished webhook channel + free-text event-trigger UI in `components/scheduler/task-form.tsx` (pre-this-ADR). |

## Activation update (2026-06-03)

The original implementation left three value paths inert. They are now closed, and
the inbound surface was generalized beyond the scheduler:

- **Inbound dispatch is live.** `RemoteControlReceiver` is mounted in `app/layout.tsx`.
  A new generic `POST /api/v1/commands/:target` route emits `remote-control://command`;
  the renderer's `lib/remote-control/dispatch.ts` registry routes by target into each
  subsystem's existing headless run entry — **scheduler** (`runTaskNow` / `emitSchedulerEvent`),
  **goals** (`createGoal` / `requestManualContinue`), **workflows** (`startWorkflowFromRemote`
  → `runWorkflow`), **agent team** (`agentTeamManager.start`), and the **plan hub**
  (`runPlan`). The original `/tasks/:id/run` + `/events` routes are retained.
- **Loopback hardening** (Tailscale LocalAPI model): Host-header allowlist + Origin/Referer
  rejection (DNS-rebinding / `0.0.0.0-day`), an `Idempotency-Key` replay cache (5-minute
  window), a read/write token capability gate, and `Content-Security-Policy: default-src 'none'`
  on every response.
- **Outbound signing is wired** onto the [Standard Webhooks](https://www.standardwebhooks.com/)
  scheme (`{id}.{timestamp}.{body}` HMAC, `webhook-id` / `webhook-timestamp` / `webhook-signature`
  headers), fed by a standalone egress registry (`lib/remote-control/outbound/`) that any subsystem
  can publish to. The legacy `X-Cognia-Signature` hex helper was retired.
- **Durable audit**: a Dexie `remoteControlAudit` table (schema v72) records every inbound
  dispatch and outbound delivery; a `"remote"` `TaskExecutionTriggerSource` tags remote runs.

See the [Remote Control subsystem docs](../subsystems/remote-control) for the wired detail.

## Customization update (2026-07-03)

The settings panels gained finer-grained, end-to-end-wired controls, following
least-privilege ACL and mainstream webhook-dashboard conventions:

- **Per-target permission ACL (inbound).** `RemoteControlInboundConfig.disabledTargets`
  is a denylist enforced server-side in Rust (`run_command` returns `403 target_disabled`
  before emitting the command event), with a renderer-side guard in `dispatchRemoteCommand`
  as defence-in-depth. The Inbound tab renders the command targets as per-subsystem toggles
  (with bulk enable/disable). Applied on the next listener start, like port/allowlist/capability.
- **Per-endpoint event subscriptions (outbound).** `WebhookEgressEndpoint.eventTypes`
  filters an egress endpoint to specific lifecycle event types (empty = all), enforced by
  `endpointSubscribesTo` in `publishOutboundEvent`. Endpoints also gained a per-endpoint
  custom-headers editor and live URL validation.
- **Tunable delivery limits (outbound).** `RemoteControlOutboundConfig.delivery`
  (`maxRetries` / `timeoutMs` / `baseDelayMs`, clamped by `normalizeWebhookDelivery`) replaces
  the previously hard-coded constants in `deliverWebhook`; applied to both per-task URLs and
  egress endpoints.
- **Inbound quickstart** cURL snippets + an Overview traffic snapshot (success / errors /
  success-rate over the recent-calls window).

## Context

cognia-next has shipped two adjacent half-features since the scheduler landed:

1. **Outbound webhook delivery** — `lib/scheduler/notification-integration.ts:176`
   already POSTs to a configured URL with retry/timeout/jitter, and
   `NotificationChannel = "desktop" | "toast" | "webhook" | "none"` plus
   `TaskNotificationConfig.webhookUrl?` were typed end-to-end. But the task form
   only rendered `["desktop", "toast"]` channel buttons — there was no way to
   actually set a webhook URL through the UI. There was also no signing or custom
   header story, so receivers had no way to verify that a delivery actually came
   from this cognia install.
2. **Event-triggered tasks** — `lib/scheduler/event-integration.ts` exposes
   `emitSchedulerEvent(eventType, data, eventSource)` and
   `lib/scheduler/task-scheduler.ts:1260` already filters listening tasks by
   **both** `eventType` and `eventSource`. The form, though, was a single
   free-text input and didn't surface `eventSource` at all. There was no way for
   anything outside the renderer to fire an event.

That left a "remote control" story with no inbound surface (external systems
can't trigger a task or fire an event) and only a partial outbound surface
(no auth, no URL field, no custom headers). The user-facing motivation in
2026-05-03 was that automation suites and personal scripts wanted to drive
their own cognia install — kick off a scheduled chat from a CI job, fire a
`backup:needed` event when an external sync ends, etc. — without writing a
plugin or learning the MCP toolchain.

## Decisions

### 1. Inbound transport: local 127.0.0.1 axum HTTP server

A new Rust module `src-tauri/src/remote_control/` spawns an axum 0.7 HTTP
server bound to `127.0.0.1:<port>` (default `47821`). Three endpoints:

- `GET  /api/v1/health` — `{ ok: true, version }`. Auth required to avoid
  leaking version info to unauthenticated probers.
- `POST /api/v1/tasks/:id/run` — emits the `remote-control://run-task` Tauri
  event; the `RemoteControlReceiver` provider in the renderer dispatches that
  to `useSchedulerStore.getState().runTaskNow(taskId)`. Returns `202`.
- `POST /api/v1/events` — emits `remote-control://emit-event`; the receiver
  forwards to `emitSchedulerEvent`. Returns `202`.

We chose 127.0.0.1 over `0.0.0.0` because LAN exposure is out of scope for
this iteration — a future ADR can add a Cloudflare Tunnel sidecar without
changing the axum app at all.

The middleware stack (outer→inner): body-size limit (8 KiB) →
bearer-auth (constant-time compare via `subtle::ConstantTimeEq`) →
IPv4 CIDR allowlist → fixed-window rate limit (default 60 req/min). Wrong
token → 401, off-allowlist → 403, oversized body → 413, over rate limit → 429. Graceful shutdown rides on a `tokio::sync::watch` channel.

The listener is **opt-in**. The Inbound tab's enable Switch is disabled
until the user explicitly clicks "Generate token", and the auto-start path
in `lib.rs:setup` only runs the listener when both `inbound.enabled` is
persisted true AND the OS keyring still has a token. A missing token cleanly
returns `TokenMissing` so the renderer prompts the user to regenerate.

### 2. Outbound HMAC signing + custom headers

`sendWebhookNotification` is extended with an optional `opts` argument
`{ signingSecret?, headers? }`. When `signingSecret` is set, the body is
HMAC-SHA256-signed and an `X-Cognia-Signature: sha256=<hex>` header rides on
every retry of the same delivery. The signing helper lives in
`lib/scheduler/webhook-signature.ts` (Web Crypto, ~30 lines) so both the
production send path and tests use the same vector.

`opts.headers` is merged BEFORE the canonical `Content-Type: application/json`
— a caller-supplied `Content-Type` is dropped on purpose so receivers always
see JSON. Both opts are computed once via `getWebhookOutboundConfig()` in
`lib/scheduler/webhook-outbound-config.ts`, which reads the Zustand
`useRemoteControlStore` for headers and (on desktop only) the OS keyring for
the signing secret. The secret never enters Zustand or Dexie.

### 3. Secrets live in the OS keyring (`com.cognia.remote-control`)

Both the inbound bearer token and the outbound signing secret are stored
through the same `keyring = "3"` crate that the TTS subsystem already uses
(`src-tauri/src/tts/keyring.rs`). Service `"com.cognia.remote-control"`,
accounts `"inbound-token"` and `"outbound-signing-secret"`. The renderer
fetches them on demand via `remoteControlGetToken` /
`remoteControlGetSigningSecret` Tauri commands; neither value is part of any
persisted Zustand state.

### 4. New `remote-control` Settings section

`components/settings/remote-control/remote-control-section.tsx` mirrors
`data/data-section.tsx` 1:1 — `useSyncExternalStore` + `?remoteControlTab=`
URL hydration, four tabs (`Overview` / `Inbound` / `Outbound` / `Events`).
The Inbound tab is gated behind `isTauri()`; the other three render in both
runtimes. The section sits in the `system` settings group between
`Scheduled Tasks` and `Desktop`.

### 5. In-place extension of `domain-list-input` for the IP allowlist

Rather than fork the search-side `domain-list-input.tsx`, we add two
optional props — `validate?: (raw: string) => string | null` and
`errorRender?: (key: string) => ReactNode`. Existing callers (the search
allow/block lists) keep their original behaviour because the default
validator returns `null`. The remote-control allowlist passes
`validateCidrOrIp` (defined in `types/remote-control/index.ts`) and an
`errorRender` that translates the returned i18n key.

### 6. Add `"remote"` to `TaskExecutionTriggerSource`

The runtime `runTaskNow` path tags executions with their initiating source.
Remote-triggered runs deserve their own variant so the execution history
can show a "remote" badge instead of mis-classifying as "run-now".

## Threat model

The single bearer token + 127.0.0.1 binding is sufficient against:

- a co-resident user-mode process on the same host that **doesn't** have read
  access to the OS keyring (defence: bearer auth)
- an off-loopback network attacker (defence: 127.0.0.1 binding +
  IPv4 CIDR allowlist defaulting to `127.0.0.1/32`)
- replay of a stolen body to a webhook receiver (defence: HMAC signature on
  outbound deliveries, `subtle::ConstantTimeEq` on inbound auth)

It is **not** sufficient against:

- a co-resident attacker who can read the OS keyring (no defence — the same
  threat applies to any cognia API key)
- a malicious browser extension running in the cognia webview (Tauri's
  default CSP applies)
- man-in-the-middle on outbound webhook deliveries (defence: receivers should
  pin TLS + verify the signature)

## Reuse map

| Concern                 | Reused source                                              | Why we didn't fork                                                             |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Webhook retry/timeout   | `lib/scheduler/notification-integration.ts:176`            | Existing 3-retry exponential-backoff loop is correct; we extend opts in place. |
| Webhook test infra      | `lib/scheduler/notification-integration.ts:231`            | `testNotificationChannel("webhook", url)` already supports an explicit URL.    |
| Tabbed settings shell   | `components/settings/data/data-section.tsx`                | `useSyncExternalStore` + `?…Tab=` URL hydration is the canonical pattern.      |
| Settings primitives     | `components/settings/common/settings-section.tsx`          | `SettingsCard`/`Toggle`/`Row` cover every layout need.                         |
| List input              | `components/settings/search/_shared/domain-list-input.tsx` | Adding a `validate?` prop avoids a parallel widget.                            |
| Tauri command bindings  | `lib/tauri/canvas.ts`                                      | One `invoke` call site per command + `isTauri()` guard.                        |
| OS keyring              | `src-tauri/src/tts/keyring.rs`                             | Same `keyring = "3"` crate, same `NoEntry → None` mapping.                     |
| Long-lived service      | `src-tauri/src/scheduler/service.rs`                       | Tauri-managed state owning a `tokio::sync::Mutex<Option<JoinHandle>>`.         |
| Frontend Tauri listener | `components/providers/a2ui-dispatch-provider.tsx`          | Top-level provider that owns Tauri listeners for the entire app lifetime.      |
| Pref persistence        | `lib/tauri/store.ts` + Zustand `persist` middleware        | Same hybrid (localStorage on web, tauri-plugin-store on desktop).              |

## Future work

- **Cloudflare Tunnel sidecar** — let users expose their inbound listener to
  the public internet without port forwarding. The axum app stays put; only a
  new sidecar process is added.
- **MCP toolset** — wrap the same routes in an MCP server so external Claude
  Desktop / Cursor sessions can drive the listener through their own protocol.
- **Per-task signing secret override** — currently a single global secret
  signs every outbound webhook.
- **Multiple bearer tokens with scopes** — single token today; per-token
  rate limiting is in place but every token has the same authority.
- **WebSocket / SSE push** — only request/response is supported today.
