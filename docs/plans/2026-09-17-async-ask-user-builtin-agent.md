# Non-blocking inline questions for the built-in agent (W4-B)

| Field         | Value                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Status        | Proposal — no code yet                                                                         |
| Author · Date | Cognia engineering · 2026-09-17                                                                |
| Scope         | `ask_user` tool surface, `plugin_tool_exec` wire, transcript card reuse                        |
| Source        | Codex 0.152–0.154 parity plan (`~/.devin/plans/plan-5646c9d3cd54ea72.md`, W4 Phase B)          |
| Related       | W4-A shipped the card + opt-in (`inlineQuestions`), `chat-send-bridge`, `data-async-questions` |
| Reviewers     | Agent runtime, chat UX                                                                         |

> **Executive summary**
>
> - **Change:** Add a non-blocking sibling to `ask_user` — the tool call resolves **immediately** with a "question posted" result, while the renderer mounts the existing `AsyncQuestionsCard` on a `data-async-questions` part appended to the in-flight assistant message. The user's answer arrives as an ordinary user message (W4-A path: `chat-send-bridge` → steer/queue).
> - **Reason:** The Anthropic tool loop **cannot** continue a turn with a pending `tool_use` — every tool call needs a `tool_result` before the next model call. Codex's `delivery:"async"` exists because its protocol separates items from turns; our equivalent is a tool call that returns fast plus a card that answers asynchronously. This is a renderer-side change only — no sidecar or protocol surgery.
> - **Impact:** One new manifest entry, one branch in `handlePluginToolExec`, one part-append hook in the chat controller, the existing card reused unchanged. Same opt-in gate (`inlineQuestions.enabled`) governs visibility.
> - **Decision:** Whether the async tool is a _separate name_ (`ask_user_async`) or a `mode` flag on `ask_user` — see Q1.

## 1. The constraint that shapes everything: `tool_use` must be answered before the model can continue

Codex's `delivery:"async"` question works because its protocol projects `Session → Turn → Item` — an `agentMessage` item can carry `questions` while the turn keeps running independently. The built-in agent has no such separation: `ask_user` is a `plugin_tool_exec` round-trip whose `execute()` awaits the user's answer (`stores/agent/ask-user-store.ts` → `runAskUser` → `enqueue` → pending promise). The sidecar's Anthropic loop cannot emit the next model call until that tool result returns — the block is **structural**, not a timeout to relax.

Therefore "non-blocking" for the built-in agent means: **the tool call resolves immediately and the answer is delivered later through a different channel.** The W4-A card already implements that channel — its answer path is an ordinary user message (`> question\n\nanswer` via `chat-send-bridge`), which inherits steer-mid-turn / queue-at-boundary semantics. Nothing new needs inventing.

### Goals and acceptance

| Goal                             | Acceptance evidence                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Turn never waits on the question | tool result returns in <1s; agent continues working                                  |
| Answer reaches the model         | card answer → `sendChatMessage` → steer if turn live, queued input otherwise         |
| Zero new UI surface              | reuses `AsyncQuestionsCard` + `data-async-questions` part + `inlineQuestions` opt-in |
| Blocking `ask_user` untouched    | existing tests green; manifest unchanged                                             |

### Non-goals

- **Mid-turn answer delivery as a tool result.** Not possible in the Anthropic tool loop — the pending `tool_use` ends the model's ability to act until resolved. Documented constraint, not a bug.
- **CLI/TUI parity.** The `data-async-questions` part is a React surface; the TUI would need its own renderer (deferred — TUI keeps the blocking dialog).
- **Multi-question batching.** `ask_user` asks one question; the async variant keeps that shape.

## 2. Design

```text
model calls ask_user_async {question, options?, allowText?}
        │
        ▼ sidecar: plugin_tool_exec (unchanged wire)
renderer handlePluginToolExec:
        │
        ├── append {type:"data-async-questions", data:{questions, answers:{}}, itemId:toolUseId}
        │   to the streaming assistant message (new hook point, ~10 lines)
        │
        └── resolve immediately: result = "Question posted inline. The user may answer
             asynchronously; their reply will arrive as a normal message."
        │
        ▼ model continues the turn — no wait
user answers card → sendChatMessage(sessionId, "> q\n\nanswer")
        ├── turn still live  → steer (existing)
        └── turn finished    → queued → next turn (existing)
```

