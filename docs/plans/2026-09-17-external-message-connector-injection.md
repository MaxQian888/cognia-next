# Inject inbound connector messages into a live external-agent turn (Codex `ExternalMessage`)

| Field         | Value                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Status        | Proposal — no code yet                                                                           |
| Author · Date | Cognia engineering · 2026-09-17                                                                  |
| Scope         | `lib/connectors/` inbound pipeline, `lib/ai/agent/external/` manager + Codex adapter surface     |
| Source        | Codex 0.154 parity plan (`~/.devin/plans/plan-5646c9d3cd54ea72.md`, item W3)                     |
| Related       | W2 shipped `sendExternalMessage` on the adapter; ADR-0131 cross-shell relay; ADR-0009 media gate |
| Reviewers     | Connectors, agent-runtime, security                                                              |

> **Executive summary**
>
> - **Change:** When a connector-bound chat session has a _live turn running on an external-agent lane_ (today: Codex), deliver the admitted inbound message to that turn through `sendExternalMessage` (`toolOutput`) instead of queueing a parallel built-in turn.
> - **Reason:** Codex 0.154's `ExternalMessage` is the first channel with the right trust semantics for remote IM content — **tool-level authority, untrusted, recorded as function output**. `turn/steer` would promote a remote sender's words to _user-level_ instructions, and the current FIFO path either waits out the turn or races it on a second runtime.
> - **Impact:** One adapter option (`joinActiveTurnOnly`), one manager passthrough + capability predicate, one new branch in the connector live-steer coordinator, one audit reason. No schema migration, no wire-format invention, no UI surface.
> - **Decision:** Injection is _ambient context_ — the IM sender gets no guaranteed reply from this path. Reply delivery remains the connector AI loop's job when no external turn is live. See Q1.

## 1. Context: inbound connector messages have exactly one lane today, and it is the wrong one mid-turn

**Situation.** Every inbound connector event follows one path [CONFIRMED]:

```
adapter transport → bus.ts → durable inbound job → admitConversationEvent
  → enqueueRouteHandlerTurn (per-conversation FIFO)
  → runRouteHandlerTurn → safeSendPrompt (PII gate) → runAndCaptureAssistantReply
  → built-in sidecar sendPrompt
```

Two mid-turn shortcuts already exist, both scoped to the built-in runtime:

- `live-steer.ts` — the per-conversation `ActiveConnectorRun` registry. A queued-behind message with `activeRunDispatchMode === "steer"` is stored, re-admitted, then pushed into the running sidecar turn via `steerSession`. It **refuses every non-`anthropic` run** (`live-steer.ts:41`).
- Chat composer steer → `mgr.steerSession(externalAgentId, undefined, text)` (`use-claude-chat-controller.ts:1007`) — Codex `turn/steer`, _user-level_ authority, text-only.

**Complication.** When the operator is driving a connector-bound session on the Codex lane in chat, an inbound IM message mid-turn has no correct destination:

- FIFO: the message waits for a turn it is not queued behind (the Codex turn is not in `turnQueues`), then launches a **built-in sidecar turn on the same session while Codex is still running** — two runtimes on one transcript.
- `turn/steer`: wrong authority. A remote IM sender's words would arrive as the operator's user input.
- Do nothing: the agent works blind to fresh context that Codex designed `ExternalMessage` to carry.

**Question.** Can inbound content reach a live Codex turn at the correct authority level, with the existing durability/admission guarantees intact?

**Answer.** Yes — `sendExternalMessage` (landed in W2) maps the connector event onto `turn/start`'s `toolOutput` field; the server folds it into the running turn like a steer, recorded as function output. The remaining work is the seam: session mapping, capability gating, and a fallback that preserves today's durable-job semantics.

### Goals and acceptance

| Goal               | Baseline                                       | Acceptance evidence                                            |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| Correct authority  | steer = user-level; IM text must not be        | wire capture shows `toolOutput`, not `input`, on `turn/start`  |
| Live-turn only     | `sendExternalMessage` can _start_ a turn today | injection attempted only while the adapter reports a live turn |
| No message loss    | durable job already exists before admission    | refused/failed injection replays through the FIFO unchanged    |
| PII parity         | live-steer path runs `hasNoLeakingPiiDeep`     | identical gate runs before external injection                  |
| Capability honesty | CLI <0.151 has no `toolOutput`                 | unsupported adapters fall through, never throw                 |

### Non-goals

- **Connector AI loop on external agents.** The loop is deeply sidecar-bound (`sendPrompt`, capture, writable roots, recovery anchors). That is a separate proposal.
- **Reply relay.** An injected message's effect on the running turn's output goes wherever that turn's output already goes (the UI). Auto-replying to IM from an injection is explicitly out — see Q1.
- **Binary media.** `content` is text only in v1; the media-model gate's `local_extract_only` semantics carry over unchanged.
- **Host-lane (remote-run) injection.** The remote decision channel cannot carry tool output; skipped, same boundary as W8-3.

