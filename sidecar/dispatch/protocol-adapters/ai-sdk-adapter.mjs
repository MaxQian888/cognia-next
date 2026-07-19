// Built-in protocol adapter: wraps the historical `@ai-sdk/*` execution path
// behind the ProtocolAdapter seam. Behavior is intentionally byte-identical
// to the pre-seam `ai-sdk.mjs` inline code — `ai-sdk.test.mjs` is the canary
// and must pass without edits.

// Endpoint-family knowledge (provider→protocol map + Responses-vs-Chat decision)
// lives in the single-source-of-truth `provider-protocol.mjs`. Re-export the two
// host helpers so existing importers (and the canary test) keep their public
// surface; `decideOpenAiEndpointFlavor` is the one decision both the sidecar and
// the renderer now share.
import {
  isGenuineOpenAiEndpoint,
  isResponsesOnlyEndpoint,
  isOpenAiNativeSurface,
  decideOpenAiEndpointFlavor,
  RESPONSES_ONLY_PROVIDERS,
} from "./provider-protocol.mjs"
import { aiSdkTelemetry, withTraceparent } from "../../telemetry.mjs"

export { isGenuineOpenAiEndpoint, isResponsesOnlyEndpoint }

// Fallback budget tiers when a reasoning "thinking level" (effort) is set but
// no explicit token budget is. Used only for the budget-driven providers
// (anthropic / google) so an effort-only config still TURNS reasoning ON
// instead of silently leaving it off. Conservative, round numbers — the
// caller can always pass an explicit `maxThinkingTokens` to override.
// Covers the WHOLE app effort union ("low".."max", see SendOptions.effort):
// the two top tiers (xhigh/max) were missing, so selecting them with no
// explicit budget mapped to `undefined` and silently DISABLED thinking — the
// highest levels did the opposite of what they say.
const EFFORT_TO_BUDGET = Object.freeze({
  low: 4096,
  medium: 12288,
  high: 24576,
  xhigh: 32768,
  max: 49152,
})

/**
 * Map an effort "thinking level" to a token budget for the budget-driven
 * providers (anthropic / google). An unrecognized level falls back to the
 * `high` tier rather than `undefined`, so a reasoning level never silently
 * leaves thinking OFF. Returns null only when no effort is given.
 */
function effortToBudget(effort) {
  if (!effort) return null
  return EFFORT_TO_BUDGET[effort] ?? EFFORT_TO_BUDGET.high
}

// OpenAI's `reasoningEffort` accepts none|minimal|low|medium|high|xhigh. The
// app's effort union additionally carries "max", which OpenAI rejects (400).
const OPENAI_EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

/**
 * Normalize the app's effort level to a value OpenAI's `reasoningEffort`
 * accepts: fold "max" down to the nearest valid ceiling "xhigh", and clamp
 * anything unexpected to "high" so an out-of-range level never 400s the call.
 */
function normalizeOpenAiEffort(effort) {
  if (effort === "max") return "xhigh"
  return OPENAI_EFFORT_VALUES.has(effort) ? effort : "high"
}

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
 * @param {{ providerId?: string }} [opts]  provider id (gates openai; see below)
 * @returns {Record<string, Record<string, unknown>>|null}
 */
export function buildReasoningProviderOptions(protocol, baseURL, reasoning, opts = {}) {
  if (!reasoning) return null
  const effort = typeof reasoning.effort === "string" && reasoning.effort ? reasoning.effort : null
  const budget =
    typeof reasoning.maxThinkingTokens === "number" && reasoning.maxThinkingTokens > 0
      ? reasoning.maxThinkingTokens
      : null
  if (!effort && !budget) return null

  switch (protocol) {
    case "anthropic": {
      const budgetTokens = budget ?? effortToBudget(effort)
      if (!budgetTokens) return null
      return { anthropic: { thinking: { type: "enabled", budgetTokens } } }
    }
    case "google": {
      const thinkingBudget = budget ?? effortToBudget(effort)
      if (!thinkingBudget) return null
      return { google: { thinkingConfig: { thinkingBudget, includeThoughts: true } } }
    }
    case "openai": {
      // `reasoning_effort` is an OpenAI Responses/Chat field. Emit it ONLY for an
      // OpenAI-native surface — OpenAI-compatible gateways (DeepSeek, Groq,
      // Ollama, …) implement their own reasoning and may 400 on an unknown
      // field; their models surface reasoning unprompted regardless. The check
      // is `isOpenAiNativeSurface`, not a bare host test: Codex's ChatGPT
      // backend (chatgpt.com) and its relay presets are native surfaces whose
      // hosts are NOT *.openai.com, so a host-only gate silently dropped these
      // options for the entire Codex subscription path — reasoning ran off and
      // invisible on the one provider whose models are all reasoning models.
      if (!effort || !isOpenAiNativeSurface({ providerId: opts.providerId, baseURL })) return null
      // `reasoningSummary: "auto"` is REQUIRED for the reasoning to be visible:
      // OpenAI o-series / gpt-5 emit NO reasoning parts in the stream without it,
      // so the user would pay for reasoning tokens and see nothing.
      return {
        openai: { reasoningEffort: normalizeOpenAiEffort(effort), reasoningSummary: "auto" },
      }
    }
    default:
      // mistral / cohere have no standard reasoning-enable option in the SDK.
      return null
  }
}

