---
"cognia-next": patch
---

Make the plain-web cloud companion usable on an account with real history. Cold boot used to drain the entire message database over the WAN — the sync handler kept pulling 500-row pages until every historical message had crossed, so the time to a rendered sidebar grew with account age and every fresh browser profile paid it again. Boot now transfers only the newest global tail, and opening a conversation hydrates that conversation's complete transcript on demand through a bounded pager; incremental pulls still drain every row after the durable cursor, so nothing is folded away.

The session list and the message page behind them stop materializing rows they discard: both read through their indexes and stop one row past the page, and the session list returns a list projection rather than whole session records — a 50-row sidebar no longer ships every session's system prompt. Older companion servers without the history RPC keep working on the synced tail.
