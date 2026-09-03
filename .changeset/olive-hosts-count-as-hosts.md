---
"cognia-next": patch
---

Settings no longer tells a paired browser that it has no host. Host detection now counts pairings made through Settings > Remote hosts, not just the `/pair` credential book, and re-reads while the page is open so a pairing takes effect without a reload. Sections that only the desktop app can open now say so, instead of advising you to pair a host that would not help.
