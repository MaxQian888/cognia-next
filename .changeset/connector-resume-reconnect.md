---
"cognia-next": patch
---

Reconnect connector bots automatically after the machine wakes from sleep or the network comes back. Long-lived gateway sockets (Discord, QQ, Slack, DingTalk, Lark) go half-open across an OS sleep and nothing re-dialed them, so a bot could silently stop receiving messages while still showing as connected until you manually hit "Reconnect now". A resume-reconnect watcher now listens for the browser/OS `online` and visibility-resume signals and re-queues the running adapters through the existing reconnect path, but only after a meaningful away period (so a quick tab switch doesn't churn healthy connections).
