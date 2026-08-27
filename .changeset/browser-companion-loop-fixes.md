---
"cognia-next": patch
---

Browser Companion: fix three defects that made the side panel unusable end to end — the RPC envelope was returned instead of its result (which read as "this Host speaks an unsupported schema" right after pairing), a capture used whichever tab was active instead of the one the right-click named, and the shared component package was missing from the extension's Tailwind build, leaving the "include the full address" checkbox invisible and unclickable.
