---
"cognia-next": patch
---

Lark connector now records the tenant behind a message and flags external (cross-tenant) groups. The bot's tenant was never captured — `/bot/v3/info` doesn't return it and the documented "backfill from the first inbound event" was never implemented — so an external-group sender's tenant was invisible. The adapter now backfills `lastWhoamiResult.tenantKey` from the first inbound event that carries a `tenant_key`, and the bot added/removed audit entries surface the `external` flag when the chat is a cross-tenant group. (The Feishu bot customized-menu handling was audited against the official `application.bot.menu_v6` payload and confirmed already correct — no change needed.)