/**
 * The Responses-API request fields Codex itself sends, which the AI SDK does not
 * default for us. Verified against `openai/codex`
 * (`codex-rs/core/src/client.rs:build_responses_request`):
 *
 *   • `store: false` — Codex sets `store` to `is_azure_responses_endpoint()`,
 *     i.e. false for BOTH the ChatGPT backend and api.openai.com. Omitting it
 *     lets the server default (`store: true`) stand, so every Codex turn is
 *     persisted server-side against the user's account — the opposite of what
 *     the Codex client does, and wrong for a zero-retention subscription.
 *   • `include: ["reasoning.encrypted_content"]` — sent when reasoning is on.
 *     With `store: false` the server keeps no reasoning state, so without this
 *     the encrypted reasoning item never comes back and the model loses its
 *     chain of thought between turns of an agentic loop.
 *
 * Scoped to the responses-only provider ids (codex) and the responses flavor:
 * the general-purpose `openai` provider keeps the server's storage default,
 * which existing users may rely on.
 *
 * @returns {Record<string, Record<string, unknown>>|null}
 */
export function buildCodexResponsesProviderOptions({ providerId, flavor, hasReasoning }) {
  if (!providerId || !RESPONSES_ONLY_PROVIDERS.has(providerId)) return null
  if (flavor !== "responses") return null
  return {
    openai: {
      store: false,
      ...(hasReasoning ? { include: ["reasoning.encrypted_content"] } : {}),
    },
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
 * Wrap a model so inline `<think>…</think>` reasoning is extracted into proper
 * reasoning parts instead of leaking into the visible answer text. Many models
 * served over the OpenAI-compatible / chat protocols (DeepSeek-R1 distills,
 * QwQ, GLM, and other reasoning checkpoints without a dedicated reasoning
 * channel) emit their chain-of-thought as a literal `<think>` block in the
 * content. `extractReasoningMiddleware` pulls it out so it renders as a
 * collapsible reasoning block, not as garbage in the answer. Harmless
 * pass-through for models that already stream reasoning natively or never emit
 * the tag — nothing is extracted, the text flows unchanged.
 */
async function withReasoningExtraction(model) {
  const { wrapLanguageModel, extractReasoningMiddleware } = await import("ai")
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  })
}

/**
 * Build a model instance for one of the five built-in AI SDK protocols.
 * Lazy-imports the per-provider SDKs so the sidecar's cold start doesn't pay
 * for OpenAI when the user is on Anthropic, etc. Every model is wrapped with
 * `<think>`-tag reasoning extraction (see withReasoningExtraction).
 */
export async function buildModel({
  protocol,
  model,
  apiKey,
  baseURL,
  headers,
  apiFlavor,
  providerId,
}) {
  const base = await buildRawModel({
    protocol,
    model,
    apiKey,
    baseURL,
    headers,
    apiFlavor,
    providerId,
  })
  return withReasoningExtraction(base)
}

