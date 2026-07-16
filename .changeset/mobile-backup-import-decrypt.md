---
"cognia-next": patch
---

Fix mobile backup restore being impossible: the phone's export path always encrypts, but the import path fed the encrypted envelope straight into the migrator, which rejects encrypted input — so restoring a phone's own backup always failed. Import now decrypts with the passphrase field, asks for the passphrase when it's missing, and reports a wrong passphrase with actionable copy instead of a generic failure.
