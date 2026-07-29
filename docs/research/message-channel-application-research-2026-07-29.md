# Message channel applicability in Cognia

Retrieved: 2026-07-29

Scope: primary-source review of Cognia's message model, chat and external-Agent pipelines,
streaming/event transports, provider/runtime routing, rendering, connectors, workflows, Tauri host,
and existing concepts named `channel`. All conclusions below are based on repository source and
accepted ADRs; design recommendations are explicitly marked as inferences.

External protocol references:

- OpenAI Harmony response format:
  https://developers.openai.com/cookbook/articles/openai-harmony
- Vercel AI SDK `UIMessage`:
  https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message

## Executive conclusion

**There is one high-value application, but it should not be introduced as a generic
`MessageChannel` field.** Cognia already receives Codex app-server assistant-message phases
(`commentary` and `final_answer`), but converts `commentary` into `thinking`, then converts
`thinking` into a persisted `reasoning` part. That makes user-facing progress narration
indistinguishable from model reasoning and renders it under the "Thinking" disclosure. The
behavior is explicit and tested:

- Codex remembers `agentMessage` item phases because delta notifications omit them
  (`lib/ai/agent/external/codex-app-server-client.ts:341-355`).
- A `commentary` delta emits `ExternalAgentEvent { type: "thinking" }`, while a final-answer delta
  emits `message_delta` (`lib/ai/agent/external/codex-app-server-client.ts:1374-1397`).
- Commentary items intentionally skip the normal assistant-message start/end envelope
  (`lib/ai/agent/external/codex-app-server-client.ts:1568-1583`,
  `lib/ai/agent/external/codex-app-server-client.ts:1669-1706`).
- The test contract asserts exactly this collapse
  (`lib/ai/agent/external/codex-app-server-client.test.ts:441-481`).
- The external-event projection turns both `thinking` and thinking deltas into the same
  `reasoning` part (`lib/ai/agent/external/event-to-parts.ts:107-137`), which the renderer presents
  through the `Reasoning` UI (`components/chat/message-renderer.tsx:1071-1090`).

The recommended concept is therefore a narrowly named **assistant output phase**, for example:

```ts
type AssistantOutputPhase = "commentary" | "final"
```

or a dedicated event such as:

```ts
{ type: "commentary_delta"; messageId?: string; text: string }
```

Reasoning remains a separate semantic track. Do not call this type `MessageChannel`: `channel`
already has at least seven incompatible meanings in the project, including an IM scope, an
execution rail, a Tauri event topic, a notification delivery target, a plugin IPC topic, a session
exposure context, and a workflow presentation destination.

## 1. What `channel` already means

| Existing meaning                | Source of truth                                                                                                                       | Why it must stay separate                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IM conversation container/scope | `ChannelKind` and `ChannelDescriptor` in `types/connectors/event.ts:54-63`                                                            | Identifies private/group/channel/thread topology and platform ids, not model output semantics.                                                                                                                                         |
| Stable topic-aware destination  | `ConversationAddress` and `ConversationDeliveryTarget` in `types/connectors/event.ts:15-38`                                           | A single IM channel can contain multiple independently isolated topics. ADR-0089 states this explicitly (`docs/content/docs/en/adr/0089-topic-scoped-connector-runtime.md:13-28`).                                                     |
| Agent execution rail            | `ExecuteAgentChannel = "sidecar" \| "text"` in `lib/ai/agent/agent-executor.ts:215-228`                                               | Describes where execution ran and whether tools exist; ADR-0090 says the text channel is only a completion fallback, not another runtime (`docs/content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md:13-25`). |
| Sidecar/Tauri event topic       | `claude://message`, `a2ui://dispatch`, `agent://message` in `src-tauri/src/claude/sidecar.rs:17-30`                                   | Names a transport subscription, not a field inside an assistant message.                                                                                                                                                               |
| Notification fan-out target     | `NotificationChannel = "center" \| "toast" \| "os" \| "push" \| "im"` in `types/notifications/index.ts:18-24`                         | Selects durable/ephemeral delivery surfaces.                                                                                                                                                                                           |
| Plugin IPC topic                | `send/broadcast/on(... channel ...)` in `types/plugin/plugin-messaging.ts:120-139`                                                    | Routes plugin-to-plugin payloads and has its own ACL/size/history behavior.                                                                                                                                                            |
| Session exposure context        | `SessionExposureChannel` in `lib/chat/session-exposure.ts:6-18`                                                                       | Governs whether embedded sessions may appear in lists, sync, or export.                                                                                                                                                                |
| Workflow progress destination   | Per-destination `ChannelState`, keyed by adapter and conversation, in `lib/connectors/a2ui-bridge/workflow-progress-runner.ts:69-115` | Tracks edit/append presentation state for an IM destination.                                                                                                                                                                           |
| UI historical name              | Desktop `ChannelList` imports conversation grouping and session models (`components/desktop/channel-list.tsx:35-80`)                  | It is the conversation sidebar; it is not a protocol abstraction.                                                                                                                                                                      |

