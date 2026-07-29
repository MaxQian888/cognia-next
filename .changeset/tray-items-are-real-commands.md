---
"cognia-next": patch
---

A tray item contributed by a plugin now actually runs when you pick it. Registering one put a row in the menu but never registered a command behind it, so the row resolved to a command id nothing owned and clicking it did nothing at all. Tray items now register a real command carrying the plugin's own `when` condition, dispatch through whichever of a handler, a plugin command, or a slash command the item declares, and are unregistered when the item goes away — so a disabled plugin's rows stop being clickable instead of lingering as no-ops.
