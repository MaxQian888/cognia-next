// Built-in protocol adapter: wraps the historical `@ai-sdk/*` execution path
// behind the ProtocolAdapter seam. Behavior is intentionally byte-identical
// to the pre-seam `ai-sdk.mjs` inline code — `ai-sdk.test.mjs` is the canary
// and must pass without edits.

/**
 * Decide whether an openai-protocol base URL is genuine OpenAI (api.openai.com),
 * which serves the modern Responses API, versus an OpenAI-*compatible* gateway
 * (DeepSeek / OpenCode / Groq / OpenRouter / Ollama / LM Studio / …) that only
 * implements Chat Completions. A missing base URL means the default OpenAI
 * endpoint. Anything that doesn't parse, or whose host isn't *.openai.com, is
 * treated as a compatible gateway so we fail safe onto `/chat/completions`.
 */
export function isGenuineOpenAiEndpoint(baseURL) {
  if (!baseURL || typeof baseURL !== "string") return true
  try {
    const host = new URL(baseURL).host.toLowerCase()
    return host === "api.openai.com" || host.endsWith(".openai.com")
  } catch {
    return false
  }
}

// Fallback budget tiers when a reasoning "thinking level" (effort) is set but
// no explicit token budget is. Used only for the budget-driven providers
// (anthropic / google) so an effort-only config still TURNS reasoning ON
// instead of silently leaving it off. Conservative, round numbers — the
// caller can always pass an explicit `maxThinkingTokens` to override.
const EFFORT_TO_BUDGET = Object.freeze({ low: 4096, medium: 12288, high: 24576 })

/**
 * Translate the app's reasoning controls (`effort` "thinking level" and/or
 * `maxThinkingTokens` budget) into the AI SDK's per-provider `providerOptions`
 * block that ENABLES reasoning. Without this the AI-SDK path never turns
 * reasoning on — `maxThinkingTokens`/`effort` were built by resolveSendOptions
 * but dropped here, so a non-Anthropic reasoning model ran with thinking off
 * (the Anthropic path defaults it on). Returns `null` when nothing applies.
 *
 * @param {string} protocol  openai | anthropic | google | mistral | cohere
 * @param {string|undefined} baseURL  the provider base URL (gates openai)
 * @param {{ effort?: string, maxThinkingTokens?: number }|undefined} reasoning
 * @returns {Record<string, Record<string, unknown>>|null}
 */
export function buildReasoningProviderOptions(protocol, baseURL, reasoning) {
  if (!reasoning) return null
  const effort = typeof reasoning.effort === "string" && reasoning.effort ? reasoning.effort : null
  const budget =
    typeof reasoning.maxThinkingTokens === "number" && reasoning.maxThinkingTokens > 0
      ? reasoning.maxThinkingTokens
      : null
  if (!effort && !budget) return null

  switch (protocol) {
    case "anthropic": {
      const budgetTokens = budget ?? (effort ? EFFORT_TO_BUDGET[effort] : null)
      if (!budgetTokens) return null
      return { anthropic: { thinking: { type: "enabled", budgetTokens } } }
    }
    case "google": {
      const thinkingBudget = budget ?? (effort ? EFFORT_TO_BUDGET[effort] : null)
      if (!thinkingBudget) return null
      return { google: { thinkingConfig: { thinkingBudget, includeThoughts: true } } }
    }
    case "openai": {
      // `reasoning_effort` is an OpenAI Responses/Chat field. Emit it ONLY for a
      // genuine *.openai.com endpoint — OpenAI-compatible gateways (DeepSeek,
      // Groq, Ollama, …) implement their own reasoning and may 400 on an
      // unknown field; their models surface reasoning unprompted regardless.
      if (!effort || !isGenuineOpenAiEndpoint(baseURL)) return null
      return { openai: { reasoningEffort: effort } }
    }
    default:
      // mistral / cohere have no standard reasoning-enable option in the SDK.
      return null
  }
}

