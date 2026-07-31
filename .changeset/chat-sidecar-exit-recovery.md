---
"cognia-next": patch
---

Recover foreground chat sessions when the assistant (sidecar) process dies mid-stream. Previously a sidecar crash left every in-flight conversation frozen in the streaming state — composer disabled, no error shown — until you reloaded the window, because the crash emitted only a single global signal with no per-session end. The chat now settles each streaming or awaiting-approval session on that signal: it stops the in-flight turn, interrupts any pending tool approval, releases the lease, and shows a retryable "the assistant stopped unexpectedly" error so you can continue with one click.
