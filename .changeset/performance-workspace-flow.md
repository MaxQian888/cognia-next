---
"cognia-next": minor
---

Make the Performance page work everywhere and read the way it is used. Web and
mobile now open it instead of a "needs a paired desktop" wall, chart what this
window can measure (frame rate, main-thread blocking, long tasks, JS heap), and
show only the metrics each source actually reports instead of flat zero lines.
Tabs, resource sections and the selected metric live in the URL, so the status
bar and the capture chip land where they point. Diagnose adds this window's chat
and render timings and a confirmed reset for backend hotspot statistics. Host-only
sections explain why they are empty. Captures gain confirmed deletion, translated
status and errors, a progress bar, an eligibility-checked comparison on any
metric, and immutable performance budgets with pass/warn/fail checks.
