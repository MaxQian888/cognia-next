---
"cognia-next": patch
---

Goal panel polish. The judge model/provider are now chosen from a provider-model picker in Settings → Goals → Defaults (reusing the shared model catalog) instead of two free-text fields — a typo can no longer silently downgrade the judge to the default provider, and a stored model that no configured provider offers is flagged inline. The Settings → Goals → Tracker card's "customise this agent" hint is now a working button that deep-links to Settings → Characters (previously a dead end). And when subgoal generation has no model with a usable API key, it shows the accurate non-retryable "needs a model with an API key" notice instead of the generic retryable error.
