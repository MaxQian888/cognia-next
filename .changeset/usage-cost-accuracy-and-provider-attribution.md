---
"cognia-next": patch
---

Usage and cost figures are now correct in four situations where they previously
were not. Turns that wrote to a 1-hour prompt cache are billed at the real 2×
rate instead of the 5-minute 1.25× rate, so long-lived cached sessions no longer
under-report their spend. Turns that cost money but reported no fresh tokens —
a fully cache-served reply, or a provider that returns a cost without a token
breakdown — are recorded instead of being silently dropped from workflow,
agent-team, connector, and goal surfaces. A model whose price is simply unknown
is now distinguishable from one that is genuinely free, rather than both showing
as $0.00. And spans now name the provider that actually served the turn: every
non-Anthropic provider used to be reported as "openai", which mis-attributed
cost and latency for DeepSeek, Zhipu, Ollama, OpenRouter, and every other
provider in per-provider rollups and exported traces.

Pricing for the Claude 5 family (Opus 5, Sonnet 5, Fable 5) and Claude Opus
4.8 / 4.7 has been added to the built-in fallback table.
