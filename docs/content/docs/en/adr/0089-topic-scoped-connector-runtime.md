---
title: "0089 — Topic-Scoped Connector Runtime"
description: "Durable topic isolation, activation, dispatch, recovery, and capability-aware live presentation for IM connectors."
---

# ADR 0089 — Topic-Scoped Connector Runtime

- **Status:** Accepted
- **Date:** 2026-07-22
- **Schema:** Dexie v120
- **Supersedes:** ADR-0009's in-memory inbound FIFO/recovery model and ADR-0025's execution-progress presentation path

## Context

An IM channel is not necessarily one conversation. Feishu groups may contain multiple topics,
each with its own participants, reply anchor, history window, active execution, approvals, and
progress card. Reconstructing a destination by splitting `conversationKey`, hydrating whole-chat
history, or committing dedup before execution makes topic leakage and crash-time message loss
possible. Presentation APIs also differ: CardKit can stream and mutate components, while some
platforms can only edit a message or append milestones.

## Decision

Core connector code treats `conversationKey` as an opaque stable identity. Adapters provide a
`ConversationAddress`; every inbound refreshes a persisted `ConversationDeliveryTarget` containing
the address, adapter-owned `ConversationReference`, source message id, and latest reply anchor.
Sessions, execution bindings, history, cards, callbacks, approvals, and proactive sends use that
same target.

Admission is resolved in `ConnectorBus` after durable job creation. Policies are
`mention_each`, `mention_activates`, `always`, and `direct_only`. A verified Feishu topic defaults
to first-mention activation with a sliding 24-hour expiry; the parent group and sibling topics are
independent. Existing `atResponseStrategy` values have an explicit compatibility mapping. Feishu
never accepts unmentioned traffic until an operator starts a probe and the transport actually
observes an unmentioned group event.

Inbound execution is represented by `connectorInboundJobs`. `queue` preserves independent FIFO
turns. `steer` is used only while the live runtime reports a safe injection boundary; otherwise the
original payload and attachments remain durable and are replayed individually at the next safe
boundary. A running lease that expires becomes `recovery_required` because model/tool side effects
cannot be assumed resumable. The default pending cap is 100 per conversation; overflow remains
history-only with an audit diagnostic.

History adapters may implement `fetchHistoryPage(target, typedCursor, options)`. Feishu accepts
only a timestamp/page-token cursor, requests chat-level pages, then retains events whose parsed
topic identity exactly equals the requested target. Message ids are never passed as timestamps.

Execution presentation uses one durable runner. The former `TurnActivityDispatcher` is removed.
Each adapter declares a `ConnectorRuntimeCapabilityMatrix`; isolation, attribution, authorization,
dedup, durable dispatch, and recovery never degrade. Presentation may degrade from CardKit/native
streaming to message editing, append-only milestones, or final-only delivery.

For Feishu, CardKit JSON 2.0 uses stable element ids. Text previews use element content streaming;
phase/actions use component mutations; full replacement is reserved for structural/final changes.
Every mutation persists `{sequence, uuid, operation}` before sending and reuses it until
acknowledged. Interaction conflict `200810` is retried, sequence/missing/expired entities are
reconciled or recreated, cards are compacted below 30 KB, and entities older than 14 days are
recreated. Completion freezes the card and sends the authoritative final answer as a normal reply
in the same topic.

## Revision — 2026-08-18 (ADR-0131 cross-shell inbox relay)

Two clarifications the relay forced into the open:

- **Reply quoting and follow-up bubbles are independent.** Quoting decides whether an outbound message references the message that triggered it; follow-up bubbling decides how a multi-part answer is split. A relayed manual reply carries `replyTo` through `connector_enqueue_outbound` unchanged, so a phone reply quotes exactly like a desktop reply.
- **Inbound *notifiability* is now a shared predicate.** `lib/connectors/inbound-notifiability.ts:isNotifiableInboundEvent` — extracted from the Notification Center bridge — is what both the desktop notification path and the relay's `connector://message-added` push consult. Edits, deletes, reactions and the bot's own outbound echoes are excluded in exactly one place, so the two surfaces can never disagree about what counts as a new message.

## Consequences

- Dexie v120 adds `connectorConversationStates` and `connectorInboundJobs` and extends execution
  presentation state with durable CardKit mutation metadata.
- Topic scope is a shared collaborative Agent context while every message retains sender identity.
- Adapter/topic activation and active-run dispatch (`queue` or `steer`) are independent settings;
  `queue` is the default.
- Static bot menus remain suitable for status/new/help commands, not live progress. CardKit is the
  durable progress surface. `push_follow_up` bubbles are a direct-chat-only
  temporary enhancement; groups and topics explicitly fall back to CardKit buttons.
- Plugin adapters may omit rich features, but must expose an explicit degradation contract and
  must require reconciliation after ambiguous delivery when the remote platform has no idempotency.
