/**
 * flow.loop typeVersion 2 — container sub-canvas execution (Dify-style).
 *
 * The container node owns a body subgraph: every node whose `parentId`
 * points at the container. Per iteration the body runs under the SAME
 * ready-set semantics as the top-level orchestrator (deps, branch-decision
 * skips, error propagation), with three additions:
 *
 *   • `$item` / `$loop` idents are injected into the expression scope and
 *     reset every iteration (consensus: explicit reset);
 *   • `staticData` is ONE shared object that accumulates across iterations
 *     (consensus: enables reduce/accumulator patterns) — `flow.set` children
 *     write into it;
 *   • the explicit `output` expression is evaluated at the END of each
 *     iteration and pushed into the container's `items[]` (consensus: leaf
 *     nodes only signal completion, never produce the loop output).
 *
 * `flow.break` stops the INNERMOST loop (no new iterations start; in-flight
 * parallel iterations drain); `flow.continue` ends its own iteration only —
 * that iteration contributes no item. Both are validated at definition time
 * to live inside a loop body.
 *
 * Concurrency: `iterationConcurrency` (forEach/times; default 1) is capped
 * by the process-wide gate (`run-concurrency-gate.ts`, default 16) — every
 * child step holds a gate slot while executing, so nested parallel loops
 * cannot multiply unbounded. `while` mode is always sequential (the
 * condition depends on the previous round).
 *
 * Idempotency / resume: the container memoizes under its own node id like
 * any step; child steps memoize under `iterationCacheKey(loopId, i, child)`
 * and stamp `loopId`/`iterationIndex` into their event payloads so
 * `IdempotencyCache.hydrate` reconstructs per-iteration progress after a
 * crash.
 */

import type {
  StepExecutionResult,
  TriggerEvent,
  VisualWorkflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRetryPolicy,
  WorkflowRunLineage,
  WorkflowRunSecurityContext,
} from "@/types/workflow/visual"
import type { LoopItemError, LoopNodeParams } from "@/types/workflow/visual"
import type { WorkflowExecutionBinding } from "@/types/workflow/deployment"
import { resolveDeep, resolveExpression } from "./expression"
import { IdempotencyCache, iterationCacheKey } from "./idempotency"
import type { RunLogger } from "./event-log"
import type { SecretResolver } from "./secret-resolver"
import { runStep } from "./step-executor"
import { getGlobalRunGate } from "./run-concurrency-gate"
import { buildErrorOutput, resolveNodeFailure } from "./node-failure"

/** Hard ceiling on iterations regardless of params (runaway-while backstop). */
const LOOP_HARD_CAP = 100_000
/** Default `maxIterations` for while mode when the author didn't set one. */
const DEFAULT_WHILE_MAX = 1_000

export interface RunLoopContainerInput {
  workflow: VisualWorkflow
  /** The `flow.loop` typeVersion 2 container node. */
  node: WorkflowNode
  trigger: TriggerEvent
  /** Upstream outputs visible to the container (and to its body). */
  upstream: Record<string, unknown>
  /**
   * Global `$nodes['id']` scope — every TOP-LEVEL node completed before this
   * container was scheduled. Passed through to body steps so non-adjacent
   * reads work inside loops too. Body-internal outputs are NOT merged in
   * (iteration-local data rides `$node` / `$item` as before).
   */
  nodesOutputs?: Record<string, unknown>
  runId: string
  signal: AbortSignal
  cache: IdempotencyCache
  retryPolicy: WorkflowRetryPolicy
  secretResolver: SecretResolver
  logger: RunLogger
  honorPinData?: boolean
  traceId?: string
  lineage?: WorkflowRunLineage
  securityContext?: WorkflowRunSecurityContext
  /** Owning workspace, threaded to every body step. */
  projectId?: string
  executionBinding?: WorkflowExecutionBinding
}

export interface LoopContainerExecution {
  output: {
    items: unknown[]
    count: number
    staticData: Record<string, unknown>
    /** Present when a non-failing item-error policy collected failures. */
    errors?: LoopItemError[]
  }
  fromCache: boolean
}

interface IterationResult {
  /** Item produced by the output mapping; `skipped` for continue'd rounds. */
  item: unknown
  contributed: boolean
  brokeLoop: boolean
  /** Set when `onItemError: "break"` absorbed this iteration's error. */
  brokeByPolicy?: boolean
}

