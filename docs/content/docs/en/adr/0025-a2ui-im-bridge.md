---
title: "ADR-0025: A2UI ⇄ IM Connector Bridge"
description: "A2UI projection, interaction, and fallback support across built-in IM connectors"
---

# ADR-0025: A2UI ⇄ IM Connector Bridge

- **Status**: Accepted
- **Date**: 2026-05-18
- **Schema bump**: v37 → v38 (`inboundLedger` widens with `namespace`, new `connectorCallbackBindings` table, `adapterInstances` gains `lastKnownCapabilities`)
- **Supersedes**: parts of ADR-0009 (Phase 2 stubs for A2UI projection, callback round-trip, computer-use isolation)

## Context

ADR-0009 shipped the five platform connectors (Telegram / Discord / Slack /
Lark / OneBot) with text + media segments and the `MessageSegment` opaque
`card` type as the only escape hatch for rich content. A2UI (ADR-0017) is the
agent's structured-UI format with 60+ component kinds, but at the time it
ran only inside the browser/Tauri renderer — IM channels saw zero of it.

The IM-completion track (Phase 2) addresses this by making A2UI a
first-class transport across every connector. Two directions need wiring:

- **Outbound**: assistant produces A2UI surfaces via the
  `builtin:a2ui-bridge` MCP server; the connector subsystem projects each
  surface into the platform's native rich content (Slack Block Kit / Lark
  Interactive Card / Telegram InlineKeyboardMarkup / Discord Embed +
  Components / OneBot CQ-code text-with-actions list).
- **Inbound callback**: user interaction (Slack button / Lark card tap /
  Telegram callback_query / Discord component interaction) round-trips back
  to the assistant as if it had fired inside the browser renderer.

## Decision

### Capability-aware downgrade

Each adapter implements `PlatformAdapter.a2uiCapability(): A2UICapabilityMatrix`
(`types/connectors/capability.ts`). The matrix declares each catalogue
component kind as one of:

- `native` — rendered with the platform's native rich element.
- `simulated` — a supported multi-step interaction, such as a reply or modal submission.
- `fallback` — degraded to `plainTextMirror` (always safe).
- `unsupported` — adapter refuses; assistant SHOULD NOT emit on this channel.

`build-options.ts:resolveSendOptions` reads the matrix at every send,
appends a `buildCapabilityPromptSection(platform, matrix)` to
`appendSystemPrompt`, and forces `a2uiEnabled = true` for any IM session
with a non-empty matrix. The assistant sees explicit guidance about which
kinds will degrade on the current channel and avoids the unsupported ones.

### `MessageSegment.a2ui`

A new segment variant carries A2UI surfaces across the connector bus:

```ts
{
  type: "a2ui",
  surfaceId: string,
  content: A2UISegmentContent,  // {components, dataModel, rootId, ...}
  plainTextMirror: string,        // always present — degradation safety net
}
```

`types/connectors/segment.ts:segmentsToPlainText` projects an `a2ui`
segment to its `plainTextMirror`, so trigger matchers (keyword,
slash-command, regex) still work uniformly across platforms.

### Per-platform A2UI mappers

Adapters own platform-specific projection through a shared toolkit
(`lib/connectors/adapters/_shared/a2ui-mapper.ts`):

- `walkA2UISurface(surface, visit)` — depth-first traversal with cycle
  short-circuit.
- `buildActionId(surfaceId, componentId, action)` + `truncateActionId` —
  deterministic id generation under platform-specific length caps.
- `recordCallbackBinding` / `resolveCallbackBinding` — Dexie-backed
  binding rows that round-trip the long action_id when the platform
  forces opaque ids (Telegram's 64-byte cap, Discord's 100-char cap).
- `generatePlainTextMirror(surface)` — fallback text projection.

#### Support audit (2026-09-08)

The per-component source of truth is each adapter's `capability.ts`; a
platform supporting A2UI does not imply it supports the complete browser
component catalog. The implementation and regression-test audit covers
all 11 built-in connectors:

| Connector | Presentation and interaction |
| --- | --- |
| Lark | Interactive Cards, buttons and supported form controls; unsupported kinds fall back. |
| Slack | Block Kit with supported buttons and form controls; edits retain native blocks. |
| Discord | Embeds and message components; text inputs use modal simulation; edits retain embeds and components. |
| Telegram | Text/media plus inline buttons; text inputs use ForceReply simulation. |
| Matrix | Formatted HTML; interactive surfaces use replies correlated to their own event and conversation. |
| WeCom | First interactive surface becomes a native template card; additional surfaces retain text mirrors. |
| DingTalk | Markdown projection and links; action callbacks and inputs are fallback, not simulated interactions. |
| WeChat Personal | Text plus simulated Button actions via digits 1–9; other input controls remain fallback. A replacement menu invalidates stale digits. |
| OneBot | Text and images; interactive controls degrade to text. |
| QQ Official | A2UI text mirror fallback. |
| WeChat OA | A2UI text mirror fallback. |

The shared reply extractor accepts tool-created surfaces, complete `a2ui`
or JSON fences, and raw JSON. It preserves surrounding prose and leaves
invalid payloads intact. The mapper resolves display bindings against the
surface data model, traverses footer/tab/accordion/action references, and
omits hidden subtrees. Callback metadata remains unchanged.

