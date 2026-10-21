/**
 * The plugin contract's share of `lib/workflow/runtime/orchestrator.ts`, which re-exports these.
 */
import type { ConcurrencyController } from "./concurrency-controller"
import type {
  RunStatus,
  TriggerEvent,
  VisualWorkflow,
  WorkflowRunLineage,
  WorkflowRunSecurityContext,
  WorkflowTriggeredFrom,
} from "../../../types/workflow/visual"
import type { SecretResolver } from "./secret-resolver"
import type { WorkflowExecutionBinding } from "../../../types/workflow/deployment"

export interface RunWorkflowInput {
  workflow: VisualWorkflow
  trigger: TriggerEvent
  /** Immutable deployment provenance for formal invocations; absent for draft tests. */
  executionBinding?: WorkflowExecutionBinding
  /** Override the auto-generated run id (used by the resume path). */
  runId?: string
  /** Override the secret resolver (tests inject in-memory resolvers here). */
  secretResolver?: SecretResolver
  /** External AbortSignal to cancel mid-run. */
  signal?: AbortSignal
  /**
   * Start mid-graph from this step id (used by the editor's "Run from here"
   * context-menu / mini-toolbar actions). Every node strictly upstream of
   * `startStepId` is marked skipped before the topo loop begins; nodes that
   * are neither upstream of nor reachable from `startStepId` are also
   * skipped so the run is bounded to the descendant subgraph. The trigger
   * payload still flows in; downstream nodes that depended on an upstream
   * output see `undefined` in their `upstreamMap` for the skipped sources.
   */
  startStepId?: string
  /**
   * Per ADR-0022 §3.7. Dynamic concurrency cap consulted on each scheduling
   * tick. When omitted, the orchestrator constructs one from
   * `workflow.settings.maxConcurrency` — the zod settings schema backfills
   * absent values to `DEFAULT_MAX_CONCURRENCY`, so legacy persisted
   * workflows run at the same width as new ones.
   */
  concurrency?: ConcurrencyController
  /**
   * Origin of this run when started from outside the workflow's own
   * trigger node (e.g., IM Claude tool, desktop button, HTTP API). Persisted
   * onto `WorkflowRunRow.triggeredBy` so the IM-side presentation runner can
   * fan-out events to the originating conversation. See
   * `lib/connectors/run-presentation/runner.ts`.
   */
  triggeredBy?: WorkflowTriggeredFrom
  /**
   * Honor `workflow.pinData` — pinned nodes return their frozen value instead
   * of executing. Set ONLY for editor manual runs ("Run" / "Run this step");
   * never for production triggers. Threaded into every `runStep`.
   */
  honorPinData?: boolean
  /**
   * Pre-seed the idempotency cache with these node outputs (keyed by node id)
   * before scheduling. Seeded nodes are treated as already-computed (no
   * executor call) and their value flows to downstream consumers. Used by
   * `runSingleNode` to reuse pinned / last-run upstream data.
   */
  seedOutputs?: Record<string, unknown>
  /**
   * Bound the run to exactly these step ids — every other node is marked
   * skipped before the loop. Used by `runSingleNode` to execute one node plus
   * its (unseeded) ancestors without touching descendants or siblings.
   */
  restrictToStepIds?: ReadonlyArray<string>
  /**
   * Optional run-scoped agent-trace id. Threaded into every step's
   * {@link StepExecutionContext} so AI nodes emit their LLM spans under one
   * trace, letting the eval workflow target assemble the run via `queryByTrace`.
   */
  traceId?: string
  /** Parent/retry provenance. Omitted inputs become a new root run. */
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  /**
   * When true, the terminal-failure safety net (`flow.catch` finalization +
   * onFailure notify) is NOT run for this invocation. Set by the failure
   * handler when it spawns a catch sub-run so a failing recovery path does not
   * recursively trigger its own catch handlers.
   */
  suppressCatch?: boolean
  /** Called after the durable run row exists, before any step executes. */
  onPersisted?: (runId: string) => void
}

export interface RunWorkflowResult {
  runId: string
  status: RunStatus
  output?: unknown
  error?: { message: string; nodeId?: string; code?: string }
}
