---
"cognia-next": minor
---

Telegram: webhook bots register themselves, instead of the docs claiming they do.

**The registration is real now.** The setup guide said cognia registered your callback URL with Telegram through `setWebhook`. Nothing ever did — the form showed the URL with a Copy button and left the call to you. So a webhook bot reported **running** while Telegram had never been told where to push, which looks exactly like a bot nobody has messaged. Starting a webhook adapter now calls `setWebhook` itself, and stopping one calls `deleteWebhook` — which is what lets you switch a bot back to long polling without Telegram answering every `getUpdates` with 409.

**A webhook bot hears everything a long-poll bot hears.** Both transports now send the same `allowed_updates` list from one shared definition. Hand-registered webhooks inherited whatever list was typed months earlier, so the recent fix that lets a bot notice being added to or removed from a chat reached long-poll bots only.

**A rotating tunnel no longer silently strands a bot.** A Cloudflared quick tunnel gets a new hostname every restart, and the old registration pointed nowhere. The adapter re-checks its public URL and re-registers when it changes, and it asks Telegram whether deliveries are actually landing — `Wrong response from the webhook: 404 Not Found` now shows up as the adapter's health reason instead of as silence.

**The webhook secret is required, and the form says so.** The local receiver rejects any delivery without it, so a webhook configured without a secret received nothing while looking configured. Saving a webhook adapter without one is now refused, and the adapter declines to register rather than pointing Telegram at a URL that will 401 every push. Both setup guides were corrected, including which tunnel to start: the one on **Platform Connections → Tunnel**, which fronts the connector server that actually serves the callback URL.
