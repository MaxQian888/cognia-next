/**
 * Built-in node executors — registered on first import of this module.
 * Each Phase 4 base executor handles the bare minimum to enable
 * end-to-end runs in tests and the Run button:
 *   • trigger.manual — passthrough of trigger payload
 *   • flow.set — write a value into the run's static-data variable
 *   • flow.branch — evaluate a condition expression, emit a decision
 *   • data.transform — small in-memory map/filter/reduce
 *   • ai.prompt — direct LLM call via the existing provider router
 *
 * Phase 6 adds the rest of the catalog. Until then, unregistered kinds
 * surface as "no executor registered" run failures.
 */

import type { StepExecutionContext, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { registerNodeExecutor } from "./registry"
import { resolveExpression } from "@/lib/workflow/runtime/expression"
import {
  evaluateConditionGroup,
  type ResolvedConditionGroup,
} from "@/lib/workflow/runtime/conditions"
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkillsByIds,
  recordSkillUsage,
  updateSkill,
} from "@/lib/db/skills"
import { getSkill as getPluginSkill } from "@/lib/plugin/registries/skill-registry"
import { getMcpServerPreset } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { createCharacter, deleteCharacter, updateCharacter } from "@/lib/db/characters"
import { createTeam, deleteTeam, updateTeam } from "@/lib/db/teams"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { createDraft } from "@/lib/db/connector-drafts"
import { generateTextEmbedding } from "@/lib/ai/embedding/multimodal-embedding"
import { extractJson } from "@/lib/twin/distill/llm"
// Side-effect import — registers the 12 desktop UI-automation executors at
// module load time. Keeps the catalog and the registry in sync without any
// cross-module wiring.
import "./desktop"

// OCR extraction node (ADR-0024) — turns an image/PDF/screen into text.
import "./ocr"

// Eval nodes — run a dataset eval / gate a run from a workflow.
import "./eval"

// Wave 3 — registers the `action.system.terminal` executor that drives
// the integrated terminal dock from a workflow step.
import "./terminal"

// Persistent terminal-session nodes (open / run / close) — dock or
// unattended-headless mode, with run-scoped cleanup via the orchestrator.
import "./terminal-session"

// Script-file node — runs a .sh/.ps1/.py/… file under its detected
// interpreter (lib/terminal/script-runner.ts), dock or unattended mode.
import "./terminal-script"

// Local Git action nodes (ADR-0038) — stage / commit / push / branch against
// the active workspace repo.
import "./git"

// ── AI structured-output helpers (shared by ai.prompt / ai.extract) ─────────

/**
 * Non-throwing JSON extraction from an LLM completion. Reuses the robust
 * `extractJson` (handles fenced blocks + leading/trailing prose) and converts
 * its throw into a `{ value, error }` result so node executors can surface a
 * `parseError` downstream instead of failing the whole run.
 */
function parseStructured(completion: string): { value: unknown; error?: string } {
  try {
    return { value: extractJson<unknown>(completion) }
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Build the JSON-only system instruction appended in `responseFormat: "json"`. */
function buildJsonInstruction(schema?: string): string {
  const base = "Respond with ONLY a single valid JSON value — no prose, no markdown code fences."
  return schema && schema.trim() ? `${base}\nMatch this shape:\n${schema.trim()}` : base
}

/** Coerce an extracted value to a declared type hint (best-effort). */
function coerceToType(value: unknown, typeHint: string): unknown {
  const hint = typeHint.toLowerCase()
  if (value === null || value === undefined) return value
  if (hint.includes("number")) {
    const n = typeof value === "number" ? value : Number(value)
    return Number.isNaN(n) ? value : n
  }
  if (hint.includes("bool")) {
    if (typeof value === "boolean") return value
    if (typeof value === "string") return value.trim().toLowerCase() === "true"
    return Boolean(value)
  }
  if (hint.includes("string")) {
    return typeof value === "string" ? value : String(value)
  }
  return value
}

// ── trigger.manual ────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "trigger.manual",
  typeVersion: 1,
  execute: async (ctx) => ({
    output: {
      firedAt: ctx.trigger.originAt,
      payload: ctx.trigger.payload,
    },
  }),
})

// ── trigger.team ──────────────────────────────────────────────────────────
// Synthesizer-internal: real firing happens in the agent-team runtime. This
// passthrough exists so the node round-trips when a workflow runs in
// "manual + trigger.team" mode (mirrors trigger.manual). Must stay side-effect
// free — it must NOT kick off a team run.
registerNodeExecutor({
  kind: "trigger.team",
  typeVersion: 1,
  execute: async (ctx) => ({
    output: {
      firedAt: ctx.trigger.originAt,
      payload: ctx.trigger.payload,
    },
  }),
})

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
        // Phase 4 ships a sum-by-default reduce; Phase 6 wires a real
        // reducer expression.
        return {
          output: arr.reduce((acc, item) => {
            const v = evalItemExpression(expr, item, ctx)
            return typeof v === "number" ? acc + v : acc
          }, 0),
        }
      default:
        throw new Error(`Unsupported transform operation: ${operation}`)
    }
  },
})

