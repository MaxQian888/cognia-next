---
"cognia-next": minor
---

CLI TUI `/provider` switcher: the picker now filters as you type — the search row matches on both the display name and the catalog id, so "claude" finds Anthropic and "or" finds OpenRouter across the full shared provider catalog (the same typeahead the `/model` picker already had). Selecting a provider that authenticates with a metered API key but has no stored credential now opens an inline key prompt instead of switching to an unusable provider and printing a shell command to run: paste the key (masked by default; Ctrl+R reveals it, Esc cancels), and on Enter it is written to `~/.cognia/credentials.json` (0600), merged into the live session, and the provider is activated in one step. Providers that need no key (local runtimes, OAuth/subscription agents) and already-configured providers switch directly as before.
