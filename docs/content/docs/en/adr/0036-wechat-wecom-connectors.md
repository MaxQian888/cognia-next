---
title: 0036 — WeChat / WeCom Connectors
description: Adds Enterprise WeChat (企业微信 / WeCom) over the 智能机器人 long connection (streaming replies, proactive push, template-card interactions) and Personal WeChat (个人微信) over the iLink gateway (QR login, reply-only HTTP long-poll, AES-128-ECB media) as native platform connectors; reuses the generic WS bridge and adds an additive onPartial / streamReply contract.
---

## Status

Accepted (2026-05-26). Implementation reconfirmed on 2026-08-12 against the adapter registry, WeCom and Personal WeChat adapters, shared capability map, and their contract tests.

## Context

The Platform Connectors subsystem (ADR-0009 / 0025) shipped Telegram / Discord /
Slack / Lark / OneBot as native TS adapters over a Rust transport bridge, all
plugging into the same `ConnectorBus` → outbound-runner → A2UI ⇄ IM bridge →
audit / health pipeline. The two reserved-but-unbuilt platform kinds were
`wecom` and `wechat-oa`.

This ADR builds **Enterprise WeChat (企业微信 / WeCom)** — the officially supported,
no-public-IP path — as Phase 1, and **Personal WeChat (个人微信)** over the iLink
half-official gateway (QR login + Bearer token + HTTP long-poll) as Phase 2.

## Decision

### Transport — 智能机器人 long connection, reusing the generic WS bridge

WeCom's 智能机器人 (AI bot) long connection
(`wss://openws.work.weixin.qq.com`, docs `path/101463`) is **plain JSON text
frames** — no protobuf, no message-level encryption, no IP whitelist. Auth is a
single `aibot_subscribe { bot_id, secret }` frame. This is fundamentally simpler
than Lark's binary protobuf long-conn, so the WeCom adapter **reuses the generic
`connectors_ws_*` bridge** (`ctx`/`connectorsWsOpen` → Rust-owned socket, the
same one OneBot forward-WS uses) instead of a bespoke Rust handler like
`lark_ws.rs`. **No new Rust code.** Media decryption (AES-256-CBC, IV = first 16
bytes of the per-message `aeskey`) runs in the renderer via Web Crypto.

The adapter lives in `lib/connectors/adapters/wecom/`:

| File | Responsibility |
| --- | --- |
| `protocol.ts` | Frame types + pure builders (`aibot_subscribe` / `_msg_callback` / `_event_callback` / `_respond_msg` / `_respond_welcome_msg` / `_respond_update_msg` / `aibot_send_msg` / `ping` / media upload) + `classifyInboundFrame`. |
| `parse.ts` | `aibot_msg_callback` → `NormalizedInboundEvent` (text/markdown/image/voice/file/video/mixed; single + group; group ⇒ `selfMentioned`). Owns the `WeComConversationRef` (chatId / chatType / userId / **reqId** / sourceMsgId). |
| `serialize.ts` | Split outbound segments into a markdown body + interactive A2UI surfaces + media (pure). |
| `a2ui-mapper.ts` | A2UI surface → `template_card` (button_interaction), records callback bindings; `template_card_event` → `ConnectorCallbackEvent`. |
| `media.ts` | AES-256-CBC decrypt + 3-step `aibot_upload_media_*` upload. |
| `welcome.ts` | Operator-configured `enter_chat` greeting (no hardcoded string). |
| `index.ts` | Factory: WS lifecycle, 30 s `ping`, backoff reconnect, req_id↔ack RPC, reply/proactive dispatch, streaming. |

### Streaming replies — additive `onPartial` / `streamReply`

The 智能机器人 streams replies by repeatedly updating one message via
`aibot_respond_msg { msgtype: "stream", stream: { id, content, finish } }`. To
drive this we add two **additive, backward-compatible** seams:

- `RunAndCaptureOptions.onPartial?(accumulatedText)` (`lib/claude/run-and-capture.ts`)
  — fired as the assistant text grows. Default `undefined` ⇒ no behaviour change
  for chat or other connectors. Forwarded through `safe-send-prompt.ts`.
- `PlatformAdapter.streamReply?(req)` (`types/connectors/adapter.ts`) — optional;
  only WeCom implements it.

`lib/connectors/runtime.ts` wires them: when the target adapter implements
`streamReply`, it passes `onPartial` to `runAndCapture` so partial text streams
live (`finish:false`) via `bus.getAdapter(...)`. The **authoritative** final
message still flows through the durable `enqueueOutbound` queue, finishing the
**same** stream id (derived from `conversationRef.reqId`) with `finish:true` — no
duplicate message. Partials are best-effort; a `streamReply` failure never aborts
the turn.

