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
 * Explicit mode keeps v1's deliberate echo-stub when credentials are
 * missing (so half-configured workflows still run end-to-end); routed mode
 * has NO stub — a missing route or missing keys is a hard, descriptive error.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { applyPiiGate, type PiiGateMode } from "./pii-gate"
import { buildJsonInstruction, parseStructured } from "./structured"

export interface AiPromptV2Params {
  mode?: "explicit" | "routed"
  /** Routed mode: the model alias resolved through the mapping registry. */
  modelAlias?: string
  /** Explicit mode: direct provider/model/credentials (v1 contract). */
  provider?: string
  model?: string
  apiKey?: string
  baseURL?: string
  systemPrompt?: string
  userPrompt?: string
  temperature?: number
  responseFormat?: "text" | "json"
  jsonSchema?: string
  piiGate?: PiiGateMode
}

interface PromptOutcome {
  provider?: string
  model?: string
  completion: string
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  stub: boolean
  costUsd?: number
  attempts?: number
  routingReason?: string
}

export async function executeAiPromptV2(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as AiPromptV2Params
  const jsonMode = params.responseFormat === "json"
  const baseSystem = jsonMode
    ? [params.systemPrompt, buildJsonInstruction(params.jsonSchema)].filter(Boolean).join("\n\n")
    : params.systemPrompt

  // PII gate FIRST — nothing leaves the machine before it ran. "block"
  // throws a non-retryable error; "redact" swaps prompts in place.
  const gated = applyPiiGate(params.piiGate, {
    system: baseSystem,
    user: params.userPrompt ?? "",
  })

  const finalize = (out: PromptOutcome): StepExecutionResult => {
    const withPii = gated.redacted ? { ...out, piiRedacted: true } : out
    if (!jsonMode) return { output: withPii }
    const parsed = parseStructured(out.completion)
    return {
      output: {
        ...withPii,
        structured: parsed.value,
        ...(parsed.error ? { parseError: parsed.error } : {}),
      },
    }
  }

  const { startSpan, endSpan } = await import("@/lib/agent-trace/emitter")
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
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
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
    try {
      const result = await runRoutedPrompt(
        {
          modelAlias: params.modelAlias,
          userPrompt: gated.user,
          systemPrompt: gated.system,
          temperature: params.temperature,
          onDelta: ctx.emitStream,
          log: (level, message) => ctx.log(level, message),
        },
        await defaultRoutedPromptDeps()
      )
      const out: PromptOutcome = {
        provider: result.provider,
        model: result.model,
        completion: result.completion,
        usage: result.usage,
        stub: false,
        costUsd: result.costUsd,
        attempts: result.attempts,
        routingReason: result.routingReason,
      }
      finishSpan(out)
      ctx.reportUsage?.({
        ...result.usage,
        providerId: result.provider,
        modelId: result.model,
        costUsd: result.costUsd,
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
    defaultTemperature: params.temperature,
  })

  let completion: string
  try {
    const options = {
      system: gated.system,
      temperature: params.temperature,
      abortSignal: ctx.signal,
    }
    if (ctx.emitStream && client.stream) {
      completion = ""
      for await (const delta of client.stream(gated.user, options)) {
        completion += delta
        ctx.emitStream(delta)
      }
    } else {
      completion = await client.complete(gated.user, options)
    }
  } catch (err) {
    failSpan(err)
    throw err
  }

  const usage = client.getUsageSnapshot?.() ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
  const { estimateCallCostUsd } = await import("@/lib/ai/providers/model-pricing")
  const costUsd = estimateCallCostUsd({
    providerId: params.provider,
    modelId: params.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })
  const out: PromptOutcome = {
    provider: params.provider,
    model: params.model,
    completion,
    usage,
    stub: false,
    costUsd,
  }
  finishSpan(out)
  ctx.reportUsage?.({
    ...usage,
    providerId: params.provider,
    modelId: params.model,
    costUsd,
  })
  return finalize(out)
}
