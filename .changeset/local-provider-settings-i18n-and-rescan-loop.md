---
"cognia-next": patch
---

Improve the Providers → Local Providers settings panel.

- **Missing translations**: the provider group headers, the setup-wizard title, and its "follow these steps" hint were showing raw i18n keys (`providerGroups.recommended`, `providerSetup`, `followStepsToStart`, …) instead of translated text — the keys were never added to `en`/`zh-CN`.
- **Continuous re-scanning**: the `useLocalProvidersScan` stub returned a fresh `scan` function and result maps on every render, which invalidated the mount-scan effect's dependencies and drove an infinite detect loop (visible as a flickering "Scanning…" button). The stub now returns stable identities, so auto-detect runs once on mount and the Scan button reflects both the install-check and server scans.
- **Setup guide now works for every provider, not just Ollama**: each provider card has its own "Setup guide" action that opens the step-by-step installer for that engine, and the guide renders the correct start command / model-pull command / browse-models link per provider (LM Studio and Jan correctly show no shell command). The footer "Quick Setup" and "Browse Models" shortcuts now target the first recommended provider that isn't already running instead of being hard-wired to Ollama.
