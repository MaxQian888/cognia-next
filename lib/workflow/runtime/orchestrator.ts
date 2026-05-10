/**
 * Workflow orchestrator. Top-level entry point for executing a workflow.
 *
 *     const result = await runWorkflow({ workflow, trigger })
 *
 * Responsibilities (per the architecture diagram in the plan):
 *   1. Clone the workflow definition into a frozen run snapshot.
 *   2. Validate (zod + graph integrity).
 *   3. Resolve secrets / credentials at the boundary.
 *   4. Topo-sort the graph; identify back-edges for loop/wait nodes.
 *   5. Step through the queue, gathering upstream outputs, calling the step
 *      executor, and routing on branch decisions.
 *   6. Persist the WorkflowRunRow + every WorkflowRunEventRow to Dexie.
 *   7. Mirror the run state to the Rust SQLite shadow (Tauri only — web mode
 *      uses Dexie alone for crash recovery).
 *
 * The orchestrator emits typed events through `event-log.ts`. The editor +
 * Runs UI bind via `useLiveQuery` so live progress is automatic.
 *
 * Crash recovery: on app boot, `resumeInFlightRuns()` (separate file) finds
 * runs whose status is still `running` in Dexie and re-invokes the
 * orchestrator with the existing runId — the IdempotencyCache hydrates from
 * the event log and skips already-completed steps.
 */

import { nanoid } from "nanoid"
import { getDb } from "@/lib/db/schema"
import { validateWorkflow, type ValidatedVisualWorkflow } from "@/lib/workflow/definition/validate"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type {
  RunStatus,
  TriggerEvent,
  VisualWorkflow,
  WorkflowRunRow,
} from "@/types/workflow/visual"
// Importing the built-ins triggers their registration side effect.
import "@/lib/workflow/nodes/built-ins"
import { createRunLogger } from "./event-log"
import { IdempotencyCache } from "./idempotency"
import { topoSort, upstream as upstreamOf } from "./topo-sort"
import { runStep } from "./step-executor"
import { NoopSecretResolver, type SecretResolver } from "./secret-resolver"
import { ackRunCompleted, persistRunState } from "./tauri-bridge"

export interface RunWorkflowInput {
  workflow: VisualWorkflow
  trigger: TriggerEvent
  /** Override the auto-generated run id (used by the resume path). */
  runId?: string
  /** Override the secret resolver (tests inject in-memory resolvers here). */
  secretResolver?: SecretResolver
  /** External AbortSignal to cancel mid-run. */
  signal?: AbortSignal
}

export interface RunWorkflowResult {
  runId: string
  status: RunStatus
  output?: unknown
  error?: { message: string; nodeId?: string; code?: string }
}

