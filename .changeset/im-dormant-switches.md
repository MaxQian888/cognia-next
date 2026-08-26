---
"cognia-next": minor
---

IM connectors: the settings that existed only as types now exist as controls. Media consent (`MediaModelGrant`) can be granted from an in-chat card, from a provider-scoped and expiring editor on the conversation, or bot-wide in the permissions card — until now nothing could write it, so inbound images were withheld from the model forever. A2UI is tri-state per bot and per conversation instead of forced on for every IM turn, inbound OCR has a per-conversation switch, and a muted or quiet CONVERSATION now stops the turn instead of only holding the delivery. The conversation header's group-admission chip reports the policy the bus actually admits on rather than a field the settings UI stopped writing.
