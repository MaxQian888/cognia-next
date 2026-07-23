/**
 * Routed execution path for `ai.prompt` typeVersion 2 (`mode: "routed"`).
 *
 * Instead of a hardcoded provider+model+apiKey, the node consults the
 * ADR-0043 provider-routing engine (model-alias mappings, strategy, health /
 * circuit / budget signals) and walks the mapping's fallback chain on
 * failure. Every attempt feeds `recordProviderOutcome` so workflow traffic
 * trains the same health metrics, rate window, and daily-cost rollup the
 * chat path uses.
 *
 * All collaborators are injectable for tests; `defaultRoutedPromptDeps()`
 * wires the production singletons lazily so headless runs (no hydrated
 * stores) degrade to priority-order routing instead of crashing.
 */

import type { LlmClient, LlmConfig } from "@/lib/twin/distill/llm"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import type { ProviderOutcome } from "@/lib/claude/provider-telemetry"
import type { CircuitBreakerStateValue } from "@cognia/provider-types/circuit-breaker"
import type { ApiFlavor } from "@cognia/provider-types/provider"

export interface ResolvedCreds {
  protocol: LlmConfig["provider"]
  apiKey?: string
  baseURL?: string
  apiFlavor?: ApiFlavor
}

export interface RoutingSelection {
  providerId: string
  modelId: string
  fallbackEntries: ModelMappingEntry[]
  reason: string
}

export interface RoutedPromptDeps {
  /** Pick primary + fallback chain for the alias/prompt. Null = no route. */
  selectRoute: (input: {
    modelAlias?: string
    promptText: string
    estimatedInputTokens?: number
  }) => Promise<RoutingSelection | null>
  /** Resolve credentials for one provider; null when unusable (no config). */
  resolveCreds: (providerId: string) => Promise<ResolvedCreds | null>
  makeClient: (config: LlmConfig) => LlmClient
  recordOutcome: (outcome: ProviderOutcome) => void
  getCircuitBreakerState: (providerId: string) => CircuitBreakerStateValue
  estimateCostUsd: (input: {
    providerId: string
    modelId: string
    inputTokens: number
    outputTokens: number
  }) => Promise<number | undefined>
  now: () => number
}

export interface RoutedPromptInput {
  modelAlias?: string
  userPrompt: string
  systemPrompt?: string
  temperature?: number
  /** Live token deltas (A3 streaming); forwarded when the client can stream. */
  onDelta?: (delta: string) => void
  log: (level: "info" | "warn", message: string) => void
}

export interface RoutedPromptOutput {
  provider: string
  model: string
  completion: string
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  costUsd?: number
  /** Providers attempted (in order) before one succeeded. */
  attempts: number
  routingReason: string
}

/** Build the production deps. Imported lazily so tests never touch stores. */
export async function defaultRoutedPromptDeps(): Promise<RoutedPromptDeps> {
  const [{ getSettings }, { buildRoutingEngine }, { createLlmClient }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@cognia/provider-routing/build-preview-engine"),
    import("@/lib/twin/distill/llm"),
  ])
  const settings = await getSettings()
  const engine = buildRoutingEngine(settings)
  const { resolveFeatureProvider, createProviderSettingsSnapshot } =
    await import("@/lib/ai/provider-consumption")
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: settings.defaultProvider,
    providerSettings: settings.providerSettings as Parameters<
      typeof createProviderSettingsSnapshot
    >[0]["providerSettings"],
    customProviders: settings.customProviders as Parameters<
      typeof createProviderSettingsSnapshot
    >[0]["customProviders"],
  })
  const { recordProviderOutcome } = await import("@/lib/claude/provider-telemetry")
  const { useCircuitBreakerStore } = await import("@/stores/settings/circuit-breaker-store")
  const { estimateCallCostUsd } = await import("@cognia/provider-core/providers/model-pricing")

  return {
    selectRoute: async ({ modelAlias, promptText, estimatedInputTokens }) => {
      let result
      try {
        result = engine.selectProvider({
          model: modelAlias,
          promptText,
          estimatedInputTokens,
        })
      } catch {
        // RoutingNoCandidatesError: alias matched but every deployment is
        // unavailable — same "no route" outcome for the workflow node.
        return null
      }
      if (!result) return null
      return {
        providerId: result.providerId,
        modelId: result.modelId,
        fallbackEntries: result.fallbackEntries ?? [],
        reason: result.reason,
      }
    },
    resolveCreds: async (providerId) => {
      const resolution = resolveFeatureProvider(
        {
          featureId: "workflow-ai-prompt",
          routeProfile: "general-text",
          selectionMode: "explicit-provider",
          providerId,
          fallbackMode: "none",
        },
        snapshot
      )
      if (resolution.kind !== "resolved") return null
      // Plugin-contributed protocol ids execute only in the sidecar's
      // declarative adapter — the workflow node's renderer client can't run
      // them, so treat the route as creds-unresolved (next candidate tries).
      if (
        !["anthropic", "openai", "azure", "google", "mistral", "cohere"].includes(
          resolution.protocol
        )
      ) {
        return null
      }
      return {
        protocol: resolution.protocol as
          "anthropic" | "openai" | "azure" | "google" | "mistral" | "cohere",
        apiKey: resolution.apiKey,
        baseURL: resolution.baseURL,
        apiFlavor: resolution.apiFlavor,
      }
    },
    makeClient: createLlmClient,
    recordOutcome: recordProviderOutcome,
    getCircuitBreakerState: (id) => useCircuitBreakerStore.getState().getState(id),
    estimateCostUsd: async (input) =>
      estimateCallCostUsd({
        ...input,
        settings: {
          providerSettings: settings.providerSettings,
          customProviders: settings.customProviders,
        },
      }),
    now: () => Date.now(),
  }
}