// ── ai.prompt ─────────────────────────────────────────────────────────────
// Real LLM call via `createLlmClient` when provider + apiKey are present in
// params (or resolvable via secret refs). When credentials aren't available
// the executor falls back to a clearly-marked echo stub so workflows authored
// before keys were configured still run end-to-end.
registerNodeExecutor({
  kind: "ai.prompt",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      systemPrompt?: string
      userPrompt?: string
      temperature?: number
      /** "json" enables structured output — the completion is parsed into
       *  `output.structured` (with `output.parseError` on failure). */
      responseFormat?: "text" | "json"
      /** Optional shape hint injected into the JSON-mode system prompt. */
      jsonSchema?: string
    }
    const apiKey =
      params.apiKey ??
      (await ctx.resolveSecret(
        ctx.params.credentialRefs && typeof ctx.params.credentialRefs === "object"
          ? ((ctx.params.credentialRefs as Record<string, string>).apiKey ?? "")
          : ""
      ))
    const userPrompt = params.userPrompt ?? ""
    const jsonMode = params.responseFormat === "json"
    // In JSON mode, append an instruction (and optional shape) so the model
    // returns parseable JSON regardless of the authored system prompt.
    const systemPrompt = jsonMode
      ? [params.systemPrompt, buildJsonInstruction(params.jsonSchema)].filter(Boolean).join("\n\n")
      : params.systemPrompt

    // Shared tail: attach `structured` / `parseError` when JSON mode is on.
    const finalize = (out: {
      provider?: string
      model?: string
      completion: string
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
      stub: boolean
    }) => {
      if (!jsonMode) return { output: out }
      const parsed = parseStructured(out.completion)
      return {
        output: {
          ...out,
          structured: parsed.value,
          ...(parsed.error ? { parseError: parsed.error } : {}),
        },
      }
    }

    if (!params.provider || !params.model || !apiKey) {
      ctx.log(
        "warn",
        "ai.prompt: provider / model / apiKey missing — using stub echo. " +
          "Configure them on the node (or via credential refs) for a real LLM call."
      )
      // JSON mode returns a parseable empty object so downstream structured
      // consumers get an object (not a parse error) before keys are configured.
      return finalize({
        provider: params.provider,
        model: params.model,
        completion: jsonMode ? "{}" : `[ai.prompt stub] ${userPrompt}`,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stub: true,
      })
    }
    const { createLlmClient } = await import("@/lib/twin/distill/llm")
    const client = createLlmClient({
      provider: params.provider as Parameters<typeof createLlmClient>[0]["provider"],
      model: params.model,
      apiKey,
      baseURL: params.baseURL,
      defaultTemperature: params.temperature,
    })
    // Emit a `chat` span for the LLM call so eval (and observability) can
    // assemble the workflow run. The eval workflow target threads `ctx.traceId`;
    // ai.classify / ai.extract delegate to this executor, so they're covered too.
    const { startSpan, endSpan } = await import("@/lib/agent-trace/emitter")
    const span = startSpan({
      operationName: "chat",
      providerName: "cognia.workflow",
      surface: "workflow",
      sessionId: ctx.runId,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(params.model ? { requestModel: params.model } : {}),
    })
    let completion: string
    try {
      completion = await client.complete(userPrompt, {
        system: systemPrompt,
        temperature: params.temperature,
      })
    } catch (err) {
      endSpan(span.spanId, {
        errorType: err instanceof Error ? err.name : "Error",
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    const usage = client.getUsageSnapshot?.() ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    endSpan(span.spanId, {
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      ...(params.model ? { responseModel: params.model } : {}),
      outputPreview: completion.slice(0, 200),
    })
    return finalize({
      provider: params.provider,
      model: params.model,
      completion,
      usage,
      stub: false,
    })
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
    const params = ctx.params as { joinPolicy?: "all" | "any" | "race" }
    const joinPolicy = params.joinPolicy ?? "all"
    const upstreamCount = Object.keys(ctx.upstream).length
    return {
      output: {
        joinPolicy,
        gathered: ctx.upstream,
        upstreamCount,
      },
    }
  },
})

// ── flow.loop ─────────────────────────────────────────────────────────────
// Iterator-style loop over an array (forEach), a fixed count (times), or a
// truthiness condition (while). Every mode is hard-capped at
// `maxIterations` (default 10000) to prevent runaway loops.
const LOOP_HARD_CAP = 100_000
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
  execute: async (ctx) => {
    const params = ctx.params as { mode?: string; durationMs?: number }
    const mode = params.mode ?? "duration"
    if (mode !== "duration") {
      // Event-based wait wires up in Phase 5+ (Rust trigger daemon needs to
      // surface external wake-ups via the IPC contract). Until then, this
      // mode is a no-op so workflows authored against it still load.
      return { output: { skipped: "event mode not yet implemented" } }
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
    }
    const url = String(params.url ?? "").trim()
    if (!url) throw new Error("io.http requires a non-empty URL")
    const method = (params.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {
      Accept: "application/json,text/plain,*/*",
      ...(params.headers ?? {}),
    }
    let body: BodyInit | undefined
    if (method !== "GET" && method !== "HEAD" && params.body !== undefined) {
      if (typeof params.body === "string") {
        body = params.body
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json"
      } else {
        body = JSON.stringify(params.body)
        headers["Content-Type"] = "application/json"
      }
    }
    const response = await fetch(url, {
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
      },
    }
  },
})

// ── action.skill.invoke ───────────────────────────────────────────────────
// Resolves a comma-separated list of skill ids into a single concatenated
// markdown body, ready for downstream AI prompts to splice into their
// systemPrompt. Records usage via `recordSkillUsage` so the "Recent" filter
// in Settings → Skills updates.
registerNodeExecutor({
  kind: "action.skill.invoke",
  typeVersion: 1,
  execute: async (ctx) => {
    const raw = String((ctx.params as { skillIds?: unknown }).skillIds ?? "")
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length === 0) {
      return { output: { skills: [], markdown: "" } }
    }
    const skills = await listSkillsByIds(ids)
    const resolved = skills.map((s) => ({
      id: s.id,
      name: s.name,
      markdown:
        (s as unknown as { systemPrompt?: string; body?: string }).systemPrompt ??
        (s as unknown as { body?: string }).body ??
        "",
    }))
    // Fall back to plugin-contributed skills (skill-registry overlay) for any
    // ids the Dexie table didn't resolve. Inline-source skills carry their
    // markdown directly; folder/managed sources resolve elsewhere, so we
    // surface the name without a body here.
    const dbIds = new Set(skills.map((s) => s.id))
    for (const id of ids) {
      if (dbIds.has(id)) continue
      const def = getPluginSkill(id)
      if (!def) continue
      resolved.push({
        id: def.id,
        name: def.name,
        markdown: def.source.kind === "inline" ? def.source.markdown : "",
      })
    }
    const markdown = resolved.map((s) => `### ${s.name}\n\n${s.markdown}`).join("\n\n")
    // Best-effort: record usage so the panel can sort by lastUsedAt.
    void recordSkillUsage(ids).catch(() => undefined)
    return {
      output: {
        skills: resolved.map((s) => ({ id: s.id, name: s.name })),
        markdown,
      },
    }
  },
})

// ── action.character.create ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      systemPrompt?: string
      description?: string
      avatarColor?: string
      avatarEmoji?: string
      model?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.character.create requires a non-empty 'name'")
    }
    if (!params.systemPrompt?.trim()) {
      throw nonRetryable("action.character.create requires a 'systemPrompt'")
    }
    const character = await createCharacter({
      name: params.name.trim(),
      systemPrompt: params.systemPrompt,
      description: params.description,
      avatarColor: params.avatarColor,
      avatarEmoji: params.avatarEmoji,
      model: params.model,
    })
    return {
      output: { characterId: character.id, name: character.name },
    }
  },
})

