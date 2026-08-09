---
"cognia-next": minor
---

Live voice now runs on a unified multi-provider layer instead of the OpenAI-only WebRTC session. OpenAI, Gemini and Grok are selectable per deployment under a new Speech setting, each with its own region (CN / Global, never crossed automatically) and its own rollout switch. Sessions are minted through the AI SDK's realtime adapters, so provider quirks — endpoints, session config, socket URLs, event shapes — stay with the SDK rather than being reimplemented. On desktop the provider API key is injected by the native host and never enters the renderer; on web your own key is used directly. A failed start now says which of "live voice is off", "no provider configured", "none available here" or "no provider would start a session" actually happened, and retries pick the next configured provider before the microphone ever opens.