export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const { workflow, trigger } = input
  const runId = input.runId ?? "run_" + nanoid(12)
  const logger = createRunLogger(runId)

  // 1. Validate the workflow.
  const validation = validateWorkflow(workflow)
  if (!validation.ok) {
    const message = `Invalid workflow: ${validation.errors.join("; ")}`
    await logger.runStarted({ trigger })
    await logger.runFailed({ message })
    // Notify plugins that this workflow tried to start but failed validation.
    getPluginEventHooks().dispatchWorkflowStart(workflow.id, workflow.name)
    getPluginEventHooks().dispatchWorkflowError(workflow.id, new Error(message))
    return { runId, status: "failed", error: { message } }
  }
  const validated = validation.workflow as ValidatedVisualWorkflow

  // Plugin host hook: workflow run is starting (after validation, before
  // any step executes). Fires once per run() invocation.
  getPluginEventHooks().dispatchWorkflowStart(workflow.id, workflow.name)

  // 2. Persist the WorkflowRunRow up front so the UI can render it as
  // "running" immediately. We freeze the workflow snapshot here.
  const startedAt = Date.now()
  let runRow: WorkflowRunRow = {
    id: runId,
    workflowId: workflow.id,
    status: "running",
    triggerKind: trigger.kind,
    triggerPayload: trigger.payload,
    triggerBinding: trigger.binding,
    startedAt,
    workflowSnapshot: validated as VisualWorkflow,
  }
  // If we're resuming, the row may already exist — Dexie's `put` handles both.
  await getDb().workflowRuns.put(runRow)
  await persistRunState({
    runId,
    workflowId: workflow.id,
    status: "running",
    snapshot: validated as VisualWorkflow,
  })
  await logger.runStarted({ trigger })

  // 3. Set up the abort + idempotency machinery.
  const ac = new AbortController()
  const externalAbort = () => ac.abort(new Error("Workflow run aborted"))
  if (input.signal) {
    if (input.signal.aborted) ac.abort(new Error("Workflow run aborted"))
    else input.signal.addEventListener("abort", externalAbort, { once: true })
  }
  // Wall-clock timeout for the whole run. Step-level timeouts already exist;
  // this guards against scenarios where many short steps + retries collectively
  // run past the user's expectation. Set to 0 to disable.
  const wallClockTimeoutMs =
    typeof validated.settings.timeoutMs === "number" && validated.settings.timeoutMs > 0
      ? validated.settings.timeoutMs
      : 0
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let wallClockExpired = false
  if (wallClockTimeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      wallClockExpired = true
      ac.abort(new Error(`Workflow run exceeded ${wallClockTimeoutMs}ms wall-clock timeout`))
    }, wallClockTimeoutMs)
  }
  const cache = await IdempotencyCache.hydrate(runId)
  const secretResolver = input.secretResolver ?? NoopSecretResolver

  // 4. Topo-sort. If sort throws (cycles snuck past validation), fail loudly.
  let order: string[]
  try {
    order = topoSort(validated as VisualWorkflow).order
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logger.runFailed({ message })
    runRow = { ...runRow, status: "failed", completedAt: Date.now(), error: { message } }
    await getDb().workflowRuns.put(runRow)
    await persistRunState({ runId, workflowId: workflow.id, status: "failed" })
    // Plugin host hook: cycle / sort failure during run preparation.
    const sortError = err instanceof Error ? err : new Error(message)
    getPluginEventHooks().dispatchWorkflowError(workflow.id, sortError)
    getPluginEventHooks().dispatchWorkflowComplete(workflow.id, false)
    return { runId, status: "failed", error: { message } }
  }

  // 5. Step through the queue.
  const skipped = new Set<string>()
  const stepOutputs = new Map<string, unknown>()
  const retryPolicy = validated.settings.retryDefaults
  let executedStepIndex = -1

  for (const stepId of order) {
    if (skipped.has(stepId)) {
      await logger.stepSkipped(stepId, "Skipped due to upstream branch decision or disabled flag")
      continue
    }
    const node = validated.nodes.find((n) => n.id === stepId)!
    if (node.data.disabled) {
      await logger.stepSkipped(stepId, "Node is disabled")
      // Disabled nodes should not block downstream — propagate skip.
      propagateSkip(validated as VisualWorkflow, stepId, skipped)
      continue
    }

    // Gather upstream outputs.
    const upstreamMap: Record<string, unknown> = {}
    for (const sourceId of upstreamOf(validated as VisualWorkflow, stepId)) {
      if (skipped.has(sourceId)) continue
      if (stepOutputs.has(sourceId)) {
        upstreamMap[sourceId] = stepOutputs.get(sourceId)
      } else if (cache.has(sourceId)) {
        upstreamMap[sourceId] = cache.get(sourceId)
      }
    }

    try {
      const result = await runStep({
        workflow: validated as VisualWorkflow,
        node,
        trigger,
        upstream: upstreamMap,
        runId,
        signal: ac.signal,
        cache,
        retryPolicy,
        secretResolver,
        logger,
      })
      stepOutputs.set(stepId, result.output)
      runRow = { ...runRow, lastCompletedStepId: stepId }
      await persistRunState({
        runId,
        workflowId: workflow.id,
        status: "running",
        lastStepId: stepId,
      })
      // Plugin host hook: a step has completed. `executedStepIndex` counts
      // executed (non-skipped) steps so plugins see a monotonically
      // increasing 0-based counter even when branches skip nodes.
      executedStepIndex += 1
      getPluginEventHooks().dispatchWorkflowStepComplete(
        workflow.id,
        executedStepIndex,
        result.output
      )

      // Branch routing — if a node returned `decision`, mark non-chosen
      // outgoing edges' targets as skipped.
      if (result.decision !== undefined) {
        const decisions = Array.isArray(result.decision) ? result.decision : [result.decision]
        const chosen = new Set(decisions)
        for (const edge of validated.edges.filter((e) => e.source === stepId)) {
          const label = edge.label ?? edge.sourceHandle ?? "default"
          if (!chosen.has(label) && chosen.size > 0) {
            propagateSkip(validated as VisualWorkflow, edge.target, skipped)
          }
        }
      }
    } catch (err) {
      const baseMessage = err instanceof Error ? err.message : String(err)
      const message = wallClockExpired
        ? `Wall-clock timeout (${wallClockTimeoutMs}ms) exceeded — aborted at ${stepId}`
        : baseMessage
      if (timeoutHandle) clearTimeout(timeoutHandle)
      await logger.runFailed({ message, nodeId: stepId })
      // `RunStatus` does not (yet) carry a dedicated "timed_out" variant — we
      // surface the wall-clock expiry through `error.code` so consumers can
      // discriminate without parsing the message string.
      const errorCode = wallClockExpired ? "timeout" : undefined
      runRow = {
        ...runRow,
        status: "failed",
        completedAt: Date.now(),
        error: { message, nodeId: stepId, code: errorCode },
      }
      await getDb().workflowRuns.put(runRow)
      await persistRunState({
        runId,
        workflowId: workflow.id,
        status: "failed",
        lastStepId: stepId,
      })
      // Plugin host hook: workflow failed. Fire both onWorkflowError
      // (error variant) and onWorkflowComplete with success=false so
      // plugins that listen to either get the same signal.
      const failureError = err instanceof Error ? err : new Error(message)
      getPluginEventHooks().dispatchWorkflowError(workflow.id, failureError)
      getPluginEventHooks().dispatchWorkflowComplete(workflow.id, false)
      return { runId, status: "failed", error: { message, nodeId: stepId, code: errorCode } }
    }
  }
  if (timeoutHandle) clearTimeout(timeoutHandle)

  // 6. Wrap up. The "output" of a run is the output of its terminal node(s).
  const terminalIds = computeTerminalNodes(validated as VisualWorkflow)
  const terminalOutputs: Record<string, unknown> = {}
  for (const id of terminalIds) {
    if (skipped.has(id)) continue
    if (stepOutputs.has(id)) terminalOutputs[id] = stepOutputs.get(id)
  }
  const finalOutput =
    Object.keys(terminalOutputs).length === 1 ? Object.values(terminalOutputs)[0] : terminalOutputs

  runRow = {
    ...runRow,
    status: "succeeded",
    completedAt: Date.now(),
    output: finalOutput,
  }
  await getDb().workflowRuns.put(runRow)
  await logger.runCompleted(finalOutput)
  await persistRunState({ runId, workflowId: workflow.id, status: "succeeded" })
  await ackRunCompleted(runId)
  // Plugin host hook: workflow finished successfully.
  getPluginEventHooks().dispatchWorkflowComplete(workflow.id, true, finalOutput)

  return { runId, status: "succeeded", output: finalOutput }
}

/**
 * Mark `nodeId` and every transitively-downstream node as skipped, unless
 * the downstream node has another live upstream path. The orchestrator
 * relies on this to skip whole branches after a flow.branch decision.
 */
function propagateSkip(workflow: VisualWorkflow, startId: string, skipped: Set<string>): void {
  const stack = [startId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (skipped.has(id)) continue
    // Don't skip if some other (non-skipped) parent still feeds this node.
    const liveParents = workflow.edges
      .filter((e) => e.target === id)
      .map((e) => e.source)
      .filter((p) => p !== startId && !skipped.has(p))
    if (liveParents.length > 0 && id !== startId) continue
    skipped.add(id)
    for (const next of workflow.edges.filter((e) => e.source === id).map((e) => e.target)) {
      stack.push(next)
    }
  }
}

function computeTerminalNodes(workflow: VisualWorkflow): string[] {
  const hasOutgoing = new Set(workflow.edges.map((e) => e.source))
  return workflow.nodes
    .filter((n) => !hasOutgoing.has(n.id) && !n.type.startsWith("trigger."))
    .map((n) => n.id)
}
