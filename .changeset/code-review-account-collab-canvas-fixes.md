---
"cognia-next": patch
---

Fix account, collaboration and Canvas defects found in code review: legacy PBKDF2 Browser Vaults could no longer be unlocked (the salt was wiped before the derivation read it), `account_bind_person` validated Logto tokens against a renderer-supplied issuer, shared-chat message authorship could be forged through the event payload, every pre-existing companion device was denied after upgrade, mobile users could not change their account password, Canvas share links were permanently unavailable, and the password throttle was bypassable by omitting the account id.
