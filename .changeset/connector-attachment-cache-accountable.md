---
"cognia-next": patch
---

**Chat attachments no longer sit on your disk in the clear, and the cache size limit now actually works.**

Every image, voice note, and document a bot fetched was written to disk twice: once encrypted, and once decrypted so the app could load it by path. Nothing ever read the decrypted copy, but it stayed there for the whole session and survived a crash. It is gone — the encrypted copy is now the only thing written.

Three related fixes come with it. The 500 MB cache limit could never be reached, because attachments were counted as zero bytes; sizes now come from the cache itself, and the oldest genuinely unused files are evicted first. Cached files expire for real — before, a "refresh" handed back the same stale bytes it was trying to replace. And deleting a bot (or an attachment) now deletes its encrypted files rather than just forgetting them, retrying in the background if the disk refuses and reporting anything permanently stuck.

Existing caches are converted once on the next launch: leftover plaintext is deleted, and anything past its age is dropped rather than migrated.
