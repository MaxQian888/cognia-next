---
"cognia-next": patch
---

The remaining streaming AI features that run in the browser and the phone no longer leave an unhandled promise rejection behind when a provider rejects the request, the response is cut off before any output, or you stop it mid-reply: canvas actions, plugin `ctx.ai.chat` and plugin agent runs on the text channel, provider-operation streams, Router Fusion role calls, the renderer LLM client used by goals, plans and evals, and the provider benchmark. Results and errors reach each feature exactly as before; only the stray "No output generated" / "This operation was aborted" rejection raised by the AI SDK's unused telemetry context is gone. Telemetry is still left on wherever something could receive it (the CLI, a caller's own integrations, or a registered integration).
