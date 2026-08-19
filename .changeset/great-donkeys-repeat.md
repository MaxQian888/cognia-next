---
"cognia-next": minor
---

Add app-usage event tracking to behavior telemetry: app launches, screen views, slash-command runs, command-palette opens and result activations, and marketplace plugin-install outcomes. These land under a new "App usage" consent category you can switch off on its own, and — like every other tracked event — stay off until behavior telemetry is enabled. Event names, ids and enums only; no titles, queries, arguments or paths are collected.
