/**
 * Step executor — runs one node, with retries, timeout, and idempotency.
 * The orchestrator owns the queue + edge logic; this module owns "given a
 * resolved context, run the executor and persist the result".
 */

import type {
  StepExecutionContext,
  TriggerEvent,
  VisualWorkflow,
  WorkflowNode,
  WorkflowRetryPolicy,
  WorkflowRunLineage,
  WorkflowRunSecurityContext,
} from "@/types/workflow/visual"
import type { WorkflowExecutionBinding } from "@/types/workflow/deployment"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import { retiredNodeKind } from "@/lib/workflow/nodes/retired-kinds"
import { resolveDeep } from "./expression"
import { IdempotencyCache } from "./idempotency"
import type { RunLogger } from "./event-log"
import type { SecretResolver } from "./secret-resolver"
import { createStreamSink } from "./stream-sink"
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from "./circuit-breaker"
import { validateNodeParams } from "@/lib/workflow/nodes/validate-params"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"

export interface RunStepInput {
  workflow: VisualWorkflow
  node: WorkflowNode
  trigger: TriggerEvent
  upstream: Record<string, unknown>
  runId: string
  signal: AbortSignal
  cache: IdempotencyCache
  retryPolicy: WorkflowRetryPolicy
  secretResolver: SecretResolver
  logger: RunLogger
  /**
   * When true AND the workflow has `pinData` for this node, the executor is
   * NOT invoked — the pinned value is returned as the step output (and recorded
   * in the event log like a real step). Set only for editor manual runs; never
   * for production triggers. Mirrors n8n's pin-data semantics.
   */
  honorPinData?: boolean
  /** Run-scoped agent-trace id, threaded onto the step context for AI-node spans. */
  traceId?: string
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  /** Owning workspace, so executors can resolve a directory without a UI store. */
  projectId?: string
  /** Formal-run provenance inherited by every node executor. */
  executionBinding?: WorkflowExecutionBinding
  /**
   * Extra expression idents merged over `upstream` for this step only — the
   * loop container injects `$item` / `$loop` here (see the ident fallback in
   * `expression.ts#evalToken`). Visible both to `resolveDeep` and to the
   * executor's `ctx.upstream`.
   */
  extraUpstream?: Record<string, unknown>
  /**
   * Run-shared mutable state exposed as `{{ $static.* }}`. The loop container
   * threads its accumulator object here; top-level steps default to `{}`.
   */
  staticData?: Record<string, unknown>
  /**
   * Idempotency key override. Loop iterations pass
   * `iterationCacheKey(loopId, i, node.id)` so each iteration memoizes
   * independently; defaults to `node.id`.
   */
  cacheKey?: string
  /** Iteration provenance stamped onto step start/complete event payloads. */
  iterationMeta?: { loopId: string; iterationIndex: number }
  /**
   * Outputs of every node completed so far in this run — the
   * `{{ $nodes['id'] }}` global expression scope. Direct predecessors remain
   * the `upstream` map (`$node[...]`); this is the best-effort superset for
   * non-adjacent reads. Optional so isolated callers stay unchanged.
   */
  nodesOutputs?: Record<string, unknown>
}

export interface StepExecution {
  /** Step output (cache-hit or fresh). */
  output: unknown
  /** Branch/switch decision; orchestrator uses to skip non-chosen edges. */
  decision?: string | string[]
  /** True iff this step came from the idempotency cache (no executor invoked). */
  fromCache: boolean
}

export class InvalidNodeParamsError extends Error {
  readonly code = "invalid-node-params" as const
  readonly retryable = false

  constructor(node: WorkflowNode, errors: readonly string[]) {
    super(
      `Invalid params for node ${node.id} (${node.type}@${node.typeVersion}): ${errors.join("; ")}`
    )
    this.name = "InvalidNodeParamsError"
  }
}

/**
 * Run a single step, returning its output. Memoized by `(runId, stepId)`
 * via the IdempotencyCache. Retries respect the per-workflow retry policy
 * unless the executor returned a non-retryable error.
 */
/**
 * Effective retry policy for one step: the node's own
 * `data.errorHandling.retry` (n8n-style per-node setting; maxRetries = extra
 * attempts after the first) wins over the workflow-level `retryDefaults`.
 */
export function resolveStepRetryPolicy(
  node: WorkflowNode,
  workflowDefault: WorkflowRetryPolicy
): WorkflowRetryPolicy {
  const nodeRetry = node.data.errorHandling?.retry
  if (!nodeRetry) return workflowDefault
  return {
    attempts: Math.max(1, nodeRetry.maxRetries + 1),
    backoff: nodeRetry.backoff,
    baseMs: Math.max(0, nodeRetry.retryIntervalMs),
    ...(typeof nodeRetry.maxIntervalMs === "number" ? { maxMs: nodeRetry.maxIntervalMs } : {}),
  }
}

