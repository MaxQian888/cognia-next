---
"cognia-next": patch
---

Fix the TTS audio cache occasionally playing the wrong clip. Cache keys used a 31-bit hash that birthday-collides at roughly 65k entries — well within the 100 MB cache cap — so a request could hit a cached entry generated from _different_ text and play that audio instead. Keys are now SHA-256, and a version prefix retires the old keys cleanly (they expire via TTL rather than being re-read).