This vocabulary density creates a concrete duplication risk: adding
`StoredMessage.channel = "commentary"` would be easy to misread as an IM channel, runtime rail, or
delivery target. A semantic name such as `AssistantOutputPhase` or an event discriminator such as
`commentary_delta` is materially safer.

## 2. External semantic boundary

OpenAI Harmony defines three assistant-output channels:

- `final` is intended for the end user;
- `analysis` is raw chain-of-thought and must not be shown to end users;
- `commentary` carries function calls and can also carry a user-visible preamble before tools.

This distinction confirms that commentary is not reasoning. It also creates a second, safety-critical
requirement for Cognia: a provider's `analysis` channel must never be mapped blindly into the current
visible `reasoning` part. The renderer deliberately keeps completed reasoning readable
(`components/chat/message-renderer.tsx:1071-1090`), and persistence writes parts verbatim
(`lib/db/messages.ts:259-270`).

The concern is immediately relevant rather than hypothetical:

- Groq's built-in provider defaults to `openai/gpt-oss-120b`, and the catalog also exposes
  `openai/gpt-oss-20b` (`packages/provider-types/src/built-in-provider-catalog.ts:603-639`).
- Hugging Face also exposes `openai/gpt-oss-120b`
  (`packages/provider-types/src/built-in-provider-catalog.ts:2984-2994`).
- The sidecar wraps models with `<think>` extraction and turns extracted content into reasoning
  parts (`sidecar/dispatch/protocol-adapters/ai-sdk-adapter.mjs:165-181`).

The Vercel AI SDK `UIMessage` contract already provides `parts`, custom data parts, metadata, and a
standard `reasoning` part, but no generic Harmony-style output-channel field. This supports a
project-owned additive part/event type instead of a new top-level message abstraction.

**Inference:** preserve the three semantics independently at the provider/adapter boundary:

| Provider semantic | Cognia projection                               | Default policy                                  |
| ----------------- | ----------------------------------------------- | ----------------------------------------------- |
| `analysis`        | internal-only ephemeral reasoning/provenance    | Do not render or persist raw chain-of-thought.  |
| `commentary`      | `commentary_delta` / `data-commentary` progress | User-visible; persist only if transcript policy |
| `final`           | normal `text` part                              | User-visible and authoritative                  |

For APIs that expose only summarized reasoning, the existing reasoning UI can remain useful. The
adapter must identify that provenance explicitly; the UI must not guess from text.

## 3. Existing message and persistence model

### 3.1 Canonical persisted chat shape

The actual chat model is AI SDK `UIMessage` plus parts:

- `StoredMessage` persists `role` and `parts`, with sender and connector metadata layered around
  that shape (`packages/agent-config-types/src/index.ts:1654-1717`).
- `listMessages` reconstructs a `UIMessage`, hoisting selected stored columns into metadata
  (`lib/db/messages.ts:96-147`).
- `persistMessages` writes changed `UIMessage` parts back to Dexie and is optimized for token-stream
  updates (`lib/db/messages.ts:149-289`).
- ADR-0057 records the established rule: terminal rich state belongs on `messages.parts`; a second
  table would duplicate an existing persistence channel and require re-joining on load
  (`docs/content/docs/en/adr/0057-chat-rendering-completeness.md:20-22`,
  `docs/content/docs/en/adr/0057-chat-rendering-completeness.md:36-48`).

