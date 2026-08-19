---
"cognia-next": minor
---

Server operations now survive the session that queued them: the Operations rail is backed by the controller's own history, so a reload — or work started from another device — is visible instead of lost, and opening an operation shows its full state-change timeline rather than just its current badge.