## 2. Current state — confirmed facts

| Fact                                                                                                                                        | Evidence                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sendExternalMessage` exists on the Codex adapter: `toolOutput` on `turn/start`, folds into an active turn or starts one, hard-gated ≥0.151 | `codex-app-server-client.ts:1622` (W2)                                                                     |
| No manager-level passthrough — `manager.ts` exposes `steerSession`/`supportsSteering` but nothing for external messages                     | `manager.ts:772-791`                                                                                       |
| Chat session → native thread id is already stored                                                                                           | `ChatSession.externalAgentSession: {agentId, sessionId}` (`packages/agent-config-types/src/index.ts:2485`) |
| Which agent drives a session's _live_ turn is tracked per session                                                                           | `sessionExternalLane` / `setSessionExternalLane` (`hooks/chat/steer-runtime.ts:143-154`)                   |
| Live-steer coordinator is Anthropic-only and registry-scoped to connector-loop runs                                                         | `live-steer.ts:41`, activation at `runtime.ts:1647`                                                        |
| Admission + PII gates run before any model contact and are reused verbatim                                                                  | `conversation-admission.ts`, `bus.ts:1340-1343`                                                            |
| Refused live steer replays through the durable job as `steer-replay` — the fallback contract already exists                                 | `bus.ts:1360-1366`                                                                                         |
| Inbound content → model input is normalized once, with media policy applied                                                                 | `inboundEventToSendContent` (`runtime.ts:500`)                                                             |

## 3. Design: a third live-delivery branch, same durability contract

```text
inbound event (durable job created, admission passed)
        │
        ▼
enqueueRouteHandlerTurn ── connector run active & anthropic? ──► live steer (existing)
        │
        ▼ NEW: session's live lane is external?
        │    sessionExternalLane(session.id) → agentId
        │    session.externalAgentSession.sessionId → native thread
        ▼
PII gate (hasNoLeakingPiiDeep) ──► mgr.sendExternalMessage(
        agentId, nativeSessionId,
        { toolName: "connector_inbound", namespace: adapterId, content })
        │
   ┌────┴─────────────┐
   ▼                  ▼
 accepted          refused / no live turn / unsupported
 job completes          │
 (audit:               ▼
  inbound_external_injected)   existing FIFO turn (unchanged)
```

### 3.1 Adapter: `joinActiveTurnOnly` option

`sendExternalMessage` today starts a turn when none is active — correct for a generic producer, wrong here: the connector must never silently spawn a Codex turn whose output has no outbound relay. Add `options.joinActiveTurnOnly?: boolean`; when set and no turn is live on that thread, the method **returns a sentinel (`{injected:false}` or throws `NoActiveTurnError`) instead of calling `turn/start`**. The version gate and `toolName` validation stay as-is.

### 3.2 Manager: passthrough + capability predicate

Mirror the `steerSession`/`supportsSteering` pair:

- `supportsExternalMessage(agentId): boolean` — `typeof adapter.sendExternalMessage === "function"`. (Version <0.151 still resolves inside the adapter and surfaces as a refused injection — no capability lie.)
- `sendExternalMessage(agentId, sessionId | undefined, message, options?)` — resolves the native session the same way `steerSession` does when `sessionId` is omitted; connector call sites always pass the explicit `externalAgentSession.sessionId`.

### 3.3 Connector seam: extend `ConnectorLiveSteerCoordinator`

`handle()` currently early-returns `unavailable` when `run.provider !== "anthropic"`. Generalize:

- `ActiveConnectorRun.provider` becomes a lane descriptor: `"anthropic" | { kind: "external", agentId: string }` (or a new `externalAgentId` field — smaller diff, no union churn).
- On `external`: PII-gate → `deps.inject(sessionId, event)` where `inject` resolves `externalAgentSession` on the bound session and calls `mgr.sendExternalMessage` with `joinActiveTurnOnly`.
- Return `accepted:true` on success → `bus.ts` completes the durable job with a new audit reason `inbound_external_injected` (new `ConversationAuditReason` or `fields.reason` — follow the existing `inbound_live_steered` precedent).

**Registry gap to close:** `activate()` only covers connector-AI-loop runs. A _UI-driven_ Codex turn on a connector-bound session never registers. Two options — see Q2.

### 3.4 Content mapping

`CodexExternalMessage.content` is a string or function-output items. v1 sends a **single text envelope** built from the already media-gated segments:

```
[connector telegram] Alice (@alice): <text / ocrText / withheld markers>
```

Reuse `inboundEventToSendContent`'s block output flattened to text — the withheld/OCR markers are already phrased for the model, and binary bytes never cross this gate either way. `toolName: "connector_inbound"`, `namespace: <adapterId>`.

## 4. Security and authority

- **Tool-level authority is the feature, not a limitation.** An injected message cannot grant permissions, cannot be read by the model as operator instruction, and lands in history as function output. This is strictly safer than `turn/steer`, which would put a remote sender's words on the user-instruction level.
- **PII gate parity.** `hasNoLeakingPiiDeep({plainText, segments})` runs before injection, same predicate the bus applies to the Anthropic live steer (`bus.ts:1341`). A block falls back to the durable turn, which applies `safeSendPrompt` — fail-closed either way.
- **No reply promise.** Injected content produces no IM-bound reply; the durable job is marked completed so the message still lands in session history (`storeInbound` runs first, mirroring the live-steer order).

## 5. Failure, ordering, and recovery

| Case                                    | Behavior                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Turn completes between check and inject | `joinActiveTurnOnly` refuses → `accepted:false` → FIFO replay                                    |
| CLI <0.151                              | adapter throws version error → caught → `accepted:false` → FIFO                                  |
| PII block                               | `inbound.policy_blocked` audit → job stays durable → normal turn                                 |
| Process exit mid-turn                   | `settlePendingServerRequests` settles the turn; job was already durable → replays on resume      |
| Double delivery                         | `storeInbound` writes once; job completion marks it — same idempotency as `inbound_live_steered` |

## 6. Alternatives considered

| Option                                                 | Verdict  | Why                                                                                                                                             |
| ------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn/steer` (`steerSession`)                          | Rejected | Promotes remote content to user-level authority; also text-only.                                                                                |
| Queue-only (status quo)                                | Rejected | The live-turn window is exactly when injection is valuable; queuing also misroutes to a built-in turn while Codex runs the session.             |
| Interrupt + restart                                    | Rejected | Destroys the running turn; ExternalMessage exists precisely to avoid this.                                                                      |
| Route the whole connector AI loop onto external agents | Deferred | Multi-week scope (capture contract, writable roots, recovery anchors, outbound relay). This proposal only delivers _into_ a live external turn. |

