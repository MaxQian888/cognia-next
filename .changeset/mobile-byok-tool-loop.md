---
"cognia-next": minor
---

Standalone (BYOK) chat on mobile now runs a real tool loop: a phone with no paired desktop can search the web, fetch pages and call plugin tools instead of being a plain completion. Reuses the same renderer tool catalog, executor, and PII gate as the paired path — including when the Anthropic native-web-tools preference is on, which previously left a standalone turn with no web tools at all, because it swaps them for natives that only exist on the paired Agent-SDK path. Letting the model load skills mid-turn is the separate `Skill` self-invocation preference, off by default; standalone honours it like the paired path does.
