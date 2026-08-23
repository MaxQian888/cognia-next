import { registerNodeExecutor } from "../registry"
import { iterationCacheKey } from "@/lib/workflow/runtime/idempotency"
import { respondToWebhook } from "@/lib/workflow/runtime/tauri-bridge"
import {
  evaluateConditionGroup,
  type ResolvedConditionGroup,
} from "@/lib/workflow/runtime/conditions"
import { guardWorkflowEgress } from "@/lib/workflow/runtime/egress-guard"
import { validateAgainstJsonSchema } from "../ai/schema-validate"
import {
  LOOP_HARD_CAP,
  MAX_SUBWORKFLOW_DEPTH,
  aggregateArray,
  evalItemExpression,
  evalLoopExpression,
  firstUpstream,
  isTruthy,
  nonRetryable,
  resolveAggregateInput,
} from "../shared/executor-support"
import type { AggregateParams } from "../shared/executor-support"
import { proxyFetch } from "@/lib/network/proxy-fetch"

// ── flow.set ──────────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "flow.set",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { variable?: string; value?: unknown }
    const variable = typeof params.variable === "string" ? params.variable.trim() : ""
    if (!variable) {
      throw new Error("flow.set requires a non-empty 'variable' name")
    }
    return {
      output: { variable, value: params.value },
      logs: [
        {
          level: "debug",
          message: `Set ${variable}`,
          payload: { value: params.value },
        },
      ],
    }
  },
})

// ── flow.branch ───────────────────────────────────────────────────────────
// `params.condition` arrives already-resolved by `resolveDeep` upstream, so
// the executor decides truthiness directly. A richer condition language
// (JS comparisons, regex tests) lands in Phase 6 alongside `data.code`.
registerNodeExecutor({
  kind: "flow.branch",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      condition?: unknown
      truthyLabel?: string
      falsyLabel?: string
    }
    const truthyLabel =
      typeof params.truthyLabel === "string" && params.truthyLabel.trim()
        ? params.truthyLabel.trim()
        : "true"
    const falsyLabel =
      typeof params.falsyLabel === "string" && params.falsyLabel.trim()
        ? params.falsyLabel.trim()
        : "false"
    // Empty / unset condition → falsy branch (matches user intuition that
    // "no condition set" means default).
    if (params.condition === undefined || params.condition === "") {
      return { output: { decision: falsyLabel }, decision: falsyLabel }
    }
    const decision = isTruthy(params.condition) ? truthyLabel : falsyLabel
    return {
      output: { decision, evaluated: params.condition },
      decision,
    }
  },
})

// ── flow.branch (typeVersion 2) ───────────────────────────────────────────
// Structured condition language (types/workflow/conditions.ts). Operands are
// authored as expression strings but arrive resolved (resolveDeep runs over
// `params` before execution), so the executor hands the resolved group to the
// pure evaluator. Decisions are the FIXED handle ids "true" / "false" —
// matching `outputHandlesFor` — never user-editable labels.
registerNodeExecutor({
  kind: "flow.branch",
  typeVersion: 2,
  execute: async (ctx) => {
    const params = ctx.params as { conditions?: ResolvedConditionGroup }
    const group = params.conditions
    // No conditions configured → "false" branch (matches the v1 intuition
    // that an unset condition means "no").
    const passed =
      !!group && Array.isArray(group.conditions) && group.conditions.length > 0
        ? evaluateConditionGroup(group)
        : false
    const decision = passed ? "true" : "false"
    return {
      output: { decision, conditionCount: group?.conditions?.length ?? 0 },
      decision,
    }
  },
})

