---
"cognia-next": patch
---

External agent runtimes: fix three ways a configured agent (Pi, Codex, Gemini CLI, and friends) was harder to use than it should have been.

- Sending a turn to an external agent no longer requires an active Anthropic subscription account. `resolveSendOptions` resolved the account before the send path picks a lane, so a browser or companion with no active account was refused outright, with an error naming a provider the turn was never going to use. Account resolution is now best-effort on that lane, and still attempted so a fallback to the built-in runtime keeps its credentials.
- The runtime selector no longer falls back to the built-in agent on reload. A host process plane that is not up yet reports `transport_blocked`, which was treated as a settled verdict and persisted the built-in choice on every refresh, because the boot provider's effect runs after its children. That reason is now transient, so the selection survives the first frame.
- The composer's model and thinking-level controls now reach the agent. The thinking chip offers the agent's own published ladder (Pi reports `off` through `max`) instead of a fixed three tiers, folds the choice down onto what the current model actually honours rather than letting the agent silently clamp it to `off`, and applies it through the `thought_level` config option that non-Codex adapters read. A model picked before the first turn is now replayed onto the session the agent opens, instead of being persisted and never read back.
