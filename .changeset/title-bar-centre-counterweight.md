---
"cognia-next": patch
---

Title bar: keep the search pill and its neighbouring segments centred while a conversation's header is projected into the bar. The centre outlet is a `flex-1` child, so it absorbed all the slack and pushed route history, the workspace pill, the ⌘K search pill and the command centre against the trailing window controls — the bar had one shape inside a chat and another everywhere else. A matching flex counterweight after the segments (rendered only while the outlet is) balances the row.
