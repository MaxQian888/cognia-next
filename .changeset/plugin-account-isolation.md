---
"cognia-next": patch
---

Plugins are now bound to the account that loaded them. Previously a plugin's granted permissions, pending consent prompts and on-disk state were process-wide, so they survived locking or switching to a different local profile. Locking or switching now rejects pending consent, unloads running plugins and clears every grant, API calls fail closed while no account is unlocked, and plugin state is stored per account on disk so one profile can never be handed another's data.
