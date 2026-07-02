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
 *   5. Schedule ready nodes up to `maxConcurrency` (ADR-0022 §1 Decision).
 *      Default `maxConcurrency=1` preserves the legacy sequential behavior;
 *      higher values allow independent nodes to run concurrently.
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
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { validateWorkflow, type ValidatedVisualWorkflow } from "@/lib/workflow/definition/validate"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { generateWorkflowRunTitle } from "@/lib/workflow/runtime/run-title"
import type {
  RunStatus,
  TriggerEvent,
  VisualWorkflow,
  WorkflowEdge,
  WorkflowRunRow,
  WorkflowTriggeredFrom,
} from "@/types/workflow/visual"
// Importing the built-ins triggers their registration side effect.
import "@/lib/workflow/nodes/built-ins"
import { createRunLogger } from "./event-log"
import {
  CAPABILITY_MISSING_CODE_PREFIX,
  formatPreflightFailures,
  preflightCapabilities,
  remoteCapabilityUnion,
} from "./capability-preflight"
import { IdempotencyCache } from "./idempotency"
import { topoSort, upstream as upstreamOf } from "./topo-sort"
import { runStep } from "./step-executor"
import { runLoopContainer } from "./loop-container"
import { buildErrorOutput, resolveNodeFailure } from "./node-failure"
import { isJoinCancel, JoinCancelError, losingBranchScope } from "./branch-scope"
import { type SecretResolver } from "./secret-resolver"
import { getDefaultSecretResolver } from "./secret-resolver-keyring"
import { ackRunCompleted, persistRunState } from "./tauri-bridge"
import { registerRun, unregisterRun } from "./run-cancel-registry"
import { type ConcurrencyController, createConcurrencyController } from "./concurrency-controller"

/**
 * Release run-scoped resources, then drop the cancel-registry entry.
 * Terminal sessions opened by `action.terminal.session.open` are closed
 * here so a run can never leak a PTY — regardless of how it terminated.
 * Cleanup failures are swallowed: they must never mask the run's result.
 */
async function releaseRunResources(runId: string): Promise<void> {
  try {
    const { closeRunSessions } = await import("@/lib/terminal/headless-session-registry")
    await closeRunSessions(runId)
  } catch {
    // best-effort cleanup
  }
  unregisterRun(runId)
}