export async function runStep(input: RunStepInput): Promise<StepExecution> {
  const { node, runId, cache, signal, logger } = input
  const retryPolicy = resolveStepRetryPolicy(node, input.retryPolicy)
  const cacheKey = input.cacheKey ?? node.id

  if (cache.has(cacheKey)) {
    return { output: cache.get(cacheKey), fromCache: true }
  }

  // Pin-data short-circuit (editor manual runs only). The pinned value stands
  // in for the executor's output so downstream nodes + the data view see it,
  // and the run timeline records a normal started/completed pair.
  if (
    input.honorPinData &&
    input.workflow.pinData &&
    Object.prototype.hasOwnProperty.call(input.workflow.pinData, node.id)
  ) {
    const pinned = input.workflow.pinData[node.id]
    await logger.stepStarted(node.id, { pinned: true }, input.iterationMeta)
    cache.set(cacheKey, pinned)
    await logger.stepCompleted(node.id, pinned, input.iterationMeta)
    return { output: pinned, fromCache: false }
  }

  const reg = getExecutor(node.type, node.typeVersion)
  if (!reg) {
    // A retired kind cannot be fixed by installing a plugin from this app, so
    // it must not be reported as if it could. The editor's `kindRetired`
    // diagnostic blocks the run before it starts; this covers the paths that
    // do not go through the editor — scheduled runs, API-triggered runs, and
    // a workflow whose provider was unregistered mid-run.
    const retired = retiredNodeKind(node.type)
    const err = new Error(
      retired
        ? `Node kind ${node.type} was removed in ${retired.removedIn} and has no executor. ` +
            `Re-author this step, or install the compatibility plugin that provides it.`
        : `No executor registered for ${node.type}@${node.typeVersion}. ` +
            `Install the plugin that provides it, or change the node type.`
    )
    await logger.stepFailed(node.id, { message: err.message, retryable: false })
    throw err
  }

  // Resolve params with expression substitution before passing to the executor.
  // `extraUpstream` rides on top of the real upstream map so loop-injected
  // idents (`$item` / `$loop`) resolve through evalToken's ident fallback.
  const upstream = input.extraUpstream
    ? { ...input.upstream, ...input.extraUpstream }
    : input.upstream
  const resolvedParams = resolveDeep(node.data.params, {
    upstream,
    trigger: input.trigger,
    staticData: input.staticData ?? {},
    params: node.data.params as Record<string, unknown>,
    variables: input.workflow.variables ?? {},
    ...(input.nodesOutputs ? { nodes: input.nodesOutputs } : {}),
  })
  const resolvedParamRecord =
    resolvedParams && typeof resolvedParams === "object" && !Array.isArray(resolvedParams)
      ? (resolvedParams as Record<string, unknown>)
      : {}
  // Built-in Zod schemas describe the authored inspector payload. Validate
  // that payload before expression substitution: a valid expression string
  // may resolve to a boolean, number, object, or array that intentionally no
  // longer matches the editor field's source type. Plugin JSON Schemas, by
  // contrast, are execution contracts and therefore validate resolved input.
  const paramErrors = validateNodeParams(node.type, node.data.params).summary
  const pluginParamsSchema = nodeCatalogEntry(node.type).paramsSchema
  if (pluginParamsSchema) {
    const pluginValidation = validateAgainstJsonSchema(pluginParamsSchema, resolvedParamRecord)
    if (!pluginValidation.ok) paramErrors.push(...pluginValidation.errors)
  }
  if (paramErrors.length > 0) {
    const err = new InvalidNodeParamsError(node, paramErrors)
    await logger.stepFailed(node.id, { message: err.message, retryable: false })
    throw err
  }

  const ctx: StepExecutionContext = {
    runId,
    workflowId: input.workflow.id,
    stepId: node.id,
    ...(input.iterationMeta ? { iteration: input.iterationMeta } : {}),
    ...(input.executionBinding ? { executionBinding: input.executionBinding } : {}),
    ...(input.lineage ? { lineage: input.lineage } : {}),
    ...(input.securityContext ? { securityContext: input.securityContext } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    params: resolvedParamRecord,
    upstream,
    trigger: input.trigger,
    signal,
    log: (level, message, payload) => void logger.log(level, message, payload, node.id),
    resolveSecret: (refId) => input.secretResolver.resolve(refId),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  }

  if (reg.pluginId && input.executionBinding?.dependencyLock?.plugins) {
    const [{ getPlugin }, { assertWorkflowPluginDependencyLock, WorkflowPluginLockError }] =
      await Promise.all([
        import("@/lib/db/plugins"),
        import("@/lib/workflow/runtime/plugin-dependency-lock"),
      ])
    const plugin = await getPlugin(reg.pluginId)
    if (!plugin) {
      throw new WorkflowPluginLockError(
        "plugin-not-locked",
        `Plugin executor ${reg.pluginId} is unavailable for this immutable workflow release.`
      )
    }
    assertWorkflowPluginDependencyLock(input.executionBinding, plugin)
  }

  // Circuit breaker (A4): if this node has tripped its breaker, fail fast
  // BEFORE consuming an attempt. The CircuitOpenError is non-retryable, so it
  // flows straight through the orchestrator's onError / error-edge path.
  const breaker = node.data.errorHandling?.circuitBreaker
  if (breaker) {
    try {
      assertCircuitClosed(input.workflow.id, node.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await logger.stepFailed(node.id, { message, retryable: false })
      throw err instanceof Error ? err : new Error(message)
    }
  }

  let attempt = 0

  while (true) {
    attempt += 1
    if (signal.aborted) {
      const err = new Error("Workflow run aborted")
      await logger.stepFailed(node.id, { message: err.message, retryable: false })
      throw err
    }

    await logger.stepStarted(node.id, { attempt }, input.iterationMeta)
    // Fresh sink per attempt so a failed attempt's partial stream never
    // interleaves with the retry's output. The sink throttles `step_stream`
    // writes; commentary uses an independent channel so it cannot be folded
    // into final output. Usage lands as one `step_usage` event.
    const sink = createStreamSink({ stepId: node.id, logger })
    const commentarySink = createStreamSink({
      stepId: node.id,
      logger: { stepStream: logger.stepCommentary },
    })
    ctx.emitStream = (delta) => sink.push(delta)
    ctx.emitCommentary = (delta) => commentarySink.push(delta)
    ctx.reportUsage = (usage) => void logger.stepUsage(node.id, usage)
    try {
      const result = await runWithTimeout(
        reg.timeoutMs ?? input.workflow.settings.timeoutMs,
        signal,
        (attemptSignal) => reg.execute({ ...ctx, signal: attemptSignal })
      )
      sink.final()
      commentarySink.final()
      const exec: StepExecution = {
        output: result.output,
        decision: result.decision,
        fromCache: false,
      }
      // Forward any executor-supplied logs into the durable event log
      // BEFORE the step_completed marker so timeline order is correct.
      if (result.logs?.length) {
        for (const l of result.logs) {
          await logger.log(l.level, l.message, l.payload, node.id)
        }
      }
      cache.set(cacheKey, result.output)
      if (breaker) recordCircuitSuccess(input.workflow.id, node.id)
      await logger.stepCompleted(node.id, result.output, input.iterationMeta)
      return exec
    } catch (err) {
      sink.final()
      commentarySink.final()
      const message = err instanceof Error ? err.message : String(err)
      const retryable = reg.retryable !== false && isRetryableError(err)
      const lastAttempt = attempt >= retryPolicy.attempts
      await logger.stepFailed(node.id, { message, retryable })

      if (!retryable || lastAttempt) {
        // Terminal failure for this node — feed the breaker so a repeatedly
        // failing node eventually trips and fail-fasts on the next run.
        if (breaker) recordCircuitFailure(input.workflow.id, node.id, breaker)
        throw err instanceof Error ? err : new Error(message)
      }

      const delay = computeBackoffMs(retryPolicy, attempt)
      await logger.stepRetrying(node.id, {
        attempt,
        maxAttempts: retryPolicy.attempts,
        delayMs: delay,
        error: message,
      })
      await logger.log(
        "warn",
        `step ${node.id} failed (attempt ${attempt}/${retryPolicy.attempts}); retrying in ${delay}ms`,
        { error: message },
        node.id
      )
      await wait(delay, signal)
    }
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const tagged = (err as Error & { retryable?: boolean }).retryable
    if (typeof tagged === "boolean") return tagged
    // Aborts are never retryable.
    if (err.name === "AbortError") return false
  }
  // Conservative default: retry once. If the error class flagged itself
  // non-retryable above, that wins.
  return true
}

function computeBackoffMs(policy: WorkflowRetryPolicy, attempt: number): number {
  const base = Math.max(0, policy.baseMs)
  if (policy.backoff === "fixed") return base
  // Exponential — `attempt` is 1-indexed; first retry waits `base`, next
  // `base * 2`, etc.
  const raw = base * Math.pow(2, attempt - 1)
  if (typeof policy.maxMs === "number") return Math.min(raw, policy.maxMs)
  return raw
}

async function runWithTimeout<T>(
  timeoutMs: number,
  outer: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ac = new AbortController()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      outer.removeEventListener("abort", onAbort)
    }
    const settle = (outcome: { value: T } | { error: unknown }) => {
      if (settled) return
      settled = true
      cleanup()
      if ("value" in outcome) resolve(outcome.value)
      else reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)))
    }
    const onAbort = () => {
      const err = new Error("Workflow run aborted")
      err.name = "AbortError"
      ac.abort(err)
      settle({ error: err })
    }

    if (outer.aborted) {
      onAbort()
      return
    }
    outer.addEventListener("abort", onAbort, { once: true })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`Step exceeded timeout (${timeoutMs}ms)`)
        err.name = "TimeoutError"
        ac.abort(err)
        settle({ error: err })
      }, timeoutMs)
    }
    Promise.resolve()
      .then(() => fn(ac.signal))
      .then(
        (value) => settle({ value }),
        (error) => settle({ error })
      )
  })
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Workflow run aborted"))
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error("Workflow run aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
