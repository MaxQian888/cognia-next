---
"cognia-next": patch
---

Fix a managed conversation getting stuck on "pipeline workspace is already active". A turn's working copy is released by a settle call that was issued exactly once and whose failure was discarded, so a single dropped or refused settle left the run open on the host forever: every later send in that conversation was refused, with an error that named neither the failure nor the turn that caused it. The settle is now retried, its failure is reported, and a turn nobody is driving any more is reclaimed on the next send, so the conversation recovers itself instead of staying wedged until the host restarts. Refusing a new turn also no longer tears the working copy out from under an earlier turn that is still running, and the refusal is now shown in your own language instead of the host's internal message.