### 2.1 Where the part gets appended

`plugin_tool_exec` already carries `sessionId` + `toolUseId`. The renderer branch resolves the in-flight assistant message from the chat store and appends the part — same mechanism the W8-3 mapper uses, minus the RPC fields (no `requestId` → card takes the message-answer path automatically). If the message isn't found (edge: tool executed but stream already committed), the part lands on a synthetic trailing message or the tool resolves as a no-op-with-text — fallback text keeps the question visible.

**Alternative considered — render inside the tool part:** `mcp-tool-card.tsx` already maps tool names to card components; registering `ask_user_async` there would render the card inside the tool row. Rejected: tool parts render input/output, not interactive answer state — the card's `data.answers` persistence contract assumes `data-async-questions` parts, and retrofitting tool-part persistence costs more than a part append.

### 2.2 The opt-in

Same `inlineQuestions.enabled` gate. When off: `ask_user_async` still resolves immediately, but instead of a card the question text lands as an appended text part — identical degrade semantics to W4-A. The model is told in the tool description that async mode is best-effort ("the user may not answer").

## 3. Failure and edge semantics

| Case                            | Behavior                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| User never answers              | Tool already resolved — no leak. The agent proceeds with whatever it had.                                          |
| User answers after turn ends    | Ordinary send → next turn. Card marks itself answered on send.                                                     |
| Session/teardown mid-question   | Card is transcript state, not a waiter — survives; answering later still works (it just becomes a normal message). |
| `inlineQuestions` off           | Text degrade; still non-blocking.                                                                                  |
| `chat-send-bridge` unregistered | `sendChatMessage` returns false → `sendFailed` toast, question stays answerable.                                   |

## 4. Work plan (small)

| #   | File                                                     | Change                                                                                                                                             |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `lib/claude/ask-user-tool.ts`                            | `buildAskUserAsyncManifestEntry` + `ASK_USER_ASYNC_TOOL_NAME`; description explicitly says "returns immediately, answer arrives as a user message" |
| 2   | `lib/claude/plugin-tool-ipc.ts`                          | new branch before `ask_user`: emit a renderer event or store signal to append the part, resolve with the ack text                                  |
| 3   | `hooks/chat/use-claude-chat-controller.ts`               | hook the part-append into the streaming assistant write                                                                                            |
| 4   | `components/chat/message-parts/async-questions-card.tsx` | none — reused as-is                                                                                                                                |
| 5   | i18n                                                     | reuse `chat.asyncQuestions.*`; no new strings except possibly the tool-result ack (model-facing, not UI)                                           |
| 6   | tests                                                    | ipc branch test (immediate resolve + part appended), controller wiring, card unchanged                                                             |

## 5. Decisions required

- **Q1 — Tool shape.** Separate `ask_user_async` name vs a `mode:"async"` arg on `ask_user`. **Recommendation: separate name** — the manifest's `timeoutMs: 0` comment exists because the blocking variant can wait arbitrarily long; splitting keeps the blocking contract obvious and lets the model pick deliberately.
- **Q2 — Should the model be told the question is async?** Yes — the tool description and the immediate result both say "answer arrives as a user message" so the model doesn't re-ask or assume an answer already landed.
- **Q3 — Same-turn visibility.** Should the card append while the turn streams (recommended — matches Codex's mid-turn feel) or only after turn end? Appending mid-turn is the whole point.

## Review record

| Reviewer | Scope | Verdict | Date |
| -------- | ----- | ------- | ---- |
| —        | —     | pending | —    |

## Sources

- `lib/claude/ask-user-tool.ts` (manifest + blocking semantics)
- `stores/agent/ask-user-store.ts` (`runAskUser` pending-promise contract)
- `lib/claude/plugin-tool-ipc.ts:865-873` (the `ask_user` branch)
- `sidecar/dispatch/ai-sdk-tools.mjs:756-799` (`pluginToolToAiSdkTool` — `execute` awaits `plugin_tool_response`)
- `components/chat/message-parts/async-questions-card.tsx` + `hooks/chat/chat-send-bridge.ts` (W4-A reuse)
- `components/chat/message-parts/mcp-tool-card.tsx` (tool→card registry, rejected option)
