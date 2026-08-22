---
"cognia-next": minor
---

A photo sent to a Telegram bot is now something the model can actually see.

Telegram delivers media as a file id, not a URL, and nothing resolved it. So when someone sent the bot a picture and asked what it was, the model received the literal text `[image: tg://file/AgACAgEAAx…]` — and answered about that. Inbound OCR was dead for the same reason: it only runs on images that carry real bytes, and none did.

Photos and documents are now downloaded through the same encrypted attachment cache the other connectors use, so the model sees the picture, OCR runs on it, and a PDF or spreadsheet is read for its contents rather than its file name. The download is keyed on Telegram's stable file id, so the same photo is never fetched twice — including across the parts of an album.

Whether those bytes may reach a cloud model is still the media policy's decision, unchanged: the default remains local extraction only.

Every step is best-effort. A file Telegram has aged out, an oversized attachment, or a locked keyring leaves the message exactly as it arrives today and never delays it.
