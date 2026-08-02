---
"cognia-next": patch
---

Plugin output-token caps are now enforced. `ctx.ai.chat()` passed the plugin-facing `maxTokens` straight through to the AI SDK, which has expected `maxOutputTokens` since v5 — the key was silently dropped, so every plugin-set cap went unapplied and generations ran to the model's own limit. Also prepares the AI SDK 7 upgrade by moving system prompts out of the `messages` array into the top-level instructions option across the sidecar dispatcher, the standalone (BYOK) chat engine, the agent executor, the team runtime, the plugin AI API, and the VS Code LM shim. Anthropic prompt-cache breakpoints are carried per-segment so cache hit rates are unchanged, and a system message interleaved mid-history keeps its original position rather than being hoisted.