## 7. Work plan

| #   | Package                                                     | Change                                                                             | Verification                                             |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `codex-app-server-client.ts`                                | `joinActiveTurnOnly` option + sentinel refusal                                     | adapter test: refused when no turn live; folds when live |
| 2   | `manager.ts` + `protocol-adapter.ts`                        | `supportsExternalMessage` + passthrough                                            | manager unit tests                                       |
| 3   | `live-steer.ts` + `install-connector-runtime.ts` + `bus.ts` | external-lane branch, `inject` dep, audit reason                                   | coordinator tests; bus-level steer/inject routing tests  |
| 4   | —                                                           | i18n/changeset (user-visible: inbound message now reaches a running Codex session) | `lint:i18n`, changeset                                   |

## 8. Decisions required

- **Q1 — Reply semantics.** Should an injected message ever produce an IM reply? Recommendation: **no** — injection is ambient context; the IM sender gets a reply only via the normal connector AI-loop path when no external turn owns the session. Documenting "your message was seen but may not be answered" beats silently dual-writing replies.
- **Q2 — Registry scope.** Extend the live-steer registry to consult `sessionExternalLane` for UI-driven external turns (option A, wider coverage, needs the lane lookup injected as a dep since `live-steer.ts` is `lib/` and the map lives in `hooks/chat/`), or restrict injection to connector-loop runs that themselves run on external lanes (option B, dead code today since the loop is sidecar-only)? **Recommendation: A** — the primary value is injecting into UI-driven Codex turns; B ships nothing reachable.
- **Q3 — Event types.** Inject all admitted inbound kinds (`create` only today), or also `edit`/`reaction` events as context? Recommendation: `create` only in v1, matching `isNotifiableInboundEvent` precedence.

## Review record

| Reviewer | Scope | Verdict | Date |
| -------- | ----- | ------- | ---- |
| —        | —     | pending | —    |

## Sources

- `lib/ai/agent/external/codex-app-server-client.ts:1622` (`sendExternalMessage`, W2)
- `lib/connectors/bus.ts:1336-1383` (live-steer interception + FIFO replay)
- `lib/connectors/live-steer.ts` (coordinator contract)
- `lib/connectors/runtime.ts:500` (`inboundEventToSendContent`), `:1647` (registry activation)
- `lib/ai/agent/external/manager.ts:772-791` (`steerSession` resolution pattern)
- `hooks/chat/steer-runtime.ts:143-154` (`sessionExternalLane`)
- `packages/agent-config-types/src/index.ts:2485` (`externalAgentSession`)
- `lib/connectors/conversation-admission.ts` (admission contract)
