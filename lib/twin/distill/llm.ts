/**
 * LLM client abstraction for the distill sub-agents.
 *
 * Each sub-agent (Style / Playbook / Knowledge / Synthesizer / Evaluator)
 * needs to ask Claude (or compatible) for structured JSON output. This
 * module wraps that into a single `LlmClient` interface so:
 *
 *   1. Tests inject deterministic mocks without touching the network.
 *   2. The orchestrator never sees provider-specific SDK calls.
 *   3. Future swap-in of `generateObject` from `ai` is one file's worth of
 *      change — current callers keep their contract.
 *
 * Phase 5 only ships the contract + a JSON-mode helper. Wiring it to a
 * real provider lives behind a default factory so the workbench can pass
 * its own configured client.
 */

import { generateText, streamText, type LanguageModel } from "ai"
import type { ApiFlavor, ProviderName } from "@cognia/provider-types/provider"
import { getBuiltInProviderDefaultBaseURL } from "@cognia/provider-types/built-in-provider-catalog"
import {
  normalizeProtocol,
  resolveProviderProtocol,
  decideOpenAiEndpointFlavor,
} from "../../../sidecar/dispatch/protocol-adapters/provider-protocol.mjs"

export interface LlmClientCallOptions {
  /** System / role-priming prompt. Defaults to a generic distiller voice. */
  system?: string
  /** Maximum tokens in the response. */
  maxTokens?: number
  /** Sampling temperature. Defaults to 0 for distill calls. */
  temperature?: number
  /** Stop sequences passed verbatim to the provider. */
  stopSequences?: string[]
  /** Abort the in-flight call (forwarded to the AI SDK). */
  abortSignal?: AbortSignal
}

/**
 * Cumulative token-usage snapshot maintained by `createLlmClient`.
 *
 * The orchestrator reads this after the run via `getUsageSnapshot()` so
 * we can persist a single `llmTokensUsed` figure on the parent
 * `twinJobs` row. Mocks may omit `getUsageSnapshot` — callers must guard.
 */
export interface LlmUsageSnapshot {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /**
   * Prompt-cache READ tokens (billed at a discount). Optional so existing
   * `{ inputTokens, outputTokens, totalTokens }` literals stay valid; absent
   * means "provider reported none". Additive to `inputTokens`, matching the
   * sidecar convention in `sidecar/dispatch/event-adapter.mjs`.
   */
  cacheReadTokens?: number
  /** Prompt-cache WRITE/creation tokens (billed at a premium). */
  cacheCreationTokens?: number
}