`types/core/message.ts` is not a competing canonical model. It explicitly says it only re-exports
AI SDK `UIMessage` and supplies minimal migration aliases (`types/core/message.ts:1-27`).

**Inference:** if commentary must survive reload, store it as an additive message part (for
example a typed `data-commentary` part) inside the existing assistant `UIMessage`. Do not add a
Dexie table and do not create another top-level Message model.

### 3.2 Built-in chat stream

The built-in path is already centralized:

1. `sendPrompt` selects `agent_send` for a frozen execution spec or the compatibility
   `claude_send` command (`lib/claude/ipc.ts:32-45`).
2. Desktop receives `claude://message`; mobile/headless receive the same topic and payload through
   the companion event WebSocket. Both feed one per-session serialized queue
   (`hooks/chat/use-claude-chat.ts:764-819`).
3. `applySdkEvent` maps SDK frames into `UIMessage.parts`; open sessions update through a
   per-session mirror and coalesced store/persistence writes, while closed sessions write directly
   to Dexie (`hooks/chat/use-claude-chat.ts:2649-2667`,
   `hooks/chat/use-claude-chat.ts:2764-2799`).

The newer canonical event contract also has only `text-delta` and `thinking-delta`; there is no
commentary phase (`packages/agent-config-types/src/agent-execution.ts:216-265`). Envelopes already
carry identity, sequence, runtime, and event payload (`packages/agent-config-types/src/agent-execution.ts:267-285`).

**Inference:** a cross-runtime implementation should extend the canonical payload vocabulary with
`commentary-delta` (or a typed assistant-output event with `phase`) rather than creating a fourth
Tauri topic. The existing envelope already supplies ordering and identity.

### 3.3 External-Agent stream

External-Agent output follows a parallel but compatible projection:

1. Codex app-server notifications become `ExternalAgentEvent`s.
2. `ExternalAgentManager` forwards each event to caller, listeners, hooks, and tracing without
   rewriting it (`lib/ai/agent/external/manager.ts:2048-2099`).
3. The chat hook pre-allocates one assistant message, applies every event to parts, updates the
   session live, and persists the final list (`hooks/chat/use-claude-chat.ts:1422-1467`,
   `hooks/chat/use-claude-chat.ts:1479-1509`).
4. `ExternalAgentEvent` currently offers `message_delta` with `delta.type = "text" | "thinking"`
   and a separate `thinking` event, but no user-visible progress/commentary event
   (`types/agent/external-agent.ts:1567-1599`,
   `types/agent/external-agent.ts:1627-1655`,
   `types/agent/external-agent.ts:1719-1725`).

This is the best insertion seam: preserve Codex's phase when adapting the provider event, then let
the existing manager and chat hook carry it to the part mapper.

## 4. Provider and model routing are not message phases

Provider/model selection uses "channel" in the connector sense:

- Per-conversation overrides are keyed by `conversationKey` and contain independent provider,
  model, and reasoning overrides (`lib/db/connector-types.ts:614-633`,
  `lib/db/connector-types.ts:669-694`).
- `resolveSendOptions` puts the IM conversation override above session, bot, character, and app
  defaults (`lib/claude/build-options.ts:980-1008`,
  `lib/claude/build-options.ts:1031-1059`).
- Sidecar dispatch now obeys a frozen `runtimeAdapter`; only legacy sends infer Anthropic versus AI
  SDK from provider id (`sidecar/dispatch/index.mjs:1-16`, `sidecar/dispatch/index.mjs:35-53`).
- The runtime registry deliberately separates adapter capability from provider identity
  (`sidecar/dispatch/runtime-adapter.mjs:1-16`, `sidecar/dispatch/runtime-adapter.mjs:37-57`).

**Decision:** do not attach commentary/final semantics to provider ids, model settings, or
`ExecuteAgentChannel`. Codex app-server has a native phase today; other providers may not.
Advertise output-phase support as an optional runtime/adapter capability and never fabricate
commentary by relabeling reasoning.

