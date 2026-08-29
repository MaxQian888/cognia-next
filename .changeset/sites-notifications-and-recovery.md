---
"cognia-next": minor
---

Sites now report themselves. A deploy that succeeds while you are on another page arrives in the notification centre with its production URL, and build, upload, deploy, domain, and access failures — plus operations waiting on reconciliation — are reported instead of vanishing with a toast. Interrupted operations are also resumed for every Site you own when the app starts, rather than only when you happen to open that Site's console. Long builds and uploads now hold a lease that actually covers them, so recovery can no longer terminate one that is still running.