/**
 * Execute one routed prompt. Throws (with a provider-by-provider summary)
 * only when every resolvable entry in the chain failed — there is no stub
 * fallback on this path.
 */
export async function runRoutedPrompt(
  input: RoutedPromptInput,
  deps: RoutedPromptDeps
): Promise<RoutedPromptOutput> {
  const { estimateCJKTokenCount } = await import("@cognia/rag/cjk-tokenizer")
  const promptText = input.userPrompt
  const route = await deps.selectRoute({
    modelAlias: input.modelAlias,
    promptText,
    estimatedInputTokens: promptText ? estimateCJKTokenCount(promptText) : undefined,
  })
  if (!route) {
    throw nonRetryable(
      `ai.prompt (routed): no provider route found` +
        (input.modelAlias
          ? ` for model alias "${input.modelAlias}". Define a model mapping for it in Settings → Routing.`
          : `. Set a model alias on the node or configure a default routing mapping.`)
    )
  }

  // Resolve credentials for the whole chain up-front and keep only usable
  // entries — a provider with no key must NOT abort the walk (the chain
  // exists precisely to route around it).
  const chain: ModelMappingEntry[] = [
    { providerId: route.providerId, modelId: route.modelId },
    ...route.fallbackEntries.filter(
      (e) => !(e.providerId === route.providerId && e.modelId === route.modelId)
    ),
  ]
  const usable: Array<{ entry: ModelMappingEntry; creds: ResolvedCreds }> = []
  const skipped: string[] = []
  for (const entry of chain) {
    if (deps.getCircuitBreakerState(entry.providerId) === "open") {
      skipped.push(`${entry.providerId} (circuit open)`)
      continue
    }
    const creds = await deps.resolveCreds(entry.providerId)
    if (!creds) {
      skipped.push(`${entry.providerId} (no credentials)`)
      continue
    }
    usable.push({ entry, creds })
  }
  if (skipped.length > 0) {
    input.log("warn", `ai.prompt (routed): skipped ${skipped.join(", ")}`)
  }
  if (usable.length === 0) {
    throw nonRetryable(
      `ai.prompt (routed): no usable provider in the chain ` +
        `[${chain.map((e) => e.providerId).join(" → ")}]. ` +
        `Configure API keys in Settings → Providers.`
    )
  }

  const errors: string[] = []
  for (let i = 0; i < usable.length; i++) {
    const { entry, creds } = usable[i]
    const started = deps.now()
    try {
      const client = deps.makeClient({
        provider: creds.protocol,
        model: entry.modelId,
        apiKey: creds.apiKey ?? "",
        baseURL: creds.baseURL,
        apiFlavor: creds.apiFlavor,
        defaultTemperature: input.temperature,
      })
      const completion = await complete(client, input)
      const usage = client.getUsageSnapshot?.() ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }
      const costUsd = await deps.estimateCostUsd({
        providerId: entry.providerId,
        modelId: entry.modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
      deps.recordOutcome({
        providerId: entry.providerId,
        ok: true,
        latencyMs: deps.now() - started,
        modelId: entry.modelId,
        tokensUsed: usage.totalTokens,
        estimatedCostUsd: costUsd,
      })
      return {
        provider: entry.providerId,
        model: entry.modelId,
        completion,
        usage,
        costUsd,
        attempts: i + 1,
        routingReason: route.reason,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.recordOutcome({
        providerId: entry.providerId,
        ok: false,
        latencyMs: deps.now() - started,
        modelId: entry.modelId,
        errorMessage: message,
      })
      errors.push(`${entry.providerId}:${entry.modelId} → ${message}`)
      if (i < usable.length - 1) {
        input.log("warn", `ai.prompt (routed): ${entry.providerId} failed, trying next provider`)
      }
    }
  }

  throw new Error(`ai.prompt (routed): all providers failed.\n${errors.join("\n")}`)
}

/** Stream when both sides support it; fall back to one-shot complete(). */
async function complete(client: LlmClient, input: RoutedPromptInput): Promise<string> {
  const options = { system: input.systemPrompt, temperature: input.temperature }
  if (input.onDelta && client.stream) {
    let full = ""
    for await (const delta of client.stream(input.userPrompt, options)) {
      full += delta
      input.onDelta(delta)
    }
    return full
  }
  return client.complete(input.userPrompt, options)
}

function nonRetryable(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { retryable: boolean }).retryable = false
  return err
}