// ── data.transform ────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "data.transform",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { operation?: string; expression?: string }
    const operation = params.operation ?? "map"
    // The first upstream output becomes the input. If there are multiple
    // upstreams, callers should add a flow.join first.
    const input = firstUpstream(ctx)
    if (input === undefined) {
      return { output: undefined }
    }
    const arr = Array.isArray(input) ? input : []
    if (!Array.isArray(input)) {
      // Pass through non-array inputs unchanged for any operation that's
      // a no-op on a scalar.
      return { output: input }
    }
    const expr = params.expression?.trim() ?? ""
    switch (operation) {
      case "map":
        return {
          output: arr.map((item) => evalItemExpression(expr, item, ctx) ?? item),
        }
      case "filter":
        return {
          output: arr.filter((item) => isTruthy(evalItemExpression(expr, item, ctx))),
        }
      case "sort":
        return {
          output: [...arr].sort((a, b) => {
            const ka = String(evalItemExpression(expr, a, ctx) ?? "")
            const kb = String(evalItemExpression(expr, b, ctx) ?? "")
            return ka.localeCompare(kb)
          }),
        }
      case "flatten":
        return { output: arr.flat() }
      case "reduce":
        // Back-compat sum: delegates to the shared aggregator (numeric/sum over
        // the item expression). For richer folds (collect / group-by / dedupe /
        // merge / custom reducer) use the dedicated `data.aggregate` node.
        return {
          output: aggregateArray(
            arr,
            { operation: "numeric", numericOp: "sum", numericField: expr || undefined },
            ctx
          ),
        }
      default:
        throw new Error(`Unsupported transform operation: ${operation}`)
    }
  },
})

// ── data.aggregate ─────────────────────────────────────────────────────────
// Real reduce/aggregate (D6③): collect / concat / merge-objects / group-by /
// dedupe / numeric (sum·avg·min·max·count) / custom (reducer expression with
// $acc·$item·$index). Input is a single array upstream, a single scalar
// (wrapped), or — on a fan-in — the set of all upstream outputs. The Dify
// Variable Aggregator / n8n Aggregate+Merge analogue, but expression-driven.
registerNodeExecutor({
  kind: "data.aggregate",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as AggregateParams
    const arr = resolveAggregateInput(ctx)
    return { output: aggregateArray(arr, params, ctx) }
  },
})

// ── flow.switch ───────────────────────────────────────────────────────────
// Multi-way branch. Picks the case label whose `value` equals the resolved
// `subject`. Falls through to `defaultLabel` (or "default") when no case
// matches. The orchestrator treats the result the same as flow.branch's
// decision — non-chosen edges get propagateSkip()'d.
registerNodeExecutor({
  kind: "flow.switch",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      subject?: unknown
      cases?: Array<{ value: unknown; label: string }>
      defaultLabel?: string
    }
    const cases = Array.isArray(params.cases) ? params.cases : []
    const defaultLabel = params.defaultLabel?.trim() || "default"
    const matched = cases.find((c) => c.value === params.subject)
    const decision = matched?.label?.trim() || defaultLabel
    return {
      output: { decision, evaluated: params.subject },
      decision,
    }
  },
})

// ── flow.switch (typeVersion 2) ───────────────────────────────────────────
// Ordered cases, each holding a structured condition group. The FIRST case
// whose group passes wins; otherwise the "default" handle. Decisions are
// stable case ids (not display labels) so renaming a case never re-routes.
registerNodeExecutor({
  kind: "flow.switch",
  typeVersion: 2,
  execute: async (ctx) => {
    const params = ctx.params as {
      cases?: Array<{ id?: string; label?: string; when?: ResolvedConditionGroup }>
    }
    const cases = Array.isArray(params.cases) ? params.cases : []
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      const group = c.when
      if (!group || !Array.isArray(group.conditions)) continue
      if (evaluateConditionGroup(group)) {
        const decision = typeof c.id === "string" && c.id.trim() ? c.id : `case-${i}`
        return {
          output: { decision, matchedLabel: c.label, matchedIndex: i },
          decision,
        }
      }
    }
    return { output: { decision: "default", matchedIndex: null }, decision: "default" }
  },
})

