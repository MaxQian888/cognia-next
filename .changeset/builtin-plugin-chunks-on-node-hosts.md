---
"cognia-next": patch
---

Fix the five bundle-split built-in plugins (Office, PDF, Documents, Presentations, Visualize) failing to enable on every Node host — the CLI, and the supervised brain behind headless and server installs. Those built-ins ship as their own code chunks addressed by a root-relative URL, which only resolves inside a document: under Node `fetch()` rejected it outright, so each one restored with `Failed to enable plugin … TypeError: Failed to parse URL`. Documents, Presentations, and Visualize declare headless support and contribute agent tools, so a headless agent silently lost its authoring, validation, and visualization tools rather than merely missing UI. Node hosts now read the chunk staged beside the bundle — with the same SHA-256 verification the browser path performs — and all three CLI layout builds stage that chunk tree, verifying each digest against the catalog the bundle pins so a stale build fails at build time instead of on the user's machine.
