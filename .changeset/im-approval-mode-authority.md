---
"cognia-next": patch
---

`/mode yolo` and `/mode prompt` now set the conversation's Authority alongside the legacy `approvalMode` field they always wrote, so the two permission models cannot disagree while both exist. An explicit `/mode auto|manual|draft` now also clears any autonomy or engagement a previous assignment left behind — without that, routing (which prefers those axes) would have silently swallowed the command. A bot's default autonomy, engagement and authority are also writable for the first time; the row has carried them since the axis model landed, but the update whitelist did not.
