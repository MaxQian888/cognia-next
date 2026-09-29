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
 *
 * Every attempt is ledgered (ADR-0188 D27): the production `makeClient` wraps
 * each candidate's client with `ledgerUtilityCalls`, so each attempt — the
 * primary and every fallback — is its own reservation, sent with no hidden SDK
 * retries and settled from its own usage. The caller names the surface: a
 * workflow node or an Agent feature is `agentsWorkflows`, the `/council` slash
 * command is `utilityLedger`. Off — the default — the client is returned as it
 * was built. A candidate the ledger refuses (its data class, its budget) is
 * skipped like one with no credentials: nothing was sent, and it says nothing
 * about the provider's health.
 */

import type { LlmClient, LlmConfig } from "@/lib/twin/distill/llm"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import type { ProviderOutcome } from "@/lib/claude/provider-telemetry"
import type { CircuitBreakerStateValue } from "@cognia/provider-types/circuit-breaker"
import type { ApiFlavor } from "@cognia/provider-types/provider"
import type { RoutingPlan, RoutingSurface } from "@cognia/provider-types/auto-router"
import { RoutingAttemptController } from "@cognia/provider-routing/routing-attempt-controller"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"
import { isRefusal, type RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import type { UtilityRunOrigin } from "@/lib/router-fusion/gate/utility-ledger"
import type { StepExecutionContext } from "@/types/workflow/visual"

export interface ResolvedCreds {
  protocol: LlmConfig["provider"]
  apiKey?: string
  baseURL?: string
  apiFlavor?: ApiFlavor
}

export type RoutingSelection = RoutingPlan

export interface RoutedPromptDeps {
  /** Pick primary + fallback chain for the alias/prompt. Null = no route. */
  selectRoute: (input: {
    modelAlias?: string
    promptText: string
    estimatedInputTokens?: number
  }) => Promise<RoutingSelection | null>
  /** Resolve credentials for one provider; null when unusable (no config). */
  resolveCreds: (providerId: string) => Promise<ResolvedCreds | null>
  /**
   * Build the client for one attempt. `deployment` is the app's own provider
   * id and model (the config carries only the SDK protocol), which is what the
   * ledger prices and polices.
   */
  makeClient: (config: LlmConfig, deployment: { providerId: string; modelId: string }) => LlmClient
  recordOutcome: (outcome: ProviderOutcome) => void
  getCircuitBreakerState: (providerId: string) => CircuitBreakerStateValue
  estimateCostUsd: (input: {
    providerId: string
    modelId: string
    inputTokens: number
    outputTokens: number
  }) => Promise<number | undefined>
  now: () => number
  maxFallbackAttempts?: number
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

/** Who a routed prompt's ledgered attempts belong to (ADR-0188 D27, D30). */
export interface RoutedPromptLedger {
  surface: Extract<RouterFusionSurface, "utilityLedger" | "agentsWorkflows">
  origin: UtilityRunOrigin
  /** Stable id of the feature, e.g. `workflow:<stepId>` or `slash-council`. */
  featureId: string
  /** Workspace whose data the prompt carries, for the data-class policy. */
  workspaceId: string | null
}

/**
 * The ledger binding every workflow AI node uses: its calls are Agent/workflow
 * work (`agentsWorkflows`), booked per step, in the workflow's own workspace —
 * the same binding `ai.prompt` v1 gives its client.
 */
export function workflowNodeLedger(
  ctx: Pick<StepExecutionContext, "stepId" | "projectId">
): RoutedPromptLedger {
  return {
    surface: "agentsWorkflows",
    origin: "workflow",
    featureId: `workflow:${ctx.stepId}`,
    workspaceId: ctx.projectId ?? null,
  }
}

export interface DefaultRoutedPromptDepsOptions {
  /** The ADR-0043 routing surface the plans are made for. Defaults to `workflow`. */
  routingSurface?: RoutingSurface
  ledger: RoutedPromptLedger
}

/** Build the production deps. Imported lazily so tests never touch stores. */
export async function defaultRoutedPromptDeps(
  options: DefaultRoutedPromptDepsOptions
): Promise<RoutedPromptDeps> {
  const surface = options.routingSurface ?? "workflow"
  const [{ getSettings }, { buildRoutingEngine }, { createLlmClient }, { ledgerUtilityCalls }] =
    await Promise.all([
      import("@/lib/db/settings"),
      import("@cognia/provider-routing/build-preview-engine"),
      import("@/lib/twin/distill/llm"),
      import("@/lib/router-fusion/gate/utility-ledger"),
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
        result = await engine.planRoute({
          surface,
          selection: modelAlias ? { kind: "alias", alias: modelAlias } : { kind: "auto" },
          promptText,
          estimatedInputTokens,
          taskHints: {
            // A routed prompt node is a single-turn, tool-less completion —
            // 0/1 are honest signals here, not omissions.
            hasCode: /```/.test(promptText ?? ""),
            toolCount: 0,
            messageCount: 1,
          },
          candidateAliases: settings.autoRouting?.candidateAliases,
          thresholds: settings.autoRouting?.thresholds,
          strategy: settings.routingConfig?.strategy,
          dataPolicy: settings.autoRouting?.dataPolicy,
          shadowMode: settings.autoRouting?.shadowMode,
        })
      } catch {
        // RoutingNoCandidatesError: alias matched but every deployment is
        // unavailable — same "no route" outcome for the workflow node.
        return null
      }
      if (!result) return null
      return result
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
    // One ledgered client per attempt: each attempt is its own reservation.
    // `settings` is the row this function just read, on either host.
    makeClient: (config, deployment) =>
      ledgerUtilityCalls(createLlmClient(config), {
        binding: {
          ...options.ledger,
          providerId: deployment.providerId,
          modelId: deployment.modelId,
        },
        settings,
      }),
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
    maxFallbackAttempts: settings.routingConfig?.maxFallbackAttempts ?? 3,
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

  const chain: ModelMappingEntry[] = route.orderedCandidates
  const controller = new RoutingAttemptController(route, deps.maxFallbackAttempts ?? 3, deps.now)
  const skipped: string[] = []
  const errors: string[] = []
  const refusals: RouterFusionRefusalError[] = []
  let attempts = 0
  let entry = controller.begin()
  while (entry) {
    if (deps.getCircuitBreakerState(entry.providerId) === "open") {
      skipped.push(`${entry.providerId} (circuit open)`)
      entry = controller.failAndAdvance()
      continue
    }
    const creds = await deps.resolveCreds(entry.providerId)
    if (!creds) {
      skipped.push(`${entry.providerId} (no credentials)`)
      entry = controller.failAndAdvance()
      continue
    }
    attempts++
    const started = deps.now()
    try {
      const client = deps.makeClient(
        {
          provider: creds.protocol,
          model: entry.modelId,
          apiKey: creds.apiKey ?? "",
          baseURL: creds.baseURL,
          apiFlavor: creds.apiFlavor,
          defaultTemperature: input.temperature,
        },
        { providerId: entry.providerId, modelId: entry.modelId }
      )
      const completion = await complete(client, input, () => controller.commit())
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
      controller.complete()
      if (skipped.length > 0) {
        input.log("warn", `ai.prompt (routed): skipped ${skipped.join(", ")}`)
      }
      return {
        provider: entry.providerId,
        model: entry.modelId,
        completion,
        usage,
        costUsd,
        attempts,
        routingReason: route.reasonCodes.join(", "),
      }
    } catch (err) {
      if (isRefusal(err)) {
        // The ledger refused before anything was sent: not an attempt, and not
        // a provider failure the health metrics should learn from.
        attempts--
        refusals.push(err)
        skipped.push(`${entry.providerId} (refused by Router + Fusion: ${err.code})`)
        entry = controller.failAndAdvance()
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      deps.recordOutcome({
        providerId: entry.providerId,
        ok: false,
        latencyMs: deps.now() - started,
        modelId: entry.modelId,
        errorMessage: message,
      })
      errors.push(`${entry.providerId}:${entry.modelId} → ${message}`)
      const next = controller.failAndAdvance()
      if (next) {
        input.log("warn", `ai.prompt (routed): ${entry.providerId} failed, trying next provider`)
      }
      entry = next
    }
  }

  if (skipped.length > 0) {
    input.log("warn", `ai.prompt (routed): skipped ${skipped.join(", ")}`)
  }
  if (attempts === 0 && refusals.length > 0) {
    // Every candidate that could run was refused: the refusal is the answer,
    // and retrying the step would be refused again.
    const [refusal] = refusals
    ;(refusal as RouterFusionRefusalError & { retryable?: boolean }).retryable = false
    throw refusal
  }
  if (attempts === 0) {
    throw nonRetryable(
      `ai.prompt (routed): no usable provider in the chain ` +
        `[${chain.map((candidate) => candidate.providerId).join(" → ")}]. ` +
        `Configure API keys in Settings → Providers.`
    )
  }
  throw new Error(`ai.prompt (routed): all providers failed.\n${errors.join("\n")}`)
}

/** Stream when both sides support it; fall back to one-shot complete(). */
async function complete(
  client: LlmClient,
  input: RoutedPromptInput,
  onCommit: () => void
): Promise<string> {
  const options = { system: input.systemPrompt, temperature: input.temperature }
  if (input.onDelta && client.stream) {
    let full = ""
    for await (const delta of client.stream(input.userPrompt, options)) {
      onCommit()
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
