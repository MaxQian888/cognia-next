---
"cognia-next": patch
---

Fix "Open in Canvas" on an inline canvas card in chat. It rendered a link to `/canvas/<id>`, a route that has never existed — the app is a static export with no dynamic segments, so every click 404'd. The button now reveals the document through the store and switches the shell to the Canvas guild, the same handoff `/canvas/join` already used.
