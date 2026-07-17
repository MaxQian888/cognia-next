---
"cognia-next": minor
---

Workflow linkage: add the `trigger.workflow.completed` chained trigger (run workflow B when A finishes, with chain-depth cap and self-trigger protection), implement `flow.wait` event mode on the wake bus (plus the `wf_emit_workflow_event` agent tool), add the `$nodes['id']` global expression scope for non-adjacent reads, restore structured-output validation (outputSchema/onSchemaViolation with one auto-fix retry) on `ai.prompt` v2 and `ai.extract`, and render schema-driven typed input fields for published `flow.subworkflow` targets.