// ── flow.break / flow.continue ────────────────────────────────────────────
// Loop-body jump markers (schemaVersion 2). Pure sentinels: the subgraph
// runner inspects `__loopSignal` on the output and stops the INNERMOST
// loop (break) or ends the current iteration (continue). Outside a loop
// body the validator rejects them at definition time, so the sentinel
// never leaks into a top-level run.
registerNodeExecutor({
  kind: "flow.break",
  typeVersion: 1,
  execute: async () => ({ output: { __loopSignal: "break" } }),
})

registerNodeExecutor({
  kind: "flow.continue",
  typeVersion: 1,
  execute: async () => ({ output: { __loopSignal: "continue" } }),
})

// ── flow.split ────────────────────────────────────────────────────────────
// Pure passthrough — the orchestrator inspects the graph to fan out, so
// this executor just forwards its upstream so downstream branches can
// reference it. Behavior matches "default" execution.
registerNodeExecutor({
  kind: "flow.split",
  typeVersion: 1,
  execute: async (ctx) => ({ output: { fanOutAt: ctx.runId, upstream: ctx.upstream } }),
})

// ── flow.join ─────────────────────────────────────────────────────────────
// Collects upstream outputs into a single payload. The orchestrator already
// gathers upstream values into `ctx.upstream`; this executor just freezes
// them with the configured `joinPolicy` so downstream nodes can branch on
// "did all parents succeed?".
registerNodeExecutor({
  kind: "flow.join",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      joinPolicy?: "all" | "any" | "race"
      /** Optional gather→reduce in one step (D6③). Omit to just gather. */
      aggregate?: AggregateParams
    }
    const joinPolicy = params.joinPolicy ?? "all"
    const upstreamCount = Object.keys(ctx.upstream).length
    const base = {
      joinPolicy,
      gathered: ctx.upstream,
      upstreamCount,
    }
    if (params.aggregate?.operation) {
      // Reduce the gathered upstream outputs (the set of branch results).
      const aggregated = aggregateArray(Object.values(ctx.upstream), params.aggregate, ctx)
      return { output: { ...base, aggregated } }
    }
    return { output: base }
  },
})