## 5. Connector and workflow paths

Connectors already have a complete message-addressing model:

- `NormalizedInboundEvent` carries platform, adapter, message id, opaque conversation key,
  structured conversation address, sender, `ChannelDescriptor`, segments, mentions, timestamp, and
  adapter-owned `channelData` (`types/connectors/event.ts:89-139`).
- `deliveryTargetFromEvent` converts that event into the stable topic-aware destination used later
  for outbound (`types/connectors/event.ts:141-158`).
- The bus creates a durable inbound job before admission/routing and queues long model turns per
  conversation (`lib/connectors/bus.ts:428-459`, `lib/connectors/bus.ts:591-618`,
  `lib/connectors/bus.ts:848-860`).
- The runtime projects an accepted inbound into the same `StoredMessage` model and scopes platform
  identity by adapter plus conversation key (`lib/connectors/runtime.ts:431-515`).
- Connector-triggered workflows receive the entire normalized event and can filter by
  `channelKind` (`lib/connectors/bus.ts:1311-1374`).
- IM-triggered workflow runs already persist their origin and delivery target in
  `WorkflowTriggeredFrom` (`types/workflow/visual.ts:752-789`).
- Agent text and A2UI are projected into outbound message segments and durably enqueued with an
  idempotency key (`lib/connectors/runtime.ts:1209-1244`).

ADR-0089 intentionally separates invariant execution semantics from degradable presentation:
native streaming may fall back to edit, append-only milestones, or final-only delivery
(`docs/content/docs/en/adr/0089-topic-scoped-connector-runtime.md:37-59`).

**Inference:** commentary can be useful to connectors and workflows only as a progress input:

- map commentary to execution-run progress/activity;
- allow the existing presentation runner and connector capability matrix to choose native stream,
  edit, append, or no live presentation;
- keep `final` as the authoritative normal reply;
- never persist commentary as a second inbound/outbound conversation or use it to construct a new
  `conversationKey`.

This reuses the existing progress fan-out and prevents commentary from generating duplicate IM
messages on platforms that only support final delivery.

## 6. Tauri and transport impact

No new transport channel is required:

- The Rust sidecar reader parses each stdout JSON line and routes only special top-level event types
  to dedicated topics; ordinary payloads continue through `claude://message`
  (`src-tauri/src/claude/sidecar.rs:483-552`).
- Canonical `agent_event` envelopes already use `agent://message`
  (`src-tauri/src/claude/sidecar.rs:527-533`).
- The host abstraction publishes unchanged channel names and payloads to either the desktop WebView
  or the headless companion event bus (`src-tauri/src/claude/host.rs:1-21`,
  `src-tauri/src/claude/host.rs:33-47`, `src-tauri/src/claude/host.rs:163-168`).

**Decision:** put output phase in the event payload. A separate
`commentary://message` topic would duplicate subscription, ordering, replay, mobile mirroring, and
permission-sensitive lifecycle logic for no gain.

## 7. Concrete opportunities, ordered

### P0 — Correct Codex commentary semantics

Recommended.

1. Add a typed external event for commentary/progress, retaining `messageId` so deltas stay
   attributable.
2. In `CodexAppServerAdapter`, emit that event for `phase === "commentary"` instead of `thinking`.
3. Keep `item/reasoning/*` mapped to `thinking`; do not merge the two.
4. Map commentary to an additive message part inside the existing assistant message.
5. Render it as visible progress narration, distinct from the brain/reasoning disclosure.
6. Preserve final-response extraction as final text only.

The change is semantically corrective and localized to seams that already exist.

### P0 — Guard raw provider analysis

Required before adding Harmony-native channel preservation or broadening gpt-oss reasoning parsing.

1. Add adapter-level provenance for raw analysis versus provider-supplied reasoning summaries.
2. Ensure raw analysis cannot become a normal text part, visible reasoning part, message preview, or
   persisted transcript part.
3. Keep only the minimum ephemeral analysis state required during an active tool loop; do not replay
   it as ordinary conversation history after the final response.
4. Add provider fixture tests covering interleaved analysis, commentary, tool calls, and final text.