// ── action.character.update ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      characterId?: string
      patch?: Record<string, unknown>
    }
    const id = params.characterId?.trim()
    if (!id) {
      throw nonRetryable("action.character.update requires 'characterId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.character.update requires a non-empty 'patch' object")
    }
    // Strip immutable fields the UI shouldn't be able to override.
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateCharacter(id, safePatch as Parameters<typeof updateCharacter>[1])
    return { output: { characterId: id, patched: Object.keys(safePatch) } }
  },
})

// ── action.team.create ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      members?: Array<{ characterId: string; role?: string }>
      orchestration?: "round_robin" | "supervisor" | "mention_round_robin"
      supervisorCharacterId?: string
      description?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.team.create requires a non-empty 'name'")
    }
    if (!Array.isArray(params.members) || params.members.length === 0) {
      throw nonRetryable("action.team.create requires at least one member")
    }
    const team = await createTeam({
      name: params.name.trim(),
      description: params.description,
      members: params.members,
      orchestration: params.orchestration,
      supervisorCharacterId: params.supervisorCharacterId,
    })
    return { output: { teamId: team.id, name: team.name } }
  },
})

// ── action.team.update ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      teamId?: string
      patch?: Record<string, unknown>
    }
    const id = params.teamId?.trim()
    if (!id) {
      throw nonRetryable("action.team.update requires 'teamId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.team.update requires a 'patch' object")
    }
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateTeam(id, safePatch as Parameters<typeof updateTeam>[1])
    return { output: { teamId: id, patched: Object.keys(safePatch) } }
  },
})

// ── action.skill.upsert ───────────────────────────────────────────────────
// "upsert" — create when no `skillId`, update otherwise. Allows workflows to
// idempotently keep a skill in sync without branching on existence.
registerNodeExecutor({
  kind: "action.skill.upsert",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      skillId?: string
      name?: string
      content?: string
      description?: string
      tags?: string[]
    }
    if (params.skillId?.trim()) {
      const id = params.skillId.trim()
      const existing = await getSkill(id)
      if (!existing) {
        throw nonRetryable(`action.skill.upsert: skill ${id} not found`)
      }
      const patch: Parameters<typeof updateSkill>[1] = {}
      if (params.name !== undefined) patch.name = params.name.trim() || existing.name
      if (params.content !== undefined) patch.content = params.content
      if (params.description !== undefined) patch.description = params.description
      if (params.tags !== undefined) patch.tags = params.tags
      await updateSkill(id, patch)
      return { output: { skillId: id, action: "updated" } }
    }
    if (!params.name?.trim() || params.content === undefined) {
      throw nonRetryable(
        "action.skill.upsert: when 'skillId' is absent, 'name' and 'content' are required"
      )
    }
    const skill = await createSkill({
      name: params.name.trim(),
      content: params.content,
      description: params.description,
      tags: params.tags,
    })
    return { output: { skillId: skill.id, action: "created" } }
  },
})

// ── action.connector.send ─────────────────────────────────────────────────
// Enqueue an outbound message via the existing `outboundQueue`. The queue
// runner (lib/connectors/outbound-runner.ts) picks rows up FIFO per
// conversation lane and handles retries / circuit breakers / rate limits.
registerNodeExecutor({
  kind: "action.connector.send",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      adapterId?: string
      conversationKey?: string
      content?: string
      idempotencyKey?: string
      replyToMessageId?: string
    }
    const adapterId = params.adapterId?.trim()
    const conversationKey = params.conversationKey?.trim()
    const content = params.content ?? ""
    if (!adapterId) throw nonRetryable("action.connector.send requires 'adapterId'")
    if (!conversationKey) throw nonRetryable("action.connector.send requires 'conversationKey'")
    if (!content) throw nonRetryable("action.connector.send requires non-empty 'content'")
    const idempotencyKey = params.idempotencyKey?.trim() || `${ctx.runId}:${ctx.stepId}`
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: { adapterId, conversationKey } as unknown as Parameters<
          typeof enqueueOutbound
        >[0]["request"]["conversationRef"],
        segments: [{ type: "text", text: content }],
        replyTo: params.replyToMessageId ? { messageId: params.replyToMessageId } : undefined,
        metadata: { idempotencyKey },
      },
      // Provenance per ADR-0009 v41 — the inbox UI uses this to render a
      // "from workflow" badge with click-to-jump on the conversation
      // timeline. `ctx.workflowId` carries the user-authored workflow id
      // (distinct from `ctx.runId` which is the per-execution token).
      source: "workflow",
      sourceWorkflow: {
        workflowId: ctx.workflowId,
        runId: ctx.runId,
        nodeId: ctx.stepId,
      },
    })
    return {
      output: {
        jobId: job.id,
        adapterId,
        conversationKey,
        idempotencyKey,
      },
    }
  },
})

// ── action.connector.draft ────────────────────────────────────────────────
// Stash the proposed reply in `connectorDrafts` for human approval in the
// Inbox UI. Distinct from connector.send — drafts never auto-send.
registerNodeExecutor({
  kind: "action.connector.draft",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      conversationKey?: string
      sessionId?: string
      content?: string
      sourceMessageId?: string
      ttlMs?: number
    }
    const conversationKey = params.conversationKey?.trim()
    const sessionId = params.sessionId?.trim()
    const content = params.content ?? ""
    if (!conversationKey) throw nonRetryable("action.connector.draft requires 'conversationKey'")
    if (!sessionId) throw nonRetryable("action.connector.draft requires 'sessionId'")
    if (!content) throw nonRetryable("action.connector.draft requires non-empty 'content'")
    const expiresAt =
      typeof params.ttlMs === "number" && params.ttlMs > 0 ? Date.now() + params.ttlMs : undefined
    const draft = await createDraft({
      conversationKey,
      sessionId,
      segments: [{ type: "text", text: content }],
      sourceMessageId: params.sourceMessageId,
      expiresAt,
    })
    return { output: { draftId: draft.id, conversationKey, sessionId } }
  },
})

