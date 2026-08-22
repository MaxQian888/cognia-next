---
"cognia-next": patch
---

A webhook-mode Discord bot no longer offers a presence badge it cannot set.

Discord's presence update is a gateway operation, so an instance configured for webhooks has no way to send one — it fails with "Discord gateway not connected" every time. The capability list is declared per platform and could not express that, and said so in a comment. The per-instance capability projection now does, so the usage-presence setting is simply absent for a webhook-mode bot instead of offering a badge that never appears.

That comment also claimed typing indicators and history reads were gateway-only. They are not — both are plain REST and work in either mode — so nothing changes for them.