/** Construct the un-wrapped provider model. Split out so the wrap is uniform. */
async function buildRawModel({ protocol, model, apiKey, baseURL, headers, apiFlavor, providerId }) {
  switch (protocol) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      // `headers` carries the Codex ChatGPT-login extras (ChatGPT-Account-Id,
      // OpenAI-Beta, originator, OAI-Product-Sku); undefined for everyone else.
      const client = createOpenAI({ apiKey, baseURL, headers })
      // Pick the endpoint family explicitly. As of @ai-sdk/openai v3 the bare
      // `client(model)` returns a Responses-API model that POSTs to `/responses`
      // — an OpenAI-proprietary endpoint. The OpenAI-*compatible* gateways this
      // protocol also serves (DeepSeek, OpenCode, Groq, Ollama, …) only implement
      // `/chat/completions`, so routing them to `/responses` 404s. The shared
      // decision honors an explicit `apiFlavor` (so the user can opt a gateway /
      // custom URL into Responses) and otherwise falls back to the host/id
      // heuristic. `providerId` is REQUIRED for that heuristic's id arm
      // (RESPONSES_ONLY_PROVIDERS): dropping it here made codex-on-a-relay-preset
      // fall through to `.chat()` while the renderer — which does pass it — said
      // `.responses()`, the exact drift this shared module exists to prevent.
      const flavor = decideOpenAiEndpointFlavor({ apiFlavor, baseURL, providerId })
      return flavor === "responses" ? client.responses(model) : client.chat(model)
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
    case "azure": {
      const { createAzure } = await import("@ai-sdk/azure")
      // Azure Foundry serves the OpenAI surface behind a per-resource endpoint.
      // The resolver carries that full endpoint as `baseURL`; `headers` is
      // forwarded for parity with the openai path (usually undefined).
      const client = createAzure({ apiKey, baseURL, headers })
      // Azure exposes BOTH /chat/completions and the newer /responses. Default
      // to chat (conservative for existing deployments); `apiFlavor: "responses"`
      // opts a resource into the Responses API. Same shared decision as openai.
      const flavor = decideOpenAiEndpointFlavor({ apiFlavor, baseURL, providerId: "azure" })
      return flavor === "responses" ? client.responses(model) : client.chat(model)
    }
    case "bedrock": {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
      // Modern Bedrock authenticates with a direct API key (bearer,
      // `AWS_BEARER_TOKEN_BEDROCK`), carried in `apiKey`. The region falls back
      // to the `AWS_REGION` env the sidecar inherits; `baseURL` is an optional
      // custom endpoint. Bedrock has its own wire protocol — no responses/chat
      // split, so `apiFlavor` does not apply here.
      const client = createAmazonBedrock({
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
      })
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
      const providerId = req.providerId
      const modelInstance = await buildModel({
        protocol,
        model: req.model,
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
        headers: creds.headers,
        apiFlavor: creds.apiFlavor,
        providerId,
      })
      const streamTextFn = req.streamTextFn ?? (await import("ai")).streamText
      const streamArgs = {
        model: modelInstance,
        messages: req.messages,
        ...(req.modelParams ?? {}),
      }
      const experimentalTelemetry = aiSdkTelemetry({
        sessionId: req.sessionId,
        traceId: req.traceId,
        provider: providerId ?? protocol,
        traceparent: req.traceparent,
      })
      if (experimentalTelemetry) {
        const { traceparent: _traceparent, ...publicTelemetry } = experimentalTelemetry
        streamArgs.experimental_telemetry = publicTelemetry
      }
      // Enable reasoning per provider (thinking budget / reasoning effort),
      // deep-merged onto any providerOptions the modelParams already carried
      // (e.g. the anthropic cacheControl breakpoint) so neither clobbers the
      // other.
      const reasoningOptions = buildReasoningProviderOptions(
        protocol,
        creds.baseURL,
        req.reasoning,
        { providerId }
      )
      // Codex's own Responses-API fields (store:false + encrypted reasoning).
      // Merged after the reasoning block so both land under the `openai` key.
      const codexOptions =
        protocol === "openai"
          ? buildCodexResponsesProviderOptions({
              providerId,
              flavor: decideOpenAiEndpointFlavor({
                apiFlavor: creds.apiFlavor,
                baseURL: creds.baseURL,
                providerId,
              }),
              hasReasoning: reasoningOptions !== null,
            })
          : null
      const mergedProviderOptions = mergeProviderOptions(
        mergeProviderOptions(streamArgs.providerOptions, reasoningOptions),
        codexOptions
      )
      if (mergedProviderOptions) streamArgs.providerOptions = mergedProviderOptions
      // Forward the abort signal so an interrupt actually cancels the in-flight
      // provider HTTP request (cooperative `cancelled` flag alone let the call
      // run to completion and keep billing).
      if (req.abortSignal) streamArgs.abortSignal = req.abortSignal
      if (req.prepareStep) streamArgs.prepareStep = req.prepareStep
      if (req.tools && Object.keys(req.tools).length > 0) {
        streamArgs.tools = req.tools
        // Multi-step agentic loop: AI SDK runs each tool's `execute` and feeds
        // the result back to the model until it stops or we hit the step cap.
        // `req.stopWhenExtra(steps)` lets the caller end the leg EARLY after a
        // specific step (the ai-sdk path uses it to break right after a tool
        // returns an image, so the dispatcher can re-project that image as a
        // universally-supported user message before the model continues — most
        // non-Anthropic provider APIs can't carry an image inside a tool result).
        streamArgs.stopWhen = ({ steps }) =>
          (steps?.length ?? 0) >= (req.maxSteps ?? 16) ||
          (typeof req.stopWhenExtra === "function" ? req.stopWhenExtra(steps) === true : false)
      }
      // streamText's result already matches AdapterResult (fullStream /
      // response / usage) — return it directly.
      return withTraceparent(req.traceparent, () => streamTextFn(streamArgs))
    },
  }
}