export async function runLoopContainer(
  input: RunLoopContainerInput
): Promise<LoopContainerExecution> {
  const { workflow, node, logger, cache, signal } = input
  const loopId = node.id

  if (cache.has(loopId)) {
    return { output: cache.get(loopId) as LoopContainerExecution["output"], fromCache: true }
  }
  if (signal.aborted) throw new Error("Workflow run aborted")

  const children = workflow.nodes.filter((n) => n.parentId === loopId)
  const childIds = new Set(children.map((n) => n.id))
  const childEdges = workflow.edges.filter((e) => childIds.has(e.source) && childIds.has(e.target))

  // Resolve the container's own params (source/times/while are expressions).
  // `while` re-evaluates its condition per round, so it is resolved lazily.
  const rawParams = (node.data.params ?? {}) as Partial<LoopNodeParams>
  // Shared accumulator — seeded from the workflow's authored staticData and
  // mutated by flow.set children across iterations.
  const staticData: Record<string, unknown> = { ...(workflow.staticData ?? {}) }
  const scopeBase = {
    upstream: input.upstream,
    trigger: input.trigger,
    staticData,
    params: rawParams as Record<string, unknown>,
    variables: workflow.variables ?? {},
  }

  const mode = rawParams.mode ?? "forEach"
  const iterationConcurrency = Math.max(
    1,
    Math.floor(
      typeof rawParams.iterationConcurrency === "number" ? rawParams.iterationConcurrency : 1
    )
  )
  const maxIterations = Math.min(
    LOOP_HARD_CAP,
    typeof rawParams.maxIterations === "number" && rawParams.maxIterations > 0
      ? Math.floor(rawParams.maxIterations)
      : mode === "while"
        ? DEFAULT_WHILE_MAX
        : LOOP_HARD_CAP
  )
  // while only: "post" = do-while (body runs before the first check).
  const conditionTiming = mode === "while" ? (rawParams.conditionTiming ?? "pre") : "pre"
  // forEach only: sequential batches of N; 0 = single implicit batch.
  const batchSize =
    mode === "forEach" && typeof rawParams.batchSize === "number" && rawParams.batchSize > 0
      ? Math.floor(rawParams.batchSize)
      : 0
  // Container-level backstop for errors the child's own handling didn't absorb.
  const onItemError =
    rawParams.onItemError === "skip" ? "remove-failed" : (rawParams.onItemError ?? "fail")
  const errorsByIndex = new Map<number, LoopItemError>()

  await logger.stepStarted(loopId, { mode, iterationConcurrency })

  /** Batch coordinates injected into `$loop` (single implicit batch unless batching). */
  interface BatchMeta {
    batchIndex: number
    batchCount: number
  }

  /** Run one iteration's body subgraph and evaluate the output mapping. */
  const runIteration = async (
    index: number,
    item: unknown,
    total: number | null,
    batch: BatchMeta = { batchIndex: 0, batchCount: 1 }
  ): Promise<IterationResult> => {
    const loopMeta = {
      index,
      isFirst: index === 0,
      isLast: total !== null ? index === total - 1 : false,
      total,
      batchIndex: batch.batchIndex,
      batchCount: batch.batchCount,
      ...(batchSize > 0 ? { batchSize } : {}),
    }
    const extraUpstream: Record<string, unknown> = { $loop: loopMeta }
    if (item !== undefined) extraUpstream.$item = item

    const sub = await runSubgraph({
      ...input,
      loopId,
      iterationIndex: index,
      children,
      childEdges,
      extraUpstream,
      staticData,
    })

    if (sub.signal === "continue") {
      return { item: undefined, contributed: false, brokeLoop: false }
    }
    if (sub.signal === "break") {
      // A broken iteration aborted mid-body — its partial mapping is
      // excluded from items[] (it still counts as an entered iteration).
      return { item: undefined, contributed: false, brokeLoop: true }
    }

    // Output mapping: evaluate against the iteration's full scope — body
    // outputs as $node[childId], plus $item / $loop / $static.
    let produced: unknown = index
    if (typeof rawParams.output === "string" && rawParams.output.trim() !== "") {
      produced = resolveExpression(rawParams.output, {
        ...scopeBase,
        upstream: { ...input.upstream, ...sub.outputs, ...extraUpstream },
      })
    }
    return { item: produced, contributed: true, brokeLoop: false }
  }

  /**
   * Policy guard around `runIteration`: under `onItemError: "fail"` errors
   * propagate exactly as before; under skip/break the failure is recorded in
   * `errorsByIndex` and the iteration RESOLVES with flags, so the sequential
   * and parallel schedulers keep their existing count/drain machinery.
   * Only errors that the child's own error handling re-threw reach here.
   */
  const runIterationGuarded = async (
    index: number,
    item: unknown,
    total: number | null,
    batch?: { batchIndex: number; batchCount: number }
  ): Promise<IterationResult> => {
    try {
      return await runIteration(index, item, total, batch)
    } catch (err) {
      if (onItemError === "fail") throw err
      // Abort is a run-level event, never an item failure — always propagate.
      if (signal.aborted) throw err
      errorsByIndex.set(index, {
        index,
        ...(item !== undefined ? { item } : {}),
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.name !== "Error" ? { errorType: err.name } : {}),
      })
      return {
        item: onItemError === "continue-with-null" ? null : undefined,
        contributed: onItemError === "continue-with-null",
        brokeLoop: false,
        brokeByPolicy: onItemError === "break",
      }
    }
  }

  const items: unknown[] = []
  let count = 0

  if (mode === "while") {
    // Sequential by definition — each round's condition depends on the last.
    // "pre" checks before the body (classic while); "post" checks after it
    // (do-while: at least one round). Both continue while truthy, so the
    // author never inverts the predicate when switching timing.
    const checkCondition = () =>
      isLoopTruthy(resolveExpression(rawParams.whileExpression ?? "", scopeBase))
    for (let i = 0; i < maxIterations; i++) {
      if (signal.aborted) throw new Error("Workflow run aborted")
      if (conditionTiming === "pre" && !checkCondition()) break
      const r = await runIterationGuarded(i, undefined, null)
      count += 1
      if (r.contributed) items.push(r.item)
      if (r.brokeLoop || r.brokeByPolicy) break
      if (conditionTiming === "post" && !checkCondition()) break
    }
  } else {
    // forEach / times — bounded collection known up front.
    let source: unknown[] = []
    if (mode === "forEach") {
      const resolved = resolveDeep(rawParams.source ?? "", scopeBase)
      if (!Array.isArray(resolved)) {
        throw nonRetryable(
          `flow.loop: forEach source did not resolve to an array (got ${typeOf(resolved)})`
        )
      }
      source = resolved
    } else {
      const resolved = resolveDeep(rawParams.times ?? 0, scopeBase)
      const n = typeof resolved === "number" ? resolved : Number(resolved)
      if (!Number.isFinite(n) || n < 0) {
        throw nonRetryable(`flow.loop: times did not resolve to a non-negative number`)
      }
      source = Array.from({ length: Math.floor(n) }, (_, i) => i)
    }
    if (source.length > maxIterations) source = source.slice(0, maxIterations)
    const total = source.length

    /**
     * Run iterations `[start, end)` — one batch (or the whole source when
     * batching is off). `iterationConcurrency` bounds in-window parallelism;
     * `items[]` stays source-ordered via GLOBAL index assignment, so batching
     * never changes output ordering or iteration cache keys.
     */
    const runWindow = async (
      start: number,
      end: number,
      batch: BatchMeta
    ): Promise<{ broke: boolean }> => {
      if (iterationConcurrency <= 1) {
        for (let i = start; i < end; i++) {
          if (signal.aborted) throw new Error("Workflow run aborted")
          const r = await runIterationGuarded(
            i,
            mode === "forEach" ? source[i] : undefined,
            total,
            batch
          )
          count += 1
          if (r.contributed) items[i] = r.item
          if (r.brokeLoop || r.brokeByPolicy) return { broke: true }
        }
        return { broke: false }
      }
      // Parallel window: keep launching until break/abort; in-flight
      // iterations drain before the window reports back.
      let next = start
      let broke = false
      let firstError: unknown
      const inflight = new Map<number, Promise<void>>()
      const launch = (i: number) => {
        const p = runIterationGuarded(i, mode === "forEach" ? source[i] : undefined, total, batch)
          .then((r) => {
            count += 1
            if (r.contributed) items[i] = r.item
            if (r.brokeLoop || r.brokeByPolicy) broke = true
          })
          .catch((err) => {
            if (!firstError) firstError = err
          })
          .finally(() => {
            inflight.delete(i)
          })
        inflight.set(i, p)
      }
      while ((next < end && !broke && !firstError) || inflight.size > 0) {
        if (signal.aborted && inflight.size === 0) throw new Error("Workflow run aborted")
        while (
          next < end &&
          !broke &&
          !firstError &&
          !signal.aborted &&
          inflight.size < iterationConcurrency
        ) {
          launch(next++)
        }
        if (inflight.size === 0) break
        await Promise.race(inflight.values())
      }
      if (firstError) throw firstError
      if (signal.aborted) throw new Error("Workflow run aborted")
      return { broke }
    }

    const batchCount = batchSize > 0 ? Math.ceil(total / batchSize) : 1
    for (let b = 0; b < batchCount; b++) {
      const start = batchSize > 0 ? b * batchSize : 0
      const end = batchSize > 0 ? Math.min(total, start + batchSize) : total
      const { broke } = await runWindow(start, end, { batchIndex: b, batchCount })
      if (broke) break
      if (signal.aborted) throw new Error("Workflow run aborted")
    }
  }

  // Sparse-slot cleanup: continue'd / post-break indices never got a value.
  const compact = items.filter((_, i) => i in items)

  // Deterministic source-order regardless of parallel completion order.
  const errors = [...errorsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
  const output: LoopContainerExecution["output"] = {
    items: compact,
    count,
    staticData: { ...staticData },
    ...(errors.length > 0 ? { errors } : {}),
  }
  cache.set(loopId, output)
  await logger.stepCompleted(loopId, output)
  return { output, fromCache: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Body subgraph runner — ready-set scheduling over the container's children.
// ─────────────────────────────────────────────────────────────────────────────

interface RunSubgraphInput extends RunLoopContainerInput {
  loopId: string
  iterationIndex: number
  children: WorkflowNode[]
  childEdges: WorkflowEdge[]
  /** `$item` / `$loop` idents for this iteration. */
  extraUpstream: Record<string, unknown>
  /** Shared accumulator (mutated in place by flow.set children). */
  staticData: Record<string, unknown>
}

interface SubgraphResult {
  signal: "completed" | "break" | "continue"
  /** Child outputs keyed by node id (for the container's output mapping). */
  outputs: Record<string, unknown>
}

async function runSubgraph(input: RunSubgraphInput): Promise<SubgraphResult> {
  const { children, childEdges, loopId, iterationIndex } = input
  const gate = getGlobalRunGate()

  const deps = new Map<string, Set<string>>()
  for (const n of children) deps.set(n.id, new Set())
  for (const e of childEdges) deps.get(e.target)?.add(e.source)

  const completed = new Set<string>()
  const skipped = new Set<string>()
  const outputs: Record<string, unknown> = {}
  const inflight = new Map<string, Promise<void>>()
  let loopSignal: "break" | "continue" | null = null
  let firstError: unknown

  const skipDownstream = (startId: string) => {
    const stack = [startId]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (skipped.has(id)) continue
      const liveParents = childEdges
        .filter((e) => e.target === id)
        .map((e) => e.source)
        .filter((p) => p !== startId && !skipped.has(p))
      if (liveParents.length > 0 && id !== startId) continue
      skipped.add(id)
      for (const e of childEdges.filter((e) => e.source === id)) stack.push(e.target)
    }
  }

  const isReady = (id: string): boolean => {
    if (completed.has(id) || skipped.has(id) || inflight.has(id)) return false
    if (firstError || loopSignal) return false
    for (const dep of deps.get(id) ?? []) {
      if (!completed.has(dep) && !skipped.has(dep)) return false
    }
    return true
  }

  const runChild = async (child: WorkflowNode): Promise<void> => {
    if (child.data.disabled) {
      skipped.add(child.id)
      skipDownstream(child.id)
      return
    }
    // Nested container — recurse with a namespaced id so its cache key and
    // event provenance stay unique per outer iteration.
    if (child.type === "flow.loop" && child.typeVersion >= 2) {
      const release = await gate.acquire(input.signal)
      try {
        const nested = await runLoopContainer({
          ...input,
          node: child,
          upstream: { ...input.upstream, ...outputs, ...input.extraUpstream },
          cache: new PrefixedCache(input.cache, `${loopId}#${iterationIndex}#`),
        })
        outputs[child.id] = nested.output
        completed.add(child.id)
      } finally {
        release()
      }
      return
    }

    const upstreamMap: Record<string, unknown> = {}
    for (const e of childEdges) {
      if (e.target !== child.id) continue
      if (skipped.has(e.source)) continue
      if (e.source in outputs) upstreamMap[e.source] = outputs[e.source]
    }
    // Children can also reference the container's own upstream nodes.
    Object.assign(upstreamMap, { ...input.upstream, ...upstreamMap })

    const release = await gate.acquire(input.signal)
    try {
      const result = await runStep({
        workflow: input.workflow,
        node: child,
        trigger: input.trigger,
        upstream: upstreamMap,
        ...(input.nodesOutputs ? { nodesOutputs: input.nodesOutputs } : {}),
        runId: input.runId,
        signal: input.signal,
        cache: input.cache,
        retryPolicy: input.retryPolicy,
        secretResolver: input.secretResolver,
        logger: input.logger,
        honorPinData: input.honorPinData,
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.lineage ? { lineage: input.lineage } : {}),
        ...(input.securityContext ? { securityContext: input.securityContext } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.executionBinding ? { executionBinding: input.executionBinding } : {}),
        extraUpstream: input.extraUpstream,
        staticData: input.staticData,
        cacheKey: iterationCacheKey(loopId, iterationIndex, child.id),
        iterationMeta: { loopId, iterationIndex },
      })
      outputs[child.id] = result.output
      completed.add(child.id)

      // Accumulator semantics — flow.set children write into the shared
      // staticData so later iterations (and the while condition) see it.
      if (child.type === "flow.set") {
        const out = result.output as { variable?: string; value?: unknown } | undefined
        if (out && typeof out.variable === "string" && out.variable.trim()) {
          input.staticData[out.variable] = out.value
        }
      }

      // Loop jump sentinels.
      const sig = (result.output as { __loopSignal?: string } | undefined)?.__loopSignal
      if (sig === "break" || sig === "continue") {
        loopSignal = sig
        return
      }

      // Branch routing inside the body (same handle-first key as top level).
      const decision = await Promise.resolve(resultDecision(result))
      if (decision !== undefined) {
        const chosen = new Set(Array.isArray(decision) ? decision : [decision])
        for (const e of childEdges.filter((e) => e.source === child.id)) {
          const routeKey = e.sourceHandle ?? e.label ?? "default"
          if (!chosen.has(routeKey) && chosen.size > 0) skipDownstream(e.target)
        }
      }
    } catch (err) {
      // Per-node error handling mirrors the top-level orchestrator catch.
      // "errorBranch" routes within the body subgraph; "continue" /
      // "defaultValue" substitute an output and let body downstream run.
      const failure = resolveNodeFailure(child)
      if (failure.mode === "continue") {
        outputs[child.id] = buildErrorOutput(err)
        completed.add(child.id)
        return
      }
      if (failure.mode === "defaultValue") {
        outputs[child.id] = failure.defaultValue
        completed.add(child.id)
        return
      }
      if (failure.mode === "errorBranch") {
        const outgoing = childEdges.filter((e) => e.source === child.id)
        const errorEdges = outgoing.filter(
          (e) => e.sourceHandle === "error" || e.data?.kind === "error"
        )
        if (errorEdges.length > 0) {
          outputs[child.id] = buildErrorOutput(err)
          completed.add(child.id)
          for (const e of outgoing) {
            if (!(e.sourceHandle === "error" || e.data?.kind === "error")) {
              skipDownstream(e.target)
            }
          }
          return
        }
        // No error edge inside the body → fall through to fail the iteration.
      }
      if (!firstError) firstError = err
    } finally {
      release()
    }
  }

  const order = children.map((n) => n.id)
  while (completed.size + skipped.size < children.length) {
    if (firstError || loopSignal) break
    if (input.signal.aborted && inflight.size === 0) break

    for (const id of order) {
      if (!isReady(id)) continue
      const child = children.find((n) => n.id === id)!
      const p = runChild(child).finally(() => inflight.delete(id))
      inflight.set(id, p)
    }
    // Every scheduled child lands in `inflight` (runChild is async), so an
    // empty in-flight set here means zero progress is possible — e.g. a
    // dependency cycle inside the body. Exit instead of spinning.
    if (inflight.size === 0) break
    await Promise.race(inflight.values())
  }
  if (inflight.size > 0) await Promise.allSettled(inflight.values())

  if (firstError) throw firstError
  if (input.signal.aborted) throw new Error("Workflow run aborted")

  return { signal: loopSignal ?? "completed", outputs }
}

/** `runStep` result decision passthrough (kept tiny for clarity). */
function resultDecision(r: { decision?: StepExecutionResult["decision"] }) {
  return r.decision
}

/**
 * Cache view that namespaces every key — used for NESTED containers so the
 * inner loop's container key (`inner`) becomes unique per outer iteration
 * (`outer#0#inner`). Child steps already namespace via `iterationCacheKey`.
 */
class PrefixedCache extends IdempotencyCache {
  constructor(
    private readonly inner: IdempotencyCache,
    private readonly prefix: string
  ) {
    super()
  }
  override has(key: string): boolean {
    return this.inner.has(this.prefix + key)
  }
  override get(key: string): unknown {
    return this.inner.get(this.prefix + key)
  }
  override set(key: string, output: unknown): void {
    this.inner.set(this.prefix + key, output)
  }
}

function isLoopTruthy(v: unknown): boolean {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    return s !== "" && s !== "false" && s !== "0"
  }
  return Boolean(v)
}

function typeOf(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}

function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}
