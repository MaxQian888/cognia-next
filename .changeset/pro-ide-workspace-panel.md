---
"cognia-next": minor
---

The Pro IDE now has a Cognia panel. A new activity-bar container shows your Issues, Plans, and Agent runs beside your code, with a status-bar item that tints when a plan or run fails; clicking a row opens the file it names, or hands the item back to Cognia when it names none. A "Send Problems to Cognia" command hands the workspace's errors and warnings to the chat on your click — it never files anything on its own. The right-click "Custom Action" entry now draws on your unified template library instead of a separate `cognia.customActions` array in code-server's settings, so a prompt template is defined in exactly one place. The whole extension is also localized for the first time: menu titles, view names, and panel text all follow your app language instead of being hardcoded English inside an otherwise-translated VS Code.
