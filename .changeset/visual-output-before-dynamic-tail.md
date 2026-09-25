---
"cognia-next": patch
---

With prompt cache optimization on, the per-turn memory and twin context stay at the very end of the system prompt again, so the stable part before them is cached. The "how to show something" guidance was being appended after that per-turn text, which left the whole appended prompt uncached on Anthropic models.
