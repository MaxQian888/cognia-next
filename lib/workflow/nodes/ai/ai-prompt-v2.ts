/**
 * `ai.prompt` typeVersion 2 — the full executor logic, kept out of
 * built-ins.ts so it's independently testable.
 *
 * v2 over v1:
 *   - `mode: "routed"` consults the ADR-0043 provider-routing engine
 *     (alias mappings + fallback chains) instead of hardcoded credentials.
 *   - `piiGate` ("off" | "block" | "redact") runs before any text egress.
 *   - Streams deltas through `ctx.emitStream` (live output in the run UI).
 *   - Reports token/cost usage through `ctx.reportUsage` (`step_usage`).
 *
 * Structured output (D3) matches v1 exactly: when JSON mode declares an
 * `outputSchema`, the completion is validated against it with ONE bounded
 * auto-fix retry (`runStructuredTurn`), and `onSchemaViolation` decides
 * whether a persistent violation throws (`fail`, default — feeds the node's
 * errorPolicy machinery) or rides the output as `schemaValid: false`
 * (`soft`). The legacy `jsonSchema` string param stays a shape HINT only.
 * `ai.classify` / `ai.extract` delegate here and inherit the contract.
 *
 * Explicit mode keeps v1's deliberate echo-stub when credentials are
 * missing (so half-configured workflows still run end-to-end); routed mode
 * has NO stub — a missing route or missing keys is a hard, descriptive error.
 * The stub never enforces the schema (there is no model to auto-fix).
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { ApiFlavor } from "@cognia/provider-types/provider"
import type { PiiGateMode } from "./pii-gate"
import { guardWorkflowEgress } from "@/lib/workflow/runtime/egress-guard"
import { buildJsonInstruction, parseStructured } from "./structured"
import { runStructuredTurn, type SchemaViolationMode } from "./structured-turn"
import { validateAgainstJsonSchema } from "./schema-validate"

export interface AiPromptV2Params {
  mode?: "explicit" | "routed"
  /** Routed mode: the model alias resolved through the mapping registry. */
  modelAlias?: string
  /** Explicit mode: direct provider/model/credentials (v1 contract). */
  provider?: string
  model?: string
  apiKey?: string
  baseURL?: string
  apiFlavor?: ApiFlavor
  headers?: Record<string, string>
  systemPrompt?: string
  /**
   * Optional twin-bound character. When set and the character has a `twinId`,
   * the twin's retrieved context is injected into the system prompt (shared
   * `injectTwinContext` helper). Absent → no twin grounding, unchanged behavior.
   */
  characterId?: string
  userPrompt?: string
  temperature?: number
  responseFormat?: "text" | "json"
  /** Legacy JSON shape HINT (string) — never validated. */
  jsonSchema?: string
  /**
   * JSON object schema the JSON-mode output must satisfy (D3). When set on a
   * real (non-stub) call, the completion is validated and auto-fixed once;
   * `schemaValid` / `schemaErrors` ride the output.
   */
  outputSchema?: Record<string, unknown>
  /** `fail` (default) throws on violation; `soft` keeps the unvalidated value. */
  onSchemaViolation?: SchemaViolationMode
  piiGate?: PiiGateMode
}

interface PromptOutcome {
  provider?: string
  model?: string
  completion: string
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  stub: boolean
  costUsd?: number
  attempts?: number
  routingReason?: string
}

