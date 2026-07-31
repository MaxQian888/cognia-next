---
"cognia-next": patch
---

Fix the teammate config dialog offering only 5 of the 13 teammate runtimes. It omitted Codex (App Server) among others, so opening the dialog on a teammate using one of the missing runtimes showed a runtime dropdown with nothing selected. Both member editors now read the same runtime list, derived from the preset catalog, and the dialog's runtime names are translated instead of showing raw ids.
