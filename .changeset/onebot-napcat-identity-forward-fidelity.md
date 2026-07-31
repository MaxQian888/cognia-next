---
"cognia-next": minor
---

OneBot (QQ / NapCat / Lagrange / LLOneBot) connector improvements. The adapter now probes the connected bot's own identity via `get_login_info` on connect and shows its real nickname + UIN in the Bot identity panel — unifying it with the Telegram/Slack/Lark identity probes — and warns when the connected UIN differs from the configured Bot UIN. Inbound message fidelity is higher: merged forwards (合并转发) are resolved through `get_forward_msg` instead of a generic placeholder, and `location`, `poke` (戳一戳), `dice` (骰子), `rps` (猜拳), contact cards, and legacy XML cards now map to structured/readable content instead of `[unsupported:…]`. Outbound, the adapter can merge-forward existing messages via the NapCat `send_group_forward_msg` / `send_private_forward_msg` extension (new `forward` capability). Adds an English OneBot setup guide.
