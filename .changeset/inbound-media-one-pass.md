---
"cognia-next": patch
---

Inbound attachments are resolved by one pass instead of one per platform.

Each connector had its own copy of the "download the attachment, inline the bytes, extract the document text" loop, and they had drifted: one read the cache first and one always re-downloaded, one guessed the wrong media type, one cached files nothing can open again. There is now a single pass, and each platform supplies only what actually differs — how to name a file and how to fetch it.

Two behaviour changes come with it. Attachments are looked up in the cache **before** anything is resolved, so a message the bot has already seen costs no token read and no download at all. And a file the app cannot read text from — an archive, a video — is no longer downloaded into the encrypted cache, where nothing could ever open it again.
