---
"cognia-next": patch
---

Fix `/compact` silently doing nothing when the summary call returns no text: the summary now sees tool calls and results, a reasoning model that spends its output budget gets one retry with headroom, a failed summary is reported as "Compaction failed: … Nothing was compacted." instead of "it will apply before the next turn", and millisecond timestamps in saved tool results (e.g. `working_set`) are no longer mistaken for bank-card numbers, which blocked resumed sessions from sending.
