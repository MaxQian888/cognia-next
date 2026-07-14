---
"cognia-next": patch
---

IM connectors (Lark long-connection, Discord/Slack/QQ/DingTalk gateways) no longer reconnect every few minutes during normal desktop use. The resume-reconnect watcher used to tear down and re-open **every** adapter whenever the window regained focus after just 30 seconds away — so on a desktop app, where the window loses focus constantly, a perfectly healthy connection was churned dozens of times an hour (each reconnect opens a brief message-loss window). It now (1) only triggers after a multi-minute away period, sized for a real OS suspend rather than an ordinary window switch, and (2) skips any transport that is still `running` and delivered traffic in the last minute — only a possibly-half-open connection is reconnected.