registerNodeExecutor({
  kind: "flow.loop",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: "forEach" | "while" | "times"
      times?: number
      input?: unknown
      inputExpression?: unknown
      bodyExpression?: string
      whileCondition?: unknown
      /**
       * Raw expression string evaluated per iteration with `$loop.index` /
       * `$item = i` in scope. Authored without `{{ }}` so `resolveDeep`
       * passes it through unchanged.
       */
      whileExpression?: string
      maxIterations?: number
    }
    const mode = params.mode ?? "forEach"
    const requestedMax = Math.floor(Number(params.maxIterations ?? 10000))
    const maxIterations = Math.max(1, Math.min(LOOP_HARD_CAP, requestedMax))
    let cappedAt: number | undefined

    if (mode === "times") {
      const times = Math.max(0, Math.floor(Number(params.times ?? 0)))
      const effective = Math.min(times, maxIterations)
      if (times > maxIterations) cappedAt = maxIterations
      const items = Array.from({ length: effective }, (_, i) => i)
      return {
        output: { iterations: items.length, items, cappedAt },
        logs: cappedAt
          ? [
              {
                level: "warn" as const,
                message: `loop.times capped at ${cappedAt} (requested ${times})`,
              },
            ]
          : undefined,
      }
    }

    if (mode === "while") {
      // Two paths:
      //   • `whileExpression` (raw expression string, no `{{ }}`): re-evaluated
      //     against an iteration-local scope (`$loop.index`, `$item = i`) each
      //     pass. This is the field forms should expose for real per-iteration
      //     conditions.
      //   • `whileCondition` (already-resolved value passed through
      //     `resolveDeep`): static for the duration of the call. Useful only
      //     for "run exactly maxIterations times when truthy at entry, zero
      //     otherwise" semantics; back-compat for older saved workflows.
      const rawWhileExpression =
        typeof params.whileExpression === "string" && params.whileExpression.trim()
          ? params.whileExpression.trim()
          : null
      const items: number[] = []
      let i = 0
      let aborted = false
      while (i < maxIterations) {
        // Honor abort signals between iterations so a wall-clock timeout or
        // user cancel can land mid-loop instead of waiting for the cap.
        if (ctx.signal.aborted) {
          aborted = true
          break
        }
        const cond = rawWhileExpression
          ? evalLoopExpression(rawWhileExpression, i, ctx)
          : params.whileCondition
        if (!isTruthy(cond)) break
        items.push(i)
        i += 1
        // Yield to the microtask queue periodically so the event loop can
        // process the abort listener (and React renders, in dev mode).
        if (i % 100 === 0) await Promise.resolve()
      }
      if (i === maxIterations) {
        cappedAt = maxIterations
      }
      const logs: Array<{ level: "warn" | "info"; message: string }> = []
      if (cappedAt !== undefined) {
        logs.push({ level: "warn", message: `loop.while capped at ${cappedAt}` })
      }
      if (aborted) {
        logs.push({ level: "info", message: "loop.while aborted by signal" })
      }
      return {
        output: { iterations: items.length, items, cappedAt, mode: "while", aborted },
        logs: logs.length > 0 ? logs : undefined,
      }
    }

    // forEach mode
    const inputCandidate = Array.isArray(params.input)
      ? params.input
      : Array.isArray(params.inputExpression)
        ? params.inputExpression
        : firstUpstream(ctx)
    if (!Array.isArray(inputCandidate)) {
      return { output: { iterations: 0, items: [] as unknown[] } }
    }
    const input =
      inputCandidate.length > maxIterations
        ? inputCandidate.slice(0, maxIterations)
        : inputCandidate
    if (inputCandidate.length > maxIterations) cappedAt = maxIterations
    const expr = params.bodyExpression?.trim() ?? ""
    const items = input.map((item) => evalItemExpression(expr, item, ctx) ?? item)
    return {
      output: { iterations: items.length, items, cappedAt },
      logs: cappedAt
        ? [{ level: "warn" as const, message: `loop.forEach capped at ${cappedAt}` }]
        : undefined,
    }
  },
})

// ── flow.wait ─────────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "flow.wait",
  typeVersion: 1,
  // Event waits may legitimately outlast the workflow's step timeout budget;
  // the run-level wall-clock guard + the node's own `timeoutMs` bound them.
  timeoutMs: 0,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: string
      durationMs?: number
      eventKey?: string
      correlationId?: string
      timeoutMs?: number
    }
    const mode = params.mode ?? "duration"
    if (mode !== "duration") {
      // Event mode uses the durable waitpoint store. Event sources persist
      // first and matching consumes once, so emitter/subscriber races and
      // renderer restarts cannot lose the event.
      const key =
        typeof params.eventKey === "string" && params.eventKey.trim()
          ? params.eventKey.trim()
          : `${ctx.runId}:${ctx.stepId}`
      const timeoutMs = Math.max(0, Number(params.timeoutMs ?? 0))
      const startedAt = Date.now()
      ctx.log(
        "info",
        `flow.wait: waiting for event "${key}"` + (timeoutMs > 0 ? ` (timeout ${timeoutMs}ms)` : "")
      )
      const [{ createWorkflowWaitpoint }, { waitForWorkflowWaitpoint }, { getWorkflowRun }] =
        await Promise.all([
          import("@/lib/db/workflow-waitpoints"),
          import("@/lib/workflow/runtime/waitpoint-repository"),
          import("@/lib/db/workflows"),
        ])
      try {
        const run = await getWorkflowRun(ctx.runId)
        const createdAt = Date.now()
        const waitpoint = await createWorkflowWaitpoint({
          id: `wpe_${ctx.runId}_${ctx.stepId}`,
          kind: "event_wait",
          status: "pending",
          runId: ctx.runId,
          workflowId: ctx.workflowId,
          stepId: ctx.stepId,
          key,
          ...(params.correlationId?.trim() ? { correlationId: params.correlationId.trim() } : {}),
          createdAt,
          notBefore: run?.startedAt ?? ctx.trigger.originAt ?? createdAt,
          ...(timeoutMs > 0 ? { expiresAt: createdAt + timeoutMs } : {}),
          updatedAt: createdAt,
        })
        const terminal =
          waitpoint.status === "pending"
            ? await waitForWorkflowWaitpoint(waitpoint.id, {
                signal: ctx.signal,
                cancelOnAbort: true,
              })
            : waitpoint
        if (terminal.status === "timed_out") throw new Error("timed out")
        if (terminal.status === "cancelled") throw new Error("aborted")
        const resolution = terminal.resolution
        if (!resolution || resolution.outcome !== "event") {
          throw new Error(`invalid event resolution for ${terminal.id}`)
        }
        return {
          output: {
            event: key,
            source: resolution.respondedBy,
            data: resolution.data,
            waitedMs: Date.now() - startedAt,
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const wrapped = new Error(`flow.wait: ${message}`) as Error & { retryable?: boolean }
        wrapped.retryable = false
        throw wrapped
      }
    }
    const ms = Math.max(0, Number(params.durationMs ?? 0))
    if (ms > 0) {
      await new Promise<void>((resolve, reject) => {
        if (ctx.signal.aborted) return reject(new Error("Workflow run aborted"))
        const t = setTimeout(() => {
          ctx.signal.removeEventListener("abort", onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(t)
          reject(new Error("Workflow run aborted"))
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true })
      })
    }
    return { output: { waitedMs: ms } }
  },
})

