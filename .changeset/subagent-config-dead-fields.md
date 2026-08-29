---
"cognia-next": patch
---

Internal: drop twelve `SubAgentConfig` fields nothing implemented. The type advertised custom tool definitions, parent-context inheritance, sibling result sharing, a retry policy, a dependency graph, a conditional-execution predicate, a result-summarisation trio, and a second external-agent routing trio — none of which any executor read, and none of which any editor could write. The external trio had already been superseded by `externalPresetId`, the field dispatch really routes on. A config type that promises behaviour the runtime does not have sends every reader down a path that dead-ends.