export async function executeAiPromptV2(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as AiPromptV2Params
  const jsonMode = params.responseFormat === "json"
  const outputSchema = params.outputSchema
  const enforceSchema = jsonMode && !!outputSchema && Object.keys(outputSchema).length > 0
  // A declared output schema doubles as the JSON shape hint (v1 parity);
  // otherwise the legacy `jsonSchema` string hint applies.
  const schemaHint = enforceSchema ? JSON.stringify(outputSchema, null, 2) : params.jsonSchema
  const baseSystem = jsonMode
    ? [params.systemPrompt, buildJsonInstruction(schemaHint)].filter(Boolean).join("\n\n")
    : params.systemPrompt

  let outboundSystem = baseSystem
  const outboundUser = params.userPrompt ?? ""

  // Twin grounding: when the node targets a twin-bound character, wrap the
  // system prompt with retrieved context via the shared injector. The final
  // assembled prompt is gated below, so locally-derived twin material cannot
  // bypass the workflow egress boundary.
  if (typeof params.characterId === "string" && params.characterId.trim()) {
    const { injectTwinContext } = await import("../shared/twin-injector")
    const injected = await injectTwinContext({
      characterId: params.characterId,
      userPrompt: outboundUser,
      baseSystemPrompt: outboundSystem,
      source: "workflow:ai.prompt",
    })
    // MERGE, don't replace: the injector's returned prompt is the twin's own
    // assembly (built from `character.systemPrompt`) and does NOT carry the
    // node's `systemPrompt` or the JSON-mode instruction baked into `baseSystem`.
    // Keep the twin context first and the node base last so the JSON instruction
    // retains its emphasis-last position.
    if (injected.applied) {
      outboundSystem = [injected.systemPrompt, outboundSystem].filter(Boolean).join("\n\n")
    }
  }

  // Gate the complete model payload after every local enrichment. "block"
  // throws a non-retryable error; "redact" swaps prompts in place.
  const guarded = guardWorkflowEgress({
    securityContext: ctx.securityContext,
    sink: "model",
    requestedMode: params.piiGate,
    value: { system: outboundSystem, user: outboundUser },
  })
  const gated = { ...guarded.value, redacted: guarded.redacted }

  // Shared tail: attach `structured` / `parseError` in JSON mode, plus the
  // soft `schemaValid` / `schemaErrors` stamp when a schema is enforced —
  // identical to v1's finalize so the two versions' outputs stay
  // shape-compatible for downstream expressions.
  const finalize = (out: PromptOutcome): StepExecutionResult => {
    const withPii = gated.redacted ? { ...out, piiRedacted: true } : out
    if (!jsonMode) return { output: withPii }
    const parsed = parseStructured(out.completion)
    const schemaFields =
      enforceSchema && !parsed.error
        ? (() => {
            const v = validateAgainstJsonSchema(outputSchema!, parsed.value)
            return v.ok ? { schemaValid: true } : { schemaValid: false, schemaErrors: v.errors }
          })()
        : enforceSchema
          ? { schemaValid: false }
          : {}
    return {
      output: {
        ...withPii,
        structured: parsed.value,
        ...(parsed.error ? { parseError: parsed.error } : {}),
        ...schemaFields,
      },
    }
  }

  /**
   * Drive one-or-two model calls through the typed-output contract. `callOnce`
   * owns the actual model invocation (routed or explicit); the auto-fix retry
   * appends the corrective re-prompt to the user prompt — same placement as
   * v1. Returns the LAST outcome (the retry's completion when one happened);
   * `runStructuredTurn` throws in `fail` mode when the schema still fails.
   */
  const runWithSchema = async (
    callOnce: (fixInstruction?: string) => Promise<PromptOutcome>
  ): Promise<PromptOutcome> => {
    if (!enforceSchema) return callOnce()
    let last: PromptOutcome | undefined
    await runStructuredTurn({
      outputSchema: outputSchema!,
      onSchemaViolation: params.onSchemaViolation,
      runOnce: async (fix) => {
        last = await callOnce(fix)
        const parsed = parseStructured(last.completion)
        return parsed.error
          ? { object: parsed.value, parseError: parsed.error }
          : { object: parsed.value }
      },
    })
    // runStructuredTurn always invoked runOnce at least once.
    return last!
  }

  const withFix = (user: string, fix?: string): string => (fix ? `${user}\n\n${fix}` : user)

  const { startSpan, endSpan } = await import("@cognia/agent-trace/emitter")
  const span = startSpan({
    operationName: "chat",
    providerName: "cognia.workflow",
    surface: "workflow",
    sessionId: ctx.runId,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    ...(params.model || params.modelAlias
      ? { requestModel: params.model ?? params.modelAlias }
      : {}),
  })
  const finishSpan = (out: PromptOutcome) => {
    endSpan(span.spanId, {
      usage: {
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        cacheReadTokens: out.usage.cacheReadTokens ?? 0,
        cacheCreationTokens: out.usage.cacheCreationTokens ?? 0,
      },
      ...(out.model ? { responseModel: out.model } : {}),
      outputPreview: out.completion.slice(0, 200),
    })
  }
  const failSpan = (err: unknown) => {
    endSpan(span.spanId, {
      errorType: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  }

  if (params.mode === "routed") {
    const { runRoutedPrompt, defaultRoutedPromptDeps } = await import("./ai-prompt-routed")
    const deps = await defaultRoutedPromptDeps()
    // Sum usage/cost across the auto-fix retry so `step_usage` reflects what
    // the node actually spent, not just the last call.
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let totalCostUsd: number | undefined
    const callOnce = async (fix?: string): Promise<PromptOutcome> => {
      const result = await runRoutedPrompt(
        {
          modelAlias: params.modelAlias,
          userPrompt: withFix(gated.user, fix),
          systemPrompt: gated.system,
          temperature: params.temperature,
          onDelta: ctx.emitStream,
          log: (level, message) => ctx.log(level, message),
        },
        deps
      )
      totals.inputTokens += result.usage.inputTokens
      totals.outputTokens += result.usage.outputTokens
      totals.totalTokens += result.usage.totalTokens
      if (typeof result.costUsd === "number") {
        totalCostUsd = (totalCostUsd ?? 0) + result.costUsd
      }
      return {
        provider: result.provider,
        model: result.model,
        completion: result.completion,
        usage: result.usage,
        stub: false,
        costUsd: result.costUsd,
        attempts: result.attempts,
        routingReason: result.routingReason,
      }
    }
    try {
      const out = await runWithSchema(callOnce)
      finishSpan({ ...out, usage: { ...out.usage, ...totals } })
      ctx.reportUsage?.({
        ...totals,
        providerId: out.provider,
        modelId: out.model,
        costUsd: totalCostUsd,
      })
      return finalize(out)
    } catch (err) {
      failSpan(err)
      throw err
    }
  }

  // ── explicit mode (v1 contract + streaming + usage reporting) ────────────
  const apiKey =
    params.apiKey ??
    (await ctx.resolveSecret(
      ctx.params.credentialRefs && typeof ctx.params.credentialRefs === "object"
        ? ((ctx.params.credentialRefs as Record<string, string>).apiKey ?? "")
        : ""
    ))

  if (!params.provider || !params.model || !apiKey) {
    ctx.log(
      "warn",
      "ai.prompt: provider / model / apiKey missing — using stub echo. " +
        "Configure them on the node (or switch to routed mode) for a real LLM call."
    )
    return finalize({
      provider: params.provider,
      model: params.model,
      completion: jsonMode ? "{}" : `[ai.prompt stub] ${gated.user}`,
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
    apiFlavor: params.apiFlavor,
    headers: params.headers,
    defaultTemperature: params.temperature,
  })

  const callOnce = async (fix?: string): Promise<PromptOutcome> => {
    const user = withFix(gated.user, fix)
    const options = {
      system: gated.system,
      temperature: params.temperature,
      abortSignal: ctx.signal,
    }
    let completion: string
    if (ctx.emitStream && client.stream) {
      completion = ""
      for await (const delta of client.stream(user, options)) {
        completion += delta
        ctx.emitStream(delta)
      }
    } else {
      completion = await client.complete(user, options)
    }
    return {
      provider: params.provider,
      model: params.model,
      completion,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      stub: false,
    }
  }

  let out: PromptOutcome
  try {
    out = await runWithSchema(callOnce)
  } catch (err) {
    failSpan(err)
    throw err
  }

  // Snapshot ONCE after the (possibly retried) turn — the client accumulates
  // usage across calls, so this is the true total for the step.
  const usage = client.getUsageSnapshot?.() ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
  const { estimateCallCostUsd } = await import("@cognia/provider-core/providers/model-pricing")
  const costUsd = estimateCallCostUsd({
    providerId: params.provider,
    modelId: params.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })
  out = { ...out, usage, costUsd }
  finishSpan(out)
  ctx.reportUsage?.({
    ...usage,
    providerId: params.provider,
    modelId: params.model,
    costUsd,
  })
  return finalize(out)
}