export interface RunWorkflowInput {
  workflow: VisualWorkflow
  trigger: TriggerEvent
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
   * `workflow.settings.maxConcurrency ?? 1`, making the change backward-
   * compatible with existing call sites (sequential behavior preserved).
   */
  concurrency?: ConcurrencyController
  /**
   * Origin of this run when started from outside the workflow's own
   * trigger node (e.g., IM Claude tool, desktop button, HTTP API). Persisted
   * onto `WorkflowRunRow.triggeredBy` so the IM-side progress-runner can
   * fan-out events to the originating conversation. See
   * `lib/connectors/a2ui-bridge/workflow-progress-runner.ts`.
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
  /**
   * When true, the terminal-failure safety net (`flow.catch` finalization +
   * onFailure notify) is NOT run for this invocation. Set by the failure
   * handler when it spawns a catch sub-run so a failing recovery path does not
   * recursively trigger its own catch handlers.
   */
  suppressCatch?: boolean
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
  // Workspace isolation (Dexie v86): a run belongs to the active workspace at
  // trigger time. Shared workflow definitions, per-workspace run history.
  const projectId = await resolveScopeProjectId()
  let runRow: WorkflowRunRow = {
    id: runId,
    workflowId: workflow.id,
    projectId,
    status: "running",
    triggerKind: trigger.kind,
    triggerPayload: trigger.payload,
    triggerBinding: trigger.binding,
    startedAt,
    workflowSnapshot: validated as VisualWorkflow,
    ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    // Denormalised indexed column (Dexie v91) so the IM progress-runner can
    // query `.where("triggeredBySource").equals("im")` instead of scanning the
    // whole table. "ui" is the default origin for non-IM/non-API runs.
    triggeredBySource: input.triggeredBy?.source ?? "ui",
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

  // 2b. Capability preflight (ADR 0060): fail the run at t=0 — one structured,
  // recoverable failure — when this runtime lacks a capability some node
  // requires, instead of an executor-internal throw after earlier steps ran
  // with side effects. Re-runs on resume by design (the resuming device must
  // also hold the caps).
  const preflightFailures = preflightCapabilities(validated, undefined, {
    restrictToNodeIds: input.restrictToStepIds,
    seededNodeIds: input.seedOutputs ? Object.keys(input.seedOutputs) : undefined,
    // ADR 0061 P3 — requirements satisfiable via a paired device pass here;
    // the mobile proxy executors own run-time reachability failures.
    remoteCapabilities: await remoteCapabilityUnion(),
  })
  if (preflightFailures.length > 0) {
    const message = formatPreflightFailures(preflightFailures)
    const code = CAPABILITY_MISSING_CODE_PREFIX + preflightFailures[0].missing[0]
    const nodeId = preflightFailures[0].nodeId
    await logger.runFailed({ message, nodeId, code })
    runRow = {
      ...runRow,
      status: "failed",
      completedAt: Date.now(),
      error: { message, nodeId, code },
    }
    await getDb().workflowRuns.put(runRow)
    await persistRunState({ runId, workflowId: workflow.id, status: "failed" })
    getPluginEventHooks().dispatchWorkflowError(workflow.id, new Error(message))
    getPluginEventHooks().dispatchWorkflowComplete(workflow.id, false)
    await releaseRunResources(runId)
    return { runId, status: "failed", error: { message, nodeId, code } }
  }

  // 3. Set up the abort + idempotency machinery.
  const ac = new AbortController()
  // Expose this run to the out-of-band cancel registry so a remote
  // `workflow_cancel_run` RPC can abort it. Unregistered on every terminal
  // path below.
  registerRun(runId, ac)
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
  // Pre-seed reused upstream outputs (runSingleNode) so seeded nodes cache-hit
  // instead of re-executing.
  if (input.seedOutputs) {
    for (const [id, value] of Object.entries(input.seedOutputs)) {
      if (!cache.has(id)) cache.set(id, value)
    }
  }
  const secretResolver = input.secretResolver ?? getDefaultSecretResolver()

  // Dynamic concurrency cap (ADR-0022 §3.7). Defaults to settings.maxConcurrency
  // or 1, preserving sequential behavior for existing callers.
  const concurrency =
    input.concurrency ?? createConcurrencyController(validated.settings.maxConcurrency ?? 1)

  // Loop-container bodies (schemaVersion 2): nodes whose parent is a flow.loop
  // container belong to that container's sub-canvas and are executed by the
  // loop runtime — they must NEVER be scheduled at the top level.
  //
  // annotation.group children ALSO carry `parentId` (for the canvas's visual
  // nesting), but a group is NOT an execution boundary — its children are
  // ordinary top-level nodes at run time. So only LOOP children are excluded.
  const loopContainerIds = new Set(
    validated.nodes.filter((n) => n.type === "flow.loop" && n.typeVersion >= 2).map((n) => n.id)
  )
  const childNodeIds = new Set(
    validated.nodes
      .filter((n) => n.parentId !== undefined && loopContainerIds.has(n.parentId))
      .map((n) => n.id)
  )
  const topLevelNodeCount = validated.nodes.length - childNodeIds.size

  // 4. Topo-sort. If sort throws (cycles snuck past validation), fail loudly.
  let order: string[]
  let backEdgeIds: Set<string>
  try {
    const sortResult = topoSort(validated as VisualWorkflow)
    order = sortResult.order.filter((id) => !childNodeIds.has(id))
    backEdgeIds = new Set(sortResult.backEdges.map((e) => e.id))
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
    await releaseRunResources(runId)
    return { runId, status: "failed", error: { message } }
  }

  // 5. Schedule.
  const skipped = new Set<string>()
  const completed = new Set<string>()
  const stepOutputs = new Map<string, unknown>()
  const retryPolicy = validated.settings.retryDefaults
  let executedStepIndex = -1
  let firstFailure: { stepId: string; err: unknown } | undefined

  // Forward-edge dependency map for cheap ready checks (top-level only —
  // body-internal edges are the loop runtime's concern).
  const topLevelForwardEdges = validated.edges.filter(
    (e) => !backEdgeIds.has(e.id) && !childNodeIds.has(e.source) && !childNodeIds.has(e.target)
  )
  const stepDeps = new Map<string, Set<string>>()
  for (const n of validated.nodes) {
    if (!childNodeIds.has(n.id)) stepDeps.set(n.id, new Set())
  }
  for (const edge of topLevelForwardEdges) {
    stepDeps.get(edge.target)?.add(edge.source)
  }

  // flow.join fan-in policy (P3). "any"/"race" joins become ready on their
  // FIRST completed dependency; "race" additionally cancels the losing
  // branches. TOP-LEVEL joins only — a join inside a loop body falls back to
  // "all" (the loop runtime has its own readiness; documented limitation).
  const joinPolicyOf = (stepId: string): "any" | "race" | null => {
    const n = validated.nodes.find((n) => n.id === stepId)
    // A join inside a LOOP body falls back to "all"; a join inside an
    // annotation.group is still a top-level join (group is visual-only).
    const isLoopChild = n?.parentId !== undefined && loopContainerIds.has(n.parentId)
    if (!n || n.type !== "flow.join" || isLoopChild) return null
    const policy = (n.data.params as { joinPolicy?: unknown }).joinPolicy
    return policy === "any" || policy === "race" ? policy : null
  }

  // Per-step abort controllers (children of the run-level `ac`) so a race
  // join can cancel ONLY the losing branches without touching siblings.
  const stepControllers = new Map<string, AbortController>()

  // If "Run from here" was requested, mark every node that is NOT the
  // start step OR a descendant of it as skipped before stepping. This
  // bounds the run to the subgraph rooted at startStepId without changing
  // the executor semantics (skipped steps emit `stepSkipped` events as
  // usual). We use a BFS over forward edges from the start node.
  if (input.startStepId) {
    const wf = validated as VisualWorkflow
    if (!wf.nodes.some((n) => n.id === input.startStepId)) {
      const message = `startStepId ${input.startStepId} not present in workflow`
      await logger.runFailed({ message })
      runRow = { ...runRow, status: "failed", completedAt: Date.now(), error: { message } }
      await getDb().workflowRuns.put(runRow)
      await persistRunState({ runId, workflowId: workflow.id, status: "failed" })
      getPluginEventHooks().dispatchWorkflowError(workflow.id, new Error(message))
      getPluginEventHooks().dispatchWorkflowComplete(workflow.id, false)
      await releaseRunResources(runId)
      return { runId, status: "failed", error: { message } }
    }
    const reachable = new Set<string>([input.startStepId])
    const queue: string[] = [input.startStepId]
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const edge of wf.edges) {
        if (edge.source === cur && !reachable.has(edge.target)) {
          reachable.add(edge.target)
          queue.push(edge.target)
        }
      }
    }
    for (const stepId of order) {
      if (!reachable.has(stepId)) skipped.add(stepId)
    }
  }

  // "Run this step" — bound the run to an explicit allow-list (target node +
  // its ancestors). Everything else is skipped before stepping.
  if (input.restrictToStepIds) {
    const keep = new Set(input.restrictToStepIds)
    for (const stepId of order) {
      if (!keep.has(stepId)) skipped.add(stepId)
    }
  }

  // Eagerly log pre-skipped steps so the event log mirrors today's behavior.
  // We also track which steps we've already logged-as-skipped so we don't
  // double-emit when branch routing / disabled propagation grows the set.
  const loggedSkips = new Set<string>()
  for (const stepId of order) {
    if (skipped.has(stepId)) {
      await logger.stepSkipped(stepId, "Skipped due to upstream branch decision or disabled flag")
      loggedSkips.add(stepId)
    }
  }

  const flushNewSkipLogs = async (): Promise<void> => {
    for (const stepId of order) {
      if (skipped.has(stepId) && !loggedSkips.has(stepId)) {
        await logger.stepSkipped(stepId, "Skipped due to upstream branch decision or disabled flag")
        loggedSkips.add(stepId)
      }
    }
  }

  const inflight = new Map<string, Promise<void>>()

  const isReady = (stepId: string): boolean => {
    if (completed.has(stepId) || skipped.has(stepId)) return false
    if (inflight.has(stepId)) return false
    if (firstFailure) return false
    const deps = stepDeps.get(stepId)
    if (!deps) return false
    // "any"/"race" joins proceed on their FIRST completed dependency —
    // late arrivals drain (any) or get cancelled (race) afterwards.
    if (deps.size > 0 && joinPolicyOf(stepId)) {
      for (const dep of deps) {
        if (completed.has(dep)) return true
      }
      return false
    }
    for (const dep of deps) {
      if (!completed.has(dep) && !skipped.has(dep)) return false
    }
    return true
  }

  /**
   * Race cancellation: once a race join proceeds, abort the in-flight steps
   * and pre-skip the pending steps of every losing branch. Cancelled steps
   * land as `step_skipped` (see the JoinCancel mapping in the catch below)
   * and never write the idempotency cache, so a later resume re-runs them
   * only if the join outcome is gone.
   */
  const cancelLosingBranches = (joinId: string): void => {
    const deps = stepDeps.get(joinId)
    if (!deps) return
    const winner = [...deps].find((d) => completed.has(d))
    if (!winner) return
    for (const loser of deps) {
      if (loser === winner || completed.has(loser)) continue
      const scope = losingBranchScope(topLevelForwardEdges, joinId, winner, loser)
      for (const id of scope) {
        if (completed.has(id)) continue
        skipped.add(id)
        stepControllers.get(id)?.abort(new JoinCancelError(joinId))
      }
    }
  }

  const scheduleOne = (stepId: string): Promise<void> => {
    const node = validated.nodes.find((n) => n.id === stepId)
    if (!node) {
      completed.add(stepId)
      return Promise.resolve()
    }
    if (node.data.disabled) {
      return (async () => {
        await logger.stepSkipped(stepId, "Node is disabled")
        // Disabled nodes should not block downstream — propagate skip.
        propagateSkip(validated as VisualWorkflow, stepId, skipped)
      })()
    }

    // Gather upstream outputs.
    const upstreamMap: Record<string, unknown> = {}
    for (const sourceId of upstreamOf(validated as VisualWorkflow, stepId)) {
      // A skipped source still feeds downstream when its value is available in
      // the idempotency cache — i.e. it was explicitly seeded ("re-run from
      // this step" reuses the prior run's upstream outputs) or already computed
      // on a resume. Branch / disabled skips never populate the cache, so they
      // still collapse to `undefined` here, preserving "run from here" semantics.
      if (skipped.has(sourceId) && !cache.has(sourceId)) continue
      if (stepOutputs.has(sourceId)) {
        upstreamMap[sourceId] = stepOutputs.get(sourceId)
      } else if (cache.has(sourceId)) {
        upstreamMap[sourceId] = cache.get(sourceId)
      }
    }

    // Child abort controller — follows the run-level signal AND can be
    // aborted individually by a race join cancelling this branch.
    const stepAc = new AbortController()
    const onRunAbort = () => stepAc.abort(ac.signal.reason ?? new Error("Workflow run aborted"))
    if (ac.signal.aborted) onRunAbort()
    else ac.signal.addEventListener("abort", onRunAbort, { once: true })
    stepControllers.set(stepId, stepAc)

    return (async () => {
      try {
        getPluginEventHooks().dispatchWorkflowNodeStart(workflow.id, node.id, node.type)
        // Loop containers (schemaVersion 2) run their body subgraph through
        // the loop runtime; everything else goes through the plain step path.
        const result: { output: unknown; decision?: string | string[]; fromCache: boolean } =
          node.type === "flow.loop" && node.typeVersion >= 2
            ? await runLoopContainer({
                workflow: validated as VisualWorkflow,
                node,
                trigger,
                upstream: upstreamMap,
                runId,
                signal: stepAc.signal,
                cache,
                retryPolicy,
                secretResolver,
                logger,
                honorPinData: input.honorPinData,
                ...(input.traceId ? { traceId: input.traceId } : {}),
              })
            : await runStep({
                workflow: validated as VisualWorkflow,
                node,
                trigger,
                upstream: upstreamMap,
                runId,
                signal: stepAc.signal,
                cache,
                retryPolicy,
                secretResolver,
                logger,
                honorPinData: input.honorPinData,
                ...(input.traceId ? { traceId: input.traceId } : {}),
              })
        stepOutputs.set(stepId, result.output)
        completed.add(stepId)
        // A join-cancel may have raced this step's own completion — keep the
        // completed/skipped sets disjoint so progress counting stays exact.
        skipped.delete(stepId)
        // P3: a race join cancels the losing branches the moment it proceeds.
        if (node.type === "flow.join" && joinPolicyOf(stepId) === "race") {
          cancelLosingBranches(stepId)
        }
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
        getPluginEventHooks().dispatchWorkflowNodeComplete(
          workflow.id,
          node.id,
          node.type,
          result.output
        )

        // Branch routing — if a node returned `decision`, mark non-chosen
        // outgoing edges' targets as skipped. `sourceHandle` is the stable
        // routing key (v2 multi-output handles emit decisions as handle ids);
        // `label` is the v1 fallback for edges drawn from a single handle and
        // routed by display label. Handle must win — otherwise renaming an
        // edge's label on a v2 node would silently re-route the run.
        if (result.decision !== undefined) {
          const decisions = Array.isArray(result.decision) ? result.decision : [result.decision]
          const chosen = new Set(decisions)
          for (const edge of validated.edges.filter((e) => e.source === stepId)) {
            const routeKey = edge.sourceHandle ?? edge.label ?? "default"
            if (!chosen.has(routeKey) && chosen.size > 0) {
              propagateSkip(validated as VisualWorkflow, edge.target, skipped)
            }
          }
        }
      } catch (err) {
        // Race-join cancellation is NOT a failure: map to skipped, never
        // cache, never set firstFailure. (`skipped` already contains the id —
        // cancelLosingBranches adds it before aborting — but keep this
        // idempotent in case the abort raced the step's own completion.)
        if (isJoinCancel(stepAc.signal.reason) || isJoinCancel(err)) {
          skipped.add(stepId)
          return
        }
        const errorObj = err instanceof Error ? err : new Error(String(err))
        getPluginEventHooks().dispatchWorkflowNodeError(workflow.id, stepId, errorObj)
        const policy = validated.settings.errorPolicy
        const outgoing = validated.edges.filter((e) => e.source === stepId)

        // Per-node error handling (data.errorHandling.onError) wins over the
        // workflow-level policy. mode null → legacy behavior below.
        // Handled failures emit a `step_completed` with the substituted
        // output AFTER the recorded `step_failed`: the data view shows what
        // downstream actually consumed, the resume path replays it through
        // the event-log cache hydration, and the run summary derives the
        // "succeeded with handled failure" warning state from the pair.
        const nodeFailure = resolveNodeFailure(node)
        if (nodeFailure.mode === "continue") {
          // n8n semantics: downstream RUNS with an error-shaped output —
          // NOT the legacy workflow-level "continue" (which skips downstream).
          const output = buildErrorOutput(errorObj)
          stepOutputs.set(stepId, output)
          cache.set(stepId, output)
          completed.add(stepId)
          await logger.stepCompleted(stepId, output)
          return
        }
        if (nodeFailure.mode === "defaultValue") {
          stepOutputs.set(stepId, nodeFailure.defaultValue)
          cache.set(stepId, nodeFailure.defaultValue)
          completed.add(stepId)
          await logger.stepCompleted(stepId, nodeFailure.defaultValue)
          return
        }
        if (nodeFailure.mode === "errorBranch") {
          const errorEdges = outgoing.filter(isErrorEdge)
          if (errorEdges.length > 0) {
            const output = buildErrorOutput(errorObj)
            stepOutputs.set(stepId, output)
            cache.set(stepId, output)
            completed.add(stepId)
            await logger.stepCompleted(stepId, output)
            for (const edge of outgoing) {
              if (!isErrorEdge(edge)) {
                propagateSkip(validated as VisualWorkflow, edge.target, skipped)
              }
            }
            return
          }
          // errorBranch chosen but no error edge drawn → fall through to the
          // legacy policy so the failure is never silently swallowed.
        }

        // errorPolicy: "branch" — when the failed node has dedicated error
        // edges, treat the failure as handled: expose the error to the error
        // branch, skip the success path, and keep the run alive.
        if (policy === "branch") {
          const errorEdges = outgoing.filter(isErrorEdge)
          if (errorEdges.length > 0) {
            stepOutputs.set(stepId, { failed: true, error: errorObj.message })
            completed.add(stepId)
            for (const edge of outgoing) {
              if (!isErrorEdge(edge)) {
                propagateSkip(validated as VisualWorkflow, edge.target, skipped)
              }
            }
            return
          }
          // No error edges configured → fall through to "stop" semantics.
        }

        // errorPolicy: "continue" — best-effort. Drop this node's downstream
        // but keep independent branches running; the run finalizes normally
        // (the step_failed event in the log records the failure).
        if (policy === "continue") {
          completed.add(stepId)
          for (const edge of outgoing) {
            propagateSkip(validated as VisualWorkflow, edge.target, skipped)
          }
          return
        }

        // errorPolicy: "stop" (default) — abort the whole run so concurrent
        // siblings observing ac.signal cancel early. Subsequent throws after
        // firstFailure are ignored.
        if (!firstFailure) firstFailure = { stepId, err }
        ac.abort(errorObj)
      } finally {
        ac.signal.removeEventListener("abort", onRunAbort)
        stepControllers.delete(stepId)
      }
    })()
  }

  // Main scheduling loop. Continue while there is more work and no failure.
  while (completed.size + skipped.size < topLevelNodeCount) {
    if (firstFailure) break
    if (ac.signal.aborted && inflight.size === 0) break

    let scheduledThisTick = 0
    for (const stepId of order) {
      if (inflight.size >= concurrency.get()) break
      if (!isReady(stepId)) continue
      const promise = scheduleOne(stepId).finally(() => {
        inflight.delete(stepId)
      })
      inflight.set(stepId, promise)
      scheduledThisTick += 1
    }

    if (inflight.size === 0) {
      // Nothing scheduled this tick AND nothing in flight — either the run is
      // done or the remaining nodes are unreachable (deps will never resolve).
      // Either way, exit the loop; finalization decides terminal status.
      if (scheduledThisTick === 0) break
      // Disabled-only schedule that resolved synchronously without awaiting —
      // loop again to pick up newly-skipped descendants.
      await flushNewSkipLogs()
      continue
    }

    await Promise.race(inflight.values())
    await flushNewSkipLogs()
  }

  // Drain any still-pending tasks so we don't leak unresolved promises.
  if (inflight.size > 0) {
    await Promise.allSettled(inflight.values())
  }

  if (firstFailure) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const { stepId, err } = firstFailure
    const baseMessage = err instanceof Error ? err.message : String(err)
    const message = wallClockExpired
      ? `Wall-clock timeout (${wallClockTimeoutMs}ms) exceeded — aborted at ${stepId}`
      : baseMessage
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
    // Small-model "work content" title for this run — fire-and-forget. A failed
    // run still describes real work, so it gets a title too.
    void generateWorkflowRunTitle(runId)
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

    // Terminal-failure safety net (A1/A2). Skipped when this IS a catch sub-run
    // (`suppressCatch`) so a failing recovery path can't recurse. Best-effort:
    // a thrown handler must never mask the original failure or leak the run.
    if (!input.suppressCatch) {
      const onFailure = validated.settings.onFailure
      const runCatch = onFailure?.runCatchNodes !== false
      try {
        const { runCatchHandlers, findCatchNodes } = await import("./failure-handler")
        if (runCatch && findCatchNodes(validated as VisualWorkflow).length > 0) {
          await runCatchHandlers({
            workflow: validated as VisualWorkflow,
            error: { stepId, message, code: errorCode },
            secretResolver: input.secretResolver,
            signal: input.signal,
          })
        }
      } catch {
        // recovery path failed — original failure already recorded
      }
      if (onFailure?.notify) {
        await logger.log(
          "error",
          "Workflow run failed",
          { notify: true, error: message, nodeId: stepId, code: errorCode },
          stepId
        )
      }
    }

    await releaseRunResources(runId)
    return { runId, status: "failed", error: { message, nodeId: stepId, code: errorCode } }
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
  // Small-model "work content" title for this run — fire-and-forget.
  void generateWorkflowRunTitle(runId)
  // Plugin host hook: workflow finished successfully.
  getPluginEventHooks().dispatchWorkflowComplete(workflow.id, true, finalOutput)

  await releaseRunResources(runId)
  return { runId, status: "succeeded", output: finalOutput }
}

/**
 * An "error" edge carries the error branch under `errorPolicy: "branch"`.
 * Either the React Flow source handle id or the edge `data.kind` may mark it.
 */
function isErrorEdge(edge: WorkflowEdge): boolean {
  return edge.sourceHandle === "error" || edge.data?.kind === "error"
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
  const loopContainerIds = new Set(
    workflow.nodes.filter((n) => n.type === "flow.loop" && n.typeVersion >= 2).map((n) => n.id)
  )
  return workflow.nodes
    .filter(
      (n) =>
        !hasOutgoing.has(n.id) &&
        !n.type.startsWith("trigger.") &&
        // Annotations never produce run output.
        !n.type.startsWith("annotation.") &&
        // Loop-body children are internal to their container — the container
        // itself is the visible terminal when nothing follows it. (group
        // children are ordinary top-level nodes, so they CAN be terminal.)
        !(n.parentId !== undefined && loopContainerIds.has(n.parentId))
    )
    .map((n) => n.id)
}