// ── data.template ─────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "data.template",
  typeVersion: 1,
  execute: async (ctx) => {
    // The template string is already passed through `resolveDeep` in the
    // step executor, so we receive it fully expanded. The executor's job is
    // to surface the rendered string as the node's output.
    const rendered = (ctx.params as { template?: unknown }).template ?? ""
    return { output: { rendered: typeof rendered === "string" ? rendered : String(rendered) } }
  },
})

// ── data.code ─────────────────────────────────────────────────────────────
// 5-second sandboxed JS via `new Function()`. Available bindings: upstream,
// trigger, params (already-resolved), staticData. The body must `return`
// the value it wants downstream nodes to consume.
registerNodeExecutor({
  kind: "data.code",
  typeVersion: 1,
  timeoutMs: 5000,
  execute: async (ctx) => {
    const code = String((ctx.params as { code?: unknown }).code ?? "")
    if (!code.trim()) return { output: undefined }
    const fn = new Function(
      "upstream",
      "trigger",
      "params",
      "staticData",
      `"use strict"; ${code}`
    ) as (upstream: unknown, trigger: unknown, params: unknown, staticData: unknown) => unknown
    try {
      const result = fn(ctx.upstream, ctx.trigger, ctx.params, {})
      const resolved = result instanceof Promise ? await result : result
      return { output: resolved }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const wrapped = new Error(`data.code failed: ${message}`) as Error & {
        retryable?: boolean
      }
      wrapped.retryable = false
      throw wrapped
    }
  },
})

