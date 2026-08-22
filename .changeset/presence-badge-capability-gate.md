---
"cognia-next": patch
---

A usage badge is no longer retried forever on a bot that can never show one.

The presence refresher asked whether the adapter _implements_ a status update. A webhook-mode Discord bot does implement it — it just fails every time, because presence is a gateway operation. So every refresh interval, forever, the bot attempted a badge, failed, and wrote an error to the audit log, burying the anomalies the log exists to surface.

It now asks what the bot can actually serve. A badge that cannot work is skipped, and the reason appears once in the connector's presence status where you can act on it, instead of as a recurring error. Real failures — a network blip, a rejected token — are still retried and still audited, exactly as before.
