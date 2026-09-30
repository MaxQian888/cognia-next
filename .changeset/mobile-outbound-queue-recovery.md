---
"cognia-next": patch
---

Mobile queued actions no longer get stuck on "Sending" after the app restarts: a send whose process died is recovered automatically, a send that never answers now times out and retries, and a stuck one can be withdrawn from the Queued actions sheet. Tapping Run again on a workflow that is already queued says so instead of queueing a duplicate run. The workflow list, banner and queue sheet now use the same words ("Queued" while waiting for the desktop, "Sending" only while it is actually being sent), and the banner's Review link has a larger tap target.
