---
"cognia-next": patch
---

Remote Host delivery is more reliable after failures and restarts. A message the Host accepted no longer fails its submit when the runtime hiccups: it is retried in the background, and a turn that may already have run a tool is parked for an explicit resume instead of being sent again. A late steer can no longer land on a later turn, and a queued message keeps its uploaded files while it waits. On paired devices, a manual retry is no longer refused as an idempotency conflict, a Host still processing a send no longer burns a retry attempt, and Host refusals and Retry-After are honored. In chat, a queued follow-up the send path refuses now shows "Not delivered" with Put back instead of reading as delivered, clearing the caption of a queued screenshot no longer deletes the screenshot, and an edit that loses the race with delivery no longer rewrites the sent bubble.
