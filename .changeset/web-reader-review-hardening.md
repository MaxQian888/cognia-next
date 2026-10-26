---
"cognia-next": patch
---

Web reading now re-checks every redirect against the private-network guard (and, in the CLI, refuses names that resolve to private addresses), treats sign-in walls and protected files as final instead of sending them to another reader, and stops an in-flight read when you turn off web tools, a reader or a provider. Search no longer lets a provider's own defaults loosen strict safe search or your source filters, never falls back to a paid AI-grounded provider you did not choose, and caps every provider response at 8 MiB.
