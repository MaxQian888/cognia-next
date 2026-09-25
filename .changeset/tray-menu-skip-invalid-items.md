---
"cognia-next": patch
---

Tray menu: one invalid item (such as a stale native action left in a saved layout) no longer blocks the whole menu update and leaves the startup English menu in place. The item is dropped, the rest of the menu applies, and the renderer logs what was skipped. A push that fails outright now returns an error and is logged once, instead of reporting success.
