---
"cognia-next": minor
---

Admit remote external-agent runs against the host's own configuration store, and manage those configurations from Settings. A run now presents a stamp — which configuration, which revision, which readiness generation — instead of a configuration blob: the host resolves it against its own head, re-derives readiness live rather than trusting the cached verdict, and leases the immutable revision it will actually launch. A configuration edited, disabled, or stripped of its credential a moment earlier is refused instead of spawned, and each refusal says which of those it was.
