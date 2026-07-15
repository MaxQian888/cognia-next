---
"cognia-next": minor
---

Make the model you pick for an external agent (Codex, Claude Code, …) actually take effect. The model never reached the agent: the execution options had no model field at all, so callers that passed one had it silently dropped, and an external teammate always ran on whatever its own CLI config selected. A teammate's configured model now reaches the agent — starting a new session on it, and switching a reused session onto it — and a team's model preference is used when the teammate pins none. Plugin subagents that declare a model get the same treatment on the external path, which previously only looked like it worked.

Team leads can now be pointed at a specific configured provider from the member editor; the existing model field applies as before.
