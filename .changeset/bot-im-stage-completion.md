---
"cognia-next": minor
---

Connector bot turns now render like real runs in IM. Feishu conversations get a native chain-of-thought message (`im/v1/message_cot`) with interleaved reasoning segments and tool-call rows, batched and throttled to the API contract, with automatic fallback to the card timeline when the tenant lacks the capability. Final answers ship as Card 2.0 result cards — state header, quote of the triggering message, requester/elapsed/interrupted footer — with `![](path|url|data:)` images uploaded to `image_key`s and a structured `resultCard` metadata block exposed to the `onConnectorOutbound` plugin hook.

The `ask_user` tool now works where it is invoked: a connector-initiated or scheduled turn projects an interactive bilingual question card into the IM conversation (option buttons, free-text field, skip), routes presses through durable callback bindings and the unified authorization guard, supports multi-select toggle repaints, freezes the card on answer/skip/expiry, mirrors the wait onto a durable run interrupt, and falls back to the desktop dialog for desktop turns. TTL and abort backstops mean a forgotten card can never wedge a turn.

Group turns see the ambient messages between the last assistant reply and the trigger plus the replied-to quote, injected as model-only context. Bot deliveries originating in IM now register an execution-run binding, so they surface the same run card, approvals, and COT as any governed run. Also fixes Dexie transaction scopes missing `notificationProjectionWork`, which had broken all interrupt creation.