// ── ai.classify ───────────────────────────────────────────────────────────
// Reuses the `ai.prompt` executor under the hood with a constrained system
// prompt. The output is normalized to the matched label so downstream
// `flow.branch` / `flow.switch` nodes can route on it directly.
registerNodeExecutor({
  kind: "ai.classify",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      input?: string
      labels?: string[]
      hint?: string
    }
    const labels = (params.labels ?? []).map((l) => l.trim()).filter(Boolean)
    if (labels.length === 0) {
      throw nonRetryable("ai.classify requires at least one entry in 'labels'")
    }
    const input = params.input ?? ""
    if (!input) throw nonRetryable("ai.classify requires non-empty 'input'")
    const labelList = labels.map((l) => `- ${l}`).join("\n")
    const systemPrompt =
      `You are a strict text classifier. ` +
      `Return EXACTLY ONE of the following labels with no extra text:\n${labelList}` +
      (params.hint ? `\n\nGuidance: ${params.hint}` : "")
    // Delegate to ai.prompt — same provider routing + stub fallback.
    const aiPrompt = (await import("./registry")).getExecutor("ai.prompt", 1)
    if (!aiPrompt) throw new Error("ai.classify: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        systemPrompt,
        userPrompt: input,
        temperature: 0,
      } as Record<string, unknown>,
    })
    const completion = String(
      (inner.output as { completion?: string } | undefined)?.completion ?? ""
    ).trim()
    // Pick the first label whose lowercase form appears in the completion.
    // If nothing matches we fall back to the first label so downstream
    // branches always receive a known value.
    const lower = completion.toLowerCase()
    const matched = labels.find((l) => lower.includes(l.toLowerCase())) ?? labels[0]
    return {
      output: {
        label: matched,
        completion,
        confident: matched.toLowerCase() === lower,
      },
      // Route like a Question Classifier: the orchestrator follows only the
      // outgoing edge whose label / sourceHandle matches the chosen category;
      // other category branches are skipped. Edges are labeled with the
      // category names in the editor.
      decision: matched,
    }
  },
})

// ── ai.extract ────────────────────────────────────────────────────────────
// Structured JSON extraction. The executor instructs the LLM to emit JSON
// matching the `schema` object's shape, then attempts to parse it.
registerNodeExecutor({
  kind: "ai.extract",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      input?: string
      schema?: Record<string, string>
      /** Field names that must be present + non-null for `valid` to be true. */
      required?: string[]
      hint?: string
    }
    const input = params.input ?? ""
    if (!input) throw nonRetryable("ai.extract requires non-empty 'input'")
    const schema = params.schema ?? {}
    const fieldList = Object.entries(schema)
      .map(([k, v]) => `  "${k}": ${v}`)
      .join(",\n")
    const systemPrompt =
      `Extract data from the user message. Reply with ONLY a JSON object ` +
      `matching this shape:\n{\n${fieldList}\n}` +
      (params.hint ? `\n\nGuidance: ${params.hint}` : "")
    const aiPrompt = (await import("./registry")).getExecutor("ai.prompt", 1)
    if (!aiPrompt) throw new Error("ai.extract: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        systemPrompt,
        userPrompt: input,
        temperature: 0,
      } as Record<string, unknown>,
    })
    const completion = String(
      (inner.output as { completion?: string } | undefined)?.completion ?? ""
    )
    // Robust parse (handles fenced blocks + surrounding prose) into a typed
    // parameter struct — this is the "Parameter Extractor" behavior.
    const parsed = parseStructured(completion)
    let extracted: unknown = parsed.value
    const parseError = parsed.error

    // Coerce declared fields to their type hints (best-effort) so downstream
    // nodes get numbers/booleans rather than stringified values.
    if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) {
      const obj = extracted as Record<string, unknown>
      for (const [key, typeHint] of Object.entries(schema)) {
        if (key in obj) obj[key] = coerceToType(obj[key], String(typeHint))
      }
      extracted = obj
    }

    const required = Array.isArray(params.required) ? params.required : []
    const present =
      extracted && typeof extracted === "object" && !Array.isArray(extracted)
        ? (extracted as Record<string, unknown>)
        : {}
    const missing = required.filter((k) => present[k] === undefined || present[k] === null)
    const valid = !parseError && missing.length === 0

    return {
      output: {
        extracted,
        missing,
        valid,
        parseError,
        completion,
      },
    }
  },
})

// ── ai.embed ──────────────────────────────────────────────────────────────
// Phase 1 ships the deterministic hash-based embedder from
// `lib/ai/embedding/multimodal-embedding`. It's not a real semantic
// embedding — it's stable across runs, useful for testing and for
// downstream "did this text change?" checks. Real semantic embeddings
// land when the orchestrator can supply a configured embedding provider
// via secret refs (Phase 9 polish).
registerNodeExecutor({
  kind: "ai.embed",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      input?: string
      dimension?: number
      provider?: string
      model?: string
      apiKey?: string
    }
    const text = params.input ?? ""
    if (!text) throw nonRetryable("ai.embed requires non-empty 'input'")
    const dimension =
      typeof params.dimension === "number" && params.dimension > 0
        ? Math.floor(params.dimension)
        : 384

    const apiKey =
      params.apiKey ??
      (await ctx.resolveSecret(
        ctx.params.credentialRefs && typeof ctx.params.credentialRefs === "object"
          ? ((ctx.params.credentialRefs as Record<string, string>).apiKey ?? "")
          : ""
      ))

    // Real semantic embedding when a provider + model (+ key if required) are
    // configured; otherwise fall back to the deterministic hash so workflows
    // authored before credentials still run end-to-end.
    if (params.provider && params.model) {
      try {
        const { generateEmbedding } = await import("@/lib/vector/embedding")
        const result = await generateEmbedding(
          text,
          {
            provider: params.provider,
            model: params.model,
            dimensions: dimension,
          } as Parameters<typeof generateEmbedding>[1],
          apiKey ?? ""
        )
        return {
          output: {
            vector: result.embedding,
            dimension: result.embedding.length,
            provider: result.provider,
            model: result.model,
            kind: "semantic",
          },
        }
      } catch (err) {
        ctx.log(
          "warn",
          `ai.embed: semantic embedding failed (${err instanceof Error ? err.message : String(err)}) — falling back to deterministic hash.`
        )
      }
    }

    const vector = generateTextEmbedding(text, { dimension })
    return {
      output: {
        vector,
        dimension: vector.length,
        // Hash-based embedder is deterministic but NOT semantic. Surface
        // that fact so downstream consumers don't accidentally trust it
        // for similarity search outside test scenarios.
        kind: "deterministic-hash",
      },
    }
  },
})