/** Deep-merge two `providerOptions` maps one level into each provider key. */
function mergeProviderOptions(base, extra) {
  if (!extra) return base ?? undefined
  const out = { ...(base ?? {}) }
  for (const [provider, opts] of Object.entries(extra)) {
    out[provider] = { ...(out[provider] ?? {}), ...opts }
  }
  return out
}

/**
 * Build a model instance for one of the five built-in AI SDK protocols.
 * Lazy-imports the per-provider SDKs so the sidecar's cold start doesn't pay
 * for OpenAI when the user is on Anthropic, etc.
 */
export async function buildModel({ protocol, model, apiKey, baseURL }) {
  switch (protocol) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const client = createOpenAI({ apiKey, baseURL })
      // Pick the endpoint family explicitly. As of @ai-sdk/openai v3 the bare
      // `client(model)` returns a Responses-API model that POSTs to `/responses`
      // — an OpenAI-proprietary endpoint. Genuine OpenAI supports it (and it is
      // the richer, built-in-tool-capable path), but the OpenAI-*compatible*
      // gateways this protocol also serves (DeepSeek, OpenCode Zen/Go, Groq,
      // OpenRouter, Ollama/LM Studio, …) only implement `/chat/completions`, so
      // routing them to `/responses` 404s ("Not Found"). Use Responses only for
      // a genuine *.openai.com endpoint; everyone else gets Chat Completions.
      return isGenuineOpenAiEndpoint(baseURL) ? client.responses(model) : client.chat(model)
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      const client = createAnthropic({ apiKey, baseURL })
      return client(model)
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
      const client = createGoogleGenerativeAI({ apiKey, baseURL })
      return client(model)
    }
    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral")
      const client = createMistral({ apiKey, baseURL })
      return client(model)
    }
    case "cohere": {
      const { createCohere } = await import("@ai-sdk/cohere")
      const client = createCohere({ apiKey, baseURL })
      return client(model)
    }
    default:
      throw new Error(`unsupported AI SDK protocol: ${protocol}`)
  }
}

/**
 * @param {string} protocol  One of openai|anthropic|google|mistral|cohere.
 * @returns {import("./types.mjs").ProtocolAdapter}
 */
export function makeAiSdkAdapter(protocol) {
  return {
    id: `ai-sdk:${protocol}`,
    async start(req) {
      const creds = req.credentials ?? {}
      const modelInstance = await buildModel({
        protocol,
        model: req.model,
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
      })
      const streamTextFn = req.streamTextFn ?? (await import("ai")).streamText
      const streamArgs = {
        model: modelInstance,
        messages: req.messages,
        ...(req.modelParams ?? {}),
      }
      // Enable reasoning per provider (thinking budget / reasoning effort),
      // deep-merged onto any providerOptions the modelParams already carried
      // (e.g. the anthropic cacheControl breakpoint) so neither clobbers the
      // other.
      const reasoningOptions = buildReasoningProviderOptions(protocol, creds.baseURL, req.reasoning)
      const mergedProviderOptions = mergeProviderOptions(
        streamArgs.providerOptions,
        reasoningOptions
      )
      if (mergedProviderOptions) streamArgs.providerOptions = mergedProviderOptions
      // Forward the abort signal so an interrupt actually cancels the in-flight
      // provider HTTP request (cooperative `cancelled` flag alone let the call
      // run to completion and keep billing).
      if (req.abortSignal) streamArgs.abortSignal = req.abortSignal
      if (req.tools && Object.keys(req.tools).length > 0) {
        streamArgs.tools = req.tools
        // Multi-step agentic loop: AI SDK runs each tool's `execute` and feeds
        // the result back to the model until it stops or we hit the step cap.
        streamArgs.stopWhen = ({ steps }) => (steps?.length ?? 0) >= (req.maxSteps ?? 16)
      }
      // streamText's result already matches AdapterResult (fullStream /
      // response / usage) — return it directly.
      return streamTextFn(streamArgs)
    },
  }
}
