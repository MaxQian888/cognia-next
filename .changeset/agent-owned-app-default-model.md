---
"cognia-next": patch
---

Stop the app-wide default model leaking an external agent's own model id into the built-in provider lane: the Built-in Agent Runtime settings page no longer shows it as the SDK sidecar's default, and renderer-side utility calls, the team lead, the CLI config push, the effort ladder and the skill recorder no longer dispatch at it.
