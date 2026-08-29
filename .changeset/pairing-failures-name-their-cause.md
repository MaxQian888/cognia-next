---
"cognia-next": patch
---

Pairing failures now name their cause instead of their shape. An `AggregateError` from Host activation used to render only its own summary sentence — "activation failed and rollback was incomplete" — while the two errors that said what actually went wrong were dropped; the technical detail now unpacks aggregate members and `cause` chains (deduplicated, so one failure shared by activation and rollback is said once). A 403 is routed by the Host's own refusal code rather than one bucket, so a re-submitted invitation says "issue a fresh one" instead of sending the user to an allow-list for a listener the request had just travelled through. And the Web boot provider's "the selected Web Host credential is unavailable" now distinguishes its four causes: no active runtime target, no paired-Host record, a locked Browser Vault, and a record whose device key was never stored.
