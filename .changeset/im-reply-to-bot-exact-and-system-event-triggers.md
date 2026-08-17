---
"cognia-next": minor
---

IM connectors: the `reply-to-bot` trigger rule now matches only replies to messages the bot actually sent (parent author from the platform payload on Telegram/Discord/Matrix, otherwise resolved from a new delivered-message ledger) instead of any reply; reaction / poke / join-request / bot-lifecycle platform events are now audited under their own kinds, appear in the conversation activity log, and can drive workflows through the new **On platform event** (`trigger.connector.system`) trigger with kind and "only the bot's own messages" filters.
