---
"cognia-next": patch
---

A local account registry that fails to load no longer leaves the app sitting on "Loading accounts…" forever. The boot read marked itself finished only when it succeeded, and the gate shows its loading shell until that flag flips — so any failure reading the account registry presented as an indefinite hang, with the actual reason reaching only a console warning. The gate's own error message sat behind that same check and could never be reached.

The load now settles whether it succeeds or fails, so you see what went wrong instead of a spinner, and a failed read can still be retried rather than being stuck for the rest of the session.