/** Normalized token delta pulled from one AI SDK result. */
export interface UsageDelta {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/**
 * Normalize one AI SDK `result.usage` (+ `result.providerMetadata`) into our
 * additive token convention — the same one `sidecar/dispatch/event-adapter.mjs`
 * uses so workflow/distill costs reconcile with the chat path:
 *   • input/output taken as reported (no subtraction),
 *   • cache-read from AI SDK v6 `cachedInputTokens` (+ openai/deepseek aliases),
 *   • cache-write from Anthropic `providerMetadata.anthropic.cacheCreationInputTokens`.
 * Every field coalesces to 0; never throws.
 */
export function readUsageDelta(
  usage: Record<string, unknown> | undefined,
  providerMetadata?: Record<string, unknown>
): UsageDelta {
  const n = (v: unknown) => {
    const num = Number(v)
    return Number.isFinite(num) ? num : 0
  }
  const anthropic = providerMetadata?.anthropic as Record<string, unknown> | undefined
  return {
    inputTokens: n(usage?.inputTokens ?? usage?.promptTokens),
    outputTokens: n(usage?.outputTokens ?? usage?.completionTokens),
    cacheReadTokens: n(
      usage?.cachedInputTokens ?? usage?.cacheReadInputTokens ?? usage?.promptCacheHitTokens
    ),
    cacheCreationTokens: n(anthropic?.cacheCreationInputTokens ?? usage?.cacheCreationInputTokens),
  }
}

export interface LlmClient {
  /**
   * Ask the LLM with a free-form prompt; return the raw text response.
   * The agent layer is responsible for parsing JSON out of the response —
   * doing the parse here would force the same JSON-extract logic on every
   * caller.
   */
  complete(prompt: string, options?: LlmClientCallOptions): Promise<string>
  /**
   * Streaming variant — yields text deltas as the provider produces them.
   * Usage accumulates into the same snapshot once the stream settles.
   * Optional so existing mocks stay valid; production clients implement it.
   */
  stream?(prompt: string, options?: LlmClientCallOptions): AsyncIterable<string>
  /**
   * Cumulative tokens consumed by this client since construction. Optional
   * so test mocks can ignore it; production clients (`createLlmClient`)
   * always implement it.
   */
  getUsageSnapshot?(): LlmUsageSnapshot
  /**
   * Which provider/model this client actually resolved to.
   *
   * Optional so mocks stay valid. Present on production clients so a caller that
   * persists model-derived output (memory's `Memory.extractor`) can record what
   * produced it — without that, output from a prompt or model later found to be
   * bad is indistinguishable from good rows and cannot be re-derived in bulk.
   */
  readonly provider?: string
  readonly model?: string
}

/**
 * Configuration for any provider-aware LLM client. The `provider` field
 * picks which AI SDK family is loaded; built-ins are anthropic, openai,
 * google, mistral, cohere. Custom OpenAI-compatible endpoints set
 * `provider: "openai"` and pass `baseURL`.
 */
export interface LlmConfig {
  provider: ProviderName | "openai" | "google" | "mistral" | "cohere"
  model: string
  apiKey: string
  baseURL?: string
  /** Extra provider headers, e.g. Codex ChatGPT-login account/originator headers. */
  headers?: Record<string, string>
  /** OpenAI endpoint family override. Omitted/"auto" falls back to shared host/id heuristic. */
  apiFlavor?: ApiFlavor
  defaultMaxTokens?: number
  defaultTemperature?: number
}

/** @deprecated Kept for back-compat with existing call sites. Use {@link LlmConfig}. */
export type AnthropicLlmConfig = LlmConfig

function buildProviderSettings(
  config: LlmConfig,
  // Catalog `defaultBaseURL`s are OpenAI-compat endpoints (e.g. Cohere's
  // `/compatibility/v1`); they must never reach a native @ai-sdk/* client,
  // so only the OpenAI-family branches opt into the catalog fallback.
  opts?: { catalogBaseURLFallback?: boolean }
): {
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
} {
  const baseURL =
    config.baseURL ??
    (opts?.catalogBaseURLFallback
      ? getBuiltInProviderDefaultBaseURL(config.provider as string)
      : undefined)
  return {
    apiKey: config.apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
  }
}

function selectOpenAiFamilyModel(
  client: unknown,
  config: LlmConfig,
  providerId: string
): LanguageModel {
  // @ai-sdk/openai v3's bare `client(model)` is the Responses API. Use the
  // shared sidecar/renderer decision so compatible gateways stay on Chat while
  // genuine OpenAI, Codex, and explicit opt-ins use Responses.
  const handle = client as {
    chat?: (model: string) => LanguageModel
    responses?: (model: string) => LanguageModel
  }
  const flavor = decideOpenAiEndpointFlavor({
    apiFlavor: config.apiFlavor,
    baseURL: config.baseURL ?? getBuiltInProviderDefaultBaseURL(providerId),
    providerId,
  })
  if (flavor === "responses" && typeof handle.responses === "function") {
    return handle.responses(config.model)
  }
  if (typeof handle.chat === "function") return handle.chat(config.model)
  throw new Error(`createLlmClient: OpenAI client for "${providerId}" has no model entrypoint`)
}

async function buildLanguageModel(config: LlmConfig): Promise<LanguageModel> {
  const providerId = config.provider as string
  const protocol = normalizeProtocol(resolveProviderProtocol(providerId) ?? providerId)

  switch (protocol) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      const client = createAnthropic(buildProviderSettings(config))
      return client(config.model)
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const client = createOpenAI(buildProviderSettings(config, { catalogBaseURLFallback: true }))
      return selectOpenAiFamilyModel(client, config, providerId)
    }
    case "azure": {
      const { createAzure } = await import("@ai-sdk/azure")
      const client = createAzure(buildProviderSettings(config))
      return selectOpenAiFamilyModel(client, config, "azure")
    }
    case "google": {
      const { createGoogle } = await import("@ai-sdk/google")
      const client = createGoogle(buildProviderSettings(config))
      return client(config.model)
    }
    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral")
      const client = createMistral(buildProviderSettings(config))
      return client(config.model)
    }
    case "cohere": {
      const { createCohere } = await import("@ai-sdk/cohere")
      const client = createCohere(buildProviderSettings(config))
      return client(config.model)
    }
    default:
      throw new Error(
        `createLlmClient: unsupported provider "${config.provider}" — supported: anthropic, openai (+ OpenAI-compatible gateways), azure, google, mistral, cohere`
      )
  }
}

