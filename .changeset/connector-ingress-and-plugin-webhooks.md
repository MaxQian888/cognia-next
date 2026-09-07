---
"cognia-next": patch
---

Connectors reach the right address on every host. The six adapter config forms and the Tunnel tab derived their inbound callback URL from the cloudflared tunnel, so a cloud install was told to start a tunnel it neither has nor needs while the address that actually works never appeared anywhere. QQ Official had offered a webhook option since it shipped without ever showing a URL, WeChat OA showed a relative path that WeChat servers can never call, and Discord webhook rows got no URL at all because a stale lookup table still called Discord gateway-only. Plugin-contributed connectors can now declare how their platform signs a webhook, so a plugin can receive over webhook instead of having every request refused, and a receiver whose transport mode disagreed with its adapter no longer stays silently down.