// ── io.http ───────────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "io.http",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      url?: string
      method?: string
      body?: unknown
      headers?: Record<string, string>
      followRedirects?: boolean
      piiGate?: "block" | "redact"
    }
    const url = String(params.url ?? "").trim()
    if (!url) throw new Error("io.http requires a non-empty URL")
    const method = (params.method ?? "GET").toUpperCase()
    const guarded = guardWorkflowEgress({
      securityContext: ctx.securityContext,
      sink: "remote-tool",
      requestedMode: params.piiGate,
      value: {
        url,
        headers: params.headers ?? {},
        body: params.body,
      },
    })
    const headers: Record<string, string> = {
      Accept: "application/json,text/plain,*/*",
      ...guarded.value.headers,
    }
    let body: BodyInit | undefined
    if (method !== "GET" && method !== "HEAD" && guarded.value.body !== undefined) {
      if (typeof guarded.value.body === "string") {
        body = guarded.value.body
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json"
      } else {
        body = JSON.stringify(guarded.value.body)
        headers["Content-Type"] = "application/json"
      }
    }
    // `proxyFetch`: the URL comes from the workflow author, so it is never on
    // the packaged shell's `connect-src` allowlist, and an HTTP node is the
    // most literal case of traffic the configured proxy must carry.
    const response = await proxyFetch(guarded.value.url, {
      method,
      headers,
      body,
      signal: ctx.signal,
      redirect: params.followRedirects === false ? "manual" : "follow",
    })
    const contentType = response.headers.get("content-type") ?? ""
    let payload: unknown
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => null)
    } else {
      payload = await response.text()
    }
    if (!response.ok) {
      const err = new Error(
        `HTTP ${response.status} ${response.statusText} from ${url}`
      ) as Error & { retryable?: boolean }
      // 5xx errors are retryable; 4xx are not.
      err.retryable = response.status >= 500
      throw err
    }
    return {
      output: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: payload,
        ...(guarded.redacted ? { piiRedacted: true } : {}),
      },
    }
  },
})

// ── flow.catch ─────────────────────────────────────────────────────────────
// Terminal-failure recovery entrypoint (run-fallback safety net). Executes
// only when the failure handler spawns a catch sub-run; the error envelope
// rides in on the trigger's `$catch` payload. Pure passthrough: surfaces the
// error as its output so downstream nodes can read `{{ $node['id'].error }}`
// and drive a notify / cleanup path.
registerNodeExecutor({
  kind: "flow.catch",
  typeVersion: 1,
  execute: async (ctx) => {
    const caught = (ctx.trigger.payload as { $catch?: unknown } | undefined)?.$catch ?? null
    return { output: { caught: caught !== null, error: caught } }
  },
})

registerNodeExecutor({
  kind: "flow.subworkflow",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      workflowId?: string
      input?: unknown
    }
    const workflowId = params.workflowId?.trim()
    if (!workflowId) {
      throw nonRetryable("flow.subworkflow requires 'workflowId'")
    }
    // Read the parent's depth from the trigger payload (default 0).
    // The parent is whoever invoked us via runWorkflow; that runs path
    // increments the depth before passing it along.
    const parentDepth = Math.max(
      0,
      Number((ctx.trigger.payload as Record<string, unknown> | undefined)?.depth ?? 0)
    )
    if (parentDepth >= MAX_SUBWORKFLOW_DEPTH) {
      throw nonRetryable(
        `flow.subworkflow: recursion depth ${parentDepth} exceeds limit ${MAX_SUBWORKFLOW_DEPTH}. ` +
          `Check that no workflow invokes itself (or a cycle).`
      )
    }
    // Lazy-imports avoid a circular dep through the node registry.
    const { executeDeployedWorkflow, WorkflowAdmissionError } =
      await import("@/lib/workflow/runtime/execution-authority")
    let execution: Awaited<ReturnType<typeof executeDeployedWorkflow>>
    try {
      const lockedDependency = ctx.executionBinding?.dependencyLock?.workflows[ctx.stepId]
      execution = await executeDeployedWorkflow({
        workflowId,
        entrypoint: "subworkflow",
        caller: `run:${ctx.runId}`,
        idempotencyKey: ctx.iteration
          ? iterationCacheKey(ctx.iteration.loopId, ctx.iteration.iterationIndex, ctx.stepId)
          : ctx.stepId,
        ...(lockedDependency ? { lockedDependency } : {}),
        triggerKind: "trigger.manual",
        payload: {
          parentRunId: ctx.runId,
          parentStepId: ctx.stepId,
          input: params.input ?? null,
          depth: parentDepth + 1,
        },
        signal: ctx.signal,
        traceId: ctx.traceId,
        lineage: {
          rootRunId: ctx.lineage?.rootRunId ?? ctx.runId,
          parentRunId: ctx.runId,
          parentStepId: ctx.stepId,
        },
        securityContext: ctx.securityContext,
      })
    } catch (error) {
      if (error instanceof WorkflowAdmissionError) {
        if (error.code === "deployment-not-found") {
          throw nonRetryable(`flow.subworkflow: workflow ${workflowId} is not deployed`)
        }
        if (error.code === "input-schema-violation") {
          throw nonRetryable(
            `flow.subworkflow: input violates the target's schema — ${error.message}`
          )
        }
      }
      throw error
    }
    const result = execution.result
    if (result.status !== "succeeded") {
      const message = result.error?.message ?? "subworkflow run failed"
      throw nonRetryable(`flow.subworkflow: ${message}`)
    }
    // Validate the terminal output against the declared output schema.
    const outputSchema = execution.version.interface.outputSchema
    if (outputSchema && Object.keys(outputSchema).length > 0) {
      const v = validateAgainstJsonSchema(outputSchema, result.output)
      if (!v.ok) {
        throw nonRetryable(
          `flow.subworkflow: output violates the target's schema — ${v.errors.join("; ")}`
        )
      }
    }
    return {
      output: {
        runId: result.runId,
        status: result.status,
        output: result.output,
      },
    }
  },
})

