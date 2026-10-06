---
"cognia-next": minor
---

Account sync preview, phase 3a: chats, messages, characters, skills, memories and shared settings now sync between your enrolled devices, end-to-end encrypted. Changes arrive live, with a fallback when the live connection is blocked, and the same field edited on two devices resolves to the newer edit. When a device and your account both hold data, the account page asks whether to merge or use the account's data, and saves a backup first. Two switches choose what syncs. A Cognia server enrolls and syncs from its own terminal with `cognia-agent account-sync` after `cognia-agent logto login`. Still off unless the account sync build flag is on.
