---
"cognia-next": patch
---

The project file tree now says why an operation failed instead of pretending it worked. A directory you may not read shows the reason where its contents would be, rather than rendering as an empty folder, and a failed create, rename or delete raises a message instead of closing its dialog silently. ADR-0162 records the trust boundary for the SFTP work these failures are the groundwork for: file transfer over a saved SSH profile grants exactly what a shell on that machine already grants, so it takes its own grant rather than borrowing workspace permissions, is approved once per transfer rather than once per chunk, and never claims a path restriction it cannot enforce.
