---
"cognia-next": minor
---

Sites: `.cognia/hosting.json` can now declare Cloudflare route patterns, which are recorded on each version and pushed at upload. Reconciliation is a durable operation rather than an untracked round-trip, so it appears in the journal and survives a crash. A rebuild is warned about when an identical build already exists. Build settings — runtime, package manager, and network allowances — are seeded from the Site's own last build instead of resetting to hard-coded values, and no longer leak between Sites.
