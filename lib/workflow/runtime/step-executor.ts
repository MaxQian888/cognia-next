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
} from "@/types/workflow/visual"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import { resolveDeep } from "./expression"
import { IdempotencyCache } from "./idempotency"
import type { RunLogger } from "./event-log"
import type { SecretResolver } from "./secret-resolver"

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
}

export interface StepExecution {
  /** Step output (cache-hit or fresh). */
  output: unknown
  /** Branch/switch decision; orchestrator uses to skip non-chosen edges. */
  decision?: string | string[]
  /** True iff this step came from the idempotency cache (no executor invoked). */
  fromCache: boolean
}

/**
 * Run a single step, returning its output. Memoized by `(runId, stepId)`
 * via the IdempotencyCache. Retries respect the per-workflow retry policy
 * unless the executor returned a non-retryable error.
 */
export async function runStep(input: RunStepInput): Promise<StepExecution> {
  const { node, runId, cache, signal, logger, retryPolicy } = input

  if (cache.has(node.id)) {
    return { output: cache.get(node.id), fromCache: true }
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
    await logger.stepStarted(node.id, { pinned: true })
    cache.set(node.id, pinned)
    await logger.stepCompleted(node.id, pinned)
    return { output: pinned, fromCache: false }
  }

  const reg = getExecutor(node.type, node.typeVersion)
  if (!reg) {
    const err = new Error(
      `No executor registered for ${node.type}@${node.typeVersion}. ` +
        `Install the plugin that provides it, or change the node type.`
    )
    await logger.stepFailed(node.id, { message: err.message, retryable: false })
    throw err
  }

  // Resolve params with expression substitution before passing to the executor.
  const resolvedParams = resolveDeep(node.data.params, {
    upstream: input.upstream,
    trigger: input.trigger,
    staticData: {},
    params: node.data.params as Record<string, unknown>,
    variables: input.workflow.variables ?? {},
  })

  const ctx: StepExecutionContext = {
    runId,
    workflowId: input.workflow.id,
    stepId: node.id,
    params: resolvedParams as Record<string, unknown>,
    upstream: input.upstream,
    trigger: input.trigger,
    signal,
    log: (level, message, payload) => void logger.log(level, message, payload, node.id),
    resolveSecret: (refId) => input.secretResolver.resolve(refId),
  }

  let attempt = 0

  while (true) {
    attempt += 1
    if (signal.aborted) {
      const err = new Error("Workflow run aborted")
      await logger.stepFailed(node.id, { message: err.message, retryable: false })
      throw err
    }

    await logger.stepStarted(node.id, { attempt })
    try {
      const result = await runWithTimeout(
        reg.timeoutMs ?? input.workflow.settings.timeoutMs,
        signal,
        () => reg.execute(ctx)
      )
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
      cache.set(node.id, result.output)
      await logger.stepCompleted(node.id, result.output)
      return exec
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const retryable = isRetryableError(err)
      const lastAttempt = attempt >= retryPolicy.attempts
      await logger.stepFailed(node.id, { message, retryable })

      if (!retryable || lastAttempt) {
        throw err instanceof Error ? err : new Error(message)
      }

      const delay = computeBackoffMs(retryPolicy, attempt)
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
  fn: () => Promise<T>
): Promise<T> {
  if (timeoutMs <= 0) return fn()
  return new Promise<T>((resolve, reject) => {
    const ac = new AbortController()
    const onAbort = () => ac.abort(new Error("Workflow run aborted"))
    if (outer.aborted) return reject(new Error("Workflow run aborted"))
    outer.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      ac.abort(new Error(`Step exceeded timeout (${timeoutMs}ms)`))
    }, timeoutMs)
    fn()
      .then((value) => {
        clearTimeout(timer)
        outer.removeEventListener("abort", onAbort)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        outer.removeEventListener("abort", onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
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
