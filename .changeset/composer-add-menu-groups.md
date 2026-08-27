---
"cognia-next": minor
---

The composer's `+` is now a real menu instead of four attach rows and a chip strip. Three groups, because the entries answer three different questions: **Add** (files, a folder, a screenshot, a smart snapshot, a cloud document, a record from the workspace), **This turn** (plan mode, a goal, the skill recorder, plus the existing capability chips), and **Extend** (slash commands, external services). Cloud documents and record references drill down into submenus inside the same popover rather than flying out of it — one Radix layer, one dismiss path, and it works unchanged on touch.

Every new entry reuses what already existed rather than growing a second implementation: the namespace rows (`@lark:`, `@issue:`, `/goal`, `/`) type into the composer and let its own trigger detection open the panel it already has, and both submenus are built from their live registries, so a provider or record source registered later shows up without a code change. Entries that cannot reach their target hide instead of rendering dead — no way to type, no namespace rows; no recorder plugin, no recorder row. External services get a counted row that opens their settings rather than a submenu: a service capability is a tool the agent may call, so there is no per-turn action to put behind a chevron and a list of them would have been a list of dead rows.
