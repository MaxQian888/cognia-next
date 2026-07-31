---
"cognia-next": patch
---

Fix the Kimi/Moonshot provider connection test. The Anthropic-wire probe posted to `<base>/messages` instead of `<base>/v1/messages`, which 404s on every Anthropic-compatible host, and it probed with a hard-coded Claude model that Kimi does not serve. Built-in providers now also fall back to their catalog base URL and default model instead of failing with "Unknown provider" when settings hold no base URL. Covers both Kimi surfaces: the Kimi API platform (`api.moonshot.cn/v1`, OpenAI wire) and Kimi For Coding (`api.kimi.com/coding/`, Anthropic wire).
