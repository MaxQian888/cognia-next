---
"cognia-next": minor
---

Let a paired phone or web companion change what a bot actually does. `adapter_update_policy` now carries the composition axes, group activation, the A2UI tri-state, the host-capability ceiling and the inbound trigger policy alongside mode, mute and quiet hours — the mobile policy sheet already rendered several of those controls, sent them, and had the whole request rejected by the contract, so it reported "saved" while the bot kept its old policy. An explicit `null` now means "unpin this", the sheet's local mirror is derived from the payload it relays, and a malformed field is refused instead of silently dropped.