// ── flow.subworkflow ──────────────────────────────────────────────────────
// Recursively invoke another workflow as a step. The subworkflow runs in a
// fresh run id (so its events don't pollute the parent's timeline); the
// parent step's output is the subworkflow's terminal output. A hard depth
// limit (10) prevents pathological self-referential workflows from
// stack-overflowing.
const MAX_SUBWORKFLOW_DEPTH = 10
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
    const [{ getWorkflow }, { runWorkflow }] = await Promise.all([
      import("@/lib/db/workflows"),
      import("@/lib/workflow/runtime/orchestrator"),
    ])
    const workflow = await getWorkflow(workflowId)
    if (!workflow) {
      throw nonRetryable(`flow.subworkflow: workflow ${workflowId} not found`)
    }
    const result = await runWorkflow({
      workflow,
      trigger: {
        workflowId,
        kind: "trigger.manual",
        payload: {
          parentRunId: ctx.runId,
          parentStepId: ctx.stepId,
          input: params.input ?? null,
          depth: parentDepth + 1,
        },
        originAt: Date.now(),
      },
      signal: ctx.signal,
    })
    if (result.status !== "succeeded") {
      const message = result.error?.message ?? "subworkflow run failed"
      throw nonRetryable(`flow.subworkflow: ${message}`)
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
// Phase 5a's webhook receiver isn't shipped yet, so this executor is a
// passthrough that records what the response WOULD have been. Once the Rust
// webhook router lands (Phase 5b webhook trigger work), this executor will
// route the body back through a Tauri command.
registerNodeExecutor({
  kind: "io.webhook.respond",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      status?: number
      body?: unknown
      headers?: Record<string, string>
    }
    return {
      output: {
        status: typeof params.status === "number" ? params.status : 200,
        body: params.body ?? null,
        headers: params.headers ?? {},
        // Surface that the response was queued but not delivered (no
        // webhook receiver to respond to). Removed once Phase 5a webhook
        // routing lands.
        deliveryDeferred: true,
      },
    }
  },
})

// ── action.character.send ─────────────────────────────────────────────────
// Posts a message into a character's chat session. The session is created
// on first send if it doesn't exist. The chat UI (when open) picks up the
// new message and the AI responds normally; when the UI is closed, the
// message lands and AI response fires the next time the session is opened.
// For platform-bound (connector) sessions, prefer `action.connector.send`.
registerNodeExecutor({
  kind: "action.character.send",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      characterId?: string
      sessionId?: string
      content?: string
      role?: "user" | "assistant"
    }
    const characterId = params.characterId?.trim()
    const content = params.content ?? ""
    if (!characterId) throw nonRetryable("action.character.send requires 'characterId'")
    if (!content) throw nonRetryable("action.character.send requires non-empty 'content'")
    const role = params.role === "assistant" ? "assistant" : "user"

    const [{ getCharacter }, { listSessions, createSession }, { persistMessages, listMessages }] =
      await Promise.all([
        import("@/lib/db/characters"),
        import("@/lib/db/sessions"),
        import("@/lib/db/messages"),
      ])

    const character = await getCharacter(characterId)
    if (!character) throw nonRetryable(`character ${characterId} not found`)

    let sessionId = params.sessionId?.trim() || ""
    if (!sessionId) {
      // Re-use the most recent session for the character, or create a new one.
      const all = await listSessions()
      const matching = all.filter((s) => s.characterId === characterId)
      sessionId = matching[0]?.id ?? ""
      if (!sessionId) {
        const created = await createSession({
          title: `${character.name} (workflow)`,
          characterId,
        })
        sessionId = created.id
      }
    }

    type UIMessageLike = Parameters<typeof persistMessages>[1][number]
    const existing = await listMessages(sessionId)
    const id = `msg_wf_${ctx.runId}_${ctx.stepId}`
    const message = {
      id,
      role,
      parts: [{ type: "text" as const, text: content }],
    } as unknown as UIMessageLike
    const next: UIMessageLike[] = [...existing, message]
    await persistMessages(sessionId, next)
    return {
      output: {
        characterId,
        sessionId,
        messageId: id,
        role,
        deliveryDeferred: role === "user", // AI auto-respond requires the chat UI to be open
      },
    }
  },
})

