---
"cognia-next": minor
---

Squad teammates and subagent templates can now be pinned to one exact saved external-agent config (e.g. "Codex strict" instead of any Codex). A pinned config that is missing, disabled, or no longer of the chosen preset fails the run with a clear error instead of quietly using another config, and preset-only bindings now pick a config deterministically (enabled, connected, oldest, then id).
