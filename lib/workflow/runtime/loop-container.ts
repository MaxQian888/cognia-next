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
} from "@/types/workflow/visual"
import type { LoopNodeParams } from "@/types/workflow/visual"
import { resolveDeep, resolveExpression } from "./expression"
import { IdempotencyCache, iterationCacheKey } from "./idempotency"
import type { RunLogger } from "./event-log"
import type { SecretResolver } from "./secret-resolver"
import { runStep } from "./step-executor"
import { getGlobalRunGate } from "./run-concurrency-gate"

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
  runId: string
  signal: AbortSignal
  cache: IdempotencyCache
  retryPolicy: WorkflowRetryPolicy
  secretResolver: SecretResolver
  logger: RunLogger
  honorPinData?: boolean
  traceId?: string
}

export interface LoopContainerExecution {
  output: { items: unknown[]; count: number; staticData: Record<string, unknown> }
  fromCache: boolean
}

interface IterationResult {
  /** Item produced by the output mapping; `skipped` for continue'd rounds. */
  item: unknown
  contributed: boolean
  brokeLoop: boolean
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

  await logger.stepStarted(loopId, { mode, iterationConcurrency })

  /** Run one iteration's body subgraph and evaluate the output mapping. */
  const runIteration = async (
    index: number,
    item: unknown,
    total: number | null
  ): Promise<IterationResult> => {
    const loopMeta = {
      index,
      isFirst: index === 0,
      isLast: total !== null ? index === total - 1 : false,
      total,
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

  const items: unknown[] = []
  let count = 0

  if (mode === "while") {
    // Sequential by definition — each round's condition depends on the last.
    for (let i = 0; i < maxIterations; i++) {
      if (signal.aborted) throw new Error("Workflow run aborted")
      const cond = resolveExpression(rawParams.whileExpression ?? "", scopeBase)
      if (!isLoopTruthy(cond)) break
      const r = await runIteration(i, undefined, null)
      count += 1
      if (r.contributed) items.push(r.item)
      if (r.brokeLoop) break
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

    if (iterationConcurrency <= 1) {
      for (let i = 0; i < total; i++) {
        if (signal.aborted) throw new Error("Workflow run aborted")
        const r = await runIteration(i, mode === "forEach" ? source[i] : undefined, total)
        count += 1
        if (r.contributed) items[i] = r.item
        if (r.brokeLoop) break
      }
    } else {
      // Parallel window: keep launching until break/abort; items[] stays
      // source-ordered via index assignment.
      let next = 0
      let broke = false
      let firstError: unknown
      const inflight = new Map<number, Promise<void>>()
      const launch = (i: number) => {
        const p = runIteration(i, mode === "forEach" ? source[i] : undefined, total)
          .then((r) => {
            count += 1
            if (r.contributed) items[i] = r.item
            if (r.brokeLoop) broke = true
          })
          .catch((err) => {
            if (!firstError) firstError = err
          })
          .finally(() => {
            inflight.delete(i)
          })
        inflight.set(i, p)
      }
      while ((next < total && !broke && !firstError) || inflight.size > 0) {
        if (signal.aborted && inflight.size === 0) throw new Error("Workflow run aborted")
        while (
          next < total &&
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
    }
  }

  // Sparse-slot cleanup: continue'd / post-break indices never got a value.
  const compact = items.filter((_, i) => i in items)

  const output = { items: compact, count, staticData: { ...staticData } }
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
        runId: input.runId,
        signal: input.signal,
        cache: input.cache,
        retryPolicy: input.retryPolicy,
        secretResolver: input.secretResolver,
        logger: input.logger,
        honorPinData: input.honorPinData,
        ...(input.traceId ? { traceId: input.traceId } : {}),
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
      if (!firstError) firstError = err
    } finally {
      release()
    }
  }

  const order = children.map((n) => n.id)
  while (completed.size + skipped.size < children.length) {
    if (firstError || loopSignal) break
    if (input.signal.aborted && inflight.size === 0) break

    let scheduled = 0
    for (const id of order) {
      if (!isReady(id)) continue
      const child = children.find((n) => n.id === id)!
      const p = runChild(child).finally(() => inflight.delete(id))
      inflight.set(id, p)
      scheduled += 1
    }
    if (inflight.size === 0) {
      if (scheduled === 0) break
      continue
    }
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