// ── action.team.run ───────────────────────────────────────────────────────
// Per ADR-0022 §5 PR 4. Kicks off a team lifecycle via the F-path synthesizer.
// Wires storeReader/storeWriter from the live Zustand store; the runtime
// itself synthesizes a child VisualWorkflow and runs it through workflow
// runtime. Returns the team-run id (the inner workflowRuns row) so the UI
// can navigate.
registerNodeExecutor({
  kind: "action.team.run",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { teamId?: string; goal?: string }
    const teamId = params.teamId?.trim()
    if (!teamId) throw nonRetryable("action.team.run requires 'teamId'")

    const [{ useAgentTeamStore }, { runTeamLifecycle }, { buildAgentTeamRuntimeDeps }] =
      await Promise.all([
        import("@/stores/agent/agent-team-store"),
        import("@/lib/ai/agent/agent-team-runtime"),
        import("@/lib/ai/agent/agent-team-runtime-deps"),
      ])

    const store = useAgentTeamStore.getState()
    const team = store.getTeam(teamId)
    if (!team) throw nonRetryable(`team ${teamId} not found`)

    // When the outer run was kicked off from an IM channel (via
    // `startWorkflowFromIM`, which mirrors the origin onto
    // `trigger.binding`), carry that origin into the synthesized team run so
    // the `workflow-progress-runner` fans the team's progress + final result
    // back to the originating conversation. Only set `source: "im"` when both
    // identifiers are present; UI / API runs leave it undefined so their
    // behavior is unchanged.
    const triggerBinding = ctx.trigger.binding
    const triggeredFrom: WorkflowTriggeredFrom | undefined =
      triggerBinding?.adapterId && triggerBinding?.conversationKey
        ? {
            source: "im",
            adapterId: triggerBinding.adapterId,
            conversationKey: triggerBinding.conversationKey,
            ...(triggerBinding.sessionId ? { sessionId: triggerBinding.sessionId } : {}),
          }
        : undefined

    const partial = buildAgentTeamRuntimeDeps()
    const deps = {
      ...partial,
      ...(triggeredFrom ? { triggeredFrom } : {}),
      storeReader: {
        getTeam: (id: string) => useAgentTeamStore.getState().getTeam(id),
        getTeammates: (id: string) => useAgentTeamStore.getState().getTeammates(id),
        getTeamTasks: (id: string) => useAgentTeamStore.getState().getTeamTasks(id),
      },
      storeWriter: {
        addMessage: (
          input: Parameters<typeof useAgentTeamStore.getState>[never] extends never
            ? never
            : Parameters<ReturnType<typeof useAgentTeamStore.getState>["addMessage"]>[0]
        ) => useAgentTeamStore.getState().addMessage(input),
        setTaskStatus: (
          taskId: string,
          status: Parameters<ReturnType<typeof useAgentTeamStore.getState>["setTaskStatus"]>[1],
          result?: string,
          error?: string
        ) => useAgentTeamStore.getState().setTaskStatus(taskId, status, result, error),
        updateTeammate: (
          teammateId: string,
          updates: Parameters<ReturnType<typeof useAgentTeamStore.getState>["updateTeammate"]>[1]
        ) => useAgentTeamStore.getState().updateTeammate(teammateId, updates),
      },
    }

    const result = await runTeamLifecycle(teamId, deps, ctx.signal).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      const wrapped = new Error(`action.team.run: ${message}`) as Error & { retryable?: boolean }
      wrapped.retryable = false
      throw wrapped
    })

    return {
      output: {
        teamId,
        teamRunId: result.runId,
        status: result.status,
        reason: result.reason,
      },
    }
  },
})

// ── action.team.task.dispatch ─────────────────────────────────────────────
// Per ADR-0022 §3.6. Synthesizer-emitted node: one per AgentTeamTask. Looks
// up the per-run TeamRunContext (registered by the synthesizer before
// runWorkflow) and delegates to the shared `dispatchTeammate` primitive, which
// claims a teammate, runs one turn (tool-enabled via the sidecar on desktop,
// text-only fallback on web/mobile), validates output, and records pool /
// budget / hooks. The same primitive powers the ultracode `pattern.*` nodes.
//
// Retryable: true → workflow runStep retries on transient failures, and each
// retry re-claims from the pool, naturally rotating to a different teammate.
registerNodeExecutor({
  kind: "action.team.task.dispatch",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => {
    const params = ctx.params as {
      teamId?: string
      taskId?: string
      title?: string
      description?: string
      expectedOutput?: string
    }
    if (!params.teamId || !params.taskId) {
      throw nonRetryable("action.team.task.dispatch requires 'teamId' and 'taskId'")
    }
    const taskId = params.taskId
    const [{ getTeamRunContext }, { buildTeammatePrompt }, { dispatchTeammate }] =
      await Promise.all([
        import("@/lib/ai/agent/team/team-run-context"),
        import("@/lib/ai/agent/agent-team-runtime-deps"),
        import("@/lib/ai/agent/team/dispatch-teammate"),
      ])
    const teamCtx = getTeamRunContext(ctx.runId)
    if (!teamCtx) {
      throw nonRetryable(
        `action.team.task.dispatch: no TeamRunContext registered for runId=${ctx.runId}`
      )
    }

    const task = {
      id: taskId,
      title: params.title ?? taskId,
      description: params.description ?? "",
      expectedOutput: params.expectedOutput,
    } as Parameters<typeof buildTeammatePrompt>[2]

    const result = await dispatchTeammate(teamCtx, {
      taskId,
      // Persona-aware prompt built from the teammate the pool actually claims.
      prompt: (teammate) => buildTeammatePrompt(teamCtx.team, teammate, task),
      signal: ctx.signal,
      validateOutput: true,
      recordToStore: true,
    })

    return {
      output: {
        text: result.text,
        teammateId: result.teammateId,
        teammateName: result.teammateName,
        tokenUsage: result.usage,
        attempt: 1,
      },
    }
  },
})

// ── action.plan.step.dispatch ─────────────────────────────────────────────
// Per ADR-0045 P2. Synthesizer-emitted node: one per PlanStep. Looks up the
// per-run PlanRunContext (registered by `runPlan` before runWorkflow) and
// delegates to `dispatchPlanStepNode`, which marks the step in_progress, runs
// the kind-specific work (agent_turn / approval_gate / sub_workflow), and
// writes the terminal status back. Retryable so the orchestrator re-runs
// transient failures per the plan's error policy.
registerNodeExecutor({
  kind: "action.plan.step.dispatch",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => {
    const params = ctx.params as { planId?: string; stepId?: string }
    if (!params.planId || !params.stepId) {
      throw nonRetryable("action.plan.step.dispatch requires 'planId' and 'stepId'")
    }
    const [{ getPlanRunContext }, { dispatchPlanStepNode }] = await Promise.all([
      import("@/lib/agent/plan/plan-run-context"),
      import("@/lib/agent/plan/step-dispatch"),
    ])
    const runCtx = getPlanRunContext(ctx.runId)
    if (!runCtx) {
      throw nonRetryable(
        `action.plan.step.dispatch: no PlanRunContext registered for runId=${ctx.runId}`
      )
    }
    return dispatchPlanStepNode(runCtx, params.stepId, ctx.signal)
  },
})

