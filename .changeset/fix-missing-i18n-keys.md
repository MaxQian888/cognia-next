---
"cognia-next": patch
---

Fix missing i18n keys that spammed MISSING_MESSAGE console errors and showed raw key paths in the UI.

Adds the absent entries to both locales: `settings.subagents.import.sources.pi` / `.opencode` (the Pi and OpenCode importers shipped without labels), `skills.card.syncPending` / `syncCurrent` / `syncError`, `eval.scorerCatalog` entries for `exact-match`, `contains-any`, `regex-match`, `numeric-match`, `choice-match`, `settings.gateway.nav.items.custom` (label + description), and the entire `learning.guide.*` namespace used by the A2UI interactive-guide component. All were dynamic `t()` refs, which is why the i18n gate never caught them.
