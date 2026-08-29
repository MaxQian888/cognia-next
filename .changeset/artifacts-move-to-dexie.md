---
"cognia-next": minor
---

Artifacts are stored in IndexedDB instead of a localStorage blob. They were kept in the same 5 MB-capped `cognia-artifacts` key as everything else the dock remembers, so on every write each artifact's content was cut at 100 KB and everything past the 200 most recent was dropped — silently, and for good, because the shortened copy was what the next reload read back. Both limits are gone: a long document keeps its full text, and an old artifact stays until you delete it. Existing artifacts are carried over on the first launch, and the transfer resumes where it left off if it is interrupted. Backups and the per-domain "Artifacts" export now carry the artifacts and their version history directly, and the storage breakdown lists them under their own heading.