// ── action.twin.rag ───────────────────────────────────────────────────────
// Vector-search the twin's chunks. Returns the top-K chunks with score and
// source metadata. Degrades gracefully when the vector store / embedding
// config is incomplete — surfaces the reason in the output rather than
// throwing, so workflows can decide whether to fail fast or carry on.
registerNodeExecutor({
  kind: "action.twin.rag",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { twinId?: string; query?: string; topK?: number }
    const twinId = params.twinId?.trim()
    const query = params.query ?? ""
    if (!twinId) throw nonRetryable("action.twin.rag requires 'twinId'")
    if (!query.trim()) throw nonRetryable("action.twin.rag requires non-empty 'query'")
    const topK = Math.max(1, Math.min(50, Math.floor(Number(params.topK ?? 6))))

    const [
      { tryBuildTwinDeps },
      { generateEmbedding },
      { vectorCollectionName },
      { getTwinChunksByVectorDocIds },
      { getTwinSource },
    ] = await Promise.all([
      import("@/lib/twin/runtime/build-deps"),
      import("@/lib/ai/embedding/embedding"),
      import("@/lib/twin/ingest/persist"),
      import("@/lib/db/twin-chunks"),
      import("@/lib/db/twin-sources"),
    ])

    const deps = await tryBuildTwinDeps()
    if (!deps) {
      return {
        output: {
          chunks: [],
          degraded: true,
          reason: "twin runtime not configured (embedding / vector store missing)",
        },
      }
    }

    let queryEmbedding: number[]
    try {
      const embedded = await generateEmbedding(query, deps.embedding)
      queryEmbedding = embedded.embedding
    } catch (err) {
      return {
        output: {
          chunks: [],
          degraded: true,
          reason: err instanceof Error ? `embed-failed: ${err.message}` : "embed-failed",
        },
      }
    }

    const collection = vectorCollectionName(twinId)
    const search = deps.store.searchByEmbedding
    if (!search) {
      return {
        output: { chunks: [], degraded: true, reason: "store.searchByEmbedding unavailable" },
      }
    }

    const hits = await search(collection, queryEmbedding, { limit: topK })
    const docIds = hits.map((h) => h.id)
    const dbChunks = await getTwinChunksByVectorDocIds(docIds)
    const chunkById = new Map(dbChunks.map((c) => [c.vectorDocId, c]))
    const titleCache = new Map<string, string | undefined>()
    const enriched: Array<{
      id: string
      score: number
      content: string
      sourceId: string
      sourceTitle?: string
    }> = []
    for (const h of hits) {
      const chunk = chunkById.get(h.id)
      if (!chunk) continue
      let title = titleCache.get(chunk.sourceId)
      if (title === undefined) {
        const src = await getTwinSource(chunk.sourceId)
        title = src?.title
        titleCache.set(chunk.sourceId, title)
      }
      enriched.push({
        id: h.id,
        score: h.score,
        content: chunk.content,
        sourceId: chunk.sourceId,
        sourceTitle: title,
      })
    }
    return { output: { chunks: enriched, count: enriched.length, degraded: false } }
  },
})

// ── action.twin.ingest ────────────────────────────────────────────────────
// Queue a new TwinSource into the ingest pipeline. The job worker picks it
// up asynchronously; this executor returns once the job is queued (not
// once it's finalized). Use `flow.wait` + a job-poll downstream if you need
// to block until the source is fully embedded.
registerNodeExecutor({
  kind: "action.twin.ingest",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      twinId?: string
      title?: string
      format?: string
      content?: string
      sourceMode?: "paste" | "fetch"
      url?: string
    }
    const twinId = params.twinId?.trim()
    if (!twinId) throw nonRetryable("action.twin.ingest requires 'twinId'")
    const format = (params.format ?? "markdown") as "markdown" | "text" | "code" | "chat"
    const sourceMode = params.sourceMode ?? "paste"
    let content = params.content ?? ""
    if (sourceMode === "fetch") {
      const url = params.url?.trim()
      if (!url) throw nonRetryable("twin.ingest fetch mode requires 'url'")
      const res = await fetch(url, { signal: ctx.signal })
      if (!res.ok) {
        const err = new Error(`twin.ingest fetch ${url} → ${res.status}`) as Error & {
          retryable?: boolean
        }
        err.retryable = res.status >= 500
        throw err
      }
      content = await res.text()
    }
    if (!content) throw nonRetryable("twin.ingest requires non-empty content")

    const [{ createTwinSource }, { createTwinJob }] = await Promise.all([
      import("@/lib/db/twin-sources"),
      import("@/lib/db/twin-jobs"),
    ])

    // Compute the required source metadata that TwinSourceDraft mandates.
    const bytes = new TextEncoder().encode(content).length
    const fingerprint = await sha256Hex(content)
    const source = await createTwinSource({
      twinId,
      kind: format === "code" ? "code" : format === "chat" ? "chat" : "doc",
      format,
      source: sourceMode === "fetch" ? (params.url ?? "manual") : "manual",
      title: params.title || `Workflow ingest ${ctx.stepId}`,
      bytes,
      fingerprint,
      status: "pending",
    } as unknown as Parameters<typeof createTwinSource>[0])
    const job = await createTwinJob({
      twinId,
      kind: "ingest",
      sourceId: source.id,
    } as unknown as Parameters<typeof createTwinJob>[0])
    return {
      output: {
        twinId,
        sourceId: source.id,
        jobId: job.id,
        status: "queued",
      },
    }
  },
})

// ── action.mcp.invokeTool ─────────────────────────────────────────────────
// Spin up a one-shot MCP client connected to the server identified by
// `serverId`, call the tool, and return its content. Stdio transport uses
// the configured command + args; HTTP / SSE servers use the configured URL.
registerNodeExecutor({
  kind: "action.mcp.invokeTool",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      serverId?: string
      toolName?: string
      args?: Record<string, unknown>
    }
    const serverId = params.serverId?.trim()
    const toolName = params.toolName?.trim()
    if (!serverId) throw nonRetryable("action.mcp.invokeTool requires 'serverId'")
    if (!toolName) throw nonRetryable("action.mcp.invokeTool requires 'toolName'")
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Record<
      string,
      unknown
    >

    const { getMcpServer } = await import("@/lib/db/mcp-servers")
    const dbServer = await getMcpServer(serverId)
    // Fall back to a plugin-contributed MCP server preset (overlay registry)
    // when the Dexie table has no row for this id. Presets share the
    // `{ name, transport, config }` shape with stored servers.
    const preset = dbServer ? null : getMcpServerPreset(serverId)
    const server =
      dbServer ??
      (preset ? { name: preset.name, transport: preset.transport, config: preset.config } : null)
    if (!server) throw nonRetryable(`MCP server ${serverId} not found`)

    // Lazily import the SDK to keep the workflow runtime tree-shakable.
    const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] =
      await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      ])

    const client = new Client({ name: "cognia-workflow", version: "1.0.0" }, { capabilities: {} })
    const transport =
      server.transport === "stdio"
        ? new StdioClientTransport({
            command: String(server.config.command ?? ""),
            args: Array.isArray(server.config.args) ? (server.config.args as string[]) : [],
            env: (server.config.env as Record<string, string>) ?? undefined,
          })
        : new StreamableHTTPClientTransport(new URL(String(server.config.url ?? "")))

    const { getPluginEventHooks } = await import("@/lib/plugin")
    const hooks = getPluginEventHooks()

    try {
      await client.connect(transport)
      hooks.dispatchMCPServerConnect(serverId, server.name)
      hooks.dispatchMCPToolCall(serverId, toolName, args)
      const result = await client.callTool({ name: toolName, arguments: args })
      hooks.dispatchMCPToolResult(serverId, toolName, result)
      return {
        output: {
          serverId,
          toolName,
          isError: result.isError ?? false,
          content: result.content ?? [],
          structuredContent: (result as unknown as { structuredContent?: unknown })
            .structuredContent,
        },
      }
    } finally {
      await client.close().catch(() => undefined)
      hooks.dispatchMCPServerDisconnect(serverId)
    }
  },
})