/**
 * Build an `LlmClient` that talks to the configured provider via the `ai`
 * SDK. Each provider's underlying client is loaded lazily so the twin
 * worker doesn't pay the cost for SDKs it never uses.
 */
/**
 * Build a raw ai-sdk `LanguageModel` handle from the twin's distill LLM config.
 * Exposes the same `buildLanguageModel` that `createLlmClient` uses internally,
 * for the `@cognia/rag` query-expansion stages (HyDE / step-back) which take an
 * ai-sdk `LanguageModel` directly rather than the `LlmClient` façade.
 */
export function createTwinLanguageModel(config: LlmConfig): Promise<LanguageModel> {
  return buildLanguageModel(config)
}

export function createLlmClient(config: LlmConfig): LlmClient {
  // The model handle is built on first use so import failures surface at
  // `complete()` time (where the workbench can show a meaningful error)
  // rather than at module load.
  let modelPromise: Promise<LanguageModel> | null = null
  const getModel = () => {
    if (!modelPromise) modelPromise = buildLanguageModel(config)
    return modelPromise
  }

  // Cumulative usage snapshot; updated after every `complete()` call.
  // Provider responses sometimes omit usage (rare on Anthropic, more common
  // on locally-hosted OpenAI-compatible endpoints) — we coalesce missing
  // values to 0 rather than NaN-poisoning the running total.
  const usage: LlmUsageSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }

  const addUsage = (
    u: Record<string, unknown> | undefined,
    providerMetadata?: Record<string, unknown>
  ) => {
    const d = readUsageDelta(u, providerMetadata)
    usage.inputTokens += d.inputTokens
    usage.outputTokens += d.outputTokens
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + d.cacheReadTokens
    usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + d.cacheCreationTokens
    usage.totalTokens = usage.inputTokens + usage.outputTokens
  }

  return {
    provider: config.provider,
    model: config.model,
    async complete(prompt, options) {
      const model = await getModel()
      const result = await generateText({
        model,
        system: options?.system,
        prompt,
        maxOutputTokens: options?.maxTokens ?? config.defaultMaxTokens,
        temperature: options?.temperature ?? config.defaultTemperature ?? 0,
        stopSequences: options?.stopSequences,
        abortSignal: options?.abortSignal,
      })
      addUsage(
        result.usage as Record<string, unknown> | undefined,
        result.providerMetadata as Record<string, unknown> | undefined
      )
      return result.text
    },
    async *stream(prompt, options) {
      const model = await getModel()
      const result = streamText({
        model,
        system: options?.system,
        prompt,
        maxOutputTokens: options?.maxTokens ?? config.defaultMaxTokens,
        temperature: options?.temperature ?? config.defaultTemperature ?? 0,
        stopSequences: options?.stopSequences,
        abortSignal: options?.abortSignal,
      })
      for await (const delta of result.textStream) {
        yield delta
      }
      // Usage settles only after the stream finishes; awaiting it here keeps
      // the cumulative snapshot correct for getUsageSnapshot() callers.
      // (`usage` is a PromiseLike without .catch — wrap before swallowing.)
      addUsage(
        (await Promise.resolve(result.usage).catch(() => undefined)) as
          Record<string, unknown> | undefined,
        (await Promise.resolve(result.providerMetadata).catch(() => undefined)) as
          Record<string, unknown> | undefined
      )
    },
    getUsageSnapshot() {
      return { ...usage }
    },
  }
}

/**
 * Back-compat alias for the original Anthropic-only factory. Prefer
 * {@link createLlmClient} for new code — the underlying implementation is
 * the same.
 */
export const createAnthropicLlmClient = createLlmClient

/**
 * Re-exported from `@cognia/eval-core` — the eval scorers need it inside a
 * zero-`@/` package, and two copies of a JSON extractor is how they drift.
 * Distill callers import it from here exactly as before.
 */
export { extractJson } from "@cognia/eval-core/json"
