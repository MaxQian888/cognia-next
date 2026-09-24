---
"cognia-next": patch
---

Secret store no longer fails credential reads while it is still starting up, reports a locked system keychain once instead of flooding boot with errors, and shows an Unlock button at startup that reloads subscriptions, proxy settings, speech keys and plugin secrets once the keychain is unlocked.
