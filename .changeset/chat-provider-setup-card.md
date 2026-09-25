---
"cognia-next": patch
---

Sending a message before any model provider is set up no longer shows "Unexpected error" with only a logs button: the chat card says the provider needs setup and its Open settings button lands on AI connections with that provider already selected (the same holds for a rejected key). The failure is no longer counted against the provider's circuit breaker, and it is announced once — the inline card only, without a toast repeating it on desktop and phone.
