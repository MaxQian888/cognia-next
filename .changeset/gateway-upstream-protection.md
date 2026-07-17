---
"cognia-next": minor
---

Gateway upstream protection: the built-in LLM gateway now cools down a pooled
account after a 429/529 (parsing `Retry-After` / Anthropic
`anthropic-ratelimit-unified-reset`, with a configurable header-less fallback),
permanently disables an account on 401 / quota-exhausted / org-disabled errors,
caps concurrent in-flight requests per gateway key and per upstream account
(with a bounded queue), sticks a conversation to one deployment via a derived
session-affinity key (prompt-cache aligned), strips risky client fields
(`service_tier`, `store`, `safety_identifier`, …) from upstream requests, and
adds a loopback-only upstream self-check. A new Settings card exposes these
knobs and lists currently parked/disabled accounts. Reasoning-effort virtual
model ids (`gpt-5-high`) now inherit their base model's pricing.
