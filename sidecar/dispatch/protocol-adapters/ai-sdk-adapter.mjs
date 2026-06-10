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
