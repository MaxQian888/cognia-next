---
"cognia-next": patch
---

Preserve `@` conversation/message references end-to-end: live and queued steer turns now keep `metadata.mentions`/`promptPreamble` so backlinks stay intact; shared sessions carry reference metadata through `message.created` sync and conversion; `room_send` RPC and host-state intents accept `citations`/`promptPreamble` and stamp them on persisted rows; typed `@` tokens resolve to citations in room sends; composer drafts persist and restore staged reference chips; converting a history to a shared session warns when it embeds snapshots of other conversations (with a live-send heads-up), and reference staging/send/stale transitions are covered by privacy-safe telemetry.
