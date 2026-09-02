---
"cognia-next": minor
---

Agent-facing template and Squad tools (ADR-0164): an opt-in "Template and Squad tools" toggle under Settings > Tools > Agent self-invocation gives the agent `template_list` / `template_get` / `template_instantiate`, `chat_template_list` / `chat_template_get` and `squad_list` / `squad_apply_template` / `squad_save_as_template`, with every write passing the same consent prompt the plugin templates API uses.
