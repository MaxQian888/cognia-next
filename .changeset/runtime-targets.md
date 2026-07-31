---
"cognia-next": minor
---

Adds explicit runtime targets — local desktop, a paired companion, or standalone web — with a target picker in the account menu. Each target keeps its own database, outbound queue, paired devices and scheduled tasks, so work started on one target no longer leaks into another, and surfaces that an inactive target cannot serve now say so instead of failing silently. Queue entries created before targets existed are preserved and quarantined for diagnostics rather than being attributed to whichever target is now active.
