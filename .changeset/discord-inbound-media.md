---
"cognia-next": minor
---

Discord: the bot can now see the images and documents people post to it.

Posting a screenshot and asking "what's wrong here?" used to hand the model the literal text `[image: https://cdn.discordapp.com/…]` — a link it has no way to open — so the answer was written from the file name. Attached documents were the same: the model got `[file: q3.pdf]` and nothing else.

Images posted in a channel the bot is in are now downloaded into the encrypted attachment cache and read. Text is extracted from attached documents so the model reads the contents. Only Discord's own CDN is fetched — a link a stranger puts in a message will not make the bot download it.

Whether the picture itself may be sent to a cloud model is unchanged and still decided per conversation: on the default setting only locally-extracted text leaves the device.
