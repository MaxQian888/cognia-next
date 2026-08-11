import { registerNodeExecutor } from "../registry"
import { guardWorkflowEgress } from "@/lib/workflow/runtime/egress-guard"
import { generateTextEmbedding } from "@cognia/provider-embedding/multimodal-embedding"
// ── AI structured-output helpers (shared by ai.prompt / ai.extract) ─────────
// parseStructured / buildJsonInstruction moved to ./ai/structured so the
// ai.prompt v2 module can share them without a circular import.
import { buildJsonInstruction, parseStructured } from "./structured"
import { runStructuredTurn } from "./structured-turn"
import { validateAgainstJsonSchema } from "./schema-validate"
import { coerceToType, nonRetryable } from "../shared/executor-support"

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
      apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
      headers?: Record<string, string>
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
      piiGate?: "off" | "block" | "redact"
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
    const guarded = guardWorkflowEgress({
      securityContext: ctx.securityContext,
      sink: "model",
      requestedMode: params.piiGate,
      value: { systemPrompt, userPrompt },
    })

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
      const withPii = guarded.redacted ? { ...out, piiRedacted: true } : out
      if (!jsonMode) return { output: withPii }
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
          ...withPii,
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
        completion: jsonMode ? "{}" : `[ai.prompt stub] ${guarded.value.userPrompt}`,
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
        const up = fix ? `${guarded.value.userPrompt}\n\n${fix}` : guarded.value.userPrompt
        completion = await client.complete(up, {
          system: guarded.value.systemPrompt,
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
  execute: async (ctx) => (await import("./ai-prompt-v2")).executeAiPromptV2(ctx),
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
  execute: async (ctx) => (await import("./ai-council")).executeAiCouncil(ctx),
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
  execute: async (ctx) => (await import("./ai-ensemble")).executeAiEnsemble(ctx),
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
      apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
      headers?: Record<string, string>
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
    const aiPrompt = (await import("../registry")).getExecutor("ai.prompt", 2)
    if (!aiPrompt) throw new Error("ai.classify: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        apiFlavor: params.apiFlavor,
        headers: params.headers,
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
      apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
      headers?: Record<string, string>
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
    // Lift the REQUIRED field names into a presence-only JSON object schema so
    // the inner v2 turn validates the completion and auto-fixes ONCE when a
    // required field is missing (D3). Deliberately presence-only: this node
    // coerces type hints AFTER parsing (`coerceToType`), so a model returning
    // `"42"` for a number hint is fine — a type-strict schema would burn the
    // retry on completions the coercion already handles. `soft` mode on
    // purpose: this node's own `valid` / `missing` output is the caller-facing
    // contract, so a persistent violation degrades to the legacy best-effort
    // parse instead of failing the step.
    const required = Array.isArray(params.required) ? params.required : []
    const innerOutputSchema =
      required.length > 0
        ? {
            type: "object",
            properties: Object.fromEntries(Object.keys(schema).map((k) => [k, {}])),
            required,
          }
        : undefined
    // Delegate to ai.prompt v2 (see ai.classify above for the rationale).
    const aiPrompt = (await import("../registry")).getExecutor("ai.prompt", 2)
    if (!aiPrompt) throw new Error("ai.extract: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        apiFlavor: params.apiFlavor,
        headers: params.headers,
        systemPrompt,
        userPrompt: input,
        temperature: 0,
        mode: params.mode,
        modelAlias: params.modelAlias,
        piiGate: params.piiGate,
        ...(innerOutputSchema
          ? {
              responseFormat: "json",
              outputSchema: innerOutputSchema,
              onSchemaViolation: "soft",
            }
          : {}),
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