### P1 — Carry the distinction through canonical Agent events

Recommended when external runtimes are brought fully under ADR-0090's canonical event contract.

Add `commentary-delta` or an assistant-output event with `phase: "commentary" | "final"`. Keep
`thinking-delta` unchanged. This lets chat, workflows, Team execution, tracing, and headless clients
consume one stable semantic without learning Codex-specific `MessagePhase` strings.

### P1 — Preserve source phase during Codex session import

Recommended, guarded by source presence.

The rollout importer treats every `response_item` of type `message` as user or assistant text and
does not inspect `payload.phase` (`lib/session-import/adapters/codex.ts:240-261`). In contrast, live
thread hydration explicitly excludes `agentMessage` items whose phase is `commentary`
(`lib/ai/agent/external/codex-app-server-client.ts:3276-3308`). If a rollout message includes phase,
the importer should preserve commentary as the same commentary part (or intentionally omit it);
it should not silently promote progress narration into final assistant prose.

### P2 — Use commentary as optional execution presentation

Recommended only behind runtime and connector presentation capabilities.

Connector and workflow runs can project commentary into the existing execution-run activity stream,
then reuse per-destination `ChannelState`. Platforms with final-only presentation simply omit live
commentary and still receive the final reply. This is an enhancement, not a correctness dependency.

## 8. Decisions to avoid

1. **Do not add `channel` to `StoredMessage`.** A turn may interleave commentary, tools, reasoning,
   and final text; phase is part-level/event-level, not message-level.
2. **Do not create a commentary Dexie table or store.** `messages.parts` already provides durable
   round-trip persistence and ADR-0057 explicitly rejects a parallel persistence channel.
3. **Do not map commentary to reasoning.** Commentary is intended for the user; reasoning is a
   distinct model-output track and may have different disclosure/security policy.
4. **Do not map reasoning to commentary for providers that lack commentary.** That would leak or
   mislabel chain-of-thought and invent cross-provider parity.
5. **Do not create a Tauri event topic per output phase.** Ordering and identity belong to the
   existing event envelope.
6. **Do not reuse connector `ChannelKind`, `conversationKey`, provider/model override, plugin IPC
   channel, notification channel, or execution channel types.** They solve orthogonal routing
   problems.
7. **Do not send every commentary update as a normal IM message.** Use the existing progress
   presentation degradation policy and keep the final reply authoritative.
8. **Do not map Harmony `analysis` to the current visible `reasoning` part.** Raw analysis has a
   stricter disclosure policy than reasoning summaries and Cognia currently persists and renders
   reasoning verbatim.

## 9. Minimal recommended contract

The smallest coherent model is:

```ts
type ExternalAgentEvent =
  | {
      type: "commentary_delta"
      timestamp: Date
      sessionId?: string
      messageId?: string
      text: string
    }
  | ExistingExternalAgentEvent

type CommentaryPart = {
  type: "data-commentary"
  data: {
    text: string
    state: "streaming" | "done"
    source?: "codex"
  }
}
```

For the canonical event contract:

```ts
type CanonicalAgentEvent =
  { kind: "commentary-delta"; delta: string; messageId?: string } | ExistingCanonicalAgentEvent
```

The `source` field is optional diagnostic provenance, not a routing switch. Renderers should key
behavior on the semantic part/event type. Connectors should consume commentary through execution
presentation, never by inspecting the provider name.

## Final recommendation

Proceed with a focused **assistant commentary/progress track**, starting with the existing Codex
app-server loss point. Name it by semantics (`AssistantOutputPhase`, `commentary_delta`,
`CommentaryPart`) rather than `MessageChannel`. Reuse:

- `ExternalAgentEvent` for live delivery;
- `UIMessage.parts` / `StoredMessage.parts` for persistence;
- canonical `AgentEventEnvelope` for cross-runtime transport;
- existing Tauri event topics for desktop/headless/mobile forwarding;
- execution-run presentation for connector/workflow progress;
- the normal text part and outbound reply path for the authoritative final answer.

This captures the value of message channels without introducing another overloaded routing
abstraction or duplicating any current transport, persistence, connector, or workflow subsystem.
