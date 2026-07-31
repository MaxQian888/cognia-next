---
"cognia-next": patch
---

Fix the Connections overview misreporting gateway/long-connection deployments (e.g. Lark long connection) as "Stopped / 0 adapters registered": the inbound-server card now only reports an error when an enabled webhook / reverse-WS adapter actually needs the local server, and per-adapter status is derived from live runtime heartbeats — the same source the Health tab uses — with a running/total summary and per-adapter state badges.
