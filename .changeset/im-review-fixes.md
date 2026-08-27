---
"cognia-next": patch
---

IM connectors: fixes to the media-consent card, axis routing and credential prefill found in review. The consent card's buttons now name the sender's platform id, so the person whose photo was withheld can actually press them, and the grant is written for a conversation that has no override row yet instead of failing silently — the card was previously a dead end in both cases. The card is only asked where a turn will actually run, is not re-asked while a live grant is in force, and is re-asked after a failed projection instead of going quiet for the rest of the process.

Routing now treats the conversation as one layer: a chat that pinned `mode` keeps it, where a bot-wide `defaultAutonomy` used to outrank it and keep a `/mode manual` chat answering. Clearing a field over the companion relay works — `JSON.stringify` was deleting the clears, so the mode chip, the trigger override and the A2UI switch silently did nothing from a phone or web companion.

Credential prefill: Slack, Telegram and Discord now refuse to save when a required credential has been emptied, instead of deleting it from the keyring and taking the bot offline. Slack and Lark record every keyring account they own, so deleting a bot purges its OAuth credentials rather than orphaning them. Clearing a rate-limit or cooldown box no longer commits `0` (a bot that answers nobody), the bot-wide trigger-policy editor no longer discards an in-progress edit when anything else writes the adapter row, and the mobile policy sheet no longer shows axis defaults it cannot actually clear on the host.