Slack input blocks enable `dispatch_action`; text input dispatches on Enter,
and callback parsing retains text and selected checkbox values. Slack documents
the default as `false` in its [Input block reference](https://docs.slack.dev/reference/block-kit/blocks/input-block/).
Slider, Tabs, Accordion, Dialog, and Drawer remain fallback in the current
Slack implementation; there is no implemented modal or multi-step flow for them.

Telegram text edits combine supported text calls and their inline keyboards;
edits requiring media or ForceReply cannot use that text-edit path. Matrix
rejects edits containing several interactive surfaces before network delivery,
because a reply to the replacement message would otherwise be ambiguous.

Verification covers serialization, outbound routing, and callback binding
with local fixtures. Credentialed delivery and real-client interaction
were not exercised by this audit. Native controls do not imply complete
property parity, including disabled-state behavior, with the browser renderer.

### Inbound callback channel

`ConnectorBus.dispatchConnectorCallback(event: ConnectorCallbackEvent)` runs
the 4-step pipeline: dedup (namespace `"callback"` on `inboundLedger`) →
binding lookup (`resolveCallbackBinding`) → audit
(`callback.received` / `callback.deduped` / `callback.unbound`) → handler.

The handler — `lib/a2ui/connector-callback-handler.ts` — appends the action
to `a2uiEventHistory` and calls `runConnectorDigestTurn` from
`scheduled-outbound.ts` so the assistant's next turn sees the click as if
it had happened in the renderer. Browser-side and IM-side users converge
on the same AI loop.

#### Revision (2026-08-31): the handler is no longer the only destination

The step above is now the DEFAULT arm, not the only one. A binding whose
`kind` names a product-authored card short-circuits before the model turn,
because the card already says what each button does and spending a turn
asking the model to re-interpret it is both slower and less reliable:

| `kind`                | Handled by                                    |
| --------------------- | --------------------------------------------- |
| `issue_action`        | `lib/issues/im/callback-handler.ts`            |
| `wf_approve` / cancel | `lib/a2ui/workflow-approval-handler.ts`        |
| workflow fan-out      | `lib/a2ui/workflow-fanout-handler.ts`          |
| `notification_action` | `lib/notifications/im-callback-handler.ts`     |
| everything else       | `lib/a2ui/connector-callback-handler.ts`       |

The vocabulary itself lives in `types/connectors/interaction.ts`, which is
the storage of record for what a `kind` means. This ADR deliberately does
not restate the list per kind: it would be a second copy that drifts.

A 5th A2UI MCP tool `a2ui_handle_connector_action` joins the bridge
(`lib/a2ui/mcp-tool-schemas.ts`) and is the projection endpoint when a
custom callback handler wants to inject an action onto a specific surface.

### Computer-use isolation

`applyComputerUseTools` (`lib/claude/computer-use-tools.ts`) gates on
`imSession === true`: when the session is bound to a platform connector
and `ConversationOverrideRow.allowComputerUse !== true`, the helper
short-circuits before attaching any native Anthropic tool. An inbound
Telegram message cannot accidentally fire screenshot / mouse / keyboard
actions on the host.

### Inbound A2UI from platform rich content

`lib/connectors/adapters/_shared/inbound-a2ui-dispatch.ts:projectInboundToA2UI`
dispatches an inbound platform payload to the matching per-platform
`inbound-to-a2ui.ts` mapper, producing an `InboundA2UIBlock`
(`inbound-a2ui-types.ts`) that is persisted onto
`StoredMessage.metadata.inboundA2UI` and rendered by
`components/chat/message-parts/inbound-a2ui-renderer.tsx` so the inbox
shows the platform's native rich structure.

> Note: an earlier draft of this ADR described a
> `lib/connectors/a2ui-bridge/segments-to-a2ui.ts:segmentsToA2UI` that
> folded a `MessageSegment[]` into an A2UI Surface. That module was never
> wired in (zero callers) and has since been **removed as dead code**; the
> `InboundA2UIBlock` path above is the real inbound projection, and it is
> not the inverse of the outbound `a2ui-to-segments.ts` projection.

## Consequences

- The `MessageSegment` union now has 13 variants (added `a2ui`).
- Schema v38 — every existing connector deployment migrates on next open.
- The five adapters all return capability matrices; assistant prompt is
  larger by ~120 tokens per IM-bound turn (capability + A2UI primer).
- `Computer Use` no longer fires from IM sessions by default — a major
  safety hardening. Operators who want IM-driven automation must opt in
  per conversation via the Conversations settings tab.
- Telegram callback_query, Discord INTERACTION_CREATE, Slack
  block_actions / view_submission, Lark
  im.interactive_message.action_triggered_v1 all route through one
  ConnectorBus channel — no per-platform fork in the assistant code path.

## References

- ADR-0009 — platform connectors baseline
- ADR-0017 — A2UI protocol
- ADR-0010 — Claude subscription OAuth (pattern reused for the connector
  OAuth driver)
- `lib/connectors/adapters/_shared/a2ui-mapper.ts` — shared toolkit
- `lib/connectors/a2ui-bridge/capability-evaluator.ts` — capability →
  prompt section
