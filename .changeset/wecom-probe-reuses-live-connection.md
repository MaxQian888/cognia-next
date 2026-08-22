---
"cognia-next": patch
---

"Test connection" no longer drops a running WeCom bot's conversation.

WeCom allows exactly one long connection per bot. The settings form's test button opened a second one with the same credentials, so pressing it while the bot was running could kick the live socket — or be kicked by it — and cut off whoever was mid-conversation. The probe's own comment admitted this and left it deliberately unfixed.

A running adapter has already proven its credentials: its socket exists because `aibot_subscribe` returned success. So testing the credentials that are already connected now answers from the live adapter's health and opens nothing at all — including when a degraded or reconnecting socket means the honest answer is "not right now". Testing _different_ credentials for a bot that is currently connected has no safe answer, so the test button says so and names what to do (stop the bot first) instead of racing for the slot. Saving new credentials still takes the connection, because replacing it is exactly what saving means.

Other bots are unaffected: the limit is per bot, so probing bot B while bot A is connected works as before.
