---
"cognia-next": patch
---

The skills block of the system prompt now has a ceiling and a named degradation ladder. It was the one part of the prompt that grew with the size of the user's library rather than with the turn, and nothing bounded it: `renderSkillsSection` and `renderSkillsCatalog` emitted everything they were handed, and the one caller that tried to pass a budget had its argument discarded behind an unused parameter. Catalog rows now shorten their descriptions, then drop them, before any skill is omitted — a model can still find a skill from its name, but not from nothing. Full skill bodies are never truncated, only omitted whole, because a half-instruction produces confident wrong guidance. Whenever the block shrinks, the level it reached and the ids it lost are logged, so a prompt that quietly lost half the catalog no longer looks the same as a user who forgot to enable those skills.
