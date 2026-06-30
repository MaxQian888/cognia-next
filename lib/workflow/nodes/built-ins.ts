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

import type { Goal, GoalConfig, GoalTemplate } from "@/types/goal"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduledTaskType,
  TaskExecution,
  TaskExecutionConfig,
  TaskFilter,
  TaskNotificationConfig,
  TaskTrigger,
  TaskTriggerType,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
import type {
  AgentPlan,
  CreatePlanInput,
  CreatePlanStepInput,
  PlanConfig,
  PlanExecutionMode,
  PlanRefinementTrigger,
  PlanRefinementType,
  PlanSource,
  PlanStatus,
  PlanStep,
  PlanStepKind,
  PlanStepStatus,
  UpdatePlanInput,
} from "@/types/agent/plan"
import type { StepExecutionContext, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { McpServer } from "@/lib/claude/types"
import { registerNodeExecutor } from "./registry"
import { resolveExpression } from "@/lib/workflow/runtime/expression"
import { respondToWebhook } from "@/lib/workflow/runtime/tauri-bridge"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import { getGoalRuntime } from "@/lib/goal/runtime"
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
import { invokeMcpTool } from "@/lib/mcp/invoke"
import { createCharacter, deleteCharacter, updateCharacter } from "@/lib/db/characters"
import { createTeam, deleteTeam, updateTeam } from "@/lib/db/teams"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { createDraft } from "@/lib/db/connector-drafts"
import {
  getActiveGoalForSession,
  getGoal,
  getOpenGoalForSession,
  listAllGoals,
  listGoalEvents,
  listGoalsBySession,
} from "@/lib/db/goals"
import {
  deleteGoalTemplate,
  getGoalTemplate,
  listGoalTemplates,
  setTemplateFavorite,
  upsertGoalTemplate,
} from "@/lib/db/goal-templates"
import { createGoalFromTemplate } from "@/lib/goal/templates"
import { seedGoalTemplates } from "@/lib/goal/seed-templates"
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { listAllPlans, listPlanEvents } from "@/lib/db/plans"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { getSession } from "@/lib/db/sessions"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { generateTextEmbedding } from "@cognia/provider-embedding/multimodal-embedding"
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
// parseStructured / buildJsonInstruction moved to ./ai/structured so the
// ai.prompt v2 module can share them without a circular import.
import { buildJsonInstruction, parseStructured } from "./ai/structured"
import { runStructuredTurn } from "./ai/structured-turn"
import { validateAgainstJsonSchema } from "./ai/schema-validate"

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
      /**
       * Optional JSON object schema the JSON-mode output must satisfy (D3).
       * When set on a real (non-stub) call, the completion is validated and
       * auto-fixed once; `schemaValid` / `schemaErrors` ride the output.
       */
      outputSchema?: Record<string, unknown>
      /** `fail` (default) throws on violation; `soft` keeps the unvalidated value. */
      onSchemaViolation?: "fail" | "soft"
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
    const outputSchema = params.outputSchema
    const enforceSchema = jsonMode && !!outputSchema && Object.keys(outputSchema).length > 0
    // When an output schema is declared it doubles as the JSON shape hint.
    const schemaHint = enforceSchema ? JSON.stringify(outputSchema, null, 2) : params.jsonSchema
    // In JSON mode, append an instruction (and optional shape) so the model
    // returns parseable JSON regardless of the authored system prompt.
    const systemPrompt = jsonMode
      ? [params.systemPrompt, buildJsonInstruction(schemaHint)].filter(Boolean).join("\n\n")
      : params.systemPrompt

    // Shared tail: attach `structured` / `parseError` when JSON mode is on.
    // A declared schema is validated softly here (no retry, never throws) so
    // the stub / pre-credential path still runs end-to-end.
    const finalize = (out: {
      provider?: string
      model?: string
      completion: string
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
      stub: boolean
    }) => {
      if (!jsonMode) return { output: out }
      const parsed = parseStructured(out.completion)
      const schemaFields =
        enforceSchema && !parsed.error
          ? (() => {
              const v = validateAgainstJsonSchema(outputSchema, parsed.value)
              return v.ok ? { schemaValid: true } : { schemaValid: false, schemaErrors: v.errors }
            })()
          : enforceSchema
            ? { schemaValid: false }
            : {}
      return {
        output: {
          ...out,
          structured: parsed.value,
          ...(parsed.error ? { parseError: parsed.error } : {}),
          ...schemaFields,
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
    const { startSpan, endSpan } = await import("@cognia/agent-trace/emitter")
    const span = startSpan({
      operationName: "chat",
      providerName: "cognia.workflow",
      surface: "workflow",
      sessionId: ctx.runId,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(params.model ? { requestModel: params.model } : {}),
    })
    let completion = ""
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    try {
      // One model call; `fix` carries the corrective re-prompt on the auto-fix
      // retry (only reached when an output schema is enforced).
      const runOnce = async (fix?: string) => {
        const up = fix ? `${userPrompt}\n\n${fix}` : userPrompt
        completion = await client.complete(up, {
          system: systemPrompt,
          temperature: params.temperature,
        })
        const parsed = parseStructured(completion)
        return { object: parsed.value, parseError: parsed.error }
      }
      if (enforceSchema) {
        await runStructuredTurn({
          outputSchema,
          onSchemaViolation: params.onSchemaViolation,
          runOnce,
        })
      } else {
        await runOnce()
      }
      usage = client.getUsageSnapshot?.() ?? usage
    } catch (err) {
      endSpan(span.spanId, {
        errorType: err instanceof Error ? err.name : "Error",
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      throw err
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

// ── ai.prompt v2 ──────────────────────────────────────────────────────────
// Adds routed mode (ADR-0043 provider-routing engine + fallback chains),
// the PII gate, live output streaming, and per-step usage/cost reporting.
// Explicit mode stays wire-compatible with v1 (including the echo stub).
// Full logic lives in ./ai/ai-prompt-v2 so it's independently testable.
registerNodeExecutor({
  kind: "ai.prompt",
  typeVersion: 2,
  execute: async (ctx) => (await import("./ai/ai-prompt-v2")).executeAiPromptV2(ctx),
})

// ── ai.council ────────────────────────────────────────────────────────────
// Multi-model consensus: fan the prompt out to several councillor models (by
// routing alias) in parallel, then a synthesizer model merges them into one
// answer with a confidence rating. Not retryable (it already runs N provider
// calls; a blanket retry would multiply cost). Logic in ./ai/ai-council.
registerNodeExecutor({
  kind: "ai.council",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("./ai/ai-council")).executeAiCouncil(ctx),
})

// ── ai.ensemble ────────────────────────────────────────────────────────────
// Run one target (inline agent.turn OR a sub-workflow) N times with optional
// per-sample lenses, then apply a bundled aggregation policy (majority-vote /
// threshold / best-of / synthesize). The signature N-vote / adversarial-verify
// harness. Not retryable (it already runs N calls). Logic in ./ai/ai-ensemble.
registerNodeExecutor({
  kind: "ai.ensemble",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("./ai/ai-ensemble")).executeAiEnsemble(ctx),
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

// ── action.goal.* ──────────────────────────────────────────────────────────
// Goal nodes are workflow adapters over GoalRuntime. Mutations must keep
// using the runtime so abort controllers, audit rows, redaction, IM guardrails,
// plugin hooks, and terminal fan-out stay identical to slash/UI goal actions.
registerNodeExecutor({
  kind: "action.goal.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      sessionId?: string
      rawObjective?: string
      characterId?: string
      startPaused?: boolean
      config?: Record<string, unknown>
      configJson?: string
    }
    const sessionId = params.sessionId?.trim()
    const rawObjective = params.rawObjective?.trim()
    if (!sessionId) throw nonRetryable("action.goal.create requires 'sessionId'")
    if (!rawObjective) throw nonRetryable("action.goal.create requires non-empty 'rawObjective'")
    const config = parseGoalConfig(params)
    const goal = await getGoalRuntime().createGoal({
      sessionId,
      rawObjective,
      characterId: params.characterId?.trim() || undefined,
      startPaused: params.startPaused,
      config,
      appSettings: useSettingsStore.getState().settings,
    })
    return { output: { goalId: goal.id, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.get")
    const goal = await getGoal(goalId)
    return { output: { goalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: "all" | "session" | "activeForSession" | "openForSession"
      sessionId?: string
      limit?: number
    }
    const mode = params.mode ?? "all"
    const limit = clampGoalLimit(params.limit)
    let goals: Goal[]
    if (mode === "session") {
      const sessionId = requireGoalSessionId(params.sessionId, "action.goal.list")
      goals = applyGoalLimit(await listGoalsBySession(sessionId), limit)
    } else if (mode === "activeForSession") {
      const sessionId = requireGoalSessionId(params.sessionId, "action.goal.list")
      const goal = await getActiveGoalForSession(sessionId)
      goals = goal ? [goal] : []
    } else if (mode === "openForSession") {
      const sessionId = requireGoalSessionId(params.sessionId, "action.goal.list")
      const goal = await getOpenGoalForSession(sessionId)
      goals = goal ? [goal] : []
    } else {
      goals = await listAllGoals(limit)
    }
    const safeGoals = goals.map(toWorkflowGoal)
    return {
      output: {
        mode,
        count: safeGoals.length,
        goals: safeGoals,
        goal: safeGoals[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.events",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const goalId = requireGoalId(ctx, "action.goal.events")
    const limit = clampGoalEventLimit(params.limit)
    const events = await listGoalEvents(goalId, limit)
    return { output: { goalId, count: events.length, events } }
  },
})

registerNodeExecutor({
  kind: "action.goal.updateObjective",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { rawObjective?: string }
    const goalId = requireGoalId(ctx, "action.goal.updateObjective")
    const rawObjective = params.rawObjective?.trim()
    if (!rawObjective) {
      throw nonRetryable("action.goal.updateObjective requires non-empty 'rawObjective'")
    }
    const result = await getGoalRuntime().updateObjective(goalId, rawObjective)
    return {
      output: {
        goalId,
        changed: result !== null,
        goal: toWorkflowGoal(result?.goal ?? (await getGoal(goalId))),
        updatePrompt: result?.updatePrompt,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.pause",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.pause", (id) => getGoalRuntime().pauseGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.resume",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.resume", (id) => getGoalRuntime().resumeGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.stop",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.stop", (id) => getGoalRuntime().stopGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.preempt",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.preempt", (id) => getGoalRuntime().preemptGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.updateConfig",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.updateConfig")
    const config = parseGoalConfig(
      ctx.params as { config?: Record<string, unknown>; configJson?: string }
    )
    if (Object.keys(config).length === 0) {
      throw nonRetryable("action.goal.updateConfig requires a non-empty config patch")
    }
    const goal = await getGoalRuntime().updateConfig(goalId, config)
    return { output: { goalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.decomposeSubgoals",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.decomposeSubgoals")
    const goal = await getGoal(goalId)
    if (!goal) return { output: { goalId, goal: null } }
    const session = await getSession(goal.sessionId)
    const client = buildRendererLlmClient({
      session,
      appSettings: useSettingsStore.getState().settings,
      featureId: "goal-subgoals",
    })
    if (!client) {
      throw nonRetryable("action.goal.decomposeSubgoals requires a configured judge model")
    }
    const updated = await getGoalRuntime().generateSubgoals(goalId, client)
    return { output: { goalId, goal: toWorkflowGoal(updated) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.toggleSubgoal",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { subgoalId?: string }
    const goalId = requireGoalId(ctx, "action.goal.toggleSubgoal")
    const subgoalId = params.subgoalId?.trim()
    if (!subgoalId) throw nonRetryable("action.goal.toggleSubgoal requires 'subgoalId'")
    const goal = await getGoalRuntime().toggleSubgoal(goalId, subgoalId)
    return { output: { goalId, subgoalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.clearSubgoals",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.clearSubgoals")
    const goal = await getGoalRuntime().clearSubgoals(goalId)
    return { output: { goalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.delete")
    await getGoalRuntime().deleteGoal(goalId)
    return { output: { goalId, deleted: true } }
  },
})

registerNodeExecutor({
  kind: "action.goal.analytics",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      scope?: "all" | "session"
      sessionId?: string
      limit?: number
      windowDays?: number
    }
    const scope = params.scope ?? "all"
    const limit = clampGoalLimit(params.limit)
    const goals =
      scope === "session"
        ? applyGoalLimit(
            await listGoalsBySession(
              requireGoalSessionId(params.sessionId, "action.goal.analytics")
            ),
            limit
          )
        : await listAllGoals(limit)
    const analytics = computeGoalAnalytics(goals, { windowDays: params.windowDays })
    return { output: { scope, count: goals.length, analytics } }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      includeBuiltIn?: boolean
      favoriteOnly?: boolean
      query?: string
      limit?: number
    }
    await seedGoalTemplates()
    const query = params.query?.trim().toLocaleLowerCase()
    const limit = clampGoalTemplateLimit(params.limit)
    let templates = await listGoalTemplates()
    if (params.includeBuiltIn === false) templates = templates.filter((tpl) => !tpl.builtin)
    if (params.favoriteOnly) templates = templates.filter((tpl) => tpl.isFavorite)
    if (query) {
      templates = templates.filter((tpl) =>
        [tpl.id, tpl.title, tpl.objectiveText].some((value) =>
          value.toLocaleLowerCase().includes(query)
        )
      )
    }
    const safeTemplates = templates.slice(0, limit).map(toWorkflowGoalTemplate)
    return {
      output: {
        count: safeTemplates.length,
        templates: safeTemplates,
        template: safeTemplates[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.createGoal",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { templateId?: string; sessionId?: string; characterId?: string }
    const templateId = requireGoalTemplateId(ctx, "action.goal.template.createGoal")
    const sessionId = requireGoalSessionId(params.sessionId, "action.goal.template.createGoal")
    const goal = await createGoalFromTemplate({
      templateId,
      sessionId,
      characterId: params.characterId?.trim() || undefined,
      appSettings: useSettingsStore.getState().settings,
    })
    return { output: { templateId, goalId: goal.id, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.upsert",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      templateId?: string
      title?: string
      objectiveText?: string
      configJson?: string
      configOverrides?: Record<string, unknown>
      isFavorite?: boolean
      sortOrder?: number
    }
    const title = params.title?.trim()
    const objectiveText = params.objectiveText?.trim()
    if (!title) throw nonRetryable("action.goal.template.upsert requires non-empty 'title'")
    if (!objectiveText) {
      throw nonRetryable("action.goal.template.upsert requires non-empty 'objectiveText'")
    }
    const requestedId = params.templateId?.trim()
    const existing = requestedId ? await getGoalTemplate(requestedId) : undefined
    const cloneBuiltIn = existing?.builtin === true
    const now = Date.now()
    const row: GoalTemplate = {
      id: requestedId && !cloneBuiltIn ? requestedId : `gtpl_${crypto.randomUUID()}`,
      title,
      objectiveText,
      configOverrides: parseGoalTemplateConfig(params),
      builtin: false,
      isFavorite: params.isFavorite ?? existing?.isFavorite ?? false,
      sortOrder:
        typeof params.sortOrder === "number" && Number.isFinite(params.sortOrder)
          ? params.sortOrder
          : (existing?.sortOrder ?? 0),
      createdAt: existing && !cloneBuiltIn ? existing.createdAt : now,
      updatedAt: now,
    }
    const saved = await upsertGoalTemplate(row)
    return {
      output: {
        templateId: saved.id,
        sourceTemplateId: cloneBuiltIn ? requestedId : undefined,
        template: toWorkflowGoalTemplate(saved),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.favorite",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { isFavorite?: boolean }
    const templateId = requireGoalTemplateId(ctx, "action.goal.template.favorite")
    await setTemplateFavorite(templateId, Boolean(params.isFavorite))
    const template = await getGoalTemplate(templateId)
    return {
      output: {
        templateId,
        changed: template !== undefined,
        template: toWorkflowGoalTemplate(template),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const templateId = requireGoalTemplateId(ctx, "action.goal.template.delete")
    const template = await getGoalTemplate(templateId)
    if (template?.builtin) {
      throw nonRetryable("cannot delete built-in goal template")
    }
    if (!template) return { output: { templateId, deleted: false } }
    await deleteGoalTemplate(templateId)
    return { output: { templateId, deleted: true } }
  },
})

// ── action.plan.* ─────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.plan.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      sessionId?: string
      characterId?: string
      title?: string
      description?: string
      source?: PlanSource
      executionMode?: PlanExecutionMode
      stepsJson?: string
      steps?: unknown
      configJson?: string
      config?: Record<string, unknown>
      metadataJson?: string
      metadata?: Record<string, unknown>
    }
    const sessionId = requirePlanSessionId(params.sessionId, "action.plan.create")
    const title = params.title?.trim()
    if (!title) throw nonRetryable("action.plan.create requires non-empty 'title'")
    const input: CreatePlanInput = {
      sessionId,
      title,
      source: normalizePlanSource(params.source),
      steps: parsePlanCreateSteps(params),
      ...(params.characterId?.trim() ? { characterId: params.characterId.trim() } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.executionMode
        ? { executionMode: normalizePlanExecutionMode(params.executionMode) }
        : {}),
      ...(parsePlanConfig(params) ? { config: parsePlanConfig(params) } : {}),
      ...(parsePlanMetadata(params) ? { metadata: parsePlanMetadata(params) } : {}),
    }
    const plan = await getPlanRuntime().createPlan(input)
    return { output: { planId: plan.id, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.get")
    const plan = await getPlanRuntime().getPlan(planId)
    return { output: { planId, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: "all" | "session" | "openForSession" | "executingForSession"
      sessionId?: string
      status?: PlanStatus | ""
      projectId?: string
      limit?: number
    }
    const mode = params.mode ?? "all"
    const limit = clampPlanLimit(params.limit)
    const runtime = getPlanRuntime()
    let plans: AgentPlan[]
    if (mode === "all") {
      plans = await listAllPlans(limit, params.projectId?.trim() || undefined)
    } else {
      const sessionId = requirePlanSessionId(params.sessionId, "action.plan.list")
      if (mode === "openForSession") {
        const plan = await runtime.getOpenPlanForSession(sessionId)
        plans = plan ? [plan] : []
      } else if (mode === "executingForSession") {
        const plan = await runtime.getExecutingPlanForSession(sessionId)
        plans = plan ? [plan] : []
      } else {
        plans = await runtime.listPlansBySession(sessionId)
      }
    }
    if (params.status) plans = plans.filter((plan) => plan.status === params.status)
    const safePlans = plans.slice(0, limit).map(toWorkflowPlan)
    return {
      output: {
        mode,
        count: safePlans.length,
        plans: safePlans,
        plan: safePlans[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.plan.events",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const planId = requirePlanId(ctx, "action.plan.events")
    const events = await listPlanEvents(planId, clampPlanEventLimit(params.limit))
    return { output: { planId, count: events.length, events, event: events[0] ?? null } }
  },
})

registerNodeExecutor({
  kind: "action.plan.updateDraft",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      title?: string
      description?: string
      executionMode?: PlanExecutionMode | ""
      stepsJson?: string
      steps?: unknown
      configJson?: string
      config?: Record<string, unknown>
      metadataJson?: string
      metadata?: Record<string, unknown>
    }
    const planId = requirePlanId(ctx, "action.plan.updateDraft")
    const patch = buildPlanDraftPatch(params)
    if (Object.keys(patch).length === 0) {
      throw nonRetryable("action.plan.updateDraft requires at least one patch field")
    }
    const plan = await getPlanRuntime().updatePlanDraft(planId, patch)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.approve",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.approve")
    const plan = await getPlanRuntime().approvePlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.reject",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { feedback?: string }
    const planId = requirePlanId(ctx, "action.plan.reject")
    const plan = await getPlanRuntime().rejectPlan(planId, params.feedback)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.refine",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      refinementType?: PlanRefinementType
      trigger?: PlanRefinementTrigger
      failedStepId?: string
      customInstructions?: string
    }
    const planId = requirePlanId(ctx, "action.plan.refine")
    const current = await getPlanRuntime().getPlan(planId)
    if (!current) return { output: { planId, changed: false, plan: null } }
    const session = await getSession(current.sessionId)
    const client = buildRendererLlmClient({
      session: session ?? null,
      appSettings: useSettingsStore.getState().settings,
      featureId: "plan-refine",
    })
    if (!client) {
      throw nonRetryable("action.plan.refine requires a configured planner model")
    }
    const refined = await getPlanRuntime().refinePlan(
      {
        planId,
        refinementType: normalizePlanRefinementType(params.refinementType),
        trigger: normalizePlanRefinementTrigger(params.trigger),
        ...(params.failedStepId?.trim() ? { failedStepId: params.failedStepId.trim() } : {}),
        ...(params.customInstructions?.trim()
          ? { customInstructions: params.customInstructions.trim() }
          : {}),
      },
      client,
      { signal: ctx.signal }
    )
    return {
      output: {
        planId,
        changed: refined !== null && refined.generationId !== current.generationId,
        plan: toWorkflowPlan(refined),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.plan.pause",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.pause")
    const plan = await getPlanRuntime().pausePlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.resume",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.resume")
    const plan = await getPlanRuntime().resumePlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.cancel",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.cancel")
    const plan = await getPlanRuntime().cancelPlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.delete")
    const existing = await getPlanRuntime().getPlan(planId)
    if (!existing) return { output: { planId, deleted: false } }
    await getPlanRuntime().deletePlan(planId)
    return { output: { planId, deleted: true } }
  },
})

registerNodeExecutor({
  kind: "action.plan.run",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.run")
    const result = await getPlanRuntime().runPlan(planId, { signal: ctx.signal })
    if (!result) throw nonRetryable(`action.plan.run: plan ${planId} not found`)
    return { output: { planId, status: result.status, result: result.output } }
  },
})

registerNodeExecutor({
  kind: "action.plan.setStepStatus",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      stepId?: string
      status?: PlanStepStatus
      result?: string
      error?: string
      outputJson?: string
      output?: unknown
      attempts?: number
    }
    const planId = requirePlanId(ctx, "action.plan.setStepStatus")
    const stepId = params.stepId?.trim()
    if (!stepId) throw nonRetryable("action.plan.setStepStatus requires 'stepId'")
    const status = normalizePlanStepStatus(params.status)
    const patch = buildPlanStepPatch(params)
    const plan = await getPlanRuntime().setStepStatus(planId, stepId, status, patch)
    return {
      output: { planId, stepId, status, changed: plan !== null, plan: toWorkflowPlan(plan) },
    }
  },
})

// ── action.scheduler.task.* ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.scheduler.task.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const task = await getTaskScheduler().createTask(buildSchedulerCreateInput(ctx.params))
    return { output: { taskId: task.id, task: toWorkflowScheduledTask(task) } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.get")
    const task = await getTaskScheduler().getTask(taskId)
    return { output: { taskId, task: toWorkflowScheduledTask(task) } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      statuses?: ScheduledTaskStatus[]
      statusesRaw?: string
      types?: ScheduledTaskType[]
      typesRaw?: string
      tags?: string[]
      tagsRaw?: string
      search?: string
      limit?: number
    }
    const limit = clampSchedulerTaskLimit(params.limit)
    const filter: TaskFilter = {
      statuses: normalizeSchedulerStatuses(params.statuses, params.statusesRaw),
      types: normalizeSchedulerTypes(params.types, params.typesRaw),
      tags: normalizeStringList(params.tags, params.tagsRaw),
      search: normalizeOptionalString(params.search),
    }
    const hasFilter = Boolean(
      filter.statuses?.length || filter.types?.length || filter.tags?.length || filter.search
    )
    const tasks = hasFilter
      ? await schedulerDb.getFilteredTasks(filter)
      : await schedulerDb.getAllTasks()
    const safeTasks = tasks.slice(0, limit)
    return {
      output: {
        count: safeTasks.length,
        tasks: safeTasks.map(toWorkflowScheduledTask),
        task: toWorkflowScheduledTask(safeTasks[0]),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.update")
    const patch = buildSchedulerUpdateInput(ctx.params)
    if (Object.keys(patch).length === 0) {
      throw nonRetryable("action.scheduler.task.update requires at least one patch field")
    }
    const task = await getTaskScheduler().updateTask(taskId, patch)
    return { output: { taskId, changed: task !== null, task: toWorkflowScheduledTask(task) } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.pause",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.pause")
    const changed = await getTaskScheduler().pauseTask(taskId)
    return { output: { taskId, changed } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.resume",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.resume")
    const changed = await getTaskScheduler().resumeTask(taskId)
    return { output: { taskId, changed } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.delete")
    const deleted = await getTaskScheduler().deleteTask(taskId)
    return { output: { taskId, deleted } }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.runNow",
  typeVersion: 1,
  execute: async (ctx) => {
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.runNow")
    const execution = await getTaskScheduler().runTaskNow(taskId, { triggerSource: "run-now" })
    return {
      output: {
        taskId,
        ran: execution !== null,
        executionId: execution?.id ?? null,
        execution: toWorkflowTaskExecution(execution),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.executions",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.executions")
    const executions = await getTaskScheduler().getTaskExecutions(
      taskId,
      clampSchedulerExecutionLimit(params.limit)
    )
    const safeExecutions = executions.map(toWorkflowTaskExecution)
    return {
      output: {
        taskId,
        count: safeExecutions.length,
        executions: safeExecutions,
        execution: safeExecutions[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.backfill",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { start?: string; end?: string }
    const taskId = requireSchedulerTaskId(ctx, "action.scheduler.task.backfill")
    const start = normalizeSchedulerDate(params.start, "scheduler backfill start")
    const end = normalizeSchedulerDate(params.end, "scheduler backfill end")
    if (!start) throw nonRetryable("action.scheduler.task.backfill requires 'start'")
    if (!end) throw nonRetryable("action.scheduler.task.backfill requires 'end'")
    const executions = await getTaskScheduler().backfillTask(taskId, { start, end })
    const safeExecutions = executions.map(toWorkflowTaskExecution)
    return {
      output: {
        taskId,
        count: safeExecutions.length,
        executions: safeExecutions,
        execution: safeExecutions[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.export",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { taskIds?: string[]; taskIdsRaw?: string }
    const taskIds = normalizeStringList(params.taskIds, params.taskIdsRaw)
    const data = await getTaskScheduler().exportTasks(taskIds)
    const tasks = data.tasks.map(toWorkflowScheduledTask)
    return {
      output: {
        version: data.version,
        exportedAt: data.exportedAt,
        count: tasks.length,
        data,
        tasks,
        task: tasks[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.task.import",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      data?: unknown
      dataJson?: string
      mode?: "merge" | "replace"
    }
    const data = parseSchedulerImportData(params.data, params.dataJson)
    const mode = params.mode === "replace" ? "replace" : "merge"
    const result = await getTaskScheduler().importTasks(data, mode)
    return { output: result }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.status",
  typeVersion: 1,
  execute: async () => ({ output: getTaskScheduler().getStatus() }),
})

registerNodeExecutor({
  kind: "action.scheduler.statistics",
  typeVersion: 1,
  execute: async () => ({ output: await schedulerDb.getStatistics() }),
})

registerNodeExecutor({
  kind: "action.scheduler.upcoming",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const tasks = await schedulerDb.getUpcomingTasks(clampSchedulerTaskLimit(params.limit))
    const safeTasks = tasks.map(toWorkflowScheduledTask)
    return {
      output: {
        count: safeTasks.length,
        tasks: safeTasks,
        task: safeTasks[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.executions.recent",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const executions = await schedulerDb.getRecentExecutions(
      clampSchedulerExecutionLimit(params.limit)
    )
    const safeExecutions = executions.map(toWorkflowTaskExecution)
    return {
      output: {
        count: safeExecutions.length,
        executions: safeExecutions,
        execution: safeExecutions[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.execution.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const executionId = requireSchedulerExecutionId(ctx, "action.scheduler.execution.get")
    const execution = await schedulerDb.getExecution(executionId)
    return {
      output: {
        executionId,
        execution: toWorkflowTaskExecution(execution),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.scheduler.event.trigger",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      eventType?: string
      eventSource?: string
      payload?: Record<string, unknown>
      payloadJson?: string
    }
    const eventType = readRequiredSchedulerString(
      params.eventType,
      "scheduler event trigger eventType"
    )
    const eventSource = normalizeOptionalString(params.eventSource)
    const payload = parseSchedulerObjectParam(
      params.payload,
      params.payloadJson,
      "scheduler event payloadJson"
    )
    await getTaskScheduler().triggerEventTask(eventType, eventSource, payload)
    return {
      output: {
        eventType,
        eventSource,
        triggered: true,
        payload: payload ?? {},
      },
    }
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

// ── action.agent.turn ─────────────────────────────────────────────────────
// Full tool-enabled agent turn (sidecar on desktop, honest text-only
// degradation on web). Logic in ./actions/agent-turn for testability.
// Not retryable — an agent turn can have side effects (tool calls).
registerNodeExecutor({
  kind: "action.agent.turn",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("./actions/agent-turn")).runAgentTurn(ctx),
})

// ── action.memory.recall / action.memory.store ───────────────────────────
// Long-term memory access (lib/memory). Recall is read-only and best-effort
// (degrades, never throws on a missing backend); store mirrors /remember's
// explicit-capture path through the shared consolidator with a mandatory
// PII gate. Store is not retryable (it writes).
registerNodeExecutor({
  kind: "action.memory.recall",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => (await import("./actions/memory-recall")).runMemoryRecall(ctx),
})
registerNodeExecutor({
  kind: "action.memory.store",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("./actions/memory-store")).runMemoryStore(ctx),
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
      mode?: "explicit" | "routed"
      modelAlias?: string
      piiGate?: "off" | "block" | "redact"
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
    // Delegate to ai.prompt v2 — explicit mode is wire-compatible with v1
    // (same provider handling + stub fallback) and inherits routed mode +
    // the PII gate when those params are set on the classify node.
    const aiPrompt = (await import("./registry")).getExecutor("ai.prompt", 2)
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
        mode: params.mode,
        modelAlias: params.modelAlias,
        piiGate: params.piiGate,
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
      mode?: "explicit" | "routed"
      modelAlias?: string
      piiGate?: "off" | "block" | "redact"
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
    // Delegate to ai.prompt v2 (see ai.classify above for the rationale).
    const aiPrompt = (await import("./registry")).getExecutor("ai.prompt", 2)
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
        mode: params.mode,
        modelAlias: params.modelAlias,
        piiGate: params.piiGate,
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
        const { generateEmbedding } = await import("@cognia/vector/embedding")
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
    // Typed-interface validation (D5): when the target declares an input
    // schema, the call payload must satisfy it BEFORE the run starts.
    const inputSchema = workflow.interface?.inputSchema
    if (inputSchema && Object.keys(inputSchema).length > 0) {
      const v = validateAgainstJsonSchema(inputSchema, params.input ?? null)
      if (!v.ok) {
        throw nonRetryable(
          `flow.subworkflow: input violates the target's schema — ${v.errors.join("; ")}`
        )
      }
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
    // Validate the terminal output against the declared output schema.
    const outputSchema = workflow.interface?.outputSchema
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
        addTask: (
          input: Parameters<ReturnType<typeof useAgentTeamStore.getState>["createTask"]>[0]
        ) => useAgentTeamStore.getState().createTask(input),
        updateTask: (
          taskId: string,
          updates: Parameters<ReturnType<typeof useAgentTeamStore.getState>["updateTask"]>[1]
        ) => useAgentTeamStore.getState().updateTask(taskId, updates),
        addEvent: (
          event: Parameters<ReturnType<typeof useAgentTeamStore.getState>["addEvent"]>[0]
        ) => useAgentTeamStore.getState().addEvent(event),
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
      assignedTo?: string
      dependencies?: string[]
    }
    if (!params.teamId || !params.taskId) {
      throw nonRetryable("action.team.task.dispatch requires 'teamId' and 'taskId'")
    }
    const teamId = params.teamId
    const taskId = params.taskId
    const [
      { getTeamRunContext },
      { buildTeammatePrompt },
      { dispatchTeammate },
      { readDependencyResults, autoPublishTaskResult },
    ] = await Promise.all([
      import("@/lib/ai/agent/team/team-run-context"),
      import("@/lib/ai/agent/agent-team-runtime-deps"),
      import("@/lib/ai/agent/team/dispatch-teammate"),
      import("@/lib/ai/agent/team/shared-memory-orchestrator"),
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

    // Blackboard read: pull the results of this task's upstream dependencies so
    // the teammate builds on prior work instead of starting cold. Dependency
    // nodes always finish first (they're DAG predecessors), so their
    // `task:<id>` entries are on the board by the time this node runs.
    const depIds = Array.isArray(params.dependencies)
      ? params.dependencies.filter((d): d is string => typeof d === "string" && d.length > 0)
      : []
    const upstream = readDependencyResults(teamId, depIds)
    const upstreamBlock =
      upstream.length > 0
        ? [
            "Upstream results from teammates whose tasks you depend on — build on these:",
            ...upstream.map(
              (u) =>
                `### ${u.taskTitle ?? u.taskId}${u.writerName ? ` (by ${u.writerName})` : ""}\n${u.value}`
            ),
            "",
          ].join("\n\n")
        : ""

    const result = await dispatchTeammate(teamCtx, {
      taskId,
      // Persona-aware prompt built from the teammate the pool actually claims,
      // prefixed with any upstream dependency results.
      prompt: (teammate) => {
        const base = buildTeammatePrompt(teamCtx.team, teammate, task)
        return upstreamBlock ? `${upstreamBlock}\n${base}` : base
      },
      signal: ctx.signal,
      validateOutput: true,
      recordToStore: true,
      // Skill-aware claim: prefer the teammate the task was assigned to.
      ...(params.assignedTo ? { preferTeammateId: params.assignedTo } : {}),
    })

    // Blackboard write: publish this task's result under `task:<taskId>` so
    // downstream teammates can read it. PII-gated + best-effort — a blackboard
    // write must never fail the task itself.
    try {
      autoPublishTaskResult(
        { id: teamId },
        { id: taskId, title: params.title ?? taskId },
        result.text,
        { id: result.teammateId, name: result.teammateName }
      )
    } catch {
      /* never fail a completed task on a blackboard write */
    }

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
      import("@cognia/provider-embedding/embedding"),
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

    // Resolve the server up front so the connect hook carries the human name and
    // the not-found case maps to a non-retryable failure. Falls back to a
    // plugin-contributed preset (overlay registry) when the Dexie table has no
    // row — presets share the `{ name, transport, config }` shape.
    const { getMcpServer } = await import("@/lib/db/mcp-servers")
    const dbServer = await getMcpServer(serverId)
    const preset = dbServer ? undefined : getMcpServerPreset(serverId)
    const server = dbServer
      ? dbServer
      : preset
        ? ({
            id: serverId,
            name: preset.name,
            transport: preset.transport,
            config: preset.config,
            enabled: true,
          } as McpServer)
        : undefined
    if (!server) throw nonRetryable(`MCP server ${serverId} not found`)

    const { getPluginEventHooks } = await import("@/lib/plugin")
    const hooks = getPluginEventHooks()

    try {
      hooks.dispatchMCPServerConnect(serverId, server.name)
      hooks.dispatchMCPToolCall(serverId, toolName, args)
      // Shared invoke seam: correct stdio/sse/http split + static headers +
      // (future) OAuth authProvider. Inject the already-resolved server so we
      // don't re-hit Dexie / the preset registry.
      const result = await invokeMcpTool(
        {
          serverId,
          toolName,
          args,
          signal: ctx.signal,
          clientInfo: { name: "cognia-workflow", version: "1.0.0" },
        },
        { getServer: async () => server }
      )
      hooks.dispatchMCPToolResult(serverId, toolName, {
        isError: result.isError,
        content: result.content,
        structuredContent: result.structuredContent,
      })
      return {
        output: {
          serverId,
          toolName,
          isError: result.isError,
          content: result.content,
          structuredContent: result.structuredContent,
        },
      }
    } finally {
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

type WorkflowGoalSnapshot = Omit<Goal, "rawObjective" | "redactionMapEnc"> & {
  goalId: string
  hasRedactions: boolean
}

type WorkflowGoalTemplateSnapshot = GoalTemplate & {
  templateId: string
}

type WorkflowPlanSnapshot = AgentPlan & {
  planId: string
}

type WorkflowScheduledTaskSnapshot = ScheduledTask & {
  taskId: string
}

type WorkflowTaskExecutionSnapshot = TaskExecution & {
  executionId: string
}

const SCHEDULER_TASK_TYPES = new Set<ScheduledTaskType>([
  "workflow",
  "agent",
  "sync",
  "backup",
  "custom",
  "plugin",
  "script",
  "test",
  "ai-generation",
  "chat",
  "im-push",
  "skill",
  "external-agent",
  "agent-team",
  "goal",
  "plan",
  "twin",
  "connection:scheduled:digest",
  "connection:outbound:send",
  "wiki-rebuild",
])

const SCHEDULER_TASK_STATUSES = new Set<ScheduledTaskStatus>([
  "active",
  "paused",
  "disabled",
  "expired",
])

const SCHEDULER_TRIGGER_TYPES = new Set<TaskTriggerType>(["cron", "interval", "once", "event"])

const PLAN_STEP_KINDS = new Set<PlanStepKind>([
  "agent_turn",
  "teammate_dispatch",
  "tool_call",
  "mcp_tool_call",
  "sub_workflow",
  "approval_gate",
])

const PLAN_STEP_STATUSES = new Set<PlanStepStatus>([
  "pending",
  "ready",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "blocked",
])

const PLAN_REFINEMENT_TYPES = new Set<PlanRefinementType>([
  "optimize",
  "simplify",
  "expand",
  "reorder",
  "repair",
])

const PLAN_REFINEMENT_TRIGGERS = new Set<PlanRefinementTrigger>([
  "manual",
  "step_failure",
  "judge_deviation",
])

const PLAN_SOURCES = new Set<PlanSource>([
  "exit_plan_mode",
  "agent_tool",
  "planner_llm",
  "team_projection",
  "goal_projection",
  "manual",
])

const PLAN_EXECUTION_MODES = new Set<PlanExecutionMode>(["in_session", "orchestrated", "auto"])

function toWorkflowGoal(goal: Goal | null | undefined): WorkflowGoalSnapshot | null {
  if (!goal) return null
  const { rawObjective: _rawObjective, redactionMapEnc, ...safe } = goal
  void _rawObjective
  return {
    ...safe,
    goalId: goal.id,
    hasRedactions: redactionMapEnc.length > 0,
  }
}

function toWorkflowGoalTemplate(
  template: GoalTemplate | null | undefined
): WorkflowGoalTemplateSnapshot | null {
  if (!template) return null
  return { ...template, templateId: template.id }
}

function toWorkflowPlan(plan: AgentPlan | null | undefined): WorkflowPlanSnapshot | null {
  if (!plan) return null
  return { ...plan, planId: plan.id }
}

function toWorkflowScheduledTask(
  task: ScheduledTask | null | undefined
): WorkflowScheduledTaskSnapshot | null {
  if (!task) return null
  return { ...task, taskId: task.id }
}

function toWorkflowTaskExecution(
  execution: TaskExecution | null | undefined
): WorkflowTaskExecutionSnapshot | null {
  if (!execution) return null
  return { ...execution, executionId: execution.id }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseJsonParam(raw: unknown, fieldName: string): unknown | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw nonRetryable(`${fieldName} must be valid JSON: ${message}`)
  }
}

function parseObjectParam(
  structured: unknown,
  raw: unknown,
  fieldName: string
): Record<string, unknown> | undefined {
  const base = isRecord(structured) ? structured : undefined
  const parsed = parseJsonParam(raw, fieldName)
  if (parsed === undefined) return base
  if (!isRecord(parsed)) throw nonRetryable(`${fieldName} must decode to an object`)
  return { ...(base ?? {}), ...parsed }
}

function buildSchedulerCreateInput(rawParams: unknown): CreateScheduledTaskInput {
  const params = isRecord(rawParams) ? rawParams : {}
  const name = readRequiredSchedulerString(params.name, "scheduler task name")
  return {
    name,
    ...(typeof params.description === "string" ? { description: params.description } : {}),
    type: normalizeSchedulerTaskType(params.type),
    trigger: buildSchedulerCreateTrigger(params),
    ...(parseSchedulerObjectParam(params.payload, params.payloadJson, "scheduler payloadJson")
      ? {
          payload: parseSchedulerObjectParam(
            params.payload,
            params.payloadJson,
            "scheduler payloadJson"
          ),
        }
      : {}),
    ...(parseSchedulerConfig(params) ? { config: parseSchedulerConfig(params) } : {}),
    ...(parseSchedulerNotification(params)
      ? { notification: parseSchedulerNotification(params) }
      : {}),
    ...(normalizeStringList(params.tags, params.tagsRaw)
      ? { tags: normalizeStringList(params.tags, params.tagsRaw) }
      : {}),
    ...(normalizeSchedulerDate(params.endAt, "scheduler endAt")
      ? { endAt: normalizeSchedulerDate(params.endAt, "scheduler endAt") }
      : {}),
    ...(normalizeStringList(params.onSuccessTaskIds, params.onSuccessTaskIdsRaw)
      ? {
          onSuccessTaskIds: normalizeStringList(
            params.onSuccessTaskIds,
            params.onSuccessTaskIdsRaw
          ),
        }
      : {}),
    ...(normalizeStringList(params.onFailureTaskIds, params.onFailureTaskIdsRaw)
      ? {
          onFailureTaskIds: normalizeStringList(
            params.onFailureTaskIds,
            params.onFailureTaskIdsRaw
          ),
        }
      : {}),
  }
}

function buildSchedulerUpdateInput(rawParams: unknown): UpdateScheduledTaskInput {
  const params = isRecord(rawParams) ? rawParams : {}
  const patch: UpdateScheduledTaskInput = {}
  if (params.name !== undefined) {
    patch.name = readRequiredSchedulerString(params.name, "scheduler task name")
  }
  if (typeof params.description === "string") patch.description = params.description
  const status = normalizeOptionalSchedulerStatus(params.status)
  if (status) patch.status = status
  const trigger = buildSchedulerUpdateTrigger(params)
  if (trigger) patch.trigger = trigger
  const payload = parseSchedulerObjectParam(
    params.payload,
    params.payloadJson,
    "scheduler payloadJson"
  )
  if (payload) patch.payload = payload
  const config = parseSchedulerConfig(params)
  if (config) patch.config = config
  const notification = parseSchedulerNotification(params)
  if (notification) patch.notification = notification
  const tags = normalizeStringList(params.tags, params.tagsRaw)
  if (tags) patch.tags = tags
  if (params.clearEndAt === true) {
    patch.endAt = null
  } else {
    const endAt = normalizeSchedulerDate(params.endAt, "scheduler endAt")
    if (endAt) patch.endAt = endAt
  }
  const onSuccessTaskIds = normalizeStringList(params.onSuccessTaskIds, params.onSuccessTaskIdsRaw)
  if (onSuccessTaskIds) patch.onSuccessTaskIds = onSuccessTaskIds
  const onFailureTaskIds = normalizeStringList(params.onFailureTaskIds, params.onFailureTaskIdsRaw)
  if (onFailureTaskIds) patch.onFailureTaskIds = onFailureTaskIds
  return patch
}

function buildSchedulerCreateTrigger(params: Record<string, unknown>): TaskTrigger {
  const type = normalizeSchedulerTriggerType(params.triggerType)
  const trigger: TaskTrigger = { type }
  applySchedulerTriggerFields(trigger, params, true)
  return trigger
}

function buildSchedulerUpdateTrigger(
  params: Record<string, unknown>
): Partial<TaskTrigger> | undefined {
  const trigger: Partial<TaskTrigger> = {}
  if (typeof params.triggerType === "string" && params.triggerType.trim()) {
    trigger.type = normalizeSchedulerTriggerType(params.triggerType)
  }
  applySchedulerTriggerFields(trigger, params, false)
  return Object.keys(trigger).length > 0 ? trigger : undefined
}

function applySchedulerTriggerFields(
  trigger: Partial<TaskTrigger>,
  params: Record<string, unknown>,
  requireForType: boolean
): void {
  const type = trigger.type
  if (type === "cron") {
    const cronExpression = normalizeOptionalString(params.cronExpression)
    if (cronExpression) trigger.cronExpression = cronExpression
    else if (requireForType) throw nonRetryable("scheduler cron trigger requires 'cronExpression'")
  }
  if (type === "interval") {
    const intervalMs = normalizeOptionalPositiveNumber(params.intervalMs, "intervalMs")
    if (intervalMs !== undefined) trigger.intervalMs = intervalMs
    else if (requireForType) throw nonRetryable("scheduler interval trigger requires 'intervalMs'")
  }
  if (type === "once") {
    const runAt = normalizeSchedulerDate(params.runAt, "scheduler runAt")
    if (runAt) trigger.runAt = runAt
    else if (requireForType) throw nonRetryable("scheduler once trigger requires 'runAt'")
  }
  if (type === "event") {
    const eventType = normalizeOptionalString(params.eventType)
    if (eventType) trigger.eventType = eventType
    else if (requireForType) throw nonRetryable("scheduler event trigger requires 'eventType'")
  }
  const eventSource = normalizeOptionalString(params.eventSource)
  if (eventSource) trigger.eventSource = eventSource
  const timezone = normalizeOptionalString(params.timezone)
  if (timezone) trigger.timezone = timezone
  const dependsOn = normalizeStringList(params.dependsOn, params.dependsOnRaw)
  if (dependsOn) trigger.dependsOn = dependsOn
  const jitterMs = normalizeOptionalNonNegativeNumber(params.jitterMs, "jitterMs")
  if (jitterMs !== undefined) trigger.jitterMs = jitterMs
}

function parseSchedulerObjectParam(
  structured: unknown,
  raw: unknown,
  fieldName: string
): Record<string, unknown> | undefined {
  const parsed = parseObjectParam(structured, raw, fieldName)
  return parsed && Object.keys(parsed).length > 0 ? parsed : undefined
}

function parseSchedulerImportData(
  structured: unknown,
  raw: unknown
): { version: number; tasks: ScheduledTask[] } {
  const parsed = structured ?? parseJsonParam(raw, "scheduler import dataJson")
  if (!isRecord(parsed)) {
    throw nonRetryable("action.scheduler.task.import requires 'dataJson'")
  }
  return parsed as { version: number; tasks: ScheduledTask[] }
}

function parseSchedulerConfig(
  rawParams: Record<string, unknown>
): Partial<TaskExecutionConfig> | undefined {
  return parseSchedulerObjectParam(
    rawParams.config,
    rawParams.configJson,
    "scheduler configJson"
  ) as Partial<TaskExecutionConfig> | undefined
}

function parseSchedulerNotification(
  rawParams: Record<string, unknown>
): Partial<TaskNotificationConfig> | undefined {
  return parseSchedulerObjectParam(
    rawParams.notification,
    rawParams.notificationJson,
    "scheduler notificationJson"
  ) as Partial<TaskNotificationConfig> | undefined
}

function normalizeSchedulerTaskType(value: unknown): ScheduledTaskType {
  if (typeof value === "string" && SCHEDULER_TASK_TYPES.has(value as ScheduledTaskType)) {
    return value as ScheduledTaskType
  }
  throw nonRetryable(`unsupported scheduler task type: ${String(value)}`)
}

function normalizeSchedulerTriggerType(value: unknown): TaskTriggerType {
  if (typeof value === "string" && SCHEDULER_TRIGGER_TYPES.has(value as TaskTriggerType)) {
    return value as TaskTriggerType
  }
  throw nonRetryable(`unsupported scheduler trigger type: ${String(value)}`)
}

function normalizeOptionalSchedulerStatus(value: unknown): ScheduledTaskStatus | undefined {
  if (value === undefined || value === "") return undefined
  if (typeof value === "string" && SCHEDULER_TASK_STATUSES.has(value as ScheduledTaskStatus)) {
    return value as ScheduledTaskStatus
  }
  throw nonRetryable(`unsupported scheduler task status: ${String(value)}`)
}

function normalizeSchedulerStatuses(
  values: unknown,
  raw: unknown
): ScheduledTaskStatus[] | undefined {
  const list = normalizeStringList(values, raw)
  if (!list) return undefined
  return list.map((value) => {
    if (!SCHEDULER_TASK_STATUSES.has(value as ScheduledTaskStatus)) {
      throw nonRetryable(`unsupported scheduler task status: ${value}`)
    }
    return value as ScheduledTaskStatus
  })
}

function normalizeSchedulerTypes(values: unknown, raw: unknown): ScheduledTaskType[] | undefined {
  const list = normalizeStringList(values, raw)
  if (!list) return undefined
  return list.map((value) => normalizeSchedulerTaskType(value))
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readRequiredSchedulerString(value: unknown, fieldName: string): string {
  const text = normalizeOptionalString(value)
  if (!text) throw nonRetryable(`${fieldName} must be a non-empty string`)
  return text
}

function normalizeStringList(values: unknown, raw: unknown): string[] | undefined {
  if (Array.isArray(values)) {
    const normalized = values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
    return normalized.length > 0 || values.length === 0 ? normalized : undefined
  }
  const text = normalizeOptionalString(raw)
  if (!text) return undefined
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

function normalizeSchedulerDate(value: unknown, fieldName: string): Date | undefined {
  const text = normalizeOptionalString(value)
  if (!text) return undefined
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw nonRetryable(`${fieldName} must be a valid date`)
  return date
}

function normalizeOptionalPositiveNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw nonRetryable(`${fieldName} must be a positive number`)
  }
  return parsed
}

function parsePlanConfig(params: {
  config?: Record<string, unknown>
  configJson?: string
}): Partial<PlanConfig> | undefined {
  const config = parseObjectParam(params.config, params.configJson, "plan configJson")
  return config && Object.keys(config).length > 0 ? (config as Partial<PlanConfig>) : undefined
}

function parsePlanMetadata(params: {
  metadata?: Record<string, unknown>
  metadataJson?: string
}): Record<string, unknown> | undefined {
  const metadata = parseObjectParam(params.metadata, params.metadataJson, "plan metadataJson")
  return metadata && Object.keys(metadata).length > 0 ? metadata : undefined
}

function parsePlanCreateSteps(params: {
  steps?: unknown
  stepsJson?: string
}): CreatePlanStepInput[] {
  const parsed = params.steps ?? parseJsonParam(params.stepsJson, "plan stepsJson")
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw nonRetryable("action.plan.create requires a non-empty steps array")
  }
  return parsed.map((step, index) => normalizePlanCreateStep(step, index))
}

function normalizePlanCreateStep(step: unknown, index: number): CreatePlanStepInput {
  if (!isRecord(step)) throw nonRetryable(`plan step ${index} must be an object`)
  const title = readRequiredPlanString(step.title, `plan step ${index}.title`)
  const kind = normalizePlanStepKind(step.kind)
  const dependsOn = normalizePlanDependsOn(step.dependsOn, index)
  const params = isRecord(step.params) ? (step.params as CreatePlanStepInput["params"]) : undefined
  const estimatedDurationMs = normalizeOptionalNonNegativeNumber(
    step.estimatedDurationMs,
    `plan step ${index}.estimatedDurationMs`
  )
  return {
    title,
    kind,
    ...(typeof step.description === "string" ? { description: step.description } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    ...(params ? { params } : {}),
    ...(estimatedDurationMs !== undefined ? { estimatedDurationMs } : {}),
  }
}

function parsePlanUpdateSteps(params: {
  steps?: unknown
  stepsJson?: string
}): PlanStep[] | undefined {
  const parsed = params.steps ?? parseJsonParam(params.stepsJson, "plan stepsJson")
  if (parsed === undefined) return undefined
  if (!Array.isArray(parsed)) throw nonRetryable("plan stepsJson must decode to an array")
  return parsed.map((step, index) => normalizePlanStep(step, index))
}

function normalizePlanStep(step: unknown, index: number): PlanStep {
  if (!isRecord(step)) throw nonRetryable(`plan step ${index} must be an object`)
  const id = readRequiredPlanString(step.id, `plan step ${index}.id`)
  const title = readRequiredPlanString(step.title, `plan step ${index}.title`)
  const kind = normalizePlanStepKind(step.kind)
  const status = normalizePlanStepStatus(step.status)
  const order = normalizeRequiredInteger(step.order, `plan step ${index}.order`)
  const dependencies = normalizeStringArray(step.dependencies, `plan step ${index}.dependencies`)
  return {
    ...(step as unknown as PlanStep),
    id,
    title,
    kind,
    status,
    order,
    dependencies,
  }
}

function buildPlanDraftPatch(params: {
  title?: string
  description?: string
  executionMode?: PlanExecutionMode | ""
  steps?: unknown
  stepsJson?: string
  config?: Record<string, unknown>
  configJson?: string
  metadata?: Record<string, unknown>
  metadataJson?: string
}): UpdatePlanInput {
  const patch: UpdatePlanInput = {}
  if (params.title !== undefined) patch.title = params.title
  if (params.description !== undefined) patch.description = params.description
  if (params.executionMode) patch.executionMode = normalizePlanExecutionMode(params.executionMode)
  const steps = parsePlanUpdateSteps(params)
  if (steps !== undefined) patch.steps = steps
  const config = parsePlanConfig(params)
  if (config !== undefined) patch.config = config
  const metadata = parsePlanMetadata(params)
  if (metadata !== undefined) patch.metadata = metadata
  return patch
}

function buildPlanStepPatch(params: {
  result?: string
  error?: string
  outputJson?: string
  output?: unknown
  attempts?: number
}): Partial<Omit<PlanStep, "id" | "status">> {
  const patch: Partial<Omit<PlanStep, "id" | "status">> = {}
  if (params.result !== undefined) patch.result = params.result
  if (params.error !== undefined) patch.error = params.error
  const parsedOutput = parseJsonParam(params.outputJson, "plan step outputJson")
  if (parsedOutput !== undefined) patch.output = parsedOutput
  else if (params.output !== undefined) patch.output = params.output
  if (params.attempts !== undefined) {
    patch.attempts = normalizeRequiredInteger(params.attempts, "attempts")
  }
  return patch
}

function readRequiredPlanString(value: unknown, fieldName: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw nonRetryable(`${fieldName} must be a non-empty string`)
  return text
}

function normalizeRequiredInteger(value: unknown, fieldName: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw nonRetryable(`${fieldName} must be a non-negative integer`)
  }
  return parsed
}

function normalizeOptionalNonNegativeNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw nonRetryable(`${fieldName} must be a non-negative number`)
  }
  return parsed
}

function normalizePlanDependsOn(value: unknown, stepIndex: number): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw nonRetryable(`plan step ${stepIndex}.dependsOn must be an array`)
  return value.map((item, depIndex) => {
    const parsed = Number(item)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw nonRetryable(
        `plan step ${stepIndex}.dependsOn[${depIndex}] must be a non-negative integer`
      )
    }
    return parsed
  })
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw nonRetryable(`${fieldName} must be an array`)
  return value.map((item, index) => {
    if (typeof item !== "string") throw nonRetryable(`${fieldName}[${index}] must be a string`)
    return item
  })
}

function normalizePlanStepKind(value: unknown): PlanStepKind {
  if (typeof value === "string" && PLAN_STEP_KINDS.has(value as PlanStepKind)) {
    return value as PlanStepKind
  }
  throw nonRetryable(`unsupported plan step kind: ${String(value)}`)
}

function normalizePlanStepStatus(value: unknown): PlanStepStatus {
  if (typeof value === "string" && PLAN_STEP_STATUSES.has(value as PlanStepStatus)) {
    return value as PlanStepStatus
  }
  throw nonRetryable(`unsupported plan step status: ${String(value)}`)
}

function normalizePlanRefinementType(value: unknown): PlanRefinementType {
  if (value === undefined || value === "") return "optimize"
  if (typeof value === "string" && PLAN_REFINEMENT_TYPES.has(value as PlanRefinementType)) {
    return value as PlanRefinementType
  }
  throw nonRetryable(`unsupported plan refinementType: ${String(value)}`)
}

function normalizePlanRefinementTrigger(value: unknown): PlanRefinementTrigger {
  if (value === undefined || value === "") return "manual"
  if (typeof value === "string" && PLAN_REFINEMENT_TRIGGERS.has(value as PlanRefinementTrigger)) {
    return value as PlanRefinementTrigger
  }
  throw nonRetryable(`unsupported plan refinement trigger: ${String(value)}`)
}

function normalizePlanSource(value: unknown): PlanSource {
  if (typeof value === "string" && PLAN_SOURCES.has(value as PlanSource)) {
    return value as PlanSource
  }
  return "manual"
}

function normalizePlanExecutionMode(value: unknown): PlanExecutionMode {
  if (typeof value === "string" && PLAN_EXECUTION_MODES.has(value as PlanExecutionMode)) {
    return value as PlanExecutionMode
  }
  throw nonRetryable(`unsupported plan executionMode: ${String(value)}`)
}

function parseGoalConfig(params: {
  config?: Record<string, unknown>
  configJson?: string
}): Partial<GoalConfig> {
  const config =
    params.config && typeof params.config === "object" && !Array.isArray(params.config)
      ? params.config
      : {}
  const raw = typeof params.configJson === "string" ? params.configJson.trim() : ""
  if (!raw) return config as Partial<GoalConfig>
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw nonRetryable(`goal configJson must be valid JSON: ${message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw nonRetryable("goal configJson must decode to an object")
  }
  return { ...config, ...(parsed as Record<string, unknown>) } as Partial<GoalConfig>
}

function parseGoalTemplateConfig(params: {
  configOverrides?: Record<string, unknown>
  configJson?: string
}): Partial<GoalConfig> | undefined {
  const config =
    params.configOverrides &&
    typeof params.configOverrides === "object" &&
    !Array.isArray(params.configOverrides)
      ? params.configOverrides
      : {}
  const raw = typeof params.configJson === "string" ? params.configJson.trim() : ""
  if (!raw) {
    return Object.keys(config).length > 0 ? (config as Partial<GoalConfig>) : undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw nonRetryable(`goal template configJson must be valid JSON: ${message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw nonRetryable("goal template configJson must decode to an object")
  }
  return { ...config, ...(parsed as Record<string, unknown>) } as Partial<GoalConfig>
}

function requireGoalId(ctx: StepExecutionContext, nodeName: string): string {
  const goalId = String((ctx.params as { goalId?: unknown }).goalId ?? "").trim()
  if (!goalId) throw nonRetryable(`${nodeName} requires 'goalId'`)
  return goalId
}

function requireGoalTemplateId(ctx: StepExecutionContext, nodeName: string): string {
  const templateId = String((ctx.params as { templateId?: unknown }).templateId ?? "").trim()
  if (!templateId) throw nonRetryable(`${nodeName} requires 'templateId'`)
  return templateId
}

function requireGoalSessionId(value: unknown, nodeName: string): string {
  const sessionId = String(value ?? "").trim()
  if (!sessionId) throw nonRetryable(`${nodeName} requires 'sessionId'`)
  return sessionId
}

function requirePlanId(ctx: StepExecutionContext, nodeName: string): string {
  const planId = String((ctx.params as { planId?: unknown }).planId ?? "").trim()
  if (!planId) throw nonRetryable(`${nodeName} requires 'planId'`)
  return planId
}

function requireSchedulerTaskId(ctx: StepExecutionContext, nodeName: string): string {
  const taskId = String((ctx.params as { taskId?: unknown }).taskId ?? "").trim()
  if (!taskId) throw nonRetryable(`${nodeName} requires 'taskId'`)
  return taskId
}

function requireSchedulerExecutionId(ctx: StepExecutionContext, nodeName: string): string {
  const executionId = String((ctx.params as { executionId?: unknown }).executionId ?? "").trim()
  if (!executionId) throw nonRetryable(`${nodeName} requires 'executionId'`)
  return executionId
}

function requirePlanSessionId(value: unknown, nodeName: string): string {
  const sessionId = String(value ?? "").trim()
  if (!sessionId) throw nonRetryable(`${nodeName} requires 'sessionId'`)
  return sessionId
}

function clampGoalLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

function clampGoalEventLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 200))
  if (!Number.isFinite(parsed)) return 200
  return Math.max(1, Math.min(5000, parsed))
}

function clampGoalTemplateLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

function clampPlanLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

function clampPlanEventLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 200))
  if (!Number.isFinite(parsed)) return 200
  return Math.max(1, Math.min(5000, parsed))
}

function clampSchedulerTaskLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 500))
  if (!Number.isFinite(parsed)) return 500
  return Math.max(1, Math.min(1000, parsed))
}

function clampSchedulerExecutionLimit(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 200))
  if (!Number.isFinite(parsed)) return 200
  return Math.max(1, Math.min(5000, parsed))
}

function applyGoalLimit(goals: Goal[], limit: number): Goal[] {
  return goals.length > limit ? goals.slice(0, limit) : goals
}

async function goalLifecycleOutput(
  ctx: StepExecutionContext,
  nodeName: string,
  mutate: (goalId: string) => Promise<Goal | null>
) {
  const goalId = requireGoalId(ctx, nodeName)
  const goal = await mutate(goalId)
  return { output: { goalId, goal: toWorkflowGoal(goal) } }
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
 * Compile a custom reducer for `data.aggregate`'s custom op. The body is a JS
 * *expression* returning the next accumulator, with `acc` / `item` / `index`
 * (and read-only `upstream` / `trigger`) in scope — same sandbox shape as
 * `data.code`. Compiled once per run, applied per item.
 */
function compileReducer(
  expression: string
): (acc: unknown, item: unknown, index: number, upstream: unknown, trigger: unknown) => unknown {
  return new Function(
    "acc",
    "item",
    "index",
    "upstream",
    "trigger",
    `"use strict"; return (${expression});`
  ) as (acc: unknown, item: unknown, index: number, upstream: unknown, trigger: unknown) => unknown
}

/** Stable key for value-equality (order-insensitive object keys). */
function stableKey(value: unknown): string {
  const seen = new WeakSet<object>()
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v
    if (seen.has(v as object)) return "[circular]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(norm)
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = norm(obj[k])
    return out
  }
  try {
    return JSON.stringify(norm(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

export type AggregateOperation =
  | "collect"
  | "concat"
  | "merge-objects"
  | "group-by"
  | "dedupe"
  | "numeric"
  | "custom"

export interface AggregateParams {
  operation?: AggregateOperation
  /** group-by / dedupe: per-item key expression (without `{{ }}`). */
  keyExpression?: string
  /** numeric: per-item value expression; empty ⇒ the item itself. */
  numericField?: string
  numericOp?: "sum" | "avg" | "min" | "max" | "count"
  /** custom: reducer expression with `$acc`/`$item`/`$index` in scope. */
  reducerExpression?: string
  /** custom: seed accumulator. */
  initialValue?: unknown
}

/**
 * Core reduce/aggregate over a value array. Shared by `data.aggregate`, the
 * `data.transform` reduce delegation, and `flow.join`'s gather→reduce option.
 */
function aggregateArray(
  arr: unknown[],
  params: AggregateParams,
  ctx: StepExecutionContext
): unknown {
  const operation = params.operation ?? "collect"
  switch (operation) {
    case "collect":
      return [...arr]
    case "concat":
      return arr.flatMap((x) => (Array.isArray(x) ? x : [x]))
    case "merge-objects":
      return arr.reduce<Record<string, unknown>>((acc, x) => {
        if (x && typeof x === "object" && !Array.isArray(x)) {
          return { ...acc, ...(x as Record<string, unknown>) }
        }
        return acc
      }, {})
    case "group-by": {
      const expr = params.keyExpression?.trim() ?? ""
      const out: Record<string, unknown[]> = {}
      for (const item of arr) {
        const key = String(evalItemExpression(expr, item, ctx) ?? "")
        ;(out[key] ??= []).push(item)
      }
      return out
    }
    case "dedupe": {
      const expr = params.keyExpression?.trim() ?? ""
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const item of arr) {
        const key = stableKey(expr ? evalItemExpression(expr, item, ctx) : item)
        if (!seen.has(key)) {
          seen.add(key)
          out.push(item)
        }
      }
      return out
    }
    case "numeric": {
      const op = params.numericOp ?? "sum"
      if (op === "count") return arr.length
      const field = params.numericField?.trim() ?? ""
      const nums = arr
        .map((item) => (field ? evalItemExpression(field, item, ctx) : item))
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      switch (op) {
        case "sum":
          return nums.reduce((a, b) => a + b, 0)
        case "avg":
          return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null
        case "min":
          return nums.length > 0 ? Math.min(...nums) : null
        case "max":
          return nums.length > 0 ? Math.max(...nums) : null
        default:
          return null
      }
    }
    case "custom": {
      const expr = params.reducerExpression?.trim() ?? ""
      if (!expr) return params.initialValue
      let fn: ReturnType<typeof compileReducer>
      try {
        fn = compileReducer(expr)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const wrapped = new Error(
          `data.aggregate custom reducer is not a valid expression: ${message}`
        ) as Error & { retryable?: boolean }
        wrapped.retryable = false
        throw wrapped
      }
      let acc = params.initialValue
      arr.forEach((item, index) => {
        try {
          acc = fn(acc, item, index, ctx.upstream, ctx.trigger)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const wrapped = new Error(`data.aggregate custom reducer failed: ${message}`) as Error & {
            retryable?: boolean
          }
          wrapped.retryable = false
          throw wrapped
        }
      })
      return acc
    }
    default:
      throw new Error(`Unsupported aggregate operation: ${operation}`)
  }
}

/**
 * Resolve the array `data.aggregate` operates on: a single array upstream is
 * used as-is; a single scalar upstream is wrapped; multiple upstreams (a
 * fan-in) are aggregated as the set of their outputs.
 */
function resolveAggregateInput(ctx: StepExecutionContext): unknown[] {
  const values = Object.values(ctx.upstream)
  if (values.length === 0) return []
  if (values.length === 1) {
    const v = values[0]
    return Array.isArray(v) ? v : [v]
  }
  return values
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
