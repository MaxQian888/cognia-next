---
"cognia-next": minor
---

Refuse Windows sandbox runs that request filesystem roots or network Off/Allowlist until those controls are enforced. Use a strict v2 stdin runner protocol, surface inactive filesystem enforcement in sandbox health, and harden process launch and output capture. The filesystem minifilter remains a separate future project.
