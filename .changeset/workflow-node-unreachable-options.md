---
"cognia-next": minor
---

Workflow nodes: options the executors already honour now have fields in the inspector. A node with a dedicated config form has no raw-JSON escape hatch, so any param the form omitted was unreachable from the editor even though the runtime read it. Long-term memory got the worst of it — `action.memory.store` could not set the memory type, its stable key, or its provenance, which made the entire procedural-memory path ("always do X" rules) impossible to author from a workflow and left the step failing on a rule the user had no way to satisfy; `action.memory.recall` could not set a relevance floor or restrict which memory types it searched.
