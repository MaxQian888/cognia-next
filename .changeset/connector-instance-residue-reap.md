---
"cognia-next": patch
---

Removing a bot now removes what it left behind.

Deleting a connector dropped its own row and its heartbeats. Everything else it had ever written kept its rows forever: the audit trail, the inbound dedup ledger, still-queued outbound messages, inbox telemetry, the Lark session and entry-context tables, the per-conversation policy overrides, and the directory entries for people only that bot had ever seen. None of it was reachable afterwards — every screen that shows it is opened from the bot — and none of it had a cleanup of its own, so it just accumulated invisibly. Still-queued outbound messages were worse than invisible: the delivery runner kept retrying them against a bot that no longer exists.

Two things are deliberately kept. Your conversation history stays — removing a bot removes the bot, not the record of what people said to it. And the attachment cleanup ledger stays, because those entries exist to finish deleting encrypted files the removal could not confirm; dropping them would leave the files on disk with nothing left that knows what they are.
