---
"cognia-next": patch
---

Workflow fixes: published workflow skills now point at the real `wf_run_workflow_typed` runner (stale bodies naming the never-registered `wf_<slug>` ghost tool self-heal at render, and the runner tool is guaranteed in-session whenever a workflow skill is active); `maxConcurrency` has ONE default (4) across schema/orchestrator/editor so legacy workflows without the field run at the same width as new ones; graph validation now rejects ALL top-level cycles (back-edges never re-executed — iteration belongs in the flow.loop v2 container) with guidance in the error; loop-body joins with any/race policies get an editor warning about their silent degradation to "all".
