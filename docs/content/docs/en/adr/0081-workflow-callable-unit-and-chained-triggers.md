---
title: ADR-0081 — Workflow callable-unit convergence & chained triggers
description: One shared typed runner backs every published workflow (no per-workflow ghost tools), workflow skills guarantee that runner in-session, and trigger.workflow.completed chains decoupled workflows with depth + self-trigger guards.
---

# ADR-0081 — Workflow callable-unit convergence & chained triggers

**Status**: Accepted (2026-07-17)

## Context

Publishing a workflow (ADR-0011, D5 in `lib/workflow/CONTEXT.md`) registers three call
surfaces: a typed agent tool, a typed `flow.subworkflow` target, and a skill-catalog
entry of `kind:"workflow"`. Two of the three had drifted from what actually shipped:

1. The generated skill body instructed the model to call a per-workflow `wf_<slug>`
   tool that **no code ever registers** — the real runner is the generic
   `wf_run_workflow_typed` (name-parameterized). Models enabling a workflow skill were
   pointed at a ghost tool.
2. Enabling a `kind:"workflow"` skill neither special-cased its rendering nor
   guaranteed the runner tool was present in the session — whether the graph was
   callable depended on the `cognia-workflow-ai` plugin happening to be enabled.
3. There was no native "workflow A finished → start workflow B" linkage. The only
   composition was `flow.subworkflow` (parent embeds child in its own run) and a
   narrow scheduler-task event path.

## Decision

1. **One shared typed runner, no per-workflow tools.** `wf_run_workflow_typed`
   (owned by `lib/workflow/publish/runner-tool.ts` — name + definition are the single
   source shared by the plugin registration and every other surface) is THE callable
   surface for published workflows. `published.toolName` (`wf_<slug>`) is display-only.
   The execution core lives in `lib/workflow/publish/run-workflow-typed-tool.ts`; the
   `cognia-workflow-ai` plugin registration is a thin wrapper over it.
2. **Graph-bodied skills self-heal and guarantee their runner.**
   `renderSkillsSection` / `renderSkillsCatalog` special-case `kind:"workflow"`:
   the body/catalog line is re-derived from the workflow name at render time
   (stale pre-fix bodies naming `wf_<slug>` are healed without a migration) and names
   the shared runner with the exact `{ "name": … }` call shape. The skills→tools
   projection in `lib/claude/build-options.ts` appends the runner manifest entry
   whenever a workflow skill is active and the plugin didn't provide it (post
   semantic-pruning, so it cannot be pruned), and `lib/claude/plugin-tool-ipc.ts`
   executes the shared core directly when plugin resolution misses.
3. **`trigger.workflow.completed` chains decoupled workflows.** The orchestrator
   announces every real terminal state (succeeded/failed — including validation,
   preflight, and sort failures) through
   `lib/workflow/runtime/workflow-completion-fanout.ts`, fire-and-forget. Matching
   subscriptions (scoped by optional source `workflowId` and outcome `status`) are
   dispatched through the canonical trigger bridge with payload
   `{ workflowId, workflowName, runId, status, output?, error?, chainDepth }`.
4. **Loop/storm guards.** Chain depth is capped at `MAX_WORKFLOW_CHAIN_DEPTH` (10),
   inherited through the trigger payload (`chainDepth`); a workflow can never trigger
   itself, even via an unscoped subscription. Catch sub-runs (`suppressCatch`) and
   partial editor runs (`startStepId` / `restrictToStepIds`) never announce.
5. **Event waits are real.** `flow.wait` event mode blocks on the in-process wake bus
   (`subscribeWake`) under a user-declared `eventKey` (or the run-scoped
   `runId:stepId` default) with an optional timeout; `wf_emit_workflow_event` is the
   agent-reachable wake source. Events firing before the subscription are dropped,
   not queued.

## Consequences

- A model enabling any published workflow skill can always execute the graph —
  the instruction, the manifest, and the execution fallback agree on one tool name.
- "A finished → run B" is expressed by dropping a `trigger.workflow.completed` node
  into B, without B being embedded in A's run, budget, or error policy.
- All cycles are now rejected at validation (see the companion topo-sort change):
  the old "authorized back-edge" tolerance validated graphs whose loops silently
  never iterated. Iteration is exclusively the `flow.loop` v2 container.
- The chain payload carries the source run's full output; consumers read it via
  `$trigger.payload.output` (or the trigger node's own passthrough output).

## References

- `docs/plans/2026-07-16-workflow-linkage-remediation.md` — the audit that drove this.
- ADR-0011 (workflows subsystem), ADR-0022 (concurrency), ADR-0034 (error branches).
