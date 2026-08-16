---
"cognia-next": minor
---

Rebuild composer autocomplete on one shared engine, with LLM-generated suggestions in the CLI

Both composers (desktop chat and the CLI TUI) now share a single inline-completion engine that
ranks suggestions across independent providers, instead of each surface carrying its own logic:

- **Two tiers.** Local sources (per-session input history + slash-command names) complete
  instantly and for free; a model-backed continuation refines the result on a debounce. Previously
  the desktop composer's only source was the model, gated behind a default-off setting — so most
  users had no inline completion at all — and the CLI had no model tier whatsoever.
- **LLM suggestions in the CLI.** The TUI composer can now predict a continuation with a model
  (`autosuggest.ai` in `~/.cognia/config.json`), resolved through the renderer LLM client and gated
  by the shared PII redactor. The provider interface also accepts an agent-backed source, which
  outranks a single-shot completion.
- **Better local ranking.** History completion is now ranked by recency _and_ frequency, tolerates
  a case difference while preserving what you typed, and de-duplicates repeats — replacing the
  CLI's "first history entry with this prefix wins" scan.
- **Multiple candidates.** Suggestions are ranked into a list you can cycle with `Alt+]` / `Alt+[`
  on both surfaces, and the ghost is labelled with the source it came from (history / command / AI),
  since a free exact match and a model guess otherwise look identical.

New settings: `composerAssistance.ghostText.local` (desktop, defaults on) and `autosuggest.local` /
`autosuggest.ai` / `autosuggest.debounceMs` (CLI). The existing
`composerAssistance.ghostText.enabled` keeps its meaning and still controls the model tier only.