// ── action.plugin.invoke ──────────────────────────────────────────────────
// Two dispatch modes, inferred for persisted-node back-compat:
//
//  - "tool" (new, UI default): invokes a plugin-registered agent tool
//    (`ctx.agent.registerTool()` / manifest `tools[]`) through the unified
//    `invokePluginTool` seam — the same path the chat agent's sidecar
//    round-trip uses, so lazy `onTool:` activation and the permission
//    consent gate behave identically.
//  - "task" (legacy, ADR-0017): dispatches to a `workflow.task` extension
//    registered under the plugin id. Kept verbatim so existing nodes and
//    the formalized extension path stay valid.
//
// The registration deliberately stays at typeVersion 1: executor lookup is
// an exact `(kind, typeVersion)` match with no fallback
// (`lib/workflow/runtime/step-executor.ts`), so a bump would orphan every
// persisted v1 node, and the params change is purely additive.
registerNodeExecutor({
  kind: "action.plugin.invoke",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      pluginId?: string
      mode?: "task" | "tool"
      toolName?: string
      taskId?: string
      args?: Record<string, unknown>
    }
    const pluginId = params.pluginId?.trim()
    const toolName = params.toolName?.trim()
    const taskId = params.taskId?.trim()
    if (!pluginId) throw nonRetryable("action.plugin.invoke requires 'pluginId'")
    const mode = params.mode ?? (toolName ? "tool" : "task")
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Record<
      string,
      unknown
    >

    if (mode === "tool") {
      if (!toolName) {
        throw nonRetryable("action.plugin.invoke (tool mode) requires 'toolName'")
      }
      const { invokePluginTool, PluginToolInvocationError } =
        await import("@/lib/plugin/core/invoke-plugin-tool")
      try {
        const { result } = await invokePluginTool(pluginId, toolName, args, {
          signal: ctx.signal,
          reason: "workflow:action.plugin.invoke",
        })
        return {
          output: { pluginId, toolName, ok: true, data: result },
        }
      } catch (err) {
        if (err instanceof PluginToolInvocationError) {
          // Configuration/permission failures won't heal on retry; runtime
          // failures (execution-failed / aborted) stay retryable.
          if (
            err.code === "plugin-not-found" ||
            err.code === "plugin-disabled" ||
            err.code === "tool-not-found" ||
            err.code === "permission-denied"
          ) {
            throw nonRetryable(err.message)
          }
        }
        throw err
      }
    }

    if (!taskId) throw nonRetryable("action.plugin.invoke requires 'taskId'")

    const { getPlugin } = await import("@/lib/db/plugins")
    const plugin = await getPlugin(pluginId)
    if (!plugin) throw nonRetryable(`plugin ${pluginId} not found`)
    if (!plugin.enabled) {
      throw nonRetryable(`plugin ${pluginId} is not enabled`)
    }

    // Plugin task invocation goes through the extension API: the plugin must
    // have registered a workflow-task extension under its plugin id.
    const { getPluginExtensions } = await import("@/lib/plugin/api/extension-api")
    const exts = getPluginExtensions(pluginId)
    type WorkflowTaskExtension = {
      point: string
      registration: {
        task?: string
        handler?: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
      }
    }
    const candidate = (exts as unknown as WorkflowTaskExtension[]).find(
      (e) => e.point === "workflow.task" && e.registration?.task === taskId
    )
    if (!candidate?.registration?.handler) {
      throw nonRetryable(
        `plugin ${pluginId} has no workflow.task '${taskId}' registered. ` +
          `Plugins must add a workflow.task extension to be invokable.`
      )
    }
    const data = await candidate.registration.handler(args, ctx.signal)
    return {
      output: {
        pluginId,
        taskId,
        ok: true,
        data,
      },
    }
  },
})

// SHA-256 hash to hex (workflow-runtime helper, used by twin.ingest).
async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(text))
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// Helper for executors that want to flag their failures as non-retryable
// (e.g., "missing required field" — retrying won't help).
function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}

// Suppress unused-import warning when only one of these helpers is exercised
// by the test suite — both are real call sites in production paths.
void deleteSkill
void deleteCharacter
void deleteTeam

// ── helpers ───────────────────────────────────────────────────────────────

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value)
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

function firstUpstream(ctx: StepExecutionContext): unknown {
  const values = Object.values(ctx.upstream)
  return values.length > 0 ? values[0] : undefined
}

/**
 * Evaluate a per-item transform expression. Item exposed as `$item`. Falls
 * back to the raw item when the expression is empty.
 */
function evalItemExpression(expression: string, item: unknown, ctx: StepExecutionContext): unknown {
  if (!expression) return item
  return resolveExpression(expression, {
    upstream: { ...ctx.upstream, $item: item },
    trigger: ctx.trigger,
    staticData: {},
    params: ctx.params as Record<string, unknown>,
  })
}

/**
 * Evaluate a `flow.loop.while` condition with the iteration count exposed.
 * Both `$item` (the raw index) and `$loop.index` resolve to the current `i`.
 */
function evalLoopExpression(
  expression: string,
  iteration: number,
  ctx: StepExecutionContext
): unknown {
  return resolveExpression(expression, {
    upstream: {
      ...ctx.upstream,
      $item: iteration,
      $loop: { index: iteration },
    },
    trigger: ctx.trigger,
    staticData: {},
    params: ctx.params as Record<string, unknown>,
  })
}