// ── io.webhook.respond ────────────────────────────────────────────────────
// Delivers a dynamic HTTP response back to a held-open webhook request. When
// the run started from a `trigger.webhook` whose workflow contains this node,
// the Rust receiver holds the inbound request open and surfaces a
// `correlationId` in the trigger payload; we route the body back through the
// `workflow_webhook_respond` command. Without a correlation id (manual run, or
// web mode where there's no receiver) it degrades to a passthrough that
// records what the response WOULD have been.
registerNodeExecutor({
  kind: "io.webhook.respond",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      status?: number
      body?: unknown
      headers?: Record<string, string>
    }
    const status = typeof params.status === "number" ? params.status : 200
    const body = params.body ?? null
    const headers = params.headers ?? {}

    const correlationId = (ctx.trigger.payload as { correlationId?: unknown } | undefined)
      ?.correlationId
    if (typeof correlationId === "string" && correlationId.length > 0) {
      // Serialize non-string bodies to JSON so the HTTP response carries a
      // real payload (the Rust side delivers the string verbatim).
      const wireBody = typeof body === "string" ? body : JSON.stringify(body ?? null)
      const delivered = await respondToWebhook(correlationId, { status, body: wireBody, headers })
      return { output: { status, body, headers, delivered } }
    }

    return {
      output: {
        status,
        body,
        headers,
        // No held-open request to answer (manual run / web mode): record the
        // intended response without delivering it.
        deliveryDeferred: true,
      },
    }
  },
})

// ── io.output ──────────────────────────────────────────────────────────────
// Declares a workflow's terminal output (D5). The resolved `value` (or the
// first upstream when omitted) is validated against the node's `outputSchema`
// — the published interface's output contract — then returned as the run's
// terminal output. `onSchemaViolation: "fail"` (default) rejects a contract
// breach; "soft" passes the value through with a warning.
registerNodeExecutor({
  kind: "io.output",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      value?: unknown
      outputSchema?: Record<string, unknown>
      onSchemaViolation?: "fail" | "soft"
    }
    // `value` rides resolveDeep ({{ }} already resolved); fall back to upstream.
    const value =
      "value" in params && params.value !== undefined ? params.value : firstUpstream(ctx)
    const schema = params.outputSchema
    if (schema && Object.keys(schema).length > 0) {
      const result = validateAgainstJsonSchema(schema, value)
      if (!result.ok) {
        if ((params.onSchemaViolation ?? "fail") === "soft") {
          ctx.log(
            "warn",
            `io.output: value violates the output schema — ${result.errors.join("; ")}`
          )
          return { output: { value, schemaValid: false, schemaErrors: result.errors } }
        }
        throw nonRetryable(
          `io.output: value violates the output schema — ${result.errors.join("; ")}`
        )
      }
      return { output: { value, schemaValid: true } }
    }
    return { output: { value } }
  },
})
