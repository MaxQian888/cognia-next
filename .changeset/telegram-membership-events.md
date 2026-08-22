---
"cognia-next": patch
---

Telegram bots now notice when they are added to or removed from a chat.

Telegram announces this through a `my_chat_member` update, and the adapter asked for an explicit list of update types that did not include it — naming any list opts out of Telegram's defaults, so the update was never delivered at all. A Telegram bot invited to a group therefore stayed silent where a Lark bot posted its welcome card, and being removed from a group left no trace anywhere.

Being added and being removed are now recorded, and joining a group sends the same one-time welcome card every other platform already sent. A permission change that does not cross the membership line — being promoted to admin, or having a restriction adjusted — is deliberately not reported as a join, which would have re-sent the welcome card every time an admin touched the settings.

Long-polling bots get this automatically. If your bot runs in webhook mode you register the URL with Telegram yourself, so add `my_chat_member` to the `allowed_updates` of your own `setWebhook` call.
