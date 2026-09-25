---
"cognia-next": patch
---

Opening a skill no longer marks it as failing validation with "A portable skill slug is required" — the check ignored the skill's slug, so the first skill you viewed (often a built-in) picked up a red error badge. Skills already flagged this way clear the next time they are opened.
