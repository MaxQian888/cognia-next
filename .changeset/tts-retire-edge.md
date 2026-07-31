---
"cognia-next": minor
---

Retire the Edge TTS provider. Edge-TTS only works by impersonating the Edge browser (a forged token, a spoofed user-agent, and a `chrome-extension://` Origin), has no acceptable terms of service or requestable key, and returns 403 in mainland China. It is removed from the provider picker; a persisted Edge selection still resolves but is now shown as retired with a notice steering you to another provider. The synthesis code remains for one release before removal.
