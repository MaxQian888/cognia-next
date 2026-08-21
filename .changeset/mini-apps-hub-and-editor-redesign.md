---
"cognia-next": minor
---

Redesign the Mini-Apps (A2UI) hub and editor chrome. The hub is now a single-column, generation-first page whose composer is the only primary surface, saved apps and templates each appear exactly once, and every radius comes from the `--radius-*` scale instead of ad-hoc `rounded-3xl`/`rounded-[28px]` shells. The library toolbar (search, sort, view, filters) pins to the top while the list scrolls, list view renders as one divided surface instead of a stack of floating cards, the template library caps at two rows behind a "show all" expander, and a back-to-top control fades in on long pages. Both screens adopt the app-wide `FeaturePageHeader`, and the editor's duplicated edit/preview/data switch collapses into a single control with a visible zoom level.

The hub composer also gains execution options: pick the agent (character) that builds the app and the provider/model it runs on. The choice is remembered per user and folded into the generation turn, so it resolves the character's system prompt, skills and execution policy exactly as a chat session would. The chat composer's model picker is now a thin binding over a shared controlled `ModelSelect`, so both surfaces render the same control.