### Reply vs proactive push

A reply must reuse the triggering callback's `req_id` (valid ~10 min). `send()`
inspects `conversationRef.reqId`: live ⇒ reply (`aibot_respond_msg`, streamed),
otherwise ⇒ proactive `aibot_send_msg` (targeting `chatid`, `chat_type` 1 single /
2 group). This covers scheduled / workflow / quiet-hours outbound. **Constraint:**
WeCom only delivers proactive pushes to a chat the user has previously messaged
the bot in — surfaced in the settings form.

### Interactions, welcome, media

`template_card_event` is acked within the 5 s window via
`aibot_respond_update_msg`, then routed through
`ConnectorBus.dispatchConnectorCallback` (Slack pattern: `triggerId = actionId`,
surface recovered via the binding table). `enter_chat` sends the operator's
configured welcome via `aibot_respond_welcome_msg`. Inbound images are decrypted
and inlined as base64 best-effort so the model receives them; outbound media is
uploaded for a `media_id`.

### Wiring + capabilities

`adapter-registry.ts` (`case "wecom"` + `buildWeComAdapter`, reads `botId` /
`secret` from the keyring), `platform-meta.tsx`, the new `wecom-config.tsx`
form, the adapters-tab create menu, the config-detail dispatcher, the generic
Send-Test + whoami panels (probe hidden — WeCom has no getMe), and i18n in both
locales. `WECOM_A2UI_CAPABILITY` marks Button + display primitives native and
degrades the rest to `plainTextMirror`.

### Phase 2 — Personal WeChat (`wechat-personal`) over iLink

No official API exists, so we ride the iLink (智联) half-official gateway
(`ilinkai.weixin.qq.com`, the OpenClaw "微信 ClawBot" feature). It is an HTTP
long-poll channel, not WebSocket, so `lib/connectors/adapters/wechat-personal/`
mirrors the WeCom split but with an HTTP loop instead of a socket:

- `protocol.ts` — endpoints (`/ilink/bot/{get_bot_qrcode,get_qrcode_status,getupdates,sendmessage}`),
  the `X-WECHAT-UIN` anti-replay header + `Authorization: Bearer <bot_token>`,
  `getupdates`/`sendmessage` body builders, item types (1=text…5=video), `ret -14`.
- `auth.ts` — the QR-login flow (`requestLoginQr` → `pollLoginStatus`), used by
  the settings wizard before an adapter row exists; HTTP injected for tests.
- `index.ts` — `start()` runs a long-poll loop via `ctx.tauri.httpRequest`,
  advancing the `get_updates_buf` cursor; `ret -14` ⇒ degraded + re-scan.
- `parse.ts`/`serialize.ts` — normalise inbound; outbound is **text-only** v1.
- `media.ts` — a self-contained AES-128 inverse cipher (FIPS-197-verified)
  because the encryption is **AES-128-ECB**, which Web Crypto does not support
  (only CBC/CTR/GCM). Inbound images are decrypted + inlined best-effort.

**Reply-only**: every `sendmessage` must echo the inbound `context_token`; there
is no proactive-send path, so `send()` rejects when no live token exists, and
`streamReply` is not implemented (iLink has no streaming). The login wizard
(`wechat-personal-config.tsx`) surfaces the **account-ban risk** and
session-expiry re-scan prominently — it's an unofficial integration.

## Revision — 2026-08-18 (ADR-0131 cross-shell inbox relay)

The adapters here are unchanged, but who can *drive* them is not. An operator on a phone or in a browser now approves drafts and sends manual replies for these connectors through the relay (ADR-0131), which reaches the host that owns the adapter rather than acting locally. Two consequences worth naming:

- The edited segments the operator approves on a phone are what get delivered — `connector_approve_draft` carries an optional `segments` array, so the draft's own text is no longer silently authoritative.
- Nothing in this ADR's method matrix changes for a thin client: an unsupported method is still unsupported, and the relay surfaces the same capability errors it would on the desktop.

## Consequences

- WeCom works with no public ingress, no message crypto, no IP whitelist — the
  most robust official path — and rides the entire existing bus pipeline (audit,
  health, quiet-hours, policy, A2UI).
- The shared AI loop gains a streaming seam usable by future streaming-capable
  platforms, at zero cost to non-streaming ones.
- `edit` / `delete` / `typing` / `history.fetch` are unsupported (no protocol
  frame); proactive push is gated by WeCom's "user must message first" rule.
- Personal WeChat is reply-only with documented ban-risk; outbound media (which
  would need ECB *encryption* + the CDN upload handshake) is out of scope in v1,
  but inbound media — including image decryption — is handled.
