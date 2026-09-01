---
"cognia-next": patch
---

A narrow browser window is now treated as narrow rather than as "not a phone". The offline and queue banner appears there instead of only in the native app, so a browser holding unsent rows finally says so. `/scheduler` sends a compact viewport to the phone-shaped scheduler that already existed at `/me/scheduler` rather than drawing its master-detail layout at 375px, and `/me/scheduler` no longer bounces a browser back out of it. Every `/me/*` sub-page also gets a definite viewport height, so its sticky header sticks and its body fills the screen instead of rendering as a short strip.
