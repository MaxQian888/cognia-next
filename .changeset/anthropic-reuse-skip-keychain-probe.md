---
"cognia-next": patch
---

Stop probing Claude Code's own keychain login when an Anthropic subscription is already active. The Providers → Anthropic panel no longer reads the external `"Claude Code-credentials"` keychain item (a separate macOS keychain prompt) once you are signed in, so opening settings no longer triggers a redundant password prompt whose result was discarded anyway.
