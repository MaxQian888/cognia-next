---
"cognia-next": patch
---

Standalone (BYOK) chat in the browser and the phone no longer leaves an unhandled promise rejection behind when a provider rejects the request (for example an invalid API key) or when you press Stop mid-reply. The turn still reports the provider error, or seals the partial answer, exactly as before; only the stray "No output generated" / "signal is aborted" rejection that the AI SDK's unused telemetry context raised is gone.
